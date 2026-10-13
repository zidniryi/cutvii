//! Colour adjustment. Every setting of a clip is baked into ONE 3D lookup table by this file, and that
//! table is the only thing that touches the colours: the preview applies it in a WebGL shader, the export
//! with FFmpeg's `lut3d`. One table, one path, so the two agree (see section 6p for the measurements).
//!
//! The table is a cube of `LUT_SIZE` points per side. Two files are written for a setting: a `.cube` for
//! FFmpeg and a small binary for the webview (`CVLT`, version u32, size u32, then `size^3` RGB triples as
//! f32, little-endian, red changing fastest: the `.cube` order).

use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::cube::Cube;
use crate::errors::{AppError, AppResult};

/// An imported table (`.cube`, see `cube.rs`) laid over the Adjust values: the colour goes through Adjust
/// first, then through the table, and `intensity` (0 to 1) says how much of the table's result is taken.
#[derive(Debug, Clone, Copy)]
pub struct Overlay<'a> {
    /// The table's id: part of the cache name.
    pub id: &'a str,
    pub cube: &'a Cube,
    pub intensity: f64,
}

/// Points per side of the table. 33 is the common size for looks and what the 6p spike measured.
pub const LUT_SIZE: usize = 33;
/// Bump when the maths below changes, so cached tables are made again.
pub const LUT_VERSION: u32 = 1;
pub const LUT_MAGIC: &[u8; 4] = b"CVLT";

/// The Adjust sliders. Each runs from -1 to 1 and 0 leaves the picture alone.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ColorAdjust {
    /// Brightness in light itself: 1 is two stops brighter, -1 two stops darker.
    pub exposure: f64,
    pub contrast: f64,
    pub saturation: f64,
    /// Saturation that works mostly on the muted colours.
    pub vibrance: f64,
    /// Negative is cooler (blue), positive warmer (orange).
    pub temperature: f64,
    /// Negative is greener, positive more magenta.
    pub tint: f64,
    pub highlights: f64,
    pub shadows: f64,
}

/// Stops of exposure at the end of the slider.
const EXPOSURE_STOPS: f64 = 2.0;

impl ColorAdjust {
    fn values(&self) -> [f64; 8] {
        [
            self.exposure,
            self.contrast,
            self.saturation,
            self.vibrance,
            self.temperature,
            self.tint,
            self.highlights,
            self.shadows,
        ]
    }
    pub fn is_identity(&self) -> bool {
        self.values().iter().all(|v| *v == 0.0)
    }
    pub fn is_valid(&self) -> bool {
        self.values().iter().all(|v| (-1.0..=1.0).contains(v))
    }
}

