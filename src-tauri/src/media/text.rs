//! Text and titles: a block of text drawn onto a transparent picture the size of the canvas.
//!
//! The preview shows that picture and the export overlays the very same file, so both always match.
//! Drawing is pure Rust with the bundled Noto Sans (SIL OFL 1.1, see `assets/fonts/OFL.txt`): no system
//! fonts are read, so the same text gives the same pixels on every machine and platform.

use std::collections::hash_map::DefaultHasher;
use std::collections::{BTreeSet, HashSet};
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use cosmic_text::{
    Align, Attrs, Buffer, Color, Family, FontSystem, Metrics, Shaping, SwashCache, Weight, fontdb,
};
use serde::{Deserialize, Serialize};

use crate::errors::{AppError, AppResult};

/// The font of a text that names none, and the stand-in for a font that is not installed here.
pub const FONT_FAMILY: &str = "Noto Sans";
/// The default font is compiled in, so text can always be drawn. The other fonts that come with CutVii are
/// files shipped next to the app (`assets/fonts`, all SIL Open Font License; see `assets/fonts/licenses`).
const BUILT_IN_FONTS: &[&[u8]] = &[
    include_bytes!("../../assets/fonts/NotoSans-Regular.ttf"),
    include_bytes!("../../assets/fonts/NotoSans-Bold.ttf"),
];
/// Font files the user may import.
pub const FONT_EXTENSIONS: &[&str] = &["ttf", "otf", "ttc"];
pub const MAX_FONT_BYTES: u64 = 40 * 1024 * 1024;
const MAX_FONT_NAME: usize = 100;

/// Bump when the drawing changes, so cached pictures are made again.
pub const RENDER_VERSION: u32 = 1;
pub const MAX_CHARS: usize = 2000;
pub const MIN_FONT_SIZE: f64 = 8.0;
pub const MAX_FONT_SIZE: f64 = 2000.0;
pub const MIN_SIDE: u32 = 16;
pub const MAX_SIDE: u32 = 8192;
/// Lines wrap at this share of the canvas width.
pub const WRAP_WIDTH: f64 = 0.9;
const LINE_HEIGHT: f32 = 1.25;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TextAlign {
    Left,
    #[default]
    Center,
    Right,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextSpec {
    pub content: String,
    /// Height of the font in canvas pixels.
    pub font_size: f64,
    /// `#RRGGBB`.
    pub color: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub bold: bool,
    /// Font family name. Absent means Noto Sans; a family that is not installed is drawn in Noto Sans too.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font: Option<String>,
    #[serde(default)]
    pub align: TextAlign,
    /// Centre of the text block as a share of the canvas (0.5, 0.5 = the middle).
    pub x: f64,
    pub y: f64,
}

fn parse_color(hex: &str) -> Option<(u8, u8, u8)> {
    let digits = hex.strip_prefix('#')?;
    if digits.len() != 6 || !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let part = |i: usize| u8::from_str_radix(&digits[i..i + 2], 16).ok();
    Some((part(0)?, part(2)?, part(4)?))
}

impl TextSpec {
    pub fn validate(&self) -> AppResult<()> {
        let fail = |m: &str| Err(AppError::InvalidInput(m.to_string()));
        if self.content.trim().is_empty() {
            return fail("the text is empty");
        }
        if self.content.chars().count() > MAX_CHARS {
            return fail("the text is too long (2000 characters at most)");
        }
        if !(MIN_FONT_SIZE..=MAX_FONT_SIZE).contains(&self.font_size) {
            return fail("the font size must be between 8 and 2000");
        }
        if self
            .font
            .as_ref()
            .is_some_and(|f| f.trim().is_empty() || f.chars().count() > MAX_FONT_NAME)
        {
            return fail("the font name is not valid");
        }
        if parse_color(&self.color).is_none() {
            return fail("the text colour must be a #RRGGBB colour");
        }
        if !(0.0..=1.0).contains(&self.x) || !(0.0..=1.0).contains(&self.y) {
            return fail("the text position must be inside the canvas");
        }
        Ok(())
    }
}

fn check_canvas(width: u32, height: u32) -> AppResult<()> {
    if (MIN_SIDE..=MAX_SIDE).contains(&width) && (MIN_SIDE..=MAX_SIDE).contains(&height) {
        Ok(())
    } else {
        Err(AppError::InvalidInput("invalid canvas size".into()))
    }
}

/// Cache name of the picture for `spec` on a canvas: changes with any property, the size or the renderer.
pub fn text_key(spec: &TextSpec, width: u32, height: u32) -> String {
    let mut h = DefaultHasher::new();
    (
        RENDER_VERSION,
        width,
        height,
        &spec.content,
        spec.font_size.to_bits(),
        &spec.color,
        spec.bold,
        &spec.font,
        spec.align,
        spec.x.to_bits(),
        spec.y.to_bits(),
    )
        .hash(&mut h);
    format!("{:016x}", h.finish())
}

struct Fonts {
    system: FontSystem,
    cache: SwashCache,
    /// Families that came with the app.
    bundled: BTreeSet<String>,
    /// Families only the user's imported files provide.
    imported: BTreeSet<String>,
    /// Imported font files already loaded.
    loaded: HashSet<PathBuf>,
}

fn family_names(db: &fontdb::Database) -> BTreeSet<String> {
    db.faces()
        .filter_map(|face| face.families.first().map(|(name, _)| name.clone()))
        .collect()
}

fn fonts() -> &'static Mutex<Fonts> {
    static FONTS: OnceLock<Mutex<Fonts>> = OnceLock::new();
    FONTS.get_or_init(|| {
        let mut db = fontdb::Database::new();
        for font in BUILT_IN_FONTS {
            db.load_font_data(font.to_vec());
        }
        let bundled = family_names(&db);
        Mutex::new(Fonts {
            system: FontSystem::new_with_locale_and_db("en-US".into(), db),
            cache: SwashCache::new(),
            bundled,
            imported: BTreeSet::new(),
            loaded: HashSet::new(),
        })
    })
}

