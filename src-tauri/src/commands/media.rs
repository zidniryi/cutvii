use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::errors::{AppError, AppResult};
use crate::media::ffmpeg::FfmpegBackend;
use crate::media::import::{ImportedMedia, import_one};
use crate::media::probe::{image_extensions, supported_extensions};

#[derive(Debug, Serialize)]
pub struct ImportFailure {
    pub path: String,
    pub error: String,
}

#[derive(Debug, Default, Serialize)]
pub struct ImportReport {
    pub imported: Vec<ImportedMedia>,
    pub failed: Vec<ImportFailure>,
}

/// Opens the native file picker (in Rust, so the webview never supplies paths) and imports the picks.
/// Runs off the UI thread; originals are only read, never modified.
#[tauri::command]
pub async fn import_media(app: AppHandle) -> AppResult<ImportReport> {
    let backend = FfmpegBackend::locate()?;
    let thumb_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::InvalidInput(format!("no cache directory: {e}")))?
        .join("thumbnails");

    let picked: Vec<PathBuf> = {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let exts: Vec<&str> = supported_extensions().collect();
            app.dialog()
                .file()
                .add_filter("Media", &exts)
                .blocking_pick_files()
                .unwrap_or_default()
                .into_iter()
                .filter_map(|p| p.into_path().ok())
                .collect()
        })
        .await
        .map_err(|e| AppError::InvalidInput(format!("file picker failed: {e}")))?
    };

    let scope = app.asset_protocol_scope();
    tauri::async_runtime::spawn_blocking(move || {
        let mut report = ImportReport::default();
        for path in picked {
            match import_one(&backend, &path, &thumb_dir) {
                Ok(media) => {
                    // Least privilege: the webview may read only files the user imported.
                    if let Err(e) = scope.allow_file(&path) {
                        report.failed.push(ImportFailure {
                            path: path.to_string_lossy().into_owned(),
                            error: format!("could not enable preview for this file: {e}"),
                        });
                        continue;
                    }
                    report.imported.push(media)
                }
                Err(e) => report.failed.push(ImportFailure {
                    path: path.to_string_lossy().into_owned(),
                    error: e.to_string(),
                }),
            }
        }
        report
    })
    .await
    .map_err(|e| AppError::InvalidInput(format!("import task failed: {e}")))
}

/// Pick a replacement for a missing file. Returns its metadata so the frontend can check it fits
/// (same type, long enough) before changing the project. `None` when the user cancels.
#[tauri::command]
pub async fn relink_media(app: AppHandle) -> AppResult<Option<ImportedMedia>> {
    let backend = FfmpegBackend::locate()?;
    let thumb_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::InvalidInput(format!("no cache directory: {e}")))?
        .join("thumbnails");

    let picked: Option<PathBuf> = {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let exts: Vec<&str> = supported_extensions().collect();
            app.dialog()
                .file()
                .add_filter("Media", &exts)
                .blocking_pick_file()
                .and_then(|p| p.into_path().ok())
        })
        .await
        .map_err(|e| AppError::InvalidInput(format!("file picker failed: {e}")))?
    };
    let Some(path) = picked else { return Ok(None) };

    let scope = app.asset_protocol_scope();
    tauri::async_runtime::spawn_blocking(move || {
        let media = import_one(&backend, &path, &thumb_dir)?;
        scope.allow_file(&path).map_err(|e| {
            AppError::InvalidInput(format!("could not enable preview for this file: {e}"))
        })?;
        Ok(Some(media))
    })
    .await
    .map_err(|e| AppError::InvalidInput(format!("relink task failed: {e}")))?
}

/// Pick one image with the native dialog and import it (probe, thumbnail, preview access).
/// Used for "Choose image…" backgrounds. `None` when the user cancels.
#[tauri::command]
pub async fn pick_image(app: AppHandle) -> AppResult<Option<ImportedMedia>> {
    let backend = FfmpegBackend::locate()?;
    let thumb_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::InvalidInput(format!("no cache directory: {e}")))?
        .join("thumbnails");

    let picked: Option<PathBuf> = {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let exts: Vec<&str> = image_extensions().collect();
            app.dialog()
                .file()
                .add_filter("Images", &exts)
                .blocking_pick_file()
                .and_then(|p| p.into_path().ok())
        })
        .await
        .map_err(|e| AppError::InvalidInput(format!("file picker failed: {e}")))?
    };
    let Some(path) = picked else { return Ok(None) };

    let scope = app.asset_protocol_scope();
    tauri::async_runtime::spawn_blocking(move || {
        let media = import_one(&backend, &path, &thumb_dir)?;
        if media.info.media_type != crate::media::MediaType::Image {
            return Err(AppError::InvalidInput("that file is not an image".into()));
        }
        scope.allow_file(&path).map_err(|e| {
            AppError::InvalidInput(format!("could not enable preview for this file: {e}"))
        })?;
        Ok(Some(media))
    })
    .await
    .map_err(|e| AppError::InvalidInput(format!("image import failed: {e}")))?
}
