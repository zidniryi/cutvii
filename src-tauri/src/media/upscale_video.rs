//! AI upscale of a stretch of video: every frame goes through the same model as a picture
//! (`media/upscale.rs`), one after the other. FFmpeg decodes the frames and encodes the enlarged ones, with
//! the stretch's own sound; the original file is never changed.
//!
//! It is slow by nature: a frame costs seconds on a processor, so only the part of the source that a clip
//! uses is treated, and both the picture size and the number of frames are limited.

use std::fs;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};

use super::tools::command;
use super::upscale::{SCALE, Upscaler, halve_rgb};
use crate::errors::{AppError, AppResult};

/// The longer side a video may have (4x of 1280x720 is already 5120x2880).
pub const MAX_VIDEO_SIDE: u32 = 1280;
/// Most frames one job may have (100 seconds at 30 fps). Each costs seconds.
pub const MAX_VIDEO_FRAMES: u64 = 3000;

pub struct VideoJob<'a> {
    pub ffmpeg: &'a Path,
    pub src: &'a Path,
    /// Where the stretch starts in the source, and how long it is (seconds).
    pub start: f64,
    pub seconds: f64,
    /// The picture as it is shown (after any rotation the file asks for).
    pub width: u32,
    pub height: u32,
    /// Frame rate as a fraction.
    pub fps: (u32, u32),
    /// 2 or 4.
    pub factor: u32,
    pub out: &'a Path,
}

/// Frames in `seconds` at `fps`, rounded up.
pub fn frame_count(seconds: f64, fps: (u32, u32)) -> u64 {
    (seconds * fps.0 as f64 / fps.1.max(1) as f64)
        .ceil()
        .max(0.0) as u64
}

/// Why a stretch cannot be upscaled, or `None`.
pub fn refusal(job: &VideoJob) -> Option<String> {
    let VideoJob {
        start,
        seconds,
        width,
        height,
        fps,
        factor,
        ..
    } = *job;
    if !(start.is_finite() && seconds.is_finite() && start >= 0.0 && seconds > 0.0) {
        return Some("invalid range".into());
    }
    if factor != 2 && factor != 4 {
        return Some("a video can be enlarged 2 or 4 times".into());
    }
    if width == 0 || height == 0 || fps.0 == 0 || fps.1 == 0 {
        return Some("this file has no picture".into());
    }
    if width.max(height) > MAX_VIDEO_SIDE {
        return Some(format!(
            "the video is {width}x{height}; AI upscale takes video up to {MAX_VIDEO_SIDE} px on the longer side"
        ));
    }
    let frames = frame_count(seconds, fps);
    if frames > MAX_VIDEO_FRAMES {
        return Some(format!(
            "that is {frames} frames; AI upscale takes up to {MAX_VIDEO_FRAMES} at a time (trim or split the clip)"
        ));
    }
    None
}

fn stop(children: &mut [&mut Child], tmp: &Path) {
    for child in children.iter_mut() {
        child.kill().ok();
        child.wait().ok();
    }
    fs::remove_file(tmp).ok();
}

