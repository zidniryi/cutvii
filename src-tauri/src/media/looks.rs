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

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

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
