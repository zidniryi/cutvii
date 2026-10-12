//! Lowering the singer in a song without a model ("centre cancelling"), for Karaoke Maker.
//!
//! In most stereo recordings the lead voice sits exactly in the middle: the same in the left and the right
//! channel. Subtracting one channel from the other removes whatever is in the middle and keeps what is to
//! the sides. That also removes bass and kick drum (usually in the middle too), so the lows of the original
//! are put back. It is an estimate, not a separation: reverb of the voice and voices placed to a side
//! remain, and a mono recording cannot be treated at all.
//!
//! The cancelling is only switched on while lyrics are sung (the ranges the caller passes), with short
//! ramps, so intros and instrumental parts keep their full sound. The original file is never changed: a new
//! audio file is written.

use std::fs;
use std::path::Path;
use std::process::Stdio;

use super::tools::command;
use crate::errors::{AppError, AppResult};

/// Seconds added before and after every sung range (lyrics times are a little late or early).
pub const RANGE_PAD: f64 = 0.4;
/// Ranges closer together than this are treated as one.
pub const RANGE_JOIN: f64 = 0.8;
/// Seconds over which the cancelling fades in and out.
pub const RAMP: f64 = 0.4;
/// Below this the original's middle is kept (bass, kick drum).
pub const KEEP_LOWS_HZ: u32 = 160;
/// More ranges than this are not worth an expression each: the whole song is treated instead.
pub const MAX_RANGES: usize = 200;

/// Sort, pad, clamp to `[0, length]` and join the ranges. Bad ones (not finite, empty) are dropped.
pub fn merge_ranges(ranges: &[(f64, f64)], length: f64) -> Vec<(f64, f64)> {
    let mut sorted: Vec<(f64, f64)> = ranges
        .iter()
        .filter(|(a, b)| a.is_finite() && b.is_finite() && b > a)
        .map(|(a, b)| ((a - RANGE_PAD).max(0.0), (b + RANGE_PAD).min(length)))
        .filter(|(a, b)| b > a)
        .collect();
    sorted.sort_by(|x, y| x.0.total_cmp(&y.0));
    let mut out: Vec<(f64, f64)> = Vec::new();
    for (a, b) in sorted {
        match out.last_mut() {
            Some(last) if a - last.1 <= RANGE_JOIN => last.1 = last.1.max(b),
            _ => out.push((a, b)),
        }
    }
    out
}

/// How much of the cancelled sound to use at time `t`, as an FFmpeg expression: 0 outside the ranges, 1
/// inside, with a ramp at each end. No ranges (or too many) means "everywhere".
pub fn gate_expression(ranges: &[(f64, f64)]) -> String {
    if ranges.is_empty() || ranges.len() > MAX_RANGES {
        return "1".to_string();
    }
    let terms: Vec<String> = ranges
        .iter()
        .map(|(a, b)| format!("clip((t-{a:.3})/{RAMP},0,1)*clip(({b:.3}-t)/{RAMP},0,1)"))
        .collect();
    format!("min(1,{})", terms.join("+"))
}

/// The filter graph: the original, and the middle-cancelled copy with the original's lows put back, mixed
/// by the gate. Both channels of the cancelled copy carry the same signal, so it also plays on one speaker.
pub fn filter_graph(ranges: &[(f64, f64)]) -> String {
    let gate = gate_expression(ranges);
    format!(
        "[0:a:0]aformat=sample_fmts=fltp:channel_layouts=stereo,asplit=3[o][s][l];\
         [s]pan=stereo|c0=c0-c1|c1=c0-c1,highpass=f={KEEP_LOWS_HZ}[side];\
         [l]pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1,lowpass=f={KEEP_LOWS_HZ}[low];\
         [side][low]amix=inputs=2:normalize=0[c];\
         [o]volume=eval=frame:volume='1-({gate})'[o2];\
         [c]volume=eval=frame:volume='{gate}'[c2];\
         [o2][c2]amix=inputs=2:normalize=0,alimiter=limit=0.97[out]"
    )
}