/// Upscale the stretch and write it to `job.out` (H.264 + AAC in an MP4). `progress` gets
/// `(frames done, frames expected)`. Returns the new picture size. `out` appears only when all is done;
/// a cancelled or failed job leaves nothing behind.
pub fn upscale_video(
    job: &VideoJob,
    upscaler: &mut Upscaler,
    progress: &mut dyn FnMut(u64, u64),
    cancel: &AtomicBool,
) -> AppResult<(u32, u32)> {
    if let Some(reason) = refusal(job) {
        return Err(AppError::InvalidInput(reason));
    }
    let (w, h) = (job.width as usize, job.height as usize);
    let times = if job.factor == 4 { SCALE } else { SCALE / 2 };
    let (out_w, out_h) = (w * times, h * times);
    let rate = format!("{}/{}", job.fps.0, job.fps.1);
    let total = frame_count(job.seconds, job.fps);
    if let Some(dir) = job.out.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = job
        .out
        .with_extension(format!("part-{}.mp4", std::process::id()));
    let range = [format!("{:.6}", job.start), format!("{:.6}", job.seconds)];

    // frames out of the source: constant frame rate, the shown orientation, RGB
    let mut decoder = command(job.ffmpeg)
        .args([
            "-v", "error", "-nostdin", "-ss", &range[0], "-t", &range[1], "-i",
        ])
        .arg(job.src)
        .args(["-an", "-vf"])
        .arg(format!("fps={rate},scale={w}:{h}"))
        .args(["-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    // enlarged frames in, plus the same stretch of the source for its sound (if it has any)
    let mut encoder = command(job.ffmpeg)
        .args(["-v", "error", "-nostdin", "-y"])
        .args(["-f", "rawvideo", "-pix_fmt", "rgb24", "-s"])
        .arg(format!("{out_w}x{out_h}"))
        .args(["-r", &rate, "-i", "-"])
        .args(["-ss", &range[0], "-t", &range[1], "-i"])
        .arg(job.src)
        .args(["-map", "0:v:0", "-map", "1:a:0?"])
        .args([
            "-vf",
            "scale=out_color_matrix=bt709",
            "-colorspace",
            "bt709",
        ])
        .args(["-color_primaries", "bt709", "-color_trc", "bt709"])
        .args(["-c:v", "libx264", "-preset", "medium", "-crf", "16"])
        .args(["-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k"])
        .args(["-movflags", "+faststart", "-f", "mp4"])
        .arg(&tmp)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    let (Some(mut frames_in), Some(mut frames_out)) = (decoder.stdout.take(), encoder.stdin.take())
    else {
        stop(&mut [&mut decoder, &mut encoder], &tmp);
        return Err(AppError::InvalidInput("FFmpeg could not be started".into()));
    };

    let mut frame = vec![0u8; w * h * 3];
    let mut done = 0u64;
    let worked = (|| -> AppResult<()> {
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err(AppError::Cancelled);
            }
            match frames_in.read_exact(&mut frame) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(()),
                Err(e) => return Err(e.into()),
            }
            let mut big = upscaler.upscale_rgb(&frame, w, h, &mut |_| {}, cancel)?;
            if job.factor == 2 {
                big = halve_rgb(&big, w * SCALE, h * SCALE).0;
            }
            frames_out.write_all(&big)?;
            done += 1;
            progress(done, total.max(done));
        }
    })();
    drop(frames_out); // end of input: the encoder finishes the file
    if let Err(e) = worked {
        stop(&mut [&mut decoder, &mut encoder], &tmp);
        return Err(e);
    }
    decoder.wait().ok();
    let encoded = encoder.wait().is_ok_and(|s| s.success());
    if !encoded || done == 0 || !fs::metadata(&tmp).is_ok_and(|m| m.len() > 1000) {
        fs::remove_file(&tmp).ok();
        return Err(AppError::InvalidInput(
            "the upscaled video could not be written".into(),
        ));
    }
    fs::rename(&tmp, job.out)?;
    Ok((out_w as u32, out_h as u32))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::MediaBackend;
    use crate::media::ffmpeg::FfmpegBackend;
    use crate::media::tools::{FFMPEG_ENV, locate_tool};
    use crate::media::upscale::onnx_from_pth;
    use std::path::PathBuf;

    /// Our own tiny random network (see `media/upscale.rs`): fast enough to run on every frame of a test.
    const TINY_PTH: &[u8] = include_bytes!("../../fixtures/tiny-compact.pth");

    fn job<'a>(ffmpeg: &'a Path, src: &'a Path, out: &'a Path, factor: u32) -> VideoJob<'a> {
        VideoJob {
            ffmpeg,
            src,
            start: 0.5,
            seconds: 1.0,
            width: 32,
            height: 24,
            fps: (6, 1),
            factor,
            out,
        }
    }

    #[test]
    fn limits_are_checked_before_anything_runs() {
        let (f, s, o) = (
            PathBuf::from("ffmpeg"),
            PathBuf::from("a.mp4"),
            PathBuf::from("o.mp4"),
        );
        let ok = job(&f, &s, &o, 4);
        assert!(refusal(&ok).is_none());
        assert_eq!(frame_count(1.0, (6, 1)), 6);
        assert_eq!(frame_count(10.0, (30000, 1001)), 300);
        let reason = |change: &dyn Fn(&mut VideoJob)| {
            let mut j = job(&f, &s, &o, 4);
            change(&mut j);
            refusal(&j).unwrap_or_default()
        };
        assert!(reason(&|j| j.factor = 3).contains("2 or 4"));
        assert!(reason(&|j| j.width = 1920).contains("1280"));
        assert!(reason(&|j| j.seconds = 600.0).contains("frames"));
        assert!(reason(&|j| j.seconds = 0.0).contains("range"));
        assert!(reason(&|j| j.start = f64::NAN).contains("range"));
        assert!(reason(&|j| j.fps = (0, 1)).contains("no picture"));
    }

    #[test]
    fn a_stretch_of_video_comes_out_enlarged_with_its_sound_and_length() {
        let Ok(ffmpeg) = locate_tool("ffmpeg", FFMPEG_ENV) else {
            eprintln!("skipped: FFmpeg not found");
            return;
        };
        let dir = std::env::temp_dir().join(format!("cutvii-upvideo-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let src = dir.join("small.mp4");
        let made = command(&ffmpeg)
            .args(["-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i"])
            .arg("testsrc=s=32x24:r=6:d=3")
            .args(["-f", "lavfi", "-i", "sine=f=440:d=3"])
            .args([
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-shortest",
            ])
            .arg(&src)
            .status()
            .unwrap();
        assert!(made.success());
        let mut upscaler = Upscaler::new(&onnx_from_pth(TINY_PTH).unwrap()).unwrap();
        let backend = FfmpegBackend::locate().unwrap();

        for (factor, size) in [(4, (128, 96)), (2, (64, 48))] {
            let out = dir.join(format!("big{factor}.mp4"));
            let mut seen = Vec::new();
            let got = upscale_video(
                &job(&ffmpeg, &src, &out, factor),
                &mut upscaler,
                &mut |done, total| seen.push((done, total)),
                &AtomicBool::new(false),
            )
            .unwrap();
            assert_eq!(got, size);
            assert_eq!(seen.first(), Some(&(1, 6)));
            assert_eq!(
                seen.last(),
                Some(&(6, 6)),
                "every frame of the second: {seen:?}"
            );
            let info = backend.probe(&out).unwrap();
            assert_eq!((info.width, info.height), (Some(size.0), Some(size.1)));
            let length = info.duration.unwrap();
            assert!((length - 1.0).abs() < 0.25, "{length}");
            assert!(
                backend.details(&out).unwrap().audio_channels.is_some(),
                "the sound came along"
            );
        }

        // stopped: nothing is left behind
        let out = dir.join("stopped.mp4");
        let stopped = upscale_video(
            &job(&ffmpeg, &src, &out, 4),
            &mut upscaler,
            &mut |_, _| {},
            &AtomicBool::new(true),
        );
        assert!(matches!(stopped, Err(AppError::Cancelled)));
        assert!(!out.exists());
        let left: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains("part-"))
            .collect();
        assert!(left.is_empty(), "{left:?}");
        fs::remove_dir_all(&dir).ok();
    }
}
