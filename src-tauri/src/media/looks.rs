//! Looks: ready-made colour settings. A look is nothing more than a named set of the Adjust values, so it
//! goes through the same one colour path as the sliders (`color.rs`) and looks the same in preview and
//! export. This file makes the gallery's small pictures: one frame of the clip, shown through each look.

use std::fs;
use std::io::{BufWriter, Read};
use std::path::{Path, PathBuf};
use std::process::Stdio;

use super::color::{ColorAdjust, apply, lut_key};
use super::tools::command;
use crate::errors::{AppError, AppResult};

/// Size of a gallery picture. Small on purpose: every look is computed exactly, pixel by pixel.
pub const THUMB_SIZE: (u32, u32) = (160, 90);
/// Most looks one request may ask for.
pub const MAX_LOOKS: usize = 64;

/// One frame of `src` at `at` seconds as `THUMB_SIZE` RGB bytes (cropped to fill, in the displayed
/// orientation: FFmpeg applies the file's rotation).
pub fn read_frame(ffmpeg: &Path, src: &Path, at: f64) -> AppResult<Vec<u8>> {
    let (w, h) = THUMB_SIZE;
    let mut child = command(ffmpeg)
        .args(["-v", "error", "-nostdin", "-ss"])
        .arg(format!("{:.3}", at.max(0.0)))
        .arg("-i")
        .arg(src)
        .args(["-frames:v", "1", "-an", "-vf"])
        .arg(format!(
            "scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}"
        ))
        .args(["-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let mut bytes = Vec::new();
    let read = child
        .stdout
        .take()
        .map(|mut out| out.read_to_end(&mut bytes));
    let status = child.wait()?;
    read.transpose()?;
    if !status.success() || bytes.len() != (w * h * 3) as usize {
        return Err(AppError::InvalidInput(
            "could not read a frame of that clip".into(),
        ));
    }
    Ok(bytes)
}

/// `frame` (RGB bytes) with the look applied, using the exact maths the lookup table is baked from.
pub fn graded(frame: &[u8], look: &ColorAdjust) -> Vec<u8> {
    if look.is_identity() {
        return frame.to_vec();
    }
    frame
        .chunks_exact(3)
        .flat_map(|p| {
            let out = apply(
                look,
                [
                    p[0] as f64 / 255.0,
                    p[1] as f64 / 255.0,
                    p[2] as f64 / 255.0,
                ],
            );
            out.map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u8)
        })
        .collect()
}

fn write_png(out: &Path, rgb: &[u8]) -> AppResult<()> {
    let tmp = out.with_extension(format!("part-{}", std::process::id()));
    let written = (|| -> AppResult<()> {
        let mut encoder = png::Encoder::new(
            BufWriter::new(fs::File::create(&tmp)?),
            THUMB_SIZE.0,
            THUMB_SIZE.1,
        );
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        let failed = |e: png::EncodingError| AppError::InvalidInput(format!("look picture: {e}"));
        let mut writer = encoder.write_header().map_err(failed)?;
        writer.write_image_data(rgb).map_err(failed)?;
        writer.finish().map_err(failed)
    })();
    if written.is_err() {
        fs::remove_file(&tmp).ok();
        return written;
    }
    fs::rename(&tmp, out)?;
    Ok(())
}

/// The gallery pictures for `looks`, in order, inside `dir`. `frame_key` names the frame (file + time);
/// pictures that already exist are reused, and the frame is only decoded when one is missing.
pub fn ensure_look_previews(
    dir: &Path,
    frame_key: &str,
    looks: &[ColorAdjust],
    frame: &dyn Fn() -> AppResult<Vec<u8>>,
) -> AppResult<Vec<PathBuf>> {
    if looks.len() > MAX_LOOKS {
        return Err(AppError::InvalidInput("too many looks at once".into()));
    }
    if looks.iter().any(|l| !l.is_valid()) {
        return Err(AppError::InvalidInput(
            "colour values must be between -1 and 1".into(),
        ));
    }
    let paths: Vec<PathBuf> = looks
        .iter()
        .map(|l| dir.join(format!("{frame_key}-{}.png", lut_key(l))))
        .collect();
    if paths.iter().all(|p| p.is_file()) {
        return Ok(paths);
    }
    fs::create_dir_all(dir)?;
    let pixels = frame()?;
    for (look, path) in looks.iter().zip(&paths) {
        if !path.is_file() {
            write_png(path, &graded(&pixels, look))?;
        }
    }
    Ok(paths)
}

/// File extension of a colour preset shared between CutVii users.
pub const PRESET_EXTENSION: &str = "cutviipreset";
/// Format number written into a preset file.
pub const PRESET_FORMAT: u32 = 1;
/// Longest preset name.
pub const MAX_PRESET_NAME: usize = 40;

/// A colour preset as a file: a name and the Adjust values, nothing else. Unknown fields are refused when
/// reading, so a file is either exactly this or not a preset.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PresetFile {
    pub cutvii_preset: u32,
    pub name: String,
    pub adjust: ColorAdjust,
}

