use std::fs;
use std::path::{Path, PathBuf};

use super::MediaType;
use super::probe::{
    apply_rotation, classify_extension, parse_frame_rotation, parse_probe_json,
    parse_stream_summary,
};
use super::tools::{FFMPEG_ENV, FFPROBE_ENV, command, locate_tool};
use super::{MediaBackend, MediaInfo, RenderRequest};
use crate::errors::{AppError, AppResult};
use crate::export::ExportReport;
use crate::export::encoder::choose_encoder;
use crate::export::render::{self, RenderJob};
use std::sync::atomic::AtomicBool;

pub const THUMBNAIL_WIDTH: u32 = 320;

/// Desktop backend: shells out to FFmpeg/FFprobe with argument vectors (never a shell string).
pub struct FfmpegBackend {
    ffmpeg: PathBuf,
    ffprobe: PathBuf,
}

impl FfmpegBackend {
    pub fn locate() -> AppResult<Self> {
        Ok(Self {
            ffmpeg: locate_tool("ffmpeg", FFMPEG_ENV)?,
            ffprobe: locate_tool("ffprobe", FFPROBE_ENV)?,
        })
    }
}

fn first_line(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .lines()
        .next()
        .unwrap_or("unknown error")
        .trim()
        .to_string()
}

fn require_file(path: &Path) -> AppResult<()> {
    if path.is_file() {
        Ok(())
    } else {
        Err(AppError::InvalidInput(format!(
            "{} is not a file",
            path.display()
        )))
    }
}

impl MediaBackend for FfmpegBackend {
    fn probe(&self, path: &Path) -> AppResult<MediaInfo> {
        let media_type = classify_extension(path)
            .ok_or_else(|| AppError::InvalidInput("unsupported file type".into()))?;
        require_file(path)?;

        let out = command(&self.ffprobe)
            .args([
                "-v",
                "error",
                "-print_format",
                "json",
                "-show_format",
                "-show_streams",
                "-i",
            ])
            .arg(path)
            .output()?;
        if !out.status.success() {
            return Err(AppError::InvalidInput(format!(
                "ffprobe could not read file: {}",
                first_line(&out.stderr)
            )));
        }
        let mut info = parse_probe_json(&String::from_utf8_lossy(&out.stdout), media_type)?;

        // Stills: EXIF orientation is only visible on the decoded frame. Not fatal if this second look fails.
        if media_type == MediaType::Image {
            let frames = command(&self.ffprobe)
                .args([
                    "-v",
                    "error",
                    "-select_streams",
                    "v:0",
                    "-read_intervals",
                    "%+#1",
                    "-show_frames",
                ])
                .args([
                    "-show_entries",
                    "frame=side_data_list",
                    "-print_format",
                    "json",
                    "-i",
                ])
                .arg(path)
                .output();
            if let Some(deg) = frames
                .ok()
                .and_then(|o| parse_frame_rotation(&String::from_utf8_lossy(&o.stdout)))
            {
                apply_rotation(&mut info, deg);
            }
        }
        Ok(info)
    }

    fn thumbnail(&self, path: &Path, at_seconds: f64, out: &Path) -> AppResult<()> {
        require_file(path)?;
        // Render to a temp file and rename, so a failed run never leaves a corrupt cache entry.
        let tmp = out.with_extension("tmp");
        let result = command(&self.ffmpeg)
            .args(["-y", "-v", "error", "-ss"])
            .arg(format!("{:.3}", at_seconds.max(0.0)))
            .arg("-i")
            .arg(path)
            .args(["-frames:v", "1", "-vf"])
            .arg(format!("scale={THUMBNAIL_WIDTH}:-2"))
            .args(["-q:v", "4", "-f", "image2"])
            .arg(&tmp)
            .output()?;
        if !result.status.success() || !tmp.is_file() {
            fs::remove_file(&tmp).ok();
            return Err(AppError::InvalidInput(format!(
                "thumbnail failed: {}",
                first_line(&result.stderr)
            )));
        }
        fs::rename(&tmp, out)?;
        Ok(())
    }

    fn has_audio(&self, path: &Path) -> AppResult<bool> {
        require_file(path)?;
        let out = command(&self.ffprobe)
            .args([
                "-v",
                "error",
                "-print_format",
                "json",
                "-show_streams",
                "-i",
            ])
            .arg(path)
            .output()?;
        if !out.status.success() {
            return Err(AppError::InvalidInput(format!(
                "ffprobe could not read file: {}",
                first_line(&out.stderr)
            )));
        }
        Ok(parse_stream_summary(&String::from_utf8_lossy(&out.stdout))?.has_audio)
    }

    fn render(
        &self,
        request: &RenderRequest,
        progress: &mut dyn FnMut(f64),
        cancel: &AtomicBool,
    ) -> AppResult<ExportReport> {
        let encoder = if request.plan.format.is_audio() {
            None
        } else {
            let listing = command(&self.ffmpeg)
                .args(["-hide_banner", "-v", "error", "-encoders"])
                .output()?;
            Some(choose_encoder(&String::from_utf8_lossy(&listing.stdout)).ok_or_else(|| {
                AppError::ToolMissing("this FFmpeg has no H.264 encoder (need libx264, libopenh264 or VideoToolbox)".into())
            })?)
        };
        render::run(
            &RenderJob {
                ffmpeg: &self.ffmpeg,
                ffprobe: &self.ffprobe,
                plan: &request.plan,
                encoder,
                output: &request.output,
            },
            progress,
            cancel,
        )
    }
}
