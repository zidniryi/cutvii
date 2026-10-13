//! AI upscale for pictures (see `media/upscale.rs`). The model is downloaded only after the user agreed in
//! the UI; the picture never leaves this computer and the original file is never changed: the result is a
//! new PNG in the app data folder.

use std::fs;
use std::io::{BufWriter, Read};
use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use super::ai::{AiJob, DOWNLOAD_EVENT, models_dir};
use super::clip_tools::{allowed_source, derived_key};
use crate::errors::{AppError, AppResult};
use crate::media::MediaBackend;
use crate::media::ffmpeg::FfmpegBackend;
use crate::media::tools::{FFMPEG_ENV, command, locate_tool};
use crate::media::upscale::{
    MAX_INPUT_SIDE, MODELS, SCALE, UpscaleModel, Upscaler, halve_rgb, model, onnx_from_pth,
};
use crate::media::upscale_video::{VideoJob, refusal, upscale_video as run_video};
use crate::media::whisper::download_model;

pub const UPSCALE_EVENT: &str = "upscale-progress";

#[derive(Clone, Serialize)]
struct UpscaleProgress {
    fraction: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    id: String,
    received: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    total: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpscaleModelStatus {
    pub id: String,
    pub label: String,
    pub approx_mb: f32,
    /// Where it is downloaded from, shown before the user agrees.
    pub source: String,
    pub installed: bool,
}

fn dir(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(models_dir(app)?.join("upscale"))
}

/// On this machine, and exactly the published size (the SHA-256 was checked when it was downloaded).
fn installed(spec: &UpscaleModel, path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|m| m.len() == spec.bytes)
}

/// The upscale models on offer and whether each is on this machine.
#[tauri::command]
pub fn upscale_models(app: AppHandle) -> AppResult<Vec<UpscaleModelStatus>> {
    let dir = dir(&app)?;
    Ok(MODELS
        .iter()
        .map(|m| UpscaleModelStatus {
            id: m.id.to_string(),
            label: m.label.to_string(),
            approx_mb: m.approx_mb,
            source: m.url.to_string(),
            installed: installed(m, &dir.join(m.file)),
        })
        .collect())
}

/// Download an upscale model into the app data folder. Called only after the user agreed. Progress
/// arrives as `ai-download` events with the id `upscale:<model>`; `cancel_ai_job` stops it.
#[tauri::command]
pub async fn download_upscale_model(
    app: AppHandle,
    job: State<'_, AiJob>,
    id: String,
) -> AppResult<()> {
    let spec = model(&id)?;
    let out = dir(&app)?.join(spec.file);
    if installed(spec, &out) {
        return Ok(());
    }
    let cancel = job.start()?;
    let events = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        download_model(
            spec.url,
            &out,
            Some((spec.bytes, spec.sha256)),
            &mut |received, total| {
                events
                    .emit(
                        DOWNLOAD_EVENT,
                        DownloadProgress {
                            id: format!("upscale:{id}"),
                            received,
                            total,
                        },
                    )
                    .ok();
            },
            &cancel,
        )
    })
    .await;
    job.finish();
    result.map_err(|e| AppError::InvalidInput(format!("download task failed: {e}")))?
}

/// Remove a downloaded upscale model from this machine.
#[tauri::command]
pub fn delete_upscale_model(app: AppHandle, id: String) -> AppResult<()> {
    let path = dir(&app)?.join(model(&id)?.file);
    match fs::remove_file(&path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
        _ => Ok(()),
    }
}

/// The whole picture as RGB bytes at its own size, in the orientation it is shown.
fn read_rgb(ffmpeg: &Path, src: &Path, width: u32, height: u32) -> AppResult<Vec<u8>> {
    let mut child = command(ffmpeg)
        .args(["-v", "error", "-nostdin", "-i"])
        .arg(src)
        .args(["-frames:v", "1", "-an", "-vf"])
        .arg(format!("scale={width}:{height}"))
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
    if !status.success() || bytes.len() != (width as usize) * (height as usize) * 3 {
        return Err(AppError::InvalidInput(
            "the picture could not be read".into(),
        ));
    }
    Ok(bytes)
}