/// The text of a preset file for `name` and `adjust`, after checking both.
pub fn preset_file_text(name: &str, adjust: &ColorAdjust) -> AppResult<String> {
    let name = name.trim();
    if name.is_empty()
        || name.chars().count() > MAX_PRESET_NAME
        || name.chars().any(char::is_control)
    {
        return Err(AppError::InvalidInput(
            "a preset needs a name of at most 40 characters".into(),
        ));
    }
    if !adjust.is_valid() {
        return Err(AppError::InvalidInput(
            "colour values must be between -1 and 1".into(),
        ));
    }
    serde_json::to_string_pretty(&PresetFile {
        cutvii_preset: PRESET_FORMAT,
        name: name.to_string(),
        adjust: *adjust,
    })
    .map_err(|e| AppError::InvalidInput(format!("preset file: {e}")))
}

/// A preset file larger than this is not read (a real one is a few hundred bytes).
pub const MAX_PRESET_BYTES: u64 = 64 * 1024;

/// Read a `.cutviipreset` file. It is UNTRUSTED input: the size is capped before reading, the text must be
/// exactly a preset (unknown fields are refused), the format number must be ours, and the name and every
/// value are checked. Nothing in the file is a path, and nothing in it is run.
pub fn read_preset(path: &Path) -> AppResult<PresetFile> {
    let bad = |m: &str| AppError::InvalidInput(m.to_string());
    let size = fs::metadata(path)?.len();
    if size > MAX_PRESET_BYTES {
        return Err(bad("the file is too large to be a colour preset"));
    }
    let text = String::from_utf8(fs::read(path)?)
        .map_err(|_| bad("this is not a CutVii colour preset"))?;
    let preset: PresetFile =
        serde_json::from_str(&text).map_err(|_| bad("this is not a CutVii colour preset"))?;
    if preset.cutvii_preset != PRESET_FORMAT {
        return Err(bad("this preset was made by a newer CutVii"));
    }
    // the same checks a preset passes before it is written
    preset_file_text(&preset.name, &preset.adjust)?;
    if preset.adjust.is_identity() {
        return Err(bad("this preset changes nothing"));
    }
    Ok(PresetFile {
        name: preset.name.trim().to_string(),
        ..preset
    })
}

