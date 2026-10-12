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

use super::text_fx::{self, Canvas, Rect};
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
pub const RENDER_VERSION: u32 = 2;
pub const MAX_CHARS: usize = 2000;
pub const MIN_FONT_SIZE: f64 = 8.0;
pub const MAX_FONT_SIZE: f64 = 2000.0;
pub const MIN_SIDE: u32 = 16;
pub const MAX_SIDE: u32 = 8192;
/// Lines wrap at this share of the canvas width, unless the text says otherwise.
pub const WRAP_WIDTH: f64 = 0.9;
pub const MIN_WRAP: f64 = 0.05;
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
    /// Lines wrap at this share of the canvas width. Absent means `WRAP_WIDTH`; subtitles set it to the
    /// width of the picture they belong to, so they stay inside a picture narrower than the canvas.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wrap: Option<f64>,
    /// Draw the text in capitals (the stored text keeps its own case).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub uppercase: bool,
    /// A line of another colour around the letters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outline: Option<TextOutline>,
    /// A shadow behind the letters; with no offset and a bright colour it is a glow.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shadow: Option<TextShadow>,
    /// A filled shape behind the text.
    #[serde(default, rename = "box", skip_serializing_if = "Option::is_none")]
    pub backdrop: Option<TextBox>,
    /// Some lines drawn in another colour.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub highlight: Option<TextHighlight>,
}