fn write_png(out: &Path, rgb: &[u8], width: u32, height: u32) -> AppResult<()> {
    if let Some(parent) = out.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = out.with_extension(format!("part-{}", std::process::id()));
    let written = (|| -> AppResult<()> {
        let mut encoder = png::Encoder::new(BufWriter::new(fs::File::create(&tmp)?), width, height);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        let failed =
            |e: png::EncodingError| AppError::InvalidInput(format!("upscaled picture: {e}"));
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

#[derive(Debug, Serialize)]
pub struct UpscaledVideo {
    pub path: String,
    pub width: u32,
    pub height: u32,
    /// Seconds: the stretch that was treated, as the new file has it.
    pub duration: f64,
}

/// Make (or reuse) an enlarged copy of `[source_in, source_out)` of an imported video, frame by frame, with
/// the downloaded model (`media/upscale_video.rs`). `factor` is 2 or 4. Progress arrives as
/// `upscale-progress` events; `cancel_ai_job` stops it and leaves nothing behind. The new file starts at
/// 0 and carries the stretch's sound.
#[tauri::command]
pub async fn upscale_video(
    app: AppHandle,
    job: State<'_, AiJob>,
    path: String,
    model_id: String,
    factor: u32,
    source_in: f64,
    source_out: f64,
) -> AppResult<UpscaledVideo> {
    let src = allowed_source(&app, &path)?;
    let spec = model(&model_id)?;
    let model_file = dir(&app)?.join(spec.file);
    if !installed(spec, &model_file) {
        return Err(AppError::InvalidInput(
            "that upscale model is not downloaded yet".into(),
        ));
    }
    if !(source_in.is_finite()
        && source_out.is_finite()
        && source_in >= 0.0
        && source_out > source_in)
    {
        return Err(AppError::InvalidInput("invalid range".into()));
    }
    let out = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::InvalidInput(format!("no data directory: {e}")))?
        .join("upscaled")
        .join(format!(
            "{}.mp4",
            derived_key(
                &src,
                &format!(
                    "upscale-video-v1|{}|{factor}|{source_in:.3}|{source_out:.3}",
                    spec.id
                )
            )?
        ));
    let scope = app.asset_protocol_scope();
    let cancel = job.start()?;
    let events = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let backend = FfmpegBackend::locate()?;
        if !out.is_file() {
            let info = backend.probe(&src)?;
            let ffmpeg = locate_tool("ffmpeg", FFMPEG_ENV)?;
            let video = VideoJob {
                ffmpeg: &ffmpeg,
                src: &src,
                start: source_in,
                seconds: source_out - source_in,
                width: info.width.unwrap_or(0),
                height: info.height.unwrap_or(0),
                fps: (info.fps_num.unwrap_or(0), info.fps_den.unwrap_or(0)),
                factor,
                out: &out,
            };
            // refused before the model is even read
            if let Some(reason) = refusal(&video) {
                return Err(AppError::InvalidInput(reason));
            }
            let mut upscaler = Upscaler::new(&onnx_from_pth(&fs::read(&model_file)?)?)?;
            run_video(
                &video,
                &mut upscaler,
                &mut |done, total| {
                    let fraction = done as f64 / total.max(1) as f64;
                    events
                        .emit(UPSCALE_EVENT, UpscaleProgress { fraction })
                        .ok();
                },
                &cancel,
            )?;
        }
        scope.allow_file(&out).map_err(|e| {
            AppError::InvalidInput(format!(
                "could not enable preview of the upscaled video: {e}"
            ))
        })?;
        let made = backend.probe(&out)?;
        let (Some(width), Some(height)) = (made.width, made.height) else {
            return Err(AppError::InvalidInput(
                "the upscaled video could not be read back".into(),
            ));
        };
        Ok(UpscaledVideo {
            path: out.to_string_lossy().into_owned(),
            width,
            height,
            duration: made.duration.unwrap_or(source_out - source_in),
        })
    })
    .await;
    job.finish();
    result.map_err(|e| AppError::InvalidInput(format!("upscale task failed: {e}")))?
}

#[derive(Debug, Serialize)]
pub struct Upscaled {
    pub path: String,
    pub width: u32,
    pub height: u32,
}

/// Make (or reuse) an enlarged copy of an imported picture with the downloaded model. `factor` is 2 or 4
/// (2 = enlarge four times, then halve). Progress arrives as `upscale-progress` events; `cancel_ai_job`
/// stops it and leaves nothing behind. Transparency is not kept: the result is an opaque PNG.
#[tauri::command]
pub async fn upscale_image(
    app: AppHandle,
    job: State<'_, AiJob>,
    path: String,
    model_id: String,
    factor: u32,
) -> AppResult<Upscaled> {
    let src = allowed_source(&app, &path)?;
    if factor != 2 && factor != 4 {
        return Err(AppError::InvalidInput(
            "the picture can be enlarged 2 or 4 times".into(),
        ));
    }
    let spec = model(&model_id)?;
    let model_file = dir(&app)?.join(spec.file);
    if !installed(spec, &model_file) {
        return Err(AppError::InvalidInput(
            "that upscale model is not downloaded yet".into(),
        ));
    }
    let out = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::InvalidInput(format!("no data directory: {e}")))?
        .join("upscaled")
        .join(format!(
            "{}.png",
            derived_key(&src, &format!("upscale-v1|{}|{factor}", spec.id))?
        ));
    let scope = app.asset_protocol_scope();
    let cancel = job.start()?;
    let events = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let backend = FfmpegBackend::locate()?;
        let info = backend.probe(&src)?;
        let (Some(width), Some(height)) = (info.width, info.height) else {
            return Err(AppError::InvalidInput("this file has no picture".into()));
        };
        if width.max(height) > MAX_INPUT_SIDE {
            return Err(AppError::InvalidInput(format!(
                "the picture is {width}x{height}; AI upscale takes pictures up to {MAX_INPUT_SIDE} px on the longer side"
            )));
        }
        let (mut out_w, mut out_h) = (width * SCALE as u32, height * SCALE as u32);
        if !out.is_file() {
            let rgb = read_rgb(&locate_tool("ffmpeg", FFMPEG_ENV)?, &src, width, height)?;
            let onnx = onnx_from_pth(&fs::read(&model_file)?)?;
            let mut upscaler = Upscaler::new(&onnx)?;
            let mut big = upscaler.upscale_rgb(
                &rgb,
                width as usize,
                height as usize,
                &mut |fraction| {
                    events.emit(UPSCALE_EVENT, UpscaleProgress { fraction }).ok();
                },
                &cancel,
            )?;
            if factor == 2 {
                let (half, w, h) = halve_rgb(&big, out_w as usize, out_h as usize);
                big = half;
                (out_w, out_h) = (w as u32, h as u32);
            }
            write_png(&out, &big, out_w, out_h)?;
        } else if factor == 2 {
            (out_w, out_h) = (out_w / 2, out_h / 2);
        }
        scope.allow_file(&out).map_err(|e| {
            AppError::InvalidInput(format!("could not enable preview of the upscaled picture: {e}"))
        })?;
        Ok(Upscaled {
            path: out.to_string_lossy().into_owned(),
            width: out_w,
            height: out_h,
        })
    })
    .await;
    job.finish();
    result.map_err(|e| AppError::InvalidInput(format!("upscale task failed: {e}")))?
}