/// Write `text` to `out` through a temporary file, so a failed write never leaves half a preset.
pub fn write_preset(out: &Path, text: &str) -> AppResult<()> {
    let tmp = out.with_extension(format!("part-{}", std::process::id()));
    if let Err(e) = fs::write(&tmp, text) {
        fs::remove_file(&tmp).ok();
        return Err(e.into());
    }
    fs::rename(&tmp, out)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn a_preset_file_holds_the_name_and_values_and_bad_input_is_refused() {
        let adjust = ColorAdjust {
            exposure: 0.25,
            tint: -0.5,
            ..ColorAdjust::default()
        };
        let text = preset_file_text("  My warm look ", &adjust).unwrap();
        let back: PresetFile = serde_json::from_str(&text).unwrap();
        assert_eq!(
            back,
            PresetFile {
                cutvii_preset: PRESET_FORMAT,
                name: "My warm look".into(),
                adjust
            }
        );
        assert!(text.contains("\"cutviiPreset\": 1"));
        assert!(preset_file_text("", &adjust).is_err());
        assert!(preset_file_text(&"x".repeat(41), &adjust).is_err());
        assert!(preset_file_text("line\nbreak", &adjust).is_err());
        let wild = ColorAdjust {
            exposure: 9.0,
            ..adjust
        };
        assert!(preset_file_text("Bad", &wild).is_err());

        let dir = std::env::temp_dir().join(format!("cutvii-preset-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let out = dir.join("look.cutviipreset");
        write_preset(&out, &text).unwrap();
        // what was exported reads back as exactly the same preset
        assert_eq!(read_preset(&out).unwrap(), back);

        // untrusted files: each of these is refused with a message, never a panic
        let refuse = |name: &str, body: &[u8], says: &str| {
            let file = dir.join(name);
            fs::write(&file, body).unwrap();
            let e = read_preset(&file).unwrap_err().to_string();
            assert!(e.contains(says), "{name}: {e}");
            fs::remove_file(&file).unwrap();
        };
        refuse(
            "garbage",
            b"\x00\xff not json",
            "not a CutVii colour preset",
        );
        refuse("json", br#"{"hello": 1}"#, "not a CutVii colour preset");
        refuse(
            "extra",
            text.replace("\"name\"", "\"path\": \"/etc/passwd\", \"name\"")
                .as_bytes(),
            "not a CutVii colour preset",
        );
        refuse(
            "newer",
            text.replace("\"cutviiPreset\": 1", "\"cutviiPreset\": 2")
                .as_bytes(),
            "newer",
        );
        refuse(
            "range",
            text.replace("0.25", "25").as_bytes(),
            "between -1 and 1",
        );
        refuse(
            "nan",
            text.replace("0.25", "NaN").as_bytes(),
            "not a CutVii colour preset",
        );
        refuse(
            "noname",
            text.replace("My warm look", "  ").as_bytes(),
            "needs a name",
        );
        refuse(
            "big",
            &vec![b' '; MAX_PRESET_BYTES as usize + 1],
            "too large",
        );
        let nothing = preset_file_text(
            "Flat",
            &ColorAdjust {
                exposure: 0.1,
                ..ColorAdjust::default()
            },
        )
        .unwrap()
        .replace("0.1", "0.0");
        refuse("identity", nothing.as_bytes(), "changes nothing");
        assert!(read_preset(&dir.join("missing")).is_err());
        assert_eq!(fs::read_to_string(&out).unwrap(), text);
        assert_eq!(
            fs::read_dir(&dir).unwrap().count(),
            1,
            "no temporary file left"
        );
        fs::remove_dir_all(&dir).ok();
    }

    /// The bundled looks file, read the way the UI reads it.
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Look {
        id: String,
        name: String,
        adjust: ColorAdjust,
    }
    const LOOKS_JSON: &str = include_str!("../../../presets/color-looks.json");

    fn grey_frame() -> Vec<u8> {
        let n = (THUMB_SIZE.0 * THUMB_SIZE.1) as usize;
        (0..n)
            .flat_map(|i| [(i % 200) as u8 + 20, 110, 90])
            .collect()
    }

    #[test]
    fn the_bundled_looks_are_valid_distinct_and_each_changes_the_picture() {
        let looks: Vec<Look> = serde_json::from_str(LOOKS_JSON).unwrap();
        assert!(looks.len() >= 8);
        let mut ids: Vec<&str> = looks.iter().map(|l| l.id.as_str()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), looks.len(), "every id is its own");
        let frame = grey_frame();
        let mut pictures = Vec::new();
        for look in &looks {
            assert!(!look.name.trim().is_empty());
            assert!(look.adjust.is_valid(), "{}", look.id);
            assert!(!look.adjust.is_identity(), "{} does something", look.id);
            let picture = graded(&frame, &look.adjust);
            assert_ne!(picture, frame, "{} changes the picture", look.id);
            assert!(
                !pictures.contains(&picture),
                "{} looks like no other",
                look.id
            );
            pictures.push(picture);
        }
    }

    #[test]
    fn a_picture_matches_the_baked_table_the_preview_and_export_use() {
        use crate::media::color::{LUT_SIZE, bake, lookup};
        let look = ColorAdjust {
            exposure: 0.2,
            contrast: 0.3,
            saturation: -0.2,
            temperature: 0.4,
            ..ColorAdjust::default()
        };
        let frame = grey_frame();
        let exact = graded(&frame, &look);
        let table = bake(&look, LUT_SIZE);
        let mut worst = 0i32;
        for (p, e) in frame.chunks_exact(3).zip(exact.chunks_exact(3)) {
            let t = lookup(&table, LUT_SIZE, [p[0], p[1], p[2]]);
            for c in 0..3 {
                worst = worst.max((t[c] as i32 - e[c] as i32).abs());
            }
        }
        // the table interpolates between 33 points per side; the gallery is exact. A few levels apart at most.
        assert!(worst <= 4, "gallery and table differ by {worst} levels");
    }

    #[test]
    fn pictures_are_made_once_and_the_frame_is_not_decoded_again() {
        let dir = std::env::temp_dir().join(format!("cutvii-looks-{}", std::process::id()));
        fs::remove_dir_all(&dir).ok();
        let decoded = Cell::new(0);
        let frame = || {
            decoded.set(decoded.get() + 1);
            Ok(grey_frame())
        };
        let looks = [
            ColorAdjust::default(),
            ColorAdjust {
                exposure: 0.5,
                ..ColorAdjust::default()
            },
        ];
        let first = ensure_look_previews(&dir, "frame", &looks, &frame).unwrap();
        assert_eq!(first.len(), 2);
        assert!(first.iter().all(|p| p.is_file()));
        assert_ne!(fs::read(&first[0]).unwrap(), fs::read(&first[1]).unwrap());
        assert_eq!(
            ensure_look_previews(&dir, "frame", &looks, &frame).unwrap(),
            first
        );
        assert_eq!(decoded.get(), 1, "decoded once");
        // another frame gets its own pictures
        let other = ensure_look_previews(&dir, "other", &looks, &frame).unwrap();
        assert_ne!(other, first);

        let bad = [ColorAdjust {
            exposure: 3.0,
            ..ColorAdjust::default()
        }];
        assert!(ensure_look_previews(&dir, "frame", &bad, &frame).is_err());
        let many = vec![ColorAdjust::default(); MAX_LOOKS + 1];
        assert!(ensure_look_previews(&dir, "frame", &many, &frame).is_err());
        fs::remove_dir_all(&dir).ok();
    }
}
