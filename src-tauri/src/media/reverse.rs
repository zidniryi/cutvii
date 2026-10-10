//! Reversing a range of a media file with bounded memory, and extracting single frames.
//!
//! FFmpeg's `reverse` filter holds every decoded frame of its input in memory, so a long clip cannot be
//! reversed in one go. We reverse short chunks one at a time and join them in reverse order: memory use is
//! bounded by one chunk whatever the clip length.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use super::tools::command;
use crate::errors::{AppError, AppResult};
use crate::export::Quality;
use crate::export::encoder::Encoder;

/// Upper bound for the raw frames one chunk may hold while being reversed.
pub const CHUNK_MEMORY_BUDGET: f64 = 256.0 * 1024.0 * 1024.0;
pub const MIN_CHUNK_SECONDS: f64 = 0.5;
pub const MAX_CHUNK_SECONDS: f64 = 10.0;
/// Audio is tiny compared with video; reverse it in long pieces.
pub const AUDIO_CHUNK_SECONDS: f64 = 60.0;
/// Reversing more than this is slow and needs a lot of temporary disk space: warn the user.
pub const LONG_REVERSE_SECONDS: f64 = 60.0;
const PREVIEW_HEIGHT: u32 = 540;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SourceShape {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub has_video: bool,
    pub has_audio: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReverseProfile {
    /// Full resolution, lossless (FFV1 + PCM in Matroska). Used as the export source.
    Lossless,
    /// Small H.264 + AAC file the webview can play. Used for the preview only.
    Preview(Encoder),
}

/// Chunk length that keeps one chunk's raw frames (4 bytes per pixel, the worst case) inside the budget.
pub fn chunk_seconds(shape: &SourceShape) -> f64 {
    if !shape.has_video || shape.width == 0 || shape.height == 0 {
        return AUDIO_CHUNK_SECONDS;
    }
    let bytes_per_second = shape.width as f64 * shape.height as f64 * 4.0 * shape.fps.max(1.0);
    (CHUNK_MEMORY_BUDGET / bytes_per_second).clamp(MIN_CHUNK_SECONDS, MAX_CHUNK_SECONDS)
}

/// `[start, end)` split into consecutive pieces of at most `chunk` seconds, in forward order.
pub fn chunk_ranges(start: f64, end: f64, chunk: f64) -> Vec<(f64, f64)> {
    let mut out = Vec::new();
    let count = ((end - start) / chunk).ceil().max(1.0) as usize;
    for i in 0..count {
        let a = start + i as f64 * chunk;
        let b = (a + chunk).min(end);
        if b - a > 1e-6 {
            out.push((a, b));
        }
    }
    out
}

fn chunk_args(shape: &SourceShape, profile: ReverseProfile) -> Vec<String> {
    let s = |v: &str| v.to_string();
    let mut a = Vec::new();
    if shape.has_video {
        match profile {
            ReverseProfile::Lossless => {
                a.extend([
                    s("-vf"),
                    s("reverse"),
                    s("-c:v"),
                    s("ffv1"),
                    s("-level"),
                    s("3"),
                ]);
            }
            ReverseProfile::Preview(encoder) => {
                // never upscale; keep even dimensions
                let scale = format!("reverse,scale=-2:'min({PREVIEW_HEIGHT},ih)'");
                let h = shape.height.min(PREVIEW_HEIGHT);
                let w =
                    ((shape.width as f64 * h as f64 / shape.height.max(1) as f64) as u32).max(2);
                a.extend([s("-vf"), scale]);
                a.extend(encoder.video_args(Quality::Draft, w, h, shape.fps));
            }
        }
    } else {
        a.push(s("-vn"));
    }
    if shape.has_audio {
        a.extend([s("-af"), s("areverse")]);
        match profile {
            ReverseProfile::Lossless => a.extend([s("-c:a"), s("pcm_s16le")]),
            ReverseProfile::Preview(_) => a.extend([s("-c:a"), s("aac"), s("-b:a"), s("128k")]),
        }
    } else {
        a.push(s("-an"));
    }
    a
}

fn run_ok(mut cmd: std::process::Command, what: &str) -> AppResult<()> {
    let out = cmd.output()?;
    if out.status.success() {
        return Ok(());
    }
    let msg = String::from_utf8_lossy(&out.stderr)
        .lines()
        .last()
        .unwrap_or("unknown error")
        .trim()
        .to_string();
    Err(AppError::InvalidInput(format!("{what} failed: {msg}")))
}

/// Reverse `[source_in, source_out)` of `src` into `out` (Matroska for lossless, MP4 for preview).
/// Temporary chunks live in a sibling folder that is always removed. `progress` gets 0.0..=1.0.
#[allow(clippy::too_many_arguments)]
pub fn reverse_range(
    ffmpeg: &Path,
    src: &Path,
    shape: &SourceShape,
    source_in: f64,
    source_out: f64,
    out: &Path,
    profile: ReverseProfile,
    chunk_override: Option<f64>,
    progress: &mut dyn FnMut(f64),
    cancel: &AtomicBool,
) -> AppResult<()> {
    if !shape.has_video && !shape.has_audio {
        return Err(AppError::InvalidInput(
            "the file has nothing to reverse".into(),
        ));
    }
    if source_out - source_in <= 1e-6 {
        return Err(AppError::InvalidInput(
            "the range to reverse is empty".into(),
        ));
    }
    let parent = out
        .parent()
        .ok_or_else(|| AppError::InvalidInput("no output folder".into()))?;
    fs::create_dir_all(parent)?;
    let stem = out
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("reverse");
    let work = parent.join(format!(".{stem}.chunks-{}", std::process::id()));
    fs::remove_dir_all(&work).ok();
    fs::create_dir_all(&work)?;

    let result = (|| -> AppResult<()> {
        let ranges = chunk_ranges(
            source_in,
            source_out,
            chunk_override.unwrap_or_else(|| chunk_seconds(shape)),
        );
        let mut files: Vec<PathBuf> = Vec::with_capacity(ranges.len());
        for (i, (a, b)) in ranges.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                return Err(AppError::Cancelled);
            }
            let file = work.join(format!("{i:05}.mkv"));
            let mut cmd = command(ffmpeg);
            cmd.args([
                "-y",
                "-v",
                "error",
                "-nostdin",
                "-ss",
                &format!("{a:.6}"),
                "-t",
                &format!("{:.6}", b - a),
                "-i",
            ])
            .arg(src)
            .args(chunk_args(shape, profile))
            .arg(&file);
            run_ok(cmd, "reversing")?;
            files.push(file);
            progress(0.95 * (i + 1) as f64 / ranges.len() as f64);
        }

        // last chunk first
        let list = work.join("list.txt");
        let lines: String = files
            .iter()
            .rev()
            .map(|f| format!("file '{}'\n", f.to_string_lossy().replace('\'', "'\\''")))
            .collect();
        fs::write(&list, lines)?;

        let tmp = out.with_extension(format!(
            "part.{}",
            out.extension().and_then(|e| e.to_str()).unwrap_or("mkv")
        ));
        let mut cmd = command(ffmpeg);
        cmd.args([
            "-y", "-v", "error", "-nostdin", "-f", "concat", "-safe", "0", "-i",
        ])
        .arg(&list)
        .args(["-c", "copy"]);
        if matches!(profile, ReverseProfile::Preview(_)) {
            cmd.args(["-movflags", "+faststart"]);
        }
        cmd.arg(&tmp);
        if let Err(e) = run_ok(cmd, "joining the reversed pieces") {
            fs::remove_file(&tmp).ok();
            return Err(e);
        }
        fs::rename(&tmp, out)?;
        progress(1.0);
        Ok(())
    })();

    fs::remove_dir_all(&work).ok();
    result
}