/// Sizes in the style parts below are shares of the font size, so a style looks the same at any size.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextOutline {
    pub color: String,
    /// Thickness, 0 (exclusive) to 0.5 of the font size.
    pub width: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextShadow {
    pub color: String,
    /// Softness, 0 (a hard copy) to 1.
    pub blur: f64,
    /// Offset right and down, -1 to 1.
    pub x: f64,
    pub y: f64,
    /// 0 to 1.
    pub opacity: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BoxShape {
    /// One rounded rectangle around the whole text.
    #[serde(rename = "rect")]
    Rect,
    /// Every line gets its own box, as wide as that line, with no gap between lines.
    #[serde(rename = "per-line")]
    PerLine,
    /// A box whose left and right edges are cut into a zigzag.
    #[serde(rename = "jagged")]
    Jagged,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextBox {
    pub color: String,
    /// 0 to 1.
    pub opacity: f64,
    pub shape: BoxShape,
    /// Space between the text and the edge of the box, 0 to 1.
    pub padding: f64,
    /// Corner radius, 0 to 1 (not used by `jagged`).
    pub radius: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HighlightLines {
    /// The last line, when there is more than one.
    Last,
    /// The first line, when there is more than one.
    First,
    /// Every second line.
    Even,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextHighlight {
    pub color: String,
    pub lines: HighlightLines,
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
        if self.wrap.is_some_and(|w| !(MIN_WRAP..=1.0).contains(&w)) {
            return fail("the text width must be between 5% and 100% of the canvas");
        }
        let colours = [
            self.outline.as_ref().map(|o| &o.color),
            self.shadow.as_ref().map(|s| &s.color),
            self.backdrop.as_ref().map(|b| &b.color),
            self.highlight.as_ref().map(|h| &h.color),
        ];
        if colours.iter().flatten().any(|c| parse_color(c).is_none()) {
            return fail("a style colour must be a #RRGGBB colour");
        }
        let unit = |v: f64| (0.0..=1.0).contains(&v);
        if self
            .outline
            .as_ref()
            .is_some_and(|o| !(o.width > 0.0 && o.width <= 0.5))
        {
            return fail("the outline width must be above 0 and at most half the font size");
        }
        if self.shadow.as_ref().is_some_and(|s| {
            !unit(s.blur) || !unit(s.opacity) || !unit(s.x.abs()) || !unit(s.y.abs())
        }) {
            return fail("the shadow values are out of range");
        }
        if self
            .backdrop
            .as_ref()
            .is_some_and(|b| !unit(b.opacity) || !unit(b.padding) || !unit(b.radius))
        {
            return fail("the box values are out of range");
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
    // every property is in the spec's own JSON, so a new one can never be forgotten here
    let described = serde_json::to_string(spec).unwrap_or_default();
    (RENDER_VERSION, width, height, described).hash(&mut h);
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
        uppercase: false,
        outline: None,
        shadow: None,
        backdrop: None,
        highlight: None,
        wrap: None,
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

/// One line of text as it was laid out, in canvas pixels.
struct Line {
    x0: f32,
    x1: f32,
    top: f32,
    bottom: f32,
}

/// Which laid-out lines are drawn in the highlight colour.
fn highlighted(lines: usize, rule: Option<HighlightLines>) -> Vec<bool> {
    (0..lines)
        .map(|i| match rule {
            Some(HighlightLines::Last) => lines > 1 && i == lines - 1,
            Some(HighlightLines::First) => lines > 1 && i == 0,
            Some(HighlightLines::Even) => i % 2 == 1,
            None => false,
        })
        .collect()
}

/// Draw `spec` on a transparent canvas. Returns straight-alpha RGBA, `width * height * 4` bytes.
/// This is the only text rasterizer: the preview shows its picture and the export overlays the same one.
pub fn render(spec: &TextSpec, width: u32, height: u32) -> AppResult<Vec<u8>> {
    spec.validate()?;
    check_canvas(width, height)?;
    let fill = parse_color(&spec.color).expect("validated");
    let accent = spec
        .highlight
        .as_ref()
        .and_then(|h| parse_color(&h.color))
        .unwrap_or(fill);
    let (w, h) = (width as usize, height as usize);

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
    let box_width = (width as f64 * spec.wrap.unwrap_or(WRAP_WIDTH)) as f32;
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
    let content = if spec.uppercase {
        spec.content.to_uppercase()
    } else {
        spec.content.clone()
    };
    buffer.set_text(&content, &attrs, Shaping::Advanced, Some(align));
    buffer.shape_until_scroll(font_system, false);
    let block_height = buffer
        .layout_runs()
        .map(|run| run.line_top + run.line_height)
        .fold(0.0f32, f32::max);
    let left = (spec.x * width as f64 - box_width as f64 / 2.0).round() as i64;
    let top = (spec.y * height as f64 - block_height as f64 / 2.0).round() as i64;

    // where each line sits, for boxes and for per-line colours
    let lines: Vec<Line> = buffer
        .layout_runs()
        .filter(|run| !run.glyphs.is_empty())
        .map(|run| {
            let x0 = run.glyphs.iter().map(|g| g.x).fold(f32::MAX, f32::min);
            let x1 = run
                .glyphs
                .iter()
                .map(|g| g.x + g.w)
                .fold(f32::MIN, f32::max);
            Line {
                x0: left as f32 + x0,
                x1: left as f32 + x1,
                top: top as f32 + run.line_top,
                bottom: top as f32 + run.line_top + run.line_height,
            }
        })
        .collect();
    let in_accent = highlighted(lines.len(), spec.highlight.as_ref().map(|h| h.lines));

    // the letters: one coverage mask for the text colour, one for the highlight colour
    let mut base_mask = vec![0u8; w * h];
    let mut accent_mask = vec![0u8; w * h];
    let white = Color::rgb(0xFF, 0xFF, 0xFF);
    for (index, run) in buffer
        .layout_runs()
        .filter(|run| !run.glyphs.is_empty())
        .enumerate()
    {
        let mask = if in_accent[index] {
            &mut accent_mask
        } else {
            &mut base_mask
        };
        for glyph in run.glyphs {
            let placed = glyph.physical((0.0, run.line_y), 1.0);
            cache.with_pixels(font_system, placed.cache_key, white, |x, y, color| {
                let alpha = color.a() as u32;
                let (px, py) = (
                    left + placed.x as i64 + x as i64,
                    top + placed.y as i64 + y as i64,
                );
                if alpha == 0 || px < 0 || py < 0 || px >= w as i64 || py >= h as i64 {
                    return;
                }
                let slot = &mut mask[py as usize * w + px as usize];
                // glyphs may overlap: coverage is blended ("over"), never added past full
                *slot = (alpha + *slot as u32 * (255 - alpha) / 255).min(255) as u8;
            });
        }
    }
    drop(guard);

    let mut pixels = vec![0u8; w * h * 4];
    let styled = spec.outline.is_some() || spec.shadow.is_some() || spec.backdrop.is_some();
    if !styled {
        // plain text: the colour everywhere it is drawn, the coverage as alpha
        for i in 0..w * h {
            let (b, a) = (base_mask[i], accent_mask[i]);
            if b == 0 && a == 0 {
                continue;
            }
            let (color, alpha) = if a > b { (accent, a) } else { (fill, b) };
            pixels[i * 4..i * 4 + 4].copy_from_slice(&[color.0, color.1, color.2, alpha]);
        }
        return Ok(pixels);
    }
    if lines.is_empty() {
        return Ok(pixels);
    }

    // Styled text is built in the part of the canvas it can reach: the lines plus room for every effect.
    let outline_px = spec.outline.as_ref().map_or(0.0, |o| o.width as f32 * size);
    let (blur_px, shift) = spec.shadow.as_ref().map_or((0.0, (0, 0)), |s| {
        (
            s.blur as f32 * size,
            (
                (s.x as f32 * size).round() as i32,
                (s.y as f32 * size).round() as i32,
            ),
        )
    });
    let pad_px = spec
        .backdrop
        .as_ref()
        .map_or(0.0, |b| b.padding as f32 * size);
    let reach = (outline_px
        + blur_px * 3.0
        + pad_px
        + shift.0.abs().max(shift.1.abs()) as f32
        + size * 0.5)
        .ceil() as i64
        + 2;
    let bound = |v: f32, grow: i64, max: usize| ((v as i64 + grow).clamp(0, max as i64)) as usize;
    let block = Rect {
        x0: lines.iter().map(|l| l.x0).fold(f32::MAX, f32::min),
        y0: lines[0].top,
        x1: lines.iter().map(|l| l.x1).fold(f32::MIN, f32::max),
        y1: lines[lines.len() - 1].bottom,
    };
    let (rx0, ry0) = (bound(block.x0, -reach, w), bound(block.y0, -reach, h));
    let (rx1, ry1) = (bound(block.x1, reach, w), bound(block.y1, reach, h));
    let (rw, rh) = (rx1.saturating_sub(rx0), ry1.saturating_sub(ry0));
    if rw == 0 || rh == 0 {
        return Ok(pixels);
    }
    let region = |mask: &[u8]| -> Vec<f32> {
        let mut out = Vec::with_capacity(rw * rh);
        for y in ry0..ry1 {
            out.extend(
                mask[y * w + rx0..y * w + rx1]
                    .iter()
                    .map(|v| *v as f32 / 255.0),
            );
        }
        out
    };
    let (base, accent_cover) = (region(&base_mask), region(&accent_mask));
    let letters: Vec<f32> = base
        .iter()
        .zip(&accent_cover)
        .map(|(a, b)| a.max(*b))
        .collect();
    let local = |r: Rect| Rect {
        x0: r.x0 - rx0 as f32,
        y0: r.y0 - ry0 as f32,
        x1: r.x1 - rx0 as f32,
        y1: r.y1 - ry0 as f32,
    };

    let mut picture = Canvas::new(rw * rh);
    // bottom to top: the box, the shadow, the outline, the letters
    if let Some(b) = &spec.backdrop {
        let mut cover = vec![0.0; rw * rh];
        let radius = b.radius as f32 * size;
        let grown = |r: Rect, x: f32, y: f32| Rect {
            x0: r.x0 - x,
            y0: r.y0 - y,
            x1: r.x1 + x,
            y1: r.y1 + y,
        };
        match b.shape {
            BoxShape::Rect => text_fx::rounded_rect(
                &mut cover,
                rw,
                rh,
                local(grown(block, pad_px, pad_px * 0.5)),
                radius,
            ),
            BoxShape::Jagged => text_fx::jagged_rect(
                &mut cover,
                rw,
                rh,
                local(grown(block, pad_px, pad_px * 0.5)),
                size * 0.16,
            ),
            // one box per line, as wide as the line; lines touch, so there is no gap between the boxes
            BoxShape::PerLine => {
                for (i, line) in lines.iter().enumerate() {
                    let r = Rect {
                        x0: line.x0 - pad_px,
                        x1: line.x1 + pad_px,
                        y0: line.top - if i == 0 { pad_px * 0.5 } else { 0.0 },
                        y1: line.bottom
                            + if i == lines.len() - 1 {
                                pad_px * 0.5
                            } else {
                                0.0
                            },
                    };
                    text_fx::rounded_rect(&mut cover, rw, rh, local(r), radius);
                }
            }
        }
        picture.paint(
            &cover,
            parse_color(&b.color).expect("validated"),
            b.opacity as f32,
        );
    }
    let outlined = spec
        .outline
        .as_ref()
        .map(|_| text_fx::outline(&letters, rw, rh, outline_px));
    if let Some(s) = &spec.shadow {
        let shape = outlined.as_deref().unwrap_or(&letters);
        let mut cover = text_fx::shifted(shape, rw, rh, shift.0, shift.1);
        text_fx::blur(&mut cover, rw, rh, blur_px.round() as usize);
        picture.paint(
            &cover,
            parse_color(&s.color).expect("validated"),
            s.opacity as f32,
        );
    }
    if let (Some(o), Some(cover)) = (&spec.outline, &outlined) {
        picture.paint(cover, parse_color(&o.color).expect("validated"), 1.0);
    }
    picture.paint(&base, fill, 1.0);
    picture.paint(&accent_cover, accent, 1.0);

    for y in 0..rh {
        for x in 0..rw {
            if let Some(rgba) = picture.pixel(y * rw + x) {
                let i = ((ry0 + y) * w + rx0 + x) * 4;
                pixels[i..i + 4].copy_from_slice(&rgba);
            }
        }
    }
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

/// The look of a text without its words, size or place: what a style preset carries.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextStyle {
    pub color: String,
    #[serde(default)]
    pub bold: bool,
    #[serde(default)]
    pub font: Option<String>,
    #[serde(default)]
    pub uppercase: bool,
    #[serde(default)]
    pub outline: Option<TextOutline>,
    #[serde(default)]
    pub shadow: Option<TextShadow>,
    #[serde(default, rename = "box")]
    pub backdrop: Option<TextBox>,
    #[serde(default)]
    pub highlight: Option<TextHighlight>,
}

impl TextStyle {
    /// `base` restyled: its words, size, alignment and place are kept, everything about its look replaced.
    pub fn on(&self, base: &TextSpec) -> TextSpec {
        TextSpec {
            color: self.color.clone(),
            bold: self.bold,
            font: self.font.clone(),
            uppercase: self.uppercase,
            outline: self.outline.clone(),
            shadow: self.shadow.clone(),
            backdrop: self.backdrop.clone(),
            highlight: self.highlight.clone(),
            ..base.clone()
        }
    }
}

/// A ready-made text style from `presets/text-styles.json` (the file the UI reads). The app itself only
/// draws styles the UI sends; this is how the tests check that the bundled file is valid for Rust too.
#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StylePreset {
    pub id: String,
    pub name: String,
    pub style: TextStyle,
    /// Seconds the text fades in and out over, when the style calls for it.
    #[serde(default)]
    pub fade: f64,
}

#[cfg(test)]
pub const STYLE_PRESETS_JSON: &str = include_str!("../../../presets/text-styles.json");
/// The longest fade a preset may ask for.
#[cfg(test)]
pub const MAX_PRESET_FADE: f64 = 5.0;
/// Size of a style's sample picture in the gallery (shown at half this size).
pub const STYLE_PREVIEW_SIZE: (u32, u32) = (480, 200);

fn sample_spec(content: String) -> TextSpec {
    TextSpec {
        content,
        font_size: 46.0,
        color: "#FFFFFF".into(),
        bold: false,
        font: None,
        uppercase: false,
        outline: None,
        shadow: None,
        backdrop: None,
        highlight: None,
        wrap: None,
        align: TextAlign::Center,
        x: 0.5,
        y: 0.5,
    }
}

/// The bundled style presets, checked: unique ids, names, and every style drawable.
#[cfg(test)]
pub fn style_presets() -> AppResult<Vec<StylePreset>> {
    let presets: Vec<StylePreset> = serde_json::from_str(STYLE_PRESETS_JSON)
        .map_err(|e| AppError::InvalidInput(format!("text styles file: {e}")))?;
    let mut seen = HashSet::new();
    for preset in &presets {
        let bad =
            |what: &str| AppError::InvalidInput(format!("text style \"{}\": {what}", preset.id));
        if preset.id.trim().is_empty() || preset.name.trim().is_empty() {
            return Err(bad("needs an id and a name"));
        }
        if !seen.insert(preset.id.as_str()) {
            return Err(bad("its id is used twice"));
        }
        if !(0.0..=MAX_PRESET_FADE).contains(&preset.fade) {
            return Err(bad("its fade must be 0 to 5 seconds"));
        }
        preset
            .style
            .on(&sample_spec("Sample".into()))
            .validate()
            .map_err(|e| bad(&e.to_string()))?;
    }
    Ok(presets)
}

/// The longest label a style preview may carry.
pub const MAX_STYLE_LABEL: usize = 40;

/// The sample picture of a style inside `dir`: its label and a second line drawn in it, made once and
/// reused. Every place that shows a style (gallery, editor, subtitle step) uses this one picture, and it
/// comes from the same rasterizer as the text itself.
pub fn ensure_style_preview(dir: &Path, style: &TextStyle, label: &str) -> AppResult<PathBuf> {
    let label = label.trim();
    if label.is_empty() || label.chars().count() > MAX_STYLE_LABEL {
        return Err(AppError::InvalidInput(
            "the style needs a short name".into(),
        ));
    }
    let (width, height) = STYLE_PREVIEW_SIZE;
    let spec = style.on(&sample_spec(format!("{label}\nlooks like this")));
    let out = dir.join(format!("{}.png", text_key(&spec, width, height)));
    if !out.is_file() {
        write_text_png(&spec, width, height, &out)?;
    }
    Ok(out)
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
        "Anton",
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
        "Anton",
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
            uppercase: false,
            outline: None,
            shadow: None,
            backdrop: None,
            highlight: None,
            wrap: None,
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
        // a narrower width keeps the lines inside it, around the same centre, and takes more lines
        let narrow = TextSpec {
            wrap: Some(0.3),
            ..long.clone()
        };
        let ((nl, nt, nr, nb), _) = ink(&render(&narrow, W, H).unwrap());
        assert!(
            nl >= W * 35 / 100 - 2 && nr <= W * 65 / 100 + 2,
            "inside the narrow box: {nl}..{nr}"
        );
        assert!(nb - nt > b - t, "more lines than at the usual width");
        for bad in [0.0, 0.01, 1.5, f64::NAN] {
            let spec = TextSpec {
                wrap: Some(bad),
                ..long.clone()
            };
            assert!(render(&spec, W, H).is_err(), "width {bad} is refused");
        }
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
            uppercase: false,
            outline: None,
            shadow: None,
            backdrop: None,
            highlight: None,
            wrap: None,
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

    /// (r, g, b, a) of the pixel at (x, y).
    fn px(pixels: &[u8], x: u32, y: u32) -> (u8, u8, u8, u8) {
        let i = ((y * W + x) * 4) as usize;
        (pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3])
    }
    fn shipped_fonts() {
        load_bundled_fonts(&Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/fonts"));
    }
    fn styled(content: &str, change: impl Fn(&mut TextSpec)) -> Vec<u8> {
        let mut s = spec(content);
        s.color = "#FFFFFF".into();
        change(&mut s);
        render(&s, W, H).unwrap()
    }
    /// The first and last painted column of row `y`, if any.
    fn row_extent(pixels: &[u8], y: u32) -> Option<(u32, u32)> {
        let painted: Vec<u32> = (0..W).filter(|x| px(pixels, *x, y).3 > 0).collect();
        Some((*painted.first()?, *painted.last()?))
    }

    #[test]
    fn all_style_presets_are_valid_and_each_draws_its_own_look() {
        shipped_fonts();
        let presets = style_presets().unwrap();
        let ids: Vec<&str> = presets.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids.len(), 21, "eleven first styles and ten more");
        assert_eq!(&ids[..3], ["clean-caption", "two-tone", "outline-pop"]);
        assert_eq!(
            ids.iter().collect::<HashSet<_>>().len(),
            21,
            "every id is its own"
        );
        let names: HashSet<&str> = presets.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names.len(), 21, "and so is every name");
        let installed: Vec<String> = list_fonts().into_iter().map(|f| f.family).collect();
        let dir = std::env::temp_dir().join(format!("cutvii-styles-{}", std::process::id()));
        let mut pictures = Vec::new();
        for preset in &presets {
            let font = preset
                .style
                .font
                .clone()
                .expect("every preset names its font");
            assert!(
                installed.contains(&font),
                "{}: {font} ships with the app",
                preset.id
            );
            let restyled = preset.style.on(&spec("Two short\nlines here"));
            assert_eq!(
                (restyled.font_size, restyled.x, restyled.align),
                (48.0, 0.5, TextAlign::Center)
            );
            let picture = render(&restyled, W, H).unwrap();
            assert!(ink(&picture).1 > 0, "{} draws something", preset.id);
            assert!(
                !pictures.contains(&picture),
                "{} looks like no other",
                preset.id
            );
            pictures.push(picture);
            let preview = ensure_style_preview(&dir, &preset.style, &preset.name).unwrap();
            assert!(preview.is_file());
        }
        assert_eq!(
            fs::read_dir(&dir).unwrap().count(),
            presets.len(),
            "one gallery picture per style"
        );
        assert!(presets.iter().any(|p| p.fade > 0.0), "Lyric Fade fades");
        // a style of the user's own is drawn by the same code; a name is needed for the sample
        let mine = TextStyle {
            color: "#00FF88".into(),
            ..presets[0].style.clone()
        };
        let own = ensure_style_preview(&dir, &mine, "My style").unwrap();
        assert!(own.is_file());
        assert_eq!(
            ensure_style_preview(&dir, &mine, "My style").unwrap(),
            own,
            "made once"
        );
        assert!(ensure_style_preview(&dir, &mine, "  ").is_err());
        assert!(ensure_style_preview(&dir, &mine, &"x".repeat(41)).is_err());
        let wrong = TextStyle {
            color: "green".into(),
            ..mine.clone()
        };
        assert!(
            ensure_style_preview(&dir, &wrong, "Bad").is_err(),
            "an invalid style is refused"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_box_sits_behind_the_text_in_each_of_its_three_shapes() {
        let boxed = |shape: BoxShape| {
            styled("wide line here\nshort", |s| {
                s.backdrop = Some(TextBox {
                    color: "#FF0000".into(),
                    opacity: 1.0,
                    shape,
                    padding: 0.3,
                    radius: 0.1,
                })
            })
        };
        let plain = styled("wide line here\nshort", |_| {});
        let ((l, t, r, b), _) = ink(&plain);
        let (first_line, second_line) = (t + 12, b - 12);

        // rect: one box wider and taller than the text, the same width on every row, red behind white
        let rect = boxed(BoxShape::Rect);
        let ((bl, bt, br, bb), _) = ink(&rect);
        assert!(
            bl < l && br > r && bt < t && bb > b,
            "the box surrounds the text"
        );
        assert_eq!(
            row_extent(&rect, first_line),
            row_extent(&rect, second_line)
        );
        assert_eq!(
            px(&rect, bl + 12, first_line),
            (255, 0, 0, 255),
            "box colour beside the letters"
        );
        assert!(
            rect.chunks_exact(4).any(|p| p == [255, 255, 255, 255]),
            "letters on top"
        );
        assert_eq!(px(&rect, bl, bt).3, 0, "the corner is rounded off");

        // per-line: each line's box is as wide as that line, and the boxes touch
        let lines = boxed(BoxShape::PerLine);
        let (wide, short) = (
            row_extent(&lines, first_line).unwrap(),
            row_extent(&lines, second_line).unwrap(),
        );
        assert!(
            wide.1 - wide.0 > (short.1 - short.0) + 100,
            "{wide:?} vs {short:?}"
        );
        assert!(
            short.0 > wide.0 + 40 && short.1 < wide.1 - 40,
            "centred under it"
        );
        let ((_, pt, _, pb), _) = ink(&lines);
        assert!(
            (pt..=pb).all(|y| row_extent(&lines, y).is_some()),
            "no gap between the lines"
        );
        let middle = (first_line + second_line) / 2;
        assert_eq!(
            px(&lines, W / 2, middle).3,
            255,
            "solid where the two lines meet"
        );

        // jagged: the left edge moves in and out down the box
        let jagged = boxed(BoxShape::Jagged);
        let ((_, jt, _, jb), _) = ink(&jagged);
        let edges: Vec<u32> = (jt + 2..jb - 2)
            .filter_map(|y| row_extent(&jagged, y))
            .map(|e| e.0)
            .collect();
        let (tip, notch) = (edges.iter().min().unwrap(), edges.iter().max().unwrap());
        assert!(
            notch - tip >= 5,
            "a zigzag about a sixth of the font size deep: {tip}..{notch}"
        );
        assert!(edges.windows(2).filter(|p| p[0] != p[1]).count() > 6);
        assert_ne!(rect, jagged);

        // half-transparent box: the tracks below would show through it
        let glass = styled("see through", |s| {
            s.backdrop = Some(TextBox {
                color: "#000000".into(),
                opacity: 0.5,
                shape: BoxShape::Rect,
                padding: 0.3,
                radius: 0.0,
            })
        });
        let ((gl, gt, _, _), _) = ink(&glass);
        assert_eq!(px(&glass, gl + 2, gt + 2), (0, 0, 0, 128));
    }

    #[test]
    fn outline_shadow_glow_highlight_and_capitals_change_the_letters_as_named() {
        let plain = styled("Hi there", |_| {});
        let ((l, t, r, b), plain_ink) = ink(&plain);

        // outline: a ring of the outline colour right around the letters, the letters still on top
        let outlined = styled("Hi there", |s| {
            s.outline = Some(TextOutline {
                color: "#0000FF".into(),
                width: 0.1,
            })
        });
        let ((ol, ot, or, ob), _) = ink(&outlined);
        assert!(
            ol + 3 <= l && or >= r + 3 && ot + 3 <= t && ob >= b + 3,
            "about 5px wider all round"
        );
        assert!(ol + 7 >= l, "and no more");
        assert!(outlined.chunks_exact(4).any(|p| p == [0, 0, 255, 255]));
        assert!(outlined.chunks_exact(4).any(|p| p == [255, 255, 255, 255]));

        // shadow: a soft dark copy, moved down and to the right
        let shadowed = styled("Hi there", |s| {
            s.shadow = Some(TextShadow {
                color: "#000000".into(),
                blur: 0.1,
                x: 0.2,
                y: 0.2,
                opacity: 0.8,
            })
        });
        let ((sl, st, sr, sb), _) = ink(&shadowed);
        assert!(
            sr > r + 8 && sb > b + 8,
            "it reaches past the letters on the shadow side"
        );
        assert!(sl + 4 >= l && st + 4 >= t, "and not on the other");
        let dark: Vec<_> = shadowed
            .chunks_exact(4)
            .filter(|p| p[3] > 0 && p[..3] == [0, 0, 0])
            .collect();
        assert!(
            dark.iter().any(|p| p[3] < 100) && dark.iter().all(|p| p[3] <= 205),
            "soft, never solid"
        );

        // glow: no offset, so it spreads evenly on every side
        let glow = styled("Hi there", |s| {
            s.shadow = Some(TextShadow {
                color: "#FF00FF".into(),
                blur: 0.2,
                x: 0.0,
                y: 0.0,
                opacity: 1.0,
            })
        });
        let ((gl, gt, gr, gb), _) = ink(&glow);
        assert!(l - gl > 10 && gr - r > 10 && t - gt > 10 && gb - b > 10);
        assert!((l - gl).abs_diff(gr - r) <= 3, "the same on both sides");

        // highlight: the last of several lines in another colour; a single line is left alone
        let accent = Some(TextHighlight {
            color: "#FFD233".into(),
            lines: HighlightLines::Last,
        });
        let two = styled("first line\nsecond", |s| s.highlight = accent.clone());
        let ((_, tt, _, tb), _) = ink(&two);
        let colours = |from: u32, to: u32| -> Vec<[u8; 3]> {
            let mut seen = Vec::new();
            for y in from..to {
                for x in 0..W {
                    let p = px(&two, x, y);
                    if p.3 == 255 && !seen.contains(&[p.0, p.1, p.2]) {
                        seen.push([p.0, p.1, p.2]);
                    }
                }
            }
            seen
        };
        assert_eq!(
            colours(tt, tt + 20),
            vec![[255, 255, 255]],
            "first line in the text colour"
        );
        assert_eq!(
            colours(tb - 20, tb),
            vec![[0xFF, 0xD2, 0x33]],
            "last line in the highlight colour"
        );
        assert_eq!(
            styled("only one", |s| s.highlight = accent.clone()),
            styled("only one", |_| {})
        );
        assert_eq!(
            highlighted(4, Some(HighlightLines::Even)),
            [false, true, false, true]
        );
        assert_eq!(
            highlighted(3, Some(HighlightLines::First)),
            [true, false, false]
        );

        // capitals: drawn as if typed in capitals, the stored words untouched
        assert_eq!(
            styled("Hi there", |s| s.uppercase = true),
            styled("HI THERE", |_| {})
        );
        assert!(ink(&styled("Hi there", |s| s.uppercase = true)).1 > plain_ink);
    }

    #[test]
    fn style_values_are_checked_and_every_one_gets_its_own_cache_name() {
        let ok = spec("Title");
        let with = |change: &dyn Fn(&mut TextSpec)| {
            let mut s = ok.clone();
            change(&mut s);
            s
        };
        let outline = |width: f64| {
            Some(TextOutline {
                color: "#000000".into(),
                width,
            })
        };
        let shadow = |blur: f64, x: f64, opacity: f64| {
            Some(TextShadow {
                color: "#000000".into(),
                blur,
                x,
                y: 0.0,
                opacity,
            })
        };
        let backdrop = |padding: f64, color: &str| {
            Some(TextBox {
                color: color.into(),
                opacity: 1.0,
                shape: BoxShape::Rect,
                padding,
                radius: 0.0,
            })
        };
        for bad in [
            with(&|s| s.outline = outline(0.0)),
            with(&|s| s.outline = outline(0.6)),
            with(&|s| s.shadow = shadow(1.5, 0.0, 1.0)),
            with(&|s| s.shadow = shadow(0.1, -2.0, 1.0)),
            with(&|s| s.shadow = shadow(0.1, 0.0, f64::NAN)),
            with(&|s| s.backdrop = backdrop(2.0, "#000000")),
            with(&|s| s.backdrop = backdrop(0.2, "black")),
            with(&|s| {
                s.highlight = Some(TextHighlight {
                    color: "#12".into(),
                    lines: HighlightLines::Last,
                })
            }),
        ] {
            assert!(bad.validate().is_err(), "{bad:?}");
        }
        let variants = [
            ok.clone(),
            with(&|s| s.uppercase = true),
            with(&|s| s.outline = outline(0.1)),
            with(&|s| s.outline = outline(0.2)),
            with(&|s| s.shadow = shadow(0.1, 0.0, 1.0)),
            with(&|s| s.backdrop = backdrop(0.2, "#000000")),
            with(&|s| {
                s.highlight = Some(TextHighlight {
                    color: "#FFD233".into(),
                    lines: HighlightLines::Even,
                })
            }),
        ];
        let keys: HashSet<String> = variants.iter().map(|s| text_key(s, W, H)).collect();
        assert_eq!(keys.len(), variants.len());
        // a plain text is written exactly as before these were added, and styles round-trip as JSON
        let json = serde_json::to_value(&ok).unwrap();
        assert!(
            json.get("box").is_none()
                && json.get("uppercase").is_none()
                && json.get("outline").is_none()
        );
        let full = with(&|s| {
            s.backdrop = backdrop(0.2, "#FFE14A");
            s.outline = outline(0.1);
        });
        let text = serde_json::to_string(&full).unwrap();
        assert!(
            text.contains("\"box\":{") && text.contains("\"shape\":\"rect\""),
            "{text}"
        );
        assert_eq!(serde_json::from_str::<TextSpec>(&text).unwrap(), full);
        assert!(serde_json::from_str::<TextSpec>(&text.replace("\"rect\"", "\"star\"")).is_err());
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
