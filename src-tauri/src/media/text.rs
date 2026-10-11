//! Text and titles: a block of text drawn onto a transparent picture the size of the canvas.
//!
//! The preview shows that picture and the export overlays the very same file, so both always match.
//! Drawing is pure Rust with the bundled Noto Sans (SIL OFL 1.1, see `assets/fonts/OFL.txt`): no system
//! fonts are read, so the same text gives the same pixels on every machine and platform.

use std::collections::hash_map::DefaultHasher;
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

pub const FONT_FAMILY: &str = "Noto Sans";
const FONT_REGULAR: &[u8] = include_bytes!("../../assets/fonts/NotoSans-Regular.ttf");
const FONT_BOLD: &[u8] = include_bytes!("../../assets/fonts/NotoSans-Bold.ttf");

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
        spec.align,
        spec.x.to_bits(),
        spec.y.to_bits(),
    )
        .hash(&mut h);
    format!("{:016x}", h.finish())
}

fn fonts() -> &'static Mutex<(FontSystem, SwashCache)> {
    static FONTS: OnceLock<Mutex<(FontSystem, SwashCache)>> = OnceLock::new();
    FONTS.get_or_init(|| {
        let mut db = fontdb::Database::new();
        db.load_font_data(FONT_REGULAR.to_vec());
        db.load_font_data(FONT_BOLD.to_vec());
        Mutex::new((
            FontSystem::new_with_locale_and_db("en-US".into(), db),
            SwashCache::new(),
        ))
    })
}

/// Draw `spec` on a transparent canvas. Returns straight-alpha RGBA, `width * height * 4` bytes.
pub fn render(spec: &TextSpec, width: u32, height: u32) -> AppResult<Vec<u8>> {
    spec.validate()?;
    check_canvas(width, height)?;
    let (r, g, b) = parse_color(&spec.color).expect("validated");

    let mut guard = fonts().lock().unwrap_or_else(|e| e.into_inner());
    let (font_system, cache) = &mut *guard;
    let size = spec.font_size as f32;
    let box_width = (width as f64 * WRAP_WIDTH) as f32;
    let mut buffer = Buffer::new(font_system, Metrics::new(size, size * LINE_HEIGHT));
    buffer.set_size(Some(box_width), None);
    let attrs = Attrs::new()
        .family(Family::Name(FONT_FAMILY))
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

    fn spec(content: &str) -> TextSpec {
        TextSpec {
            content: content.into(),
            font_size: 48.0,
            color: "#E5733A".into(),
            bold: false,
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
