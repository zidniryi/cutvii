use std::fs;
use std::path::{Path, PathBuf};

use super::MediaType;
use super::color::ensure_lut;
use super::probe::{
    MediaDetails, apply_rotation, classify_extension, parse_details, parse_frame_rotation,
    parse_probe_json, parse_stream_summary,
};
use super::reverse::{ReverseProfile, SourceShape, extract_frame, reverse_range};
use super::tools::{FFMPEG_ENV, FFPROBE_ENV, command, locate_tool};
use super::waveform::read_peaks;
use super::{MediaBackend, MediaInfo, RenderRequest};
use crate::errors::{AppError, AppResult};
use crate::export::ExportFormat;
use crate::export::ExportReport;
use crate::export::encoder::{MP3_ENCODER, choose_encoder, has_encoder};
use crate::export::plan::ExportPlan;
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

impl FfmpegBackend {
    /// Codecs, container, bit rate and size on disk of a file, for the inspector. The file is only read.
    pub fn details(&self, path: &Path) -> AppResult<MediaDetails> {
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
        Ok(MediaDetails {
            size_bytes: fs::metadata(path)?.len(),
            ..parse_details(&String::from_utf8_lossy(&out.stdout))?
        })
    }

    /// Size, frame rate and stream kinds of a file (what the reverse pipeline needs to size its chunks).
    pub fn shape(&self, path: &Path) -> AppResult<SourceShape> {
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
        let s = parse_stream_summary(&String::from_utf8_lossy(&out.stdout))?;
        Ok(SourceShape {
            width: s.width.unwrap_or(0),
            height: s.height.unwrap_or(0),
            fps: s.fps.unwrap_or(30.0),
            has_video: s.has_video,
            has_audio: s.has_audio,
        })
    }

    /// Small reversed copy the webview can play (preview only, never used for export).
    pub fn reverse_preview(
        &self,
        src: &Path,
        source_in: f64,
        source_out: f64,
        out: &Path,
        progress: &mut dyn FnMut(f64),
        cancel: &AtomicBool,
    ) -> AppResult<()> {
        let shape = self.shape(src)?;
        let listing = command(&self.ffmpeg)
            .args(["-hide_banner", "-v", "error", "-encoders"])
            .output()?;
        let encoder =
            choose_encoder(&String::from_utf8_lossy(&listing.stdout)).ok_or_else(|| {
                AppError::ToolMissing(
                    "this FFmpeg has no H.264 encoder for the reverse preview".into(),
                )
            })?;
        reverse_range(
            &self.ffmpeg,
            src,
            &shape,
            source_in,
            source_out,
            out,
            ReverseProfile::Preview(encoder),
            None,
            progress,
            cancel,
        )
    }

    /// A copy of an image at most `max_width` wide (JPEG), for cheap full-canvas previews. Never upscales.
    pub fn scaled_image(&self, src: &Path, max_width: u32, out: &Path) -> AppResult<()> {
        require_file(src)?;
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent)?;
        }
        let tmp = out.with_extension("tmp");
        let result = command(&self.ffmpeg)
            .args(["-y", "-v", "error", "-nostdin", "-i"])
            .arg(src)
            .args(["-frames:v", "1", "-vf"])
            .arg(format!("scale='min({max_width},iw)':-2"))
            .args(["-q:v", "3", "-f", "image2", "-c:v", "mjpeg"])
            .arg(&tmp)
            .output()?;
        if !result.status.success() || !tmp.is_file() {
            fs::remove_file(&tmp).ok();
            return Err(AppError::InvalidInput(format!(
                "image preview failed: {}",
                first_line(&result.stderr)
            )));
        }
        fs::rename(&tmp, out)?;
        Ok(())
    }

    /// The exact frame at `time`, at the file's full resolution, as a PNG.
    pub fn extract_frame(&self, src: &Path, time: f64, out: &Path) -> AppResult<()> {
        require_file(src)?;
        extract_frame(&self.ffmpeg, src, time, out)
    }

    /// Replace every reversed clip with a lossless reversed copy of its used range, written into `work`.
    fn resolve_reversed(
        &self,
        plan: &ExportPlan,
        work: &Path,
        progress: &mut dyn FnMut(f64),
        cancel: &AtomicBool,
    ) -> AppResult<ExportPlan> {
        let mut plan = plan.clone();
        let total = plan.clips.iter().filter(|c| c.reversed).count().max(1);
        for (done, (i, clip)) in plan
            .clips
            .iter_mut()
            .enumerate()
            .filter(|(_, c)| c.reversed)
            .enumerate()
        {
            let out = work.join(format!("reversed-{i}.mkv"));
            let base = done as f64 / total as f64;
            self.reverse_lossless(
                &clip.path,
                clip.source_in,
                clip.source_in + clip.source_duration,
                &out,
                &mut |f| progress(base + f / total as f64),
                cancel,
            )?;
            clip.path = out;
            clip.source_in = 0.0;
            clip.reversed = false;
        }
        Ok(plan)
    }
}