/// Write `[start, start + seconds)` of the first audio stream of `src` to `out` (AAC in an `.m4a`) with the
/// singer lowered inside `ranges` (seconds from `start`). `out` appears only when the whole file is done.
pub fn reduce_vocals(
    ffmpeg: &Path,
    src: &Path,
    start: f64,
    seconds: f64,
    ranges: &[(f64, f64)],
    out: &Path,
) -> AppResult<()> {
    if !(start.is_finite() && seconds.is_finite() && start >= 0.0 && seconds > 0.0) {
        return Err(AppError::InvalidInput("invalid range".into()));
    }
    if let Some(dir) = out.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = out.with_extension(format!("part-{}.m4a", std::process::id()));
    let status = command(ffmpeg)
        .args(["-v", "error", "-nostdin", "-y", "-ss"])
        .arg(format!("{start:.6}"))
        .arg("-t")
        .arg(format!("{seconds:.6}"))
        .arg("-i")
        .arg(src)
        .arg("-filter_complex")
        .arg(filter_graph(&merge_ranges(ranges, seconds)))
        .args([
            "-map", "[out]", "-vn", "-c:a", "aac", "-b:a", "192k", "-f", "mp4",
        ])
        .arg(&tmp)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let done = matches!(&status, Ok(s) if s.success())
        && fs::metadata(&tmp).map(|m| m.len() > 1000).unwrap_or(false);
    if !done {
        fs::remove_file(&tmp).ok();
        return Err(AppError::InvalidInput(
            "the voice could not be lowered in this file".into(),
        ));
    }
    fs::rename(&tmp, out)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::tools::{FFMPEG_ENV, locate_tool};
    use std::path::PathBuf;

    #[test]
    fn ranges_are_padded_joined_and_kept_inside_the_song() {
        let merged = merge_ranges(
            &[
                (10.0, 12.0),
                (1.0, 2.0),
                (2.5, 3.0),
                (f64::NAN, 4.0),
                (5.0, 5.0),
            ],
            12.1,
        );
        assert_eq!(merged.len(), 2);
        assert!((merged[0].0 - 0.6).abs() < 1e-9 && (merged[0].1 - 3.4).abs() < 1e-9);
        assert!((merged[1].0 - 9.6).abs() < 1e-9 && (merged[1].1 - 12.1).abs() < 1e-9);
        assert!(merge_ranges(&[], 10.0).is_empty());
    }

    #[test]
    fn the_gate_is_everywhere_without_ranges_and_an_expression_with_them() {
        assert_eq!(gate_expression(&[]), "1");
        let many = vec![(0.0, 1.0); MAX_RANGES + 1];
        assert_eq!(gate_expression(&many), "1");
        let e = gate_expression(&[(1.0, 2.0), (5.0, 6.5)]);
        assert!(e.starts_with("min(1,clip((t-1.000)/0.4,0,1)*clip((2.000-t)/0.4,0,1)+"));
        assert!(filter_graph(&[(1.0, 2.0)]).contains("c0=c0-c1|c1=c0-c1"));
    }

    /// Mean level in dB of `file` between `from` and `from + len`, in a narrow band around `hz`.
    fn level(ffmpeg: &Path, file: &Path, from: f64, len: f64, hz: u32) -> f64 {
        let out = command(ffmpeg)
            .args([
                "-v",
                "info",
                "-nostdin",
                "-ss",
                &from.to_string(),
                "-t",
                &len.to_string(),
                "-i",
            ])
            .arg(file)
            .args([
                "-af",
                &format!("bandpass=f={hz}:width_type=h:w=60,volumedetect"),
                "-f",
                "null",
                "-",
            ])
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&out.stderr);
        text.lines()
            .find_map(|l| l.split("mean_volume:").nth(1))
            .and_then(|v| v.trim().trim_end_matches(" dB").parse().ok())
            .unwrap_or_else(|| panic!("no mean_volume in:\n{text}"))
    }

    #[test]
    fn the_middle_is_lowered_only_while_lyrics_are_sung_and_the_sides_and_lows_stay() {
        let Ok(ffmpeg) = locate_tool("ffmpeg", FFMPEG_ENV) else {
            eprintln!("skipped: FFmpeg not found");
            return;
        };
        let dir: PathBuf =
            std::env::temp_dir().join(format!("cutvii-vocals-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        // 8 s of a made-up "song": a 1 kHz "voice" and an 80 Hz "bass" in the middle, a 440 Hz "guitar"
        // on the left and a 660 Hz one on the right.
        let song = dir.join("song.wav");
        let made = command(&ffmpeg)
            .args(["-v", "error", "-y", "-f", "lavfi", "-i"])
            .arg(
                "aevalsrc='0.2*sin(2*PI*1000*t)+0.2*sin(2*PI*80*t)+0.2*sin(2*PI*440*t)|\
                 0.2*sin(2*PI*1000*t)+0.2*sin(2*PI*80*t)+0.2*sin(2*PI*660*t)':s=44100:d=8",
            )
            .arg(&song)
            .status()
            .unwrap();
        assert!(made.success());

        let out = dir.join("instrumental.m4a");
        // lyrics are sung from 4 to 6 s only
        reduce_vocals(&ffmpeg, &song, 0.0, 8.0, &[(4.0, 6.0)], &out).unwrap();
        assert!(out.is_file());
        assert_eq!(
            fs::read_dir(&dir).unwrap().count(),
            2,
            "no temporary file left"
        );

        // the voice: untouched before the lyrics, far lower during them
        let before = level(&ffmpeg, &out, 1.0, 2.0, 1000);
        let during = level(&ffmpeg, &out, 4.5, 1.0, 1000);
        let original = level(&ffmpeg, &song, 1.0, 2.0, 1000);
        assert!(
            (before - original).abs() < 2.0,
            "outside the lyrics: {before} vs {original}"
        );
        assert!(
            during < before - 18.0,
            "voice during lyrics {during} dB, before {before} dB"
        );
        // the instruments on the sides and the bass in the middle are still there during the lyrics
        for hz in [440, 660, 80] {
            let kept = level(&ffmpeg, &out, 4.3, 1.4, hz);
            let was = level(&ffmpeg, &song, 4.3, 1.4, hz);
            assert!(
                kept > was - 9.0,
                "{hz} Hz during lyrics: {kept} dB, was {was} dB"
            );
        }

        // bad input is refused and leaves nothing behind
        assert!(reduce_vocals(&ffmpeg, &song, 0.0, 0.0, &[], &dir.join("x.m4a")).is_err());
        assert!(
            reduce_vocals(
                &ffmpeg,
                &dir.join("missing.wav"),
                0.0,
                5.0,
                &[],
                &dir.join("y.m4a")
            )
            .is_err()
        );
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 2);
        fs::remove_dir_all(&dir).ok();
    }
}
