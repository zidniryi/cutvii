//! Per-clip helpers that produce files: the reversed preview copy and freeze-frame images.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::errors::{AppError, AppResult};
use crate::media::ffmpeg::FfmpegBackend;
use crate::media::import::{ImportedMedia, cache_key, import_one};

pub const REVERSE_PROGRESS_EVENT: &str = "reverse-progress";

#[derive(Clone, Serialize)]
struct ReverseProgress {
    key: String,
    fraction: f64,
}

/// Cache name for something derived from a file: changes when the file or the parameters change.
pub fn derived_key(path: &Path, params: &str) -> AppResult<String> {
    let mut h = DefaultHasher::new();
    (cache_key(path)?, params).hash(&mut h);
    Ok(format!("{:016x}", h.finish()))
}

/// Only files the user imported or opened may be processed.
fn allowed_source(app: &AppHandle, path: &str) -> AppResult<PathBuf> {
    let p = PathBuf::from(path);
    if !p.is_file() {
        return Err(AppError::InvalidInput("the source file is missing".into()));
    }
    if !app.asset_protocol_scope().is_allowed(&p) {
        return Err(AppError::InvalidInput(
            "that file was not imported or opened in this session".into(),
        ));
    }
    Ok(p)
}

/// Build (or reuse) the small reversed copy of `[source_in, source_out)` used by the preview.
/// `key` is echoed in progress events so the UI can tell requests apart. Returns the file path.
#[tauri::command]
pub async fn prepare_reverse_preview(
    app: AppHandle,
    key: String,
    path: String,
    source_in: f64,
    source_out: f64,
) -> AppResult<String> {
    let src = allowed_source(&app, &path)?;
    if !(source_in >= 0.0 && source_out > source_in) {
        return Err(AppError::InvalidInput("invalid range".into()));
    }
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::InvalidInput(format!("no cache directory: {e}")))?
        .join("reverse");
    let name = derived_key(&src, &format!("{source_in:.3}-{source_out:.3}"))?;
    let out = dir.join(format!("{name}.mp4"));
    if out.is_file() {
        return Ok(out.to_string_lossy().into_owned());
    }

    let backend = FfmpegBackend::locate()?;
    let result = out.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut emit = |fraction: f64| {
            app.emit(
                REVERSE_PROGRESS_EVENT,
                ReverseProgress {
                    key: key.clone(),
                    fraction,
                },
            )
            .ok();
        };
        backend.reverse_preview(
            &src,
            source_in,
            source_out,
            &out,
            &mut emit,
            &AtomicBool::new(false),
        )
    })
    .await
    .map_err(|e| AppError::InvalidInput(format!("reverse task failed: {e}")))??;
    Ok(result.to_string_lossy().into_owned())
}

/// Save the exact frame at `time` of the source as a full-resolution PNG in the app data folder and
/// return it as importable media. The original file is only read.
#[tauri::command]
pub async fn extract_freeze_frame(
    app: AppHandle,
    path: String,
    time: f64,
) -> AppResult<ImportedMedia> {
    let src = allowed_source(&app, &path)?;
    if !(time >= 0.0 && time.is_finite()) {
        return Err(AppError::InvalidInput("invalid time".into()));
    }
    let data = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::InvalidInput(format!("no data directory: {e}")))?;
    let thumbs = app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::InvalidInput(format!("no cache directory: {e}")))?
        .join("thumbnails");
    let stem = src
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "frame".into());
    let out = data.join("frames").join(format!(
        "{stem} freeze {}.png",
        derived_key(&src, &format!("{time:.4}"))?
    ));
    let scope = app.asset_protocol_scope();

    tauri::async_runtime::spawn_blocking(move || {
        let backend = FfmpegBackend::locate()?;
        if !out.is_file() {
            backend.extract_frame(&src, time, &out)?;
        }
        let media = import_one(&backend, &out, &thumbs)?;
        scope.allow_file(&out).map_err(|e| {
            AppError::InvalidInput(format!("could not enable preview for the frame: {e}"))
        })?;
        Ok(media)
    })
    .await
    .map_err(|e| AppError::InvalidInput(format!("freeze-frame task failed: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derived_keys_depend_on_file_and_parameters() {
        let dir = std::env::temp_dir().join(format!("cutvii-derived-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a.mp4");
        std::fs::write(&a, b"one").unwrap();
        let k1 = derived_key(&a, "0.000-4.000").unwrap();
        assert_eq!(k1, derived_key(&a, "0.000-4.000").unwrap());
        assert_ne!(k1, derived_key(&a, "0.000-3.000").unwrap());
        std::fs::write(&a, b"different size").unwrap();
        assert_ne!(
            k1,
            derived_key(&a, "0.000-4.000").unwrap(),
            "an edited file gets a new key"
        );
        assert!(derived_key(&dir.join("missing.mp4"), "x").is_err());
        std::fs::remove_dir_all(dir).ok();
    }
}
