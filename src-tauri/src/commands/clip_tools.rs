//! Per-clip helpers that produce files: the reversed preview copy and freeze-frame images.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::commands::export::reveal_command;
use crate::errors::{AppError, AppResult};
use crate::media::MediaBackend;
use crate::media::color::{ColorAdjust, ensure_lut};
use crate::media::ffmpeg::FfmpegBackend;
use crate::media::import::{ImportedMedia, cache_key, import_one};
use crate::media::probe::MediaDetails;
use crate::media::text::{
    FONT_EXTENSIONS, FontInfo, TextSpec, ensure_font_preview, ensure_text_picture, import_font,
    list_fonts, load_bundled_fonts, load_user_fonts,
};
use crate::media::waveform::{FORMAT_VERSION, write_waveform};

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
pub(crate) fn allowed_source(app: &AppHandle, path: &str) -> AppResult<PathBuf> {
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

pub const IMAGE_PREVIEW_WIDTH: u32 = 1280;

/// Build (or reuse) a downscaled copy of an imported image, for use as a full-canvas background in the
/// preview. Export always reads the original.
#[tauri::command]
pub async fn prepare_image_preview(app: AppHandle, path: String) -> AppResult<String> {
    let src = allowed_source(&app, &path)?;
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::InvalidInput(format!("no cache directory: {e}")))?
        .join("previews");
    let out = dir.join(format!(
        "{}.jpg",
        derived_key(&src, &format!("w{IMAGE_PREVIEW_WIDTH}"))?
    ));
    if out.is_file() {
        return Ok(out.to_string_lossy().into_owned());
    }
    let result = out.clone();
    tauri::async_runtime::spawn_blocking(move || {
        FfmpegBackend::locate()?.scaled_image(&src, IMAGE_PREVIEW_WIDTH, &out)
    })
    .await
    .map_err(|e| AppError::InvalidInput(format!("image preview task failed: {e}")))??;
    Ok(result.to_string_lossy().into_owned())
}

/// Build (or reuse) the waveform peaks of an imported file and return the cached file's path, or `None`
/// when the file has no audio. The webview loads the peaks through the asset protocol.
#[tauri::command]
pub async fn prepare_waveform(app: AppHandle, path: String) -> AppResult<Option<String>> {
    let src = allowed_source(&app, &path)?;
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::InvalidInput(format!("no cache directory: {e}")))?
        .join("waveforms");
    let out = dir.join(format!(
        "{}.wf",
        derived_key(&src, &format!("waveform-v{FORMAT_VERSION}"))?
    ));
    if out.is_file() {
        return Ok(Some(out.to_string_lossy().into_owned()));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let backend = FfmpegBackend::locate()?;
        if !backend.has_audio(&src)? {
            return Ok(None);
        }
        write_waveform(backend.audio_peaks(&src)?, &out)?;
        Ok(Some(out.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| AppError::InvalidInput(format!("waveform task failed: {e}")))?
}

/// Draw (or reuse) the picture of a text block on a `width` x `height` canvas and return its path. The
/// picture lives in the app data folder and is made preview-readable; the same file is used by the export.
#[tauri::command]
pub async fn render_text(
    app: AppHandle,
    spec: TextSpec,
    width: u32,
    height: u32,
) -> AppResult<String> {
    let data = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::InvalidInput(format!("no data directory: {e}")))?;
    let scope = app.asset_protocol_scope();
    tauri::async_runtime::spawn_blocking(move || {
        let out = ensure_text_picture(&data, &spec, width, height)?;
        scope.allow_file(&out).map_err(|e| {
            AppError::InvalidInput(format!("could not enable preview for the text: {e}"))
        })?;
        Ok(out.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| AppError::InvalidInput(format!("text task failed: {e}")))?
}

/// Codecs, container, bit rate and size of an imported file, for the Info tab.
#[tauri::command]
pub async fn media_details(app: AppHandle, path: String) -> AppResult<MediaDetails> {
    let src = allowed_source(&app, &path)?;
    tauri::async_runtime::spawn_blocking(move || FfmpegBackend::locate()?.details(&src))
        .await
        .map_err(|e| AppError::InvalidInput(format!("details task failed: {e}")))?
}

/// Show an imported file in Finder / Explorer / the file manager. Only files of this session can be shown.
#[tauri::command]
pub fn reveal_media(app: AppHandle, path: String) -> AppResult<()> {
    let src = allowed_source(&app, &path)?;
    let (program, args) = reveal_command(&src);
    // argument vector, no shell; only a failure to start the file manager counts as an error
    std::process::Command::new(program).args(args).spawn()?;
    Ok(())
}

/// Bake (or reuse) the colour table for the Adjust values and return the file the preview shader loads.
/// The export bakes the same table with the same code.
#[tauri::command]
pub async fn bake_color_lut(app: AppHandle, adjust: ColorAdjust) -> AppResult<String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::InvalidInput(format!("no cache directory: {e}")))?
        .join("luts");
    tauri::async_runtime::spawn_blocking(move || {
        Ok(ensure_lut(&dir, &adjust)?
            .binary
            .to_string_lossy()
            .into_owned())
    })
    .await
    .map_err(|e| AppError::InvalidInput(format!("colour task failed: {e}")))?
}