/// Share of the progress bar given to preparing reversed clips before the render itself.
const REVERSE_PROGRESS_SHARE: f64 = 0.4;

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

    fn reverse_lossless(
        &self,
        src: &Path,
        source_in: f64,
        source_out: f64,
        out: &Path,
        progress: &mut dyn FnMut(f64),
        cancel: &AtomicBool,
    ) -> AppResult<()> {
        let shape = self.shape(src)?;
        reverse_range(
            &self.ffmpeg,
            src,
            &shape,
            source_in,
            source_out,
            out,
            ReverseProfile::Lossless,
            None,
            progress,
            cancel,
        )
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

    fn audio_peaks(&self, path: &Path) -> AppResult<Vec<u8>> {
        require_file(path)?;
        read_peaks(&self.ffmpeg, path)
    }

    fn render(
        &self,
        request: &RenderRequest,
        progress: &mut dyn FnMut(f64),
        cancel: &AtomicBool,
    ) -> AppResult<ExportReport> {
        // Colour: bake each graded clip's table now (same code and same files as the preview uses).
        let mut graded = request.plan.clone();
        let luts = std::env::temp_dir().join("cutvii-luts");
        for clip in graded.clips.iter_mut().filter(|c| c.video) {
            if let Some(adjust) = &clip.color {
                clip.lut = Some(ensure_lut(&luts, adjust)?.cube);
            }
        }
        let request = &RenderRequest {
            plan: graded,
            output: request.output.clone(),
        };
        let listing = if request.plan.format == ExportFormat::Mp3 || !request.plan.format.is_audio()
        {
            command(&self.ffmpeg)
                .args(["-hide_banner", "-v", "error", "-encoders"])
                .output()?
                .stdout
        } else {
            Vec::new()
        };
        if request.plan.format == ExportFormat::Mp3
            && !has_encoder(&String::from_utf8_lossy(&listing), MP3_ENCODER)
        {
            return Err(AppError::ToolMissing(
                "this FFmpeg cannot write MP3 (it was built without libmp3lame); choose M4A or WAV instead".into(),
            ));
        }
        let encoder = if request.plan.format.is_audio() {
            None
        } else {
            Some(choose_encoder(&String::from_utf8_lossy(&listing)).ok_or_else(|| {
                AppError::ToolMissing("this FFmpeg has no H.264 encoder (need libx264, libopenh264 or VideoToolbox)".into())
            })?)
        };
        if !request.plan.clips.iter().any(|c| c.reversed) {
            return render::run(
                &RenderJob {
                    ffmpeg: &self.ffmpeg,
                    ffprobe: &self.ffprobe,
                    plan: &request.plan,
                    encoder,
                    output: &request.output,
                },
                progress,
                cancel,
            );
        }

        // Reversed clips: build lossless reversed copies in a temp folder next to the output, render from
        // those, and always remove the folder (success, failure or cancel).
        let stem = request
            .output
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("export");
        let work = request
            .output
            .with_file_name(format!(".{stem}.cutvii-reverse"));
        std::fs::remove_dir_all(&work).ok();
        std::fs::create_dir_all(&work)?;
        let result = self
            .resolve_reversed(
                &request.plan,
                &work,
                &mut |f| progress(f * REVERSE_PROGRESS_SHARE),
                cancel,
            )
            .and_then(|plan| {
                render::run(
                    &RenderJob {
                        ffmpeg: &self.ffmpeg,
                        ffprobe: &self.ffprobe,
                        plan: &plan,
                        encoder,
                        output: &request.output,
                    },
                    &mut |f| progress(REVERSE_PROGRESS_SHARE + f * (1.0 - REVERSE_PROGRESS_SHARE)),
                    cancel,
                )
            });
        std::fs::remove_dir_all(&work).ok();
        result
    }
}