fn is_font_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| FONT_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

/// Load every font file in `dir` that is not loaded yet. Returns the families those files provide.
fn load_fonts_in(dir: &Path, guard: &mut Fonts) -> BTreeSet<String> {
    let mut families = BTreeSet::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return families;
    };
    let mut paths: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| is_font_file(p))
        .collect();
    paths.sort();
    for path in paths {
        if !guard.loaded.insert(path.clone()) {
            continue;
        }
        // the file is read when the font is used, not kept in memory
        let db = guard.system.db_mut();
        for id in db.load_font_source(fontdb::Source::File(path)) {
            if let Some((name, _)) = db.face(id).and_then(|face| face.families.first()) {
                families.insert(name.clone());
            }
        }
    }
    families
}

/// Make the fonts that ship with CutVii (the files in `dir`) available. Returns how many families were
/// added; 0 on the first call means the folder is missing and only the built-in default font can be used.
pub fn load_bundled_fonts(dir: &Path) -> usize {
    let mut guard = fonts().lock().unwrap_or_else(|e| e.into_inner());
    let families = load_fonts_in(dir, &mut guard);
    for family in &families {
        guard.imported.remove(family);
    }
    let added = families.len();
    guard.bundled.extend(families);
    added
}

/// Make the fonts the user imported earlier (the files in `dir`) available. Cheap to call again.
pub fn load_user_fonts(dir: &Path) {
    let mut guard = fonts().lock().unwrap_or_else(|e| e.into_inner());
    let families = load_fonts_in(dir, &mut guard);
    let new: Vec<String> = families
        .into_iter()
        .filter(|f| !guard.bundled.contains(f))
        .collect();
    guard.imported.extend(new);
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontInfo {
    pub family: String,
    /// Comes with CutVii (as opposed to imported by the user on this machine).
    pub bundled: bool,
    /// A small picture of the family name drawn in the font itself, for the font picker.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
}

/// Size of a font preview picture; the picker shows it at half this size so it stays sharp.
pub const FONT_PREVIEW_SIZE: (u32, u32) = (560, 64);
const FONT_PREVIEW_FONT_SIZE: f64 = 34.0;
/// The app's text colour (`--text`).
const FONT_PREVIEW_COLOR: &str = "#F2F0ED";

/// The preview picture of `family` inside `dir`: its name drawn in the font, made once and reused.
pub fn ensure_font_preview(dir: &Path, family: &str) -> AppResult<PathBuf> {
    let (width, height) = FONT_PREVIEW_SIZE;
    let spec = TextSpec {
        content: family.to_string(),
        font_size: FONT_PREVIEW_FONT_SIZE,
        color: FONT_PREVIEW_COLOR.into(),
        bold: false,
        font: Some(family.to_string()),
        align: TextAlign::Left,
        // the 90% text box then spans the whole picture but for a small margin
        x: 0.5,
        y: 0.5,
    };
    let out = dir.join(format!("{}.png", text_key(&spec, width, height)));
    if !out.is_file() {
        write_text_png(&spec, width, height, &out)?;
    }
    Ok(out)
}

/// Every font text can be drawn in, by family name: bundled ones first, then imported ones.
pub fn list_fonts() -> Vec<FontInfo> {
    let guard = fonts().lock().unwrap_or_else(|e| e.into_inner());
    let mut all: Vec<FontInfo> = family_names(guard.system.db())
        .into_iter()
        .map(|family| FontInfo {
            bundled: guard.bundled.contains(&family),
            family,
            preview: None,
        })
        .collect();
    all.sort_by(|a, b| b.bundled.cmp(&a.bundled).then(a.family.cmp(&b.family)));
    all
}

/// Copy a font file into `dir` and make it available. The original is only read. Returns its families.
pub fn import_font(src: &Path, dir: &Path) -> AppResult<Vec<String>> {
    let invalid = |m: &str| AppError::InvalidInput(m.to_string());
    if !is_font_file(src) {
        return Err(invalid("choose a .ttf, .otf or .ttc font file"));
    }
    if fs::metadata(src)?.len() > MAX_FONT_BYTES {
        return Err(invalid("that font file is too large (40 MB at most)"));
    }
    let bytes = fs::read(src)?;
    // read it on its own first: a file that is not a font must never reach the shared font list
    let mut probe = fontdb::Database::new();
    probe.load_font_data(bytes.clone());
    let families: Vec<String> = family_names(&probe).into_iter().collect();
    if families.is_empty() {
        return Err(invalid("that file is not a font CutVii can read"));
    }
    let name = src
        .file_name()
        .ok_or_else(|| invalid("that font file has no name"))?;
    fs::create_dir_all(dir)?;
    let target = dir.join(name);
    if fs::read(&target).ok().as_deref() != Some(&bytes[..]) {
        let tmp = target.with_extension(format!("part-{}", std::process::id()));
        fs::write(&tmp, &bytes)?;
        fs::rename(&tmp, &target)?;
    }
    let mut guard = fonts().lock().unwrap_or_else(|e| e.into_inner());
    if guard.loaded.insert(target.clone()) {
        guard.system.db_mut().load_font_data(bytes);
    }
    for family in &families {
        if !guard.bundled.contains(family) {
            guard.imported.insert(family.clone());
        }
    }
    Ok(families)
}

/// Draw `spec` on a transparent canvas. Returns straight-alpha RGBA, `width * height * 4` bytes.
pub fn render(spec: &TextSpec, width: u32, height: u32) -> AppResult<Vec<u8>> {
    spec.validate()?;
    check_canvas(width, height)?;
    let (r, g, b) = parse_color(&spec.color).expect("validated");

    let mut guard = fonts().lock().unwrap_or_else(|e| e.into_inner());
    // a font that is not installed here (a project from another machine) is drawn in the default font
    let family = spec
        .font
        .as_deref()
        .filter(|f| family_names(guard.system.db()).contains(*f))
        .unwrap_or(FONT_FAMILY)
        .to_string();
    let Fonts {
        system: font_system,
        cache,
        ..
    } = &mut *guard;
    let size = spec.font_size as f32;
    let box_width = (width as f64 * WRAP_WIDTH) as f32;
    let mut buffer = Buffer::new(font_system, Metrics::new(size, size * LINE_HEIGHT));
    buffer.set_size(Some(box_width), None);
    let attrs = Attrs::new()
        .family(Family::Name(&family))
        .weight(if spec.bold {
            Weight::BOLD
        } else {
            Weight::NORMAL
        });
    let align = match spec.align {
        TextAlign::Left => Align::Left,
        TextAlign::Center => Align::Center,
        TextAlign::Right => Align::Right,
    };
    buffer.set_text(&spec.content, &attrs, Shaping::Advanced, Some(align));
    buffer.shape_until_scroll(font_system, false);
    let block_height = buffer
        .layout_runs()
        .map(|run| run.line_top + run.line_height)
        .fold(0.0f32, f32::max);

    let left = (spec.x * width as f64 - box_width as f64 / 2.0).round() as i64;
    let top = (spec.y * height as f64 - block_height as f64 / 2.0).round() as i64;
    let mut pixels = vec![0u8; width as usize * height as usize * 4];
    buffer.draw(
        font_system,
        cache,
        Color::rgb(r, g, b),
        |x, y, w, h, color| {
            let alpha = color.a() as u32;
            if alpha == 0 {
                return;
            }
            for py in y as i64 + top..y as i64 + top + h as i64 {
                for px in x as i64 + left..x as i64 + left + w as i64 {
                    if px < 0 || py < 0 || px >= width as i64 || py >= height as i64 {
                        continue;
                    }
                    let i = (py as usize * width as usize + px as usize) * 4;
                    // one colour throughout, so only the coverage is blended ("over")
                    let below = pixels[i + 3] as u32;
                    pixels[i..i + 3].copy_from_slice(&[r, g, b]);
                    pixels[i + 3] = (alpha + below * (255 - alpha) / 255).min(255) as u8;
                }
            }
        },
    );
    Ok(pixels)
}

/// Draw `spec` and write it to `out` as a PNG, through a temp file so a failed run never leaves a
/// corrupt picture.
pub fn write_text_png(spec: &TextSpec, width: u32, height: u32, out: &Path) -> AppResult<()> {
    let pixels = render(spec, width, height)?;
    if let Some(parent) = out.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = out.with_extension(format!("part-{}", std::process::id()));
    let written = (|| -> AppResult<()> {
        let mut encoder = png::Encoder::new(BufWriter::new(fs::File::create(&tmp)?), width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        let failed = |e: png::EncodingError| AppError::InvalidInput(format!("text picture: {e}"));
        let mut writer = encoder.write_header().map_err(failed)?;
        writer.write_image_data(&pixels).map_err(failed)?;
        writer.finish().map_err(failed)
    })();
    if let Err(e) = written {
        fs::remove_file(&tmp).ok();
        return Err(e);
    }
    fs::rename(&tmp, out)?;
    Ok(())
}

/// The picture of `spec` on a canvas, inside `data_dir/text`: drawn now unless it already exists.
pub fn ensure_text_picture(
    data_dir: &Path,
    spec: &TextSpec,
    width: u32,
    height: u32,
) -> AppResult<PathBuf> {
    spec.validate()?;
    check_canvas(width, height)?;
    load_user_fonts(&data_dir.join("fonts"));
    let out = data_dir
        .join("text")
        .join(format!("{}.png", text_key(spec, width, height)));
    if !out.is_file() {
        write_text_png(spec, width, height, &out)?;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: u32 = 640;
    const H: u32 = 360;
    /// Every family that ships with CutVii, in the order the picker lists them.
    const ALL_FAMILIES: &[&str] = &[
        "Alegreya",
        "Aleo",
        "Alex Brush",
        "Arapey",
        "Assistant",
        "Barlow",
        "Bitcount Ink",
        "Bitter",
        "Brawler",
        "Bungee Spice",
        "Caladea",
        "Carme",
        "DM Sans",
        "Enriqueta",
        "Fraunces",
        "Google Sans",
        "Grandiflora One",
        "Grechen Fuemen",
        "LINE Seed JP",
        "Lato",
        "Libre Baskerville",
        "Luckiest Guy",
        "Merienda",
        "Merriweather",
        "Mulish",
        "Noto Sans",
        "Nunito",
        "Open Sans",
        "Oswald",
        "Pinyon Script",
        "Playfair Display",
        "Playwrite NZ Basic Guides",
        "Poppins",
        "Roboto",
        "Rokkitt",
        "Rubik",
        "Work Sans",
    ];
    const SINGLE_WEIGHT: &[&str] = &[
        "Alex Brush",
        "Arapey",
        "Bungee Spice",
        "Carme",
        "Grandiflora One",
        "Grechen Fuemen",
        "Luckiest Guy",
        "Pinyon Script",
        "Playwrite NZ Basic Guides",
    ];

    fn spec(content: &str) -> TextSpec {
        TextSpec {
            content: content.into(),
            font_size: 48.0,
            color: "#E5733A".into(),
            bold: false,
            font: None,
            align: TextAlign::Center,
            x: 0.5,
            y: 0.5,
        }
    }

    /// (left, top, right, bottom) of the painted pixels and the summed alpha.
    fn ink(pixels: &[u8]) -> ((u32, u32, u32, u32), u64) {
        let (mut l, mut t, mut r, mut b, mut sum) = (W, H, 0, 0, 0u64);
        for (i, px) in pixels.chunks_exact(4).enumerate() {
            if px[3] == 0 {
                continue;
            }
            let (x, y) = (i as u32 % W, i as u32 / W);
            (l, t, r, b) = (l.min(x), t.min(y), r.max(x), b.max(y));
            sum += px[3] as u64;
        }
        ((l, t, r, b), sum)
    }

    #[test]
    fn draws_the_text_in_its_colour_centred_on_a_transparent_canvas() {
        let pixels = render(&spec("Hello"), W, H).unwrap();
        assert_eq!(pixels.len(), (W * H * 4) as usize);
        let ((l, t, r, b), sum) = ink(&pixels);
        assert!(sum > 0, "something is drawn");
        assert!((l + r).abs_diff(W) <= 8, "centred across: {l}..{r} of {W}");
        assert!((t + b).abs_diff(H) <= 24, "centred down: {t}..{b} of {H}");
        assert!((90..200).contains(&(r - l)), "plausible width: {}", r - l);
        assert!((25..60).contains(&(b - t)), "plausible height: {}", b - t);
        assert!(
            pixels
                .chunks_exact(4)
                .all(|p| p[3] == 0 || p[..3] == [0xE5, 0x73, 0x3A]),
            "only the requested colour"
        );
        assert!(
            pixels.chunks_exact(4).any(|p| p[3] == 255),
            "solid inside the letters"
        );
        assert_eq!(pixels[3], 0, "corner is transparent");
        // same input, same pixels
        assert_eq!(pixels, render(&spec("Hello"), W, H).unwrap());
    }

    #[test]
    fn alignment_position_weight_and_size_change_the_picture() {
        let base = spec("Hi");
        let ((cl, ct, cr, _), regular) = ink(&render(&base, W, H).unwrap());

        let left = TextSpec {
            align: TextAlign::Left,
            ..base.clone()
        };
        let ((l, ..), _) = ink(&render(&left, W, H).unwrap());
        assert!(l.abs_diff(W / 20) <= 8, "left edge of the 90% box: {l}");
        let right = TextSpec {
            align: TextAlign::Right,
            ..base.clone()
        };
        let ((_, _, r, _), _) = ink(&render(&right, W, H).unwrap());
        assert!(r.abs_diff(W * 19 / 20) <= 8, "right edge of the box: {r}");

        let moved = TextSpec {
            x: 0.25,
            y: 0.8,
            ..base.clone()
        };
        let ((ml, mt, mr, _), _) = ink(&render(&moved, W, H).unwrap());
        assert!(
            (cl + cr).abs_diff(ml + mr + W / 2) <= 2,
            "moved a quarter left"
        );
        assert!(mt.abs_diff(ct + 108) <= 1, "moved 30% down: {ct} -> {mt}");

        let bold = TextSpec {
            bold: true,
            ..base.clone()
        };
        assert!(
            ink(&render(&bold, W, H).unwrap()).1 > regular * 11 / 10,
            "bold has more ink"
        );
        let big = TextSpec {
            font_size: 96.0,
            ..base.clone()
        };
        let ((bl, _, br, _), _) = ink(&render(&big, W, H).unwrap());
        assert!(
            (br - bl) as f64 > (cr - cl) as f64 * 1.8,
            "twice the size is about twice as wide"
        );
    }

    #[test]
    fn long_text_wraps_inside_the_canvas_and_line_breaks_are_kept() {
        let ((_, t1, _, b1), _) = ink(&render(&spec("One line"), W, H).unwrap());
        let long = spec("This sentence is far too long to fit on a single line of the canvas");
        let ((l, t, r, b), _) = ink(&render(&long, W, H).unwrap());
        assert!(
            l >= W / 20 - 2 && r <= W * 19 / 20 + 2,
            "inside the box: {l}..{r}"
        );
        assert!(b - t > (b1 - t1) * 2, "more than one line");
        let ((_, t2, _, b2), _) = ink(&render(&spec("One\nTwo"), W, H).unwrap());
        assert!(b2 - t2 > (b1 - t1) * 3 / 2, "explicit line break");
        // text pushed past the edge is cut off, not an error
        let edge = TextSpec {
            x: 1.0,
            y: 0.0,
            ..spec("Corner")
        };
        assert!(ink(&render(&edge, W, H).unwrap()).1 > 0);
    }

    #[test]
    fn bundled_fonts_are_listed_and_change_the_picture() {
        let shipped = Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/fonts");
        load_bundled_fonts(&shipped);
        assert_eq!(
            load_bundled_fonts(&shipped),
            0,
            "loading again adds nothing"
        );
        assert_eq!(load_bundled_fonts(&shipped.join("missing")), 0);
        let fonts = list_fonts();
        let bundled: Vec<&str> = fonts
            .iter()
            .filter(|f| f.bundled)
            .map(|f| f.family.as_str())
            .collect();
        assert_eq!(bundled, ALL_FAMILIES);
        let with = |font: Option<&str>, bold: bool| TextSpec {
            font: font.map(String::from),
            bold,
            ..spec("Hamburg")
        };
        let default = render(&with(None, false), W, H).unwrap();
        assert_eq!(
            default,
            render(&with(Some("Noto Sans"), false), W, H).unwrap()
        );
        let mut seen = vec![default.clone()];
        for family in ALL_FAMILIES.iter().filter(|f| **f != "Noto Sans") {
            let regular = render(&with(Some(family), false), W, H).unwrap();
            assert!(ink(&regular).1 > 0, "{family} draws something");
            assert!(!seen.contains(&regular), "{family} has its own look");
            // most families get heavier when bold; a few come in a single weight
            let bold = ink(&render(&with(Some(family), true), W, H).unwrap()).1;
            if !SINGLE_WEIGHT.contains(family) {
                assert!(bold > ink(&regular).1 * 21 / 20, "{family} bold");
            }
            seen.push(regular);
        }
        // a font that is not installed here is drawn in the default font, but is a different cache entry
        assert_eq!(
            default,
            render(&with(Some("Not Installed"), false), W, H).unwrap()
        );
        assert_ne!(
            text_key(&with(None, false), W, H),
            text_key(&with(Some("Roboto"), false), W, H)
        );
        assert!(with(Some("  "), false).validate().is_err());
        assert!(with(Some(&"x".repeat(101)), false).validate().is_err());
    }

    #[test]
    fn font_previews_show_the_name_in_the_font_and_are_made_once() {
        load_bundled_fonts(&Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/fonts"));
        let dir = std::env::temp_dir().join(format!("cutvii-previews-{}", std::process::id()));
        let roboto = ensure_font_preview(&dir, "Roboto").unwrap();
        let script = ensure_font_preview(&dir, "Pinyon Script").unwrap();
        assert_ne!(roboto, script);
        assert_ne!(fs::read(&roboto).unwrap(), fs::read(&script).unwrap());
        let made = fs::metadata(&roboto).unwrap().modified().unwrap();
        assert_eq!(ensure_font_preview(&dir, "Roboto").unwrap(), roboto);
        assert_eq!(fs::metadata(&roboto).unwrap().modified().unwrap(), made);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 2);

        // the longest family name still fits on one line of the picture
        let (w, h) = FONT_PREVIEW_SIZE;
        let long = TextSpec {
            content: "Playwrite NZ Basic Guides".into(),
            font_size: FONT_PREVIEW_FONT_SIZE,
            color: FONT_PREVIEW_COLOR.into(),
            bold: false,
            font: Some("Playwrite NZ Basic Guides".into()),
            align: TextAlign::Left,
            x: 0.5,
            y: 0.5,
        };
        let pixels = render(&long, w, h).unwrap();
        let rows: Vec<u32> = pixels
            .chunks_exact(4)
            .enumerate()
            .filter(|(_, p)| p[3] > 0)
            .map(|(i, _)| i as u32 / w)
            .collect();
        assert!(
            rows.iter().min().unwrap() > &0 && rows.iter().max().unwrap() < &(h - 1),
            "not cut off at the top or bottom"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn importing_a_font_copies_it_and_rejects_files_that_are_not_fonts() {
        let dir = std::env::temp_dir().join(format!("cutvii-fonts-{}", std::process::id()));
        let (from, store) = (dir.join("downloads"), dir.join("fonts"));
        fs::create_dir_all(&from).unwrap();
        let assets = Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/fonts");
        let source = from.join("My Font.TTF");
        fs::copy(assets.join("GrechenFuemen-Regular.ttf"), &source).unwrap();

        assert_eq!(import_font(&source, &store).unwrap(), ["Grechen Fuemen"]);
        let copy = store.join("My Font.TTF");
        assert_eq!(fs::read(&copy).unwrap(), fs::read(&source).unwrap());
        // again: same result, still one file, and the original is untouched
        assert_eq!(import_font(&source, &store).unwrap(), ["Grechen Fuemen"]);
        assert_eq!(fs::read_dir(&store).unwrap().count(), 1);
        assert!(source.is_file());
        load_user_fonts(&store); // what a later start of the app does
        load_user_fonts(&dir.join("missing"));

        let fake = from.join("fake.ttf");
        fs::write(&fake, b"this is not a font").unwrap();
        let e = import_font(&fake, &store).unwrap_err().to_string();
        assert!(e.contains("not a font"), "{e}");
        let text = from.join("notes.txt");
        fs::write(&text, b"hello").unwrap();
        assert!(import_font(&text, &store).is_err());
        assert!(import_font(&from.join("gone.ttf"), &store).is_err());
        assert_eq!(
            fs::read_dir(&store).unwrap().count(),
            1,
            "nothing else was stored"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn invalid_specs_and_sizes_are_rejected() {
        let ok = spec("Title");
        assert!(ok.validate().is_ok());
        let bad = [
            TextSpec {
                content: "  \n".into(),
                ..ok.clone()
            },
            TextSpec {
                content: "x".repeat(MAX_CHARS + 1),
                ..ok.clone()
            },
            TextSpec {
                font_size: 4.0,
                ..ok.clone()
            },
            TextSpec {
                font_size: f64::NAN,
                ..ok.clone()
            },
            TextSpec {
                color: "red".into(),
                ..ok.clone()
            },
            TextSpec {
                color: "#12345G".into(),
                ..ok.clone()
            },
            TextSpec {
                x: 1.5,
                ..ok.clone()
            },
            TextSpec {
                y: f64::NAN,
                ..ok.clone()
            },
        ];
        for s in &bad {
            assert!(render(s, W, H).is_err(), "{s:?}");
        }
        assert!(render(&ok, 8, H).is_err());
        assert!(render(&ok, W, MAX_SIDE + 1).is_err());
    }

    #[test]
    fn spec_round_trips_as_camel_case_json_and_rejects_unknown_fields() {
        let json = r##"{"content":"Hi","fontSize":64,"color":"#FFFFFF","x":0.5,"y":0.9}"##;
        let parsed: TextSpec = serde_json::from_str(json).unwrap();
        assert_eq!(
            (parsed.font_size, parsed.bold, parsed.align),
            (64.0, false, TextAlign::Center)
        );
        let out = serde_json::to_value(&parsed).unwrap();
        assert_eq!(out["align"], "center");
        assert!(out.get("bold").is_none(), "false is left out");
        assert!(
            serde_json::from_str::<TextSpec>(&json.replace("\"x\"", "\"font\":1,\"x\"")).is_err()
        );
    }

    #[test]
    fn writes_a_png_that_decodes_to_the_same_pixels_and_keys_follow_the_spec() {
        let dir = std::env::temp_dir().join(format!("cutvii-text-{}", std::process::id()));
        let s = spec("Saved");
        let out = dir
            .join("nested")
            .join(format!("{}.png", text_key(&s, W, H)));
        write_text_png(&s, W, H, &out).unwrap();
        assert_eq!(
            fs::read_dir(out.parent().unwrap()).unwrap().count(),
            1,
            "no temp file left"
        );

        let decoder = png::Decoder::new(std::io::BufReader::new(fs::File::open(&out).unwrap()));
        let mut reader = decoder.read_info().unwrap();
        let mut decoded = vec![0u8; (W * H * 4) as usize];
        let info = reader.next_frame(&mut decoded).unwrap();
        assert_eq!(
            (info.width, info.height, info.color_type),
            (W, H, png::ColorType::Rgba)
        );
        assert_eq!(decoded, render(&s, W, H).unwrap());

        let key = text_key(&s, W, H);
        assert_eq!(key, text_key(&s.clone(), W, H));
        assert_ne!(key, text_key(&spec("Other"), W, H));
        assert_ne!(key, text_key(&s, W, H + 2));
        assert_ne!(
            key,
            text_key(
                &TextSpec {
                    bold: true,
                    ..s.clone()
                },
                W,
                H
            )
        );
        // an invalid spec writes nothing
        let bad = dir.join("bad.png");
        assert!(write_text_png(&spec(" "), W, H, &bad).is_err());
        assert!(!bad.exists());
        fs::remove_dir_all(&dir).ok();
    }
}