fn fonts_dir(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::InvalidInput(format!("no data directory: {e}")))?
        .join("fonts"))
}

/// Called once at startup, before any text is drawn: the fonts shipped with the app, then the ones the user
/// imported. Without the shipped folder only the built-in default font is available, which is worth a line
/// in the log but never stops the app.
pub fn load_fonts(app: &AppHandle) {
    match app.path().resource_dir() {
        Ok(resources) => {
            let dir = resources.join("assets").join("fonts");
            if load_bundled_fonts(&dir) == 0 {
                eprintln!("CutVii: no bundled fonts found in {}", dir.display());
            }
        }
        Err(e) => eprintln!("CutVii: no resource directory for the bundled fonts: {e}"),
    }
    if let Ok(dir) = fonts_dir(app) {
        load_user_fonts(&dir);
    }
}

/// The fonts text can use: the ones that come with CutVii and the ones imported on this machine, each with
/// a small cached picture of its name for the font picker (left out if it cannot be drawn).
#[tauri::command]
pub async fn text_fonts(app: AppHandle) -> AppResult<Vec<FontInfo>> {
    let dir = fonts_dir(&app)?;
    let previews = app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::InvalidInput(format!("no cache directory: {e}")))?
        .join("font-previews");
    tauri::async_runtime::spawn_blocking(move || {
        load_user_fonts(&dir);
        list_fonts()
            .into_iter()
            .map(|font| FontInfo {
                preview: ensure_font_preview(&previews, &font.family)
                    .ok()
                    .map(|p| p.to_string_lossy().into_owned()),
                ..font
            })
            .collect()
    })
    .await
    .map_err(|e| AppError::InvalidInput(format!("font task failed: {e}")))
}

/// Native "Import font" dialog: copy the chosen font files into the app data folder and return the family
/// names they provide. Empty when the user cancels. The webview never supplies a path.
#[tauri::command]
pub async fn import_text_font(app: AppHandle) -> AppResult<Vec<String>> {
    let dir = fonts_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let picked = app
            .dialog()
            .file()
            .add_filter("Fonts", FONT_EXTENSIONS)
            .blocking_pick_files()
            .unwrap_or_default();
        let mut families = Vec::new();
        for file in picked {
            let path = file
                .into_path()
                .map_err(|e| AppError::InvalidInput(format!("that file cannot be read: {e}")))?;
            for family in import_font(&path, &dir)? {
                if !families.contains(&family) {
                    families.push(family);
                }
            }
        }
        Ok(families)
    })
    .await
    .map_err(|e| AppError::InvalidInput(format!("font task failed: {e}")))?
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