/// Write the frame shown at `time` (seconds into the file) as a full-resolution PNG.
pub fn extract_frame(ffmpeg: &Path, src: &Path, time: f64, out: &Path) -> AppResult<()> {
    if let Some(parent) = out.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = out.with_extension("part.png");
    let mut cmd = command(ffmpeg);
    cmd.args([
        "-y",
        "-v",
        "error",
        "-nostdin",
        "-ss",
        &format!("{:.6}", time.max(0.0)),
        "-i",
    ])
    .arg(src)
    .args(["-frames:v", "1", "-an", "-f", "image2", "-c:v", "png"])
    .arg(&tmp);
    let result = run_ok(cmd, "extracting the frame");
    if result.is_err() || !tmp.is_file() {
        fs::remove_file(&tmp).ok();
        return result.and(Err(AppError::InvalidInput(
            "there is no frame at that position".into(),
        )));
    }
    fs::rename(&tmp, out)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shape(w: u32, h: u32, fps: f64) -> SourceShape {
        SourceShape {
            width: w,
            height: h,
            fps,
            has_video: true,
            has_audio: true,
        }
    }

    #[test]
    fn chunk_length_keeps_raw_frames_inside_the_memory_budget() {
        for s in [
            shape(1920, 1080, 30.0),
            shape(3840, 2160, 60.0),
            shape(1280, 720, 24.0),
            shape(7680, 4320, 60.0),
        ] {
            let secs = chunk_seconds(&s);
            assert!((MIN_CHUNK_SECONDS..=MAX_CHUNK_SECONDS).contains(&secs));
            let bytes = s.width as f64 * s.height as f64 * 4.0 * s.fps * secs;
            // inside the budget, unless the minimum chunk length already exceeds it (8K60)
            assert!(
                bytes <= CHUNK_MEMORY_BUDGET * 1.001 || secs == MIN_CHUNK_SECONDS,
                "{s:?}: {bytes}"
            );
        }
        assert_eq!(chunk_seconds(&shape(320, 180, 30.0)), MAX_CHUNK_SECONDS); // small video: capped, not unbounded
        assert!(chunk_seconds(&shape(1920, 1080, 30.0)) < 1.5);
        let audio = SourceShape {
            has_video: false,
            ..shape(0, 0, 0.0)
        };
        assert_eq!(chunk_seconds(&audio), AUDIO_CHUNK_SECONDS);
    }

    #[test]
    fn ranges_cover_the_span_exactly_once_in_order() {
        let r = chunk_ranges(2.0, 9.5, 3.0);
        assert_eq!(r, vec![(2.0, 5.0), (5.0, 8.0), (8.0, 9.5)]);
        assert_eq!(chunk_ranges(0.0, 1.0, 10.0), vec![(0.0, 1.0)]);
        let total: f64 = chunk_ranges(1.25, 61.0, 0.7)
            .iter()
            .map(|(a, b)| b - a)
            .sum();
        assert!((total - 59.75).abs() < 1e-6);
    }

    #[test]
    fn chunk_arguments_follow_the_streams_and_profile() {
        let both = chunk_args(&shape(1920, 1080, 30.0), ReverseProfile::Lossless).join(" ");
        assert_eq!(
            both,
            "-vf reverse -c:v ffv1 -level 3 -af areverse -c:a pcm_s16le"
        );
        let audio_only = SourceShape {
            has_video: false,
            ..shape(0, 0, 0.0)
        };
        assert_eq!(
            chunk_args(&audio_only, ReverseProfile::Lossless).join(" "),
            "-vn -af areverse -c:a pcm_s16le"
        );
        let silent = SourceShape {
            has_audio: false,
            ..shape(640, 360, 30.0)
        };
        let preview = chunk_args(&silent, ReverseProfile::Preview(Encoder::Libx264)).join(" ");
        assert!(
            preview.starts_with("-vf reverse,scale=-2:'min(540,ih)' -c:v libx264")
                && preview.ends_with("-an"),
            "{preview}"
        );
    }
}