fn to_linear(v: f64) -> f64 {
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

fn to_encoded(v: f64) -> f64 {
    let v = v.max(0.0);
    if v <= 0.003_130_8 {
        v * 12.92
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    }
}

fn luma(c: [f64; 3]) -> f64 {
    0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

/// The adjusted colour for one encoded (display) RGB colour, each channel 0..=1. SDR / Rec.709 only.
pub fn apply(a: &ColorAdjust, rgb: [f64; 3]) -> [f64; 3] {
    // white balance and exposure work on light, so they behave like a camera's
    let mut gains = [
        1.0 + 0.25 * a.temperature,
        1.0 - 0.20 * a.tint,
        1.0 - 0.25 * a.temperature,
    ];
    let balance = luma(gains);
    for g in &mut gains {
        *g /= balance; // a white balance change keeps the overall brightness
    }
    let exposure = 2f64.powf(a.exposure * EXPOSURE_STOPS);
    let mut c = [0.0; 3];
    for i in 0..3 {
        c[i] = to_encoded(to_linear(rgb[i]) * gains[i] * exposure);
    }
    // shadows lift or lower the dark tones (but keep black black), highlights the bright ones
    let y = luma(c).clamp(0.0, 1.0);
    let lift =
        a.shadows * 0.25 * (1.0 - y).powi(2) * (4.0 * y).min(1.0) + a.highlights * 0.25 * y.powi(2);
    for v in &mut c {
        *v += lift;
    }
    // contrast turns around middle grey
    for v in &mut c {
        *v = (*v - 0.5) * (1.0 + a.contrast) + 0.5;
    }
    // saturation moves every colour away from (or towards) its own grey; vibrance mostly the muted ones
    let grey = luma(c);
    for v in &mut c {
        *v = grey + (*v - grey) * (1.0 + a.saturation);
    }
    let grey = luma(c);
    let strongest = c[0].max(c[1]).max(c[2]).clamp(0.0, 1.0);
    let weakest = c[0].min(c[1]).min(c[2]).clamp(0.0, 1.0);
    let boost = 1.0 + a.vibrance * (1.0 - (strongest - weakest));
    for v in &mut c {
        *v = (grey + (*v - grey) * boost).clamp(0.0, 1.0);
    }
    c
}

/// The whole table for `a`: `size^3` colours, red changing fastest, then green, then blue.
#[cfg(test)]
pub fn bake(a: &ColorAdjust, size: usize) -> Vec<[f32; 3]> {
    bake_with(a, None, size)
}

/// The whole table for `a` with an imported table on top (see [`Overlay`]). Without one, or at intensity
/// 0, this is exactly [`bake`].
pub fn bake_with(a: &ColorAdjust, overlay: Option<&Overlay>, size: usize) -> Vec<[f32; 3]> {
    let overlay = overlay.filter(|o| o.intensity > 0.0);
    let last = (size - 1) as f64;
    let mut table = Vec::with_capacity(size * size * size);
    for b in 0..size {
        for g in 0..size {
            for r in 0..size {
                let mut c = apply(a, [r as f64 / last, g as f64 / last, b as f64 / last]);
                if let Some(o) = overlay {
                    let looked = o.cube.sample(c);
                    let t = o.intensity.min(1.0);
                    for k in 0..3 {
                        c[k] = (c[k] + (looked[k] - c[k]) * t).clamp(0.0, 1.0);
                    }
                }
                table.push([c[0] as f32, c[1] as f32, c[2] as f32]);
            }
        }
    }
    table
}

/// Look `rgb` (8-bit) up in `table` exactly as FFmpeg's `lut3d` does by default: tetrahedral interpolation
/// in single precision, and the fraction cut off (not rounded) when going back to 8 bits. The preview
/// shader follows the same steps; this is the reference both are held to.
#[cfg(test)]
pub fn lookup(table: &[[f32; 3]], size: usize, rgb: [u8; 3]) -> [u8; 3] {
    let scale = (size - 1) as f32;
    let p = [
        rgb[0] as f32 / 255.0 * scale,
        rgb[1] as f32 / 255.0 * scale,
        rgb[2] as f32 / 255.0 * scale,
    ];
    let cell = |v: f32| (v.floor() as usize).min(size - 2);
    let i = [cell(p[0]), cell(p[1]), cell(p[2])];
    let (r, g, b) = (p[0] - i[0] as f32, p[1] - i[1] as f32, p[2] - i[2] as f32);
    let at = |dr: usize, dg: usize, db: usize| {
        table[((i[2] + db) * size + (i[1] + dg)) * size + (i[0] + dr)]
    };
    let (w, a1, a2) = if r > g {
        if g > b {
            ([1.0 - r, r - g, g - b, b], at(1, 0, 0), at(1, 1, 0))
        } else if r > b {
            ([1.0 - r, r - b, b - g, g], at(1, 0, 0), at(1, 0, 1))
        } else {
            ([1.0 - b, b - r, r - g, g], at(0, 0, 1), at(1, 0, 1))
        }
    } else if b > g {
        ([1.0 - b, b - g, g - r, r], at(0, 0, 1), at(0, 1, 1))
    } else if b > r {
        ([1.0 - g, g - b, b - r, r], at(0, 1, 0), at(0, 1, 1))
    } else {
        ([1.0 - g, g - r, r - b, b], at(0, 1, 0), at(1, 1, 0))
    };
    let (c000, c111) = (at(0, 0, 0), at(1, 1, 1));
    let mut out = [0u8; 3];
    for k in 0..3 {
        let v = w[0] * c000[k] + w[1] * a1[k] + w[2] * a2[k] + w[3] * c111[k];
        out[k] = (v.clamp(0.0, 1.0) * 255.0) as u8;
    }
    out
}

/// Cache name of the table for `a`: changes with any value, the size or the maths.
pub fn lut_key(a: &ColorAdjust) -> String {
    let mut h = DefaultHasher::new();
    (LUT_VERSION, LUT_SIZE, a.values().map(f64::to_bits)).hash(&mut h);
    format!("{:016x}", h.finish())
}

/// Cache name of the table for `a` with an imported table on top. Without one it is [`lut_key`].
pub fn graded_key(a: &ColorAdjust, overlay: Option<&Overlay>) -> String {
    match overlay.filter(|o| o.intensity > 0.0) {
        None => lut_key(a),
        Some(o) => {
            let mut h = DefaultHasher::new();
            (lut_key(a), o.id, o.intensity.min(1.0).to_bits()).hash(&mut h);
            format!("{:016x}", h.finish())
        }
    }
}

/// The two files of a baked table.
#[derive(Debug, Clone, PartialEq)]
pub struct LutFiles {
    /// For FFmpeg `lut3d`.
    pub cube: PathBuf,
    /// For the preview shader.
    pub binary: PathBuf,
}

fn write_atomic(out: &Path, bytes: &[u8]) -> AppResult<()> {
    let tmp = out.with_extension(format!("part-{}", std::process::id()));
    if let Err(e) = fs::write(&tmp, bytes) {
        fs::remove_file(&tmp).ok();
        return Err(e.into());
    }
    fs::rename(&tmp, out)?;
    Ok(())
}

/// The table files for `a` inside `dir`, made now unless they already exist. The names are ours (a hash),
/// never taken from user input, so they are safe to hand to FFmpeg.
pub fn ensure_lut(dir: &Path, a: &ColorAdjust) -> AppResult<LutFiles> {
    ensure_graded_lut(dir, a, None)
}

/// [`ensure_lut`] with an imported table on top. The imported file itself never reaches FFmpeg: only the
/// table baked here does, under our own name.
pub fn ensure_graded_lut(
    dir: &Path,
    a: &ColorAdjust,
    overlay: Option<&Overlay>,
) -> AppResult<LutFiles> {
    if overlay.is_some_and(|o| !(0.0..=1.0).contains(&o.intensity)) {
        return Err(AppError::InvalidInput(
            "LUT intensity must be between 0 and 1".into(),
        ));
    }
    if !a.is_valid() {
        return Err(AppError::InvalidInput(
            "colour values must be between -1 and 1".into(),
        ));
    }
    let key = graded_key(a, overlay);
    let files = LutFiles {
        cube: dir.join(format!("{key}.cube")),
        binary: dir.join(format!("{key}.cvlut")),
    };
    if files.cube.is_file() && files.binary.is_file() {
        return Ok(files);
    }
    fs::create_dir_all(dir)?;
    let table = bake_with(a, overlay, LUT_SIZE);

    let mut cube = Vec::with_capacity(table.len() * 28);
    writeln!(cube, "TITLE \"CutVii {key}\"\nLUT_3D_SIZE {LUT_SIZE}")?;
    for c in &table {
        writeln!(cube, "{:.6} {:.6} {:.6}", c[0], c[1], c[2])?;
    }
    write_atomic(&files.cube, &cube)?;

    let mut binary = Vec::with_capacity(12 + table.len() * 12);
    binary.extend_from_slice(LUT_MAGIC);
    binary.extend_from_slice(&LUT_VERSION.to_le_bytes());
    binary.extend_from_slice(&(LUT_SIZE as u32).to_le_bytes());
    for c in &table {
        for v in c {
            binary.extend_from_slice(&v.to_le_bytes());
        }
    }
    write_atomic(&files.binary, &binary)?;
    Ok(files)
}

/// `path` as the value of a filter option inside an FFmpeg filter graph: quoted, with what the two levels
/// of FFmpeg parsing treat specially escaped. Backslashes become slashes (FFmpeg accepts them on Windows).
pub fn filter_path(path: &Path) -> String {
    let text = path
        .to_string_lossy()
        .replace('\\', "/")
        .replace(':', "\\:")
        .replace('\'', "'\\\\\\''");
    format!("'{text}'")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::tools::{FFMPEG_ENV, command, locate_tool};

    fn grade(change: impl Fn(&mut ColorAdjust)) -> ColorAdjust {
        let mut a = ColorAdjust::default();
        change(&mut a);
        a
    }
    const STRONG: ColorAdjust = ColorAdjust {
        exposure: 0.4,
        contrast: 0.6,
        saturation: 0.7,
        vibrance: 0.5,
        temperature: 0.8,
        tint: 0.4,
        highlights: -0.8,
        shadows: 0.8,
    };

    #[test]
    fn nothing_set_changes_nothing() {
        let neutral = ColorAdjust::default();
        assert!(neutral.is_identity() && neutral.is_valid());
        for c in [
            [0.0, 0.0, 0.0],
            [1.0, 1.0, 1.0],
            [0.2, 0.5, 0.9],
            [0.5, 0.5, 0.5],
        ] {
            let out = apply(&neutral, c);
            for k in 0..3 {
                assert!((out[k] - c[k]).abs() < 1e-9, "{c:?} -> {out:?}");
            }
        }
        // and through the table: every 8-bit colour comes back as it went in
        let table = bake(&neutral, LUT_SIZE);
        for rgb in [
            [0, 0, 0],
            [255, 255, 255],
            [51, 128, 230],
            [17, 200, 3],
            [128, 128, 128],
        ] {
            let out = lookup(&table, LUT_SIZE, rgb);
            for k in 0..3 {
                assert!(out[k].abs_diff(rgb[k]) <= 1, "{rgb:?} -> {out:?}");
            }
        }
    }

    #[test]
    fn each_slider_does_what_its_name_says() {
        let mid = [0.5, 0.4, 0.3];
        let y = |c: [f64; 3]| luma(c);
        let spread = |c: [f64; 3]| c[0].max(c[1]).max(c[2]) - c[0].min(c[1]).min(c[2]);
        let with = |change: &dyn Fn(&mut ColorAdjust), c: [f64; 3]| apply(&grade(change), c);

        assert!(y(with(&|a| a.exposure = 0.5, mid)) > y(mid) + 0.1);
        assert!(y(with(&|a| a.exposure = -0.5, mid)) < y(mid) - 0.1);
        // contrast pushes tones away from middle grey, and leaves middle grey where it is
        assert!(with(&|a| a.contrast = 0.5, [0.8, 0.8, 0.8])[0] > 0.8);
        assert!(with(&|a| a.contrast = 0.5, [0.2, 0.2, 0.2])[0] < 0.2);
        assert!((with(&|a| a.contrast = 0.5, [0.5, 0.5, 0.5])[0] - 0.5).abs() < 1e-9);
        // saturation: more colour, none at -1; a grey stays grey
        assert!(spread(with(&|a| a.saturation = 0.5, mid)) > spread(mid));
        assert!(spread(with(&|a| a.saturation = -1.0, mid)) < 1e-9);
        let grey = with(&|a| a.saturation = 1.0, [0.4, 0.4, 0.4]);
        assert!(spread(grey) < 1e-9);
        // vibrance moves a muted colour more than a vivid one
        let gain = |c: [f64; 3]| spread(with(&|a| a.vibrance = 1.0, c)) / spread(c);
        assert!(gain([0.5, 0.45, 0.4]) > gain([0.9, 0.3, 0.1]));
        // temperature: warm is more red than blue, cool the other way; tint: magenta has less green
        let warm = with(&|a| a.temperature = 1.0, [0.5, 0.5, 0.5]);
        assert!(warm[0] > warm[2]);
        let cool = with(&|a| a.temperature = -1.0, [0.5, 0.5, 0.5]);
        assert!(cool[2] > cool[0]);
        let magenta = with(&|a| a.tint = 1.0, [0.5, 0.5, 0.5]);
        assert!(magenta[1] < magenta[0] && magenta[1] < magenta[2]);
        // shadows touch the dark tones far more than the bright ones, highlights the reverse; black stays
        let lift = |change: &dyn Fn(&mut ColorAdjust), v: f64| with(change, [v, v, v])[0] - v;
        assert!(lift(&|a| a.shadows = 1.0, 0.25) > 4.0 * lift(&|a| a.shadows = 1.0, 0.8));
        assert!(lift(&|a| a.highlights = -1.0, 0.9) < 4.0 * lift(&|a| a.highlights = -1.0, 0.25));
        assert!(lift(&|a| a.shadows = 1.0, 0.0).abs() < 1e-9);
        // whatever is asked, the result is a colour
        for c in [[0.0, 0.0, 0.0], [1.0, 1.0, 1.0], [1.0, 0.0, 0.5]] {
            assert!(apply(&STRONG, c).iter().all(|v| (0.0..=1.0).contains(v)));
        }
    }

    #[test]
    fn values_outside_the_sliders_are_refused_and_keys_follow_the_values() {
        assert!(!grade(|a| a.exposure = 1.5).is_valid());
        assert!(!grade(|a| a.tint = f64::NAN).is_valid());
        assert!(!grade(|a| a.contrast = 0.1).is_identity());
        let dir = std::env::temp_dir().join(format!("cutvii-color-bad-{}", std::process::id()));
        assert!(ensure_lut(&dir, &grade(|a| a.shadows = -2.0)).is_err());
        assert!(!dir.exists(), "nothing is written for a refused setting");
        assert_ne!(lut_key(&STRONG), lut_key(&grade(|a| a.contrast = 0.6)));
        assert_eq!(lut_key(&STRONG), lut_key(&STRONG));
        // unknown fields in a project file are an error, like everywhere else
        assert!(serde_json::from_str::<ColorAdjust>(r#"{"exposure":0,"contrast":0,"saturation":0,"vibrance":0,"temperature":0,"tint":0,"highlights":0,"shadows":0,"gamma":1}"#).is_err());
        let sent = serde_json::to_value(STRONG).unwrap();
        assert_eq!(sent["temperature"], 0.8);
    }

    #[test]
    fn an_imported_table_goes_on_top_of_adjust_by_its_intensity() {
        use crate::media::cube::tests::cube_of;
        let warm = grade(|a| a.temperature = 0.4);
        let plain = bake(&warm, LUT_SIZE);
        let same = cube_of(17, |c| c);
        let swapped = cube_of(17, |c| [c[2], c[1], c[0]]);
        let over = |cube, intensity| Overlay {
            id: "0123456789abcdef01234567",
            cube,
            intensity,
        };
        let close = |a: &[[f32; 3]], b: &[[f32; 3]]| {
            a.iter()
                .zip(b)
                .all(|(x, y)| (0..3).all(|k| (x[k] - y[k]).abs() < 1e-5))
        };
        // a table that changes nothing, and any table at intensity 0, leave Adjust as it was
        assert!(close(
            &bake_with(&warm, Some(&over(&same, 1.0)), LUT_SIZE),
            &plain
        ));
        assert_eq!(
            bake_with(&warm, Some(&over(&swapped, 0.0)), LUT_SIZE),
            plain
        );
        assert_eq!(
            graded_key(&warm, Some(&over(&swapped, 0.0))),
            lut_key(&warm)
        );
        // Adjust first, then the table: red and blue of the ADJUSTED colour change places
        let full = bake_with(&warm, Some(&over(&swapped, 1.0)), LUT_SIZE);
        let turned: Vec<[f32; 3]> = plain.iter().map(|c| [c[2], c[1], c[0]]).collect();
        assert!(close(&full, &turned));
        // half way is half way between the two
        let half = bake_with(&warm, Some(&over(&swapped, 0.5)), LUT_SIZE);
        let middle: Vec<[f32; 3]> = plain
            .iter()
            .zip(&turned)
            .map(|(a, b)| {
                [
                    (a[0] + b[0]) / 2.0,
                    (a[1] + b[1]) / 2.0,
                    (a[2] + b[2]) / 2.0,
                ]
            })
            .collect();
        assert!(close(&half, &middle));

        // every setting has its own cache name, and a table that goes out of range is kept inside 0..1
        let keys = [
            lut_key(&warm),
            graded_key(&warm, Some(&over(&swapped, 1.0))),
            graded_key(&warm, Some(&over(&swapped, 0.5))),
            graded_key(&ColorAdjust::default(), Some(&over(&swapped, 1.0))),
        ];
        assert!((0..4).all(|i| (0..i).all(|j| keys[i] != keys[j])));
        let wild = cube_of(5, |c| [c[0] * 4.0 - 1.0, c[1], c[2]]);
        assert!(
            bake_with(&warm, Some(&over(&wild, 1.0)), LUT_SIZE)
                .iter()
                .flatten()
                .all(|v| (0.0..=1.0).contains(v))
        );

        let dir = std::env::temp_dir().join(format!("cutvii-graded-{}", std::process::id()));
        let files = ensure_graded_lut(&dir, &warm, Some(&over(&swapped, 1.0))).unwrap();
        assert!(files.cube.is_file() && files.binary.is_file());
        assert_ne!(files.cube, ensure_lut(&dir, &warm).unwrap().cube);
        assert!(ensure_graded_lut(&dir, &warm, Some(&over(&swapped, 1.5))).is_err());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn filter_paths_survive_spaces_colons_and_quotes() {
        assert_eq!(
            filter_path(Path::new("/tmp/a b/x.cube")),
            "'/tmp/a b/x.cube'"
        );
        assert_eq!(
            filter_path(Path::new("C:\\Users\\Ann\\x.cube")),
            "'C\\:/Users/Ann/x.cube'"
        );
        assert_eq!(
            filter_path(Path::new("/tmp/it's/x.cube")),
            "'/tmp/it'\\\\\\''s/x.cube'"
        );
    }

    /// The table files load in FFmpeg and its pixels equal `lookup` (the reference the preview shader is
    /// written to). Runs against a real FFmpeg; skipped (loudly) when none is installed.
    #[test]
    fn ffmpeg_applies_the_table_exactly_as_the_reference_does() {
        let Ok(ffmpeg) = locate_tool("ffmpeg", FFMPEG_ENV) else {
            eprintln!("SKIPPED: ffmpeg not found");
            return;
        };
        // a folder name with a space and an apostrophe, to prove the escaping on a real run
        let dir = std::env::temp_dir().join(format!("cutvii color's test {}", std::process::id()));
        let files = ensure_lut(&dir, &STRONG).unwrap();
        let again = ensure_lut(&dir, &STRONG).unwrap();
        assert_eq!(files, again);
        assert_eq!(
            fs::read_dir(&dir).unwrap().count(),
            2,
            "one .cube, one binary, no temp files"
        );

        let binary = fs::read(&files.binary).unwrap();
        assert_eq!(&binary[..4], LUT_MAGIC);
        assert_eq!(
            u32::from_le_bytes(binary[8..12].try_into().unwrap()) as usize,
            LUT_SIZE
        );
        assert_eq!(binary.len(), 12 + LUT_SIZE.pow(3) * 12);

        // every colour of a 64x64x4 sweep plus pseudo-random ones
        let (w, h) = (256usize, 128usize);
        let mut frame = Vec::with_capacity(w * h * 3);
        let mut seed = 0x2545_F491u32;
        for i in 0..w * h {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            if i % 2 == 0 {
                frame.extend_from_slice(&[
                    (i % 256) as u8,
                    ((i / 256) * 2) as u8,
                    ((i * 7) % 256) as u8,
                ]);
            } else {
                frame.extend_from_slice(&seed.to_le_bytes()[..3]);
            }
        }
        let src = dir.join("frame.rgb");
        let out = dir.join("out.rgb");
        fs::write(&src, &frame).unwrap();
        let status = command(&ffmpeg)
            .args([
                "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s",
            ])
            .arg(format!("{w}x{h}"))
            .arg("-i")
            .arg(&src)
            .arg("-vf")
            .arg(format!("lut3d=file={}", filter_path(&files.cube)))
            .args(["-f", "rawvideo", "-pix_fmt", "rgb24"])
            .arg(&out)
            .status()
            .unwrap();
        assert!(
            status.success(),
            "ffmpeg read our .cube from an awkward path"
        );
        let got = fs::read(&out).unwrap();
        assert_eq!(got.len(), frame.len());

        let table = bake(&STRONG, LUT_SIZE);
        let (mut worst, mut off) = (0u8, 0usize);
        for (src, got) in frame.chunks_exact(3).zip(got.chunks_exact(3)) {
            let want = lookup(&table, LUT_SIZE, [src[0], src[1], src[2]]);
            for k in 0..3 {
                let d = want[k].abs_diff(got[k]);
                worst = worst.max(d);
                off += usize::from(d > 0);
            }
        }
        assert!(
            worst <= 1,
            "preview reference and export differ by {worst} levels"
        );
        assert!(
            off * 1000 < frame.len(),
            "{off} of {} values differ: more than 0.1 %",
            frame.len()
        );
        fs::remove_dir_all(&dir).ok();
    }
}
