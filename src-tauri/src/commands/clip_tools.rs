//! Per-clip helpers that produce files: the reversed preview copy and freeze-frame images.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::commands::export::reveal_command;
use crate::commands::export::safe_file_stem;
use crate::errors::{AppError, AppResult};
use crate::media::MediaBackend;
use crate::media::clean::write_sample;
use crate::media::color::{ColorAdjust, Overlay, ensure_graded_lut};
use crate::media::cube::{
    CUBE_EXTENSION, CubeInfo, MAX_CUBE_FILES, delete_cube, list_cubes, load_cube, read_cube,
    store_cube,
};
use crate::media::ffmpeg::FfmpegBackend;
use crate::media::import::{ImportedMedia, cache_key, import_one};
use crate::media::looks::{
    PRESET_EXTENSION, ensure_look_previews, preset_file_text, read_frame, read_preset, write_preset,
};
use crate::media::pack::{CheckedPack, PACK_EXTENSION, PackFile, pack_text, read_pack};
use crate::media::probe::MediaDetails;
use crate::media::text::{
    FONT_EXTENSIONS, FontInfo, STYLE_FILE_EXTENSION, StyleFile, TextSpec, TextStyle,
    checked_style_file, ensure_font_preview, ensure_style_preview, ensure_text_picture,
    import_font, list_fonts, load_bundled_fonts, load_user_fonts, read_style_file,
};
use crate::media::tools::{FFMPEG_ENV, locate_tool};
use crate::media::vocals::{merge_ranges, reduce_vocals};
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
pub async fn bake_color_lut(
    app: AppHandle,
    adjust: ColorAdjust,
    lut: Option<crate::project::ClipLut>,
) -> AppResult<String> {
    let cubes = cubes_dir(&app)?;
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::InvalidInput(format!("no cache directory: {e}")))?
        .join("luts");
    tauri::async_runtime::spawn_blocking(move || {
        // an imported LUT goes on top of Adjust; one that is not on this computer is an error
        let cube = lut.as_ref().map(|l| load_cube(&cubes, &l.id)).transpose()?;
        let overlay = lut.as_ref().zip(cube.as_ref()).map(|(l, cube)| Overlay {
            id: &l.id,
            cube,
            intensity: l.intensity,
        });
        Ok(ensure_graded_lut(&dir, &adjust, overlay.as_ref())?
            .binary
            .to_string_lossy()
            .into_owned())
    })
    .await
    .map_err(|e| AppError::InvalidInput(format!("colour task failed: {e}")))?
}

/// Small pictures of one frame of an imported file, each shown through one of `looks` (in the same
/// order), for the Looks gallery. `at` is a source time in seconds. Made once per frame and look.
#[tauri::command]
pub async fn look_previews(
    app: AppHandle,
    path: String,
    at: f64,
    looks: Vec<ColorAdjust>,
) -> AppResult<Vec<String>> {
    let src = allowed_source(&app, &path)?;
    if !(at.is_finite() && at >= 0.0) {
        return Err(AppError::InvalidInput("invalid time".into()));
    }
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::InvalidInput(format!("no cache directory: {e}")))?
        .join("look-previews");
    tauri::async_runtime::spawn_blocking(move || {
        let key = derived_key(&src, &format!("look-frame|{at:.3}"))?;
        let frame = || read_frame(&locate_tool("ffmpeg", FFMPEG_ENV)?, &src, at);
        Ok(ensure_look_previews(&dir, &key, &looks, &frame)?
            .into_iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect())
    })
    .await
    .map_err(|e| AppError::InvalidInput(format!("look preview task failed: {e}")))?
}

/// Save one of the user's colour presets as a `.cutviipreset` file to share. The native dialog picks the
/// place (the webview never supplies a path); the name only suggests the file name. Returns the path
/// written, or `None` when the dialog is dismissed.
#[tauri::command]
pub async fn export_color_preset(
    app: AppHandle,
    name: String,
    adjust: ColorAdjust,
) -> AppResult<Option<String>> {
    let text = preset_file_text(&name, &adjust)?;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(mut out) = app
            .dialog()
            .file()
            .add_filter("CutVii colour preset", &[PRESET_EXTENSION])
            .set_file_name(format!("{}.{PRESET_EXTENSION}", safe_file_stem(&name)))
            .blocking_save_file()
            .and_then(|p| p.into_path().ok())
        else {
            return Ok(None);
        };
        if out.extension().is_none() {
            out.set_extension(PRESET_EXTENSION);
        }
        write_preset(&out, &text)?;
        Ok(Some(out.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| AppError::InvalidInput(format!("preset task failed: {e}")))?
}

/// Save one of the user's text styles as a `.cutvii-textstyle` file to share. The native dialog picks the
/// place; the name only suggests the file name. Returns the path written, or `None` when dismissed.
#[tauri::command]
pub async fn export_text_style(
    app: AppHandle,
    name: String,
    style: serde_json::Value,
    fade: Option<f64>,
) -> AppResult<Option<String>> {
    let file = checked_style_file(&name, &style, fade)?;
    let text = serde_json::to_string_pretty(&file)
        .map_err(|e| AppError::InvalidInput(format!("style file: {e}")))?;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(mut out) = app
            .dialog()
            .file()
            .add_filter("CutVii text style", &[STYLE_FILE_EXTENSION])
            .set_file_name(format!(
                "{}.{STYLE_FILE_EXTENSION}",
                safe_file_stem(&file.name)
            ))
            .blocking_save_file()
            .and_then(|p| p.into_path().ok())
        else {
            return Ok(None);
        };
        if out.extension().is_none() {
            out.set_extension(STYLE_FILE_EXTENSION);
        }
        write_preset(&out, &text)?;
        Ok(Some(out.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| AppError::InvalidInput(format!("style task failed: {e}")))?
}

/// What a text style import found: the styles that are fine, and for each refused file its name and why.
#[derive(Debug, Serialize)]
pub struct StyleImport {
    pub styles: Vec<StyleFile>,
    pub problems: Vec<(String, String)>,
}

/// Native "Import style" dialog: read the chosen `.cutvii-textstyle` files. Every file is checked as
/// untrusted input (see `read_style_file`); a bad one is reported and the others still load. The webview
/// never supplies a path. Empty when the user cancels.
#[tauri::command]
pub async fn import_text_styles(app: AppHandle) -> AppResult<StyleImport> {
    tauri::async_runtime::spawn_blocking(move || {
        let picked = app
            .dialog()
            .file()
            .add_filter("CutVii text style", &[STYLE_FILE_EXTENSION])
            .blocking_pick_files()
            .unwrap_or_default();
        let mut found = StyleImport {
            styles: Vec::new(),
            problems: Vec::new(),
        };
        for file in picked.into_iter().take(MAX_PRESET_FILES) {
            let Ok(path) = file.into_path() else {
                continue;
            };
            let shown = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            match read_style_file(&path) {
                Ok(style) => found.styles.push(style),
                Err(e) => found.problems.push((shown, e.to_string())),
            }
        }
        Ok(found)
    })
    .await
    .map_err(|e| AppError::InvalidInput(format!("style task failed: {e}")))?
}

/// Save a style pack (`.cutvii-pack`). The pack is checked like one being read; the native dialog picks the
/// place. Returns the path written, or `None` when the dialog is dismissed.
#[tauri::command]
pub async fn export_style_pack(app: AppHandle, pack: PackFile) -> AppResult<Option<String>> {
    let text = pack_text(&pack)?;
    let suggested = safe_file_stem(&pack.name);
    tauri::async_runtime::spawn_blocking(move || {
        let Some(mut out) = app
            .dialog()
            .file()
            .add_filter("CutVii style pack", &[PACK_EXTENSION])
            .set_file_name(format!("{suggested}.{PACK_EXTENSION}"))
            .blocking_save_file()
            .and_then(|p| p.into_path().ok())
        else {
            return Ok(None);
        };
        if out.extension().is_none() {
            out.set_extension(PACK_EXTENSION);
        }
        write_preset(&out, &text)?;
        Ok(Some(out.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| AppError::InvalidInput(format!("pack task failed: {e}")))?
}

/// Native "Open style pack" dialog: read and check the chosen file (untrusted input, see `media/pack.rs`).
/// `None` when the user cancels. The webview never supplies a path.
#[tauri::command]
pub async fn open_style_pack(app: AppHandle) -> AppResult<Option<CheckedPack>> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = app
            .dialog()
            .file()
            .add_filter("CutVii style pack", &[PACK_EXTENSION])
            .blocking_pick_file()
            .and_then(|p| p.into_path().ok())
        else {
            return Ok(None);
        };
        read_pack(&path).map(Some)
    })
    .await
    .map_err(|e| AppError::InvalidInput(format!("pack task failed: {e}")))?
}

/// A new audio file made from a clip's sound.
#[derive(Debug, Serialize)]
pub struct MadeAudio {
    pub path: String,
    /// Seconds.
    pub duration: f64,
}

/// Most sung ranges one request may name.
const MAX_SUNG_RANGES: usize = 5000;

/// Make (or reuse) a copy of `[source_in, source_out)` of an imported file's sound with the singer lowered
/// while lyrics are sung (`ranges`, seconds from `source_in`). No model: centre cancelling, see
/// `media/vocals.rs`. The copy lives in the app data folder; the original file is never changed. A mono
/// recording is refused, because there is no middle to remove.
#[tauri::command]
pub async fn make_instrumental(
    app: AppHandle,
    path: String,
    source_in: f64,
    source_out: f64,
    ranges: Vec<(f64, f64)>,
) -> AppResult<MadeAudio> {
    let src = allowed_source(&app, &path)?;
    if !(source_in.is_finite()
        && source_out.is_finite()
        && source_in >= 0.0
        && source_out > source_in)
    {
        return Err(AppError::InvalidInput("invalid range".into()));
    }
    if ranges.len() > MAX_SUNG_RANGES {
        return Err(AppError::InvalidInput("too many lyric lines".into()));
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::InvalidInput(format!("no data directory: {e}")))?
        .join("karaoke");
    let scope = app.asset_protocol_scope();
    tauri::async_runtime::spawn_blocking(move || {
        let backend = FfmpegBackend::locate()?;
        match backend.details(&src)?.audio_channels {
            None => {
                return Err(AppError::InvalidInput("this clip has no sound".into()));
            }
            Some(1) => {
                return Err(AppError::InvalidInput(
                    "this recording is mono, so the voice cannot be lowered this way".into(),
                ));
            }
            _ => {}
        }
        let seconds = source_out - source_in;
        let merged = merge_ranges(&ranges, seconds);
        let mut params = format!("instrumental-v2|{source_in:.3}|{source_out:.3}");
        for (a, b) in &merged {
            params.push_str(&format!("|{a:.2}-{b:.2}"));
        }
        let out = dir.join(format!("{}.m4a", derived_key(&src, &params)?));
        if !out.is_file() {
            reduce_vocals(
                &locate_tool("ffmpeg", FFMPEG_ENV)?,
                &src,
                source_in,
                seconds,
                &ranges,
                &out,
            )?;
        }
        scope.allow_file(&out).map_err(|e| {
            AppError::InvalidInput(format!("could not enable playback of the new sound: {e}"))
        })?;
        let duration = backend.probe(&out)?.duration.unwrap_or(seconds);
        Ok(MadeAudio {
            path: out.to_string_lossy().into_owned(),
            duration,
        })
    })
    .await
    .map_err(|e| AppError::InvalidInput(format!("sound task failed: {e}")))?
}

/// A few seconds of a clip's sound from `start` (source seconds), cleaned the way the export will clean it
/// (`media/clean.rs`), to listen to. One sample is kept at a time, in the cache folder.
#[tauri::command]
pub async fn audio_clean_sample(
    app: AppHandle,
    path: String,
    start: f64,
    clean: crate::project::AudioClean,
) -> AppResult<String> {
    let src = allowed_source(&app, &path)?;
    if !(start.is_finite() && start >= 0.0 && clean.is_valid()) {
        return Err(AppError::InvalidInput("invalid sample request".into()));
    }
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::InvalidInput(format!("no cache directory: {e}")))?
        .join("audio-samples");
    let scope = app.asset_protocol_scope();
    tauri::async_runtime::spawn_blocking(move || {
        let params = format!("clean-v1|{start:.3}|{:.3}|{}", clean.noise, clean.rumble);
        let out = dir.join(format!("{}.wav", derived_key(&src, &params)?));
        if !out.is_file() {
            // older samples are of no use any more
            if let Ok(entries) = std::fs::read_dir(&dir) {
                for old in entries.flatten() {
                    std::fs::remove_file(old.path()).ok();
                }
            }
            write_sample(
                &locate_tool("ffmpeg", FFMPEG_ENV)?,
                &src,
                start,
                &clean,
                &out,
            )?;
        }
        scope.allow_file(&out).map_err(|e| {
            AppError::InvalidInput(format!("could not enable playback of the sample: {e}"))
        })?;
        Ok(out.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| AppError::InvalidInput(format!("sound task failed: {e}")))?
}

/// A lyrics file larger than this is not read.
const MAX_LYRICS_BYTES: u64 = 1024 * 1024;

/// A lyrics file the user picked: its name (to show) and its text. The text is only ever parsed as lyrics.
#[derive(Debug, Serialize)]
pub struct LyricsFile {
    pub name: String,
    pub text: String,
}

/// Read a text file as lyrics: at most 1 MB, and it must be text (UTF-8, with or without a byte-order
/// mark; no NUL bytes). Untrusted input: nothing in it is run or followed.
pub fn read_lyrics(path: &Path) -> AppResult<String> {
    let bad = |m: &str| AppError::InvalidInput(m.to_string());
    if std::fs::metadata(path)?.len() > MAX_LYRICS_BYTES {
        return Err(bad("the file is too large (1 MB at most)"));
    }
    let bytes = std::fs::read(path)?;
    let text = String::from_utf8(bytes).map_err(|_| bad("this is not a text file"))?;
    if text.contains('\0') {
        return Err(bad("this is not a text file"));
    }
    Ok(text.trim_start_matches('\u{feff}').to_string())
}

/// Native "Open lyrics" dialog (`.lrc`, `.srt`, `.txt`). The webview never supplies a path. `None` when the
/// user cancels.
#[tauri::command]
pub async fn open_lyrics_file(app: AppHandle) -> AppResult<Option<LyricsFile>> {
    pick_text_file(app, "Lyrics", &["lrc", "srt", "txt"]).await
}

/// Native "Import subtitles" dialog (`.srt` only), read like a lyrics file: text, 1 MB at most. `None` when
/// the user cancels.
#[tauri::command]
pub async fn open_srt_file(app: AppHandle) -> AppResult<Option<LyricsFile>> {
    pick_text_file(app, "Subtitles", &["srt"]).await
}

async fn pick_text_file(
    app: AppHandle,
    kind: &'static str,
    extensions: &'static [&'static str],
) -> AppResult<Option<LyricsFile>> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = app
            .dialog()
            .file()
            .add_filter(kind, extensions)
            .blocking_pick_file()
            .and_then(|p| p.into_path().ok())
        else {
            return Ok(None);
        };
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        Ok(Some(LyricsFile {
            name,
            text: read_lyrics(&path)?,
        }))
    })
    .await
    .map_err(|e| AppError::InvalidInput(format!("file task failed: {e}")))?
}

/// Subtitles longer than this are not written.
const MAX_SRT_BYTES: usize = 2 * 1024 * 1024;

/// Subtitle text from the webview, checked before it is written: not empty, at most 2 MB, no NUL bytes.
pub fn checked_srt(text: &str) -> AppResult<&str> {
    let bad = |m: &str| AppError::InvalidInput(m.to_string());
    if text.trim().is_empty() {
        return Err(bad("there are no subtitles to save"));
    }
    if text.len() > MAX_SRT_BYTES {
        return Err(bad("the subtitles are too long to save (2 MB at most)"));
    }
    if text.contains('\0') {
        return Err(bad("the subtitles are not plain text"));
    }
    Ok(text)
}
/// The real line count of each text (the rasterizer's wrapping), for the "Too long" warning. At most
/// `MAX_LINE_COUNTS` texts at once.
#[tauri::command]
pub async fn text_line_counts(
    specs: Vec<TextSpec>,
    width: u32,
    height: u32,
) -> AppResult<Vec<u32>> {
    if specs.len() > MAX_LINE_COUNTS {
        return Err(AppError::InvalidInput("too many texts at once".into()));
    }
    tauri::async_runtime::spawn_blocking(move || {
        specs
            .iter()
            .map(|s| crate::media::text::line_count(s, width, height))
            .collect()
    })
    .await
    .map_err(|e| AppError::InvalidInput(format!("text task failed: {e}")))?
}
const MAX_LINE_COUNTS: usize = 5000;

/// Cut captions into readable pieces (`media/captions.rs`). Pure work; the limits are checked there.
#[tauri::command]
pub fn split_captions(
    request: crate::media::captions::Request,
) -> AppResult<Vec<crate::media::captions::Caption>> {
    crate::media::captions::split(&request)
}

/// Save subtitles as a `.srt` file. The native dialog picks the place; the name only suggests the file
/// name. An existing file is replaced only once the new one is complete. Returns the path written, or
/// `None` when dismissed.
#[tauri::command]
pub async fn export_srt(app: AppHandle, name: String, text: String) -> AppResult<Option<String>> {
    checked_srt(&text)?;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(mut out) = app
            .dialog()
            .file()
            .add_filter("Subtitles", &["srt"])
            .set_file_name(format!("{}.srt", safe_file_stem(&name)))
            .blocking_save_file()
            .and_then(|p| p.into_path().ok())
        else {
            return Ok(None);
        };
        if out.extension().is_none() {
            out.set_extension("srt");
        }
        write_preset(&out, &text)?;
        Ok(Some(out.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| AppError::InvalidInput(format!("subtitle task failed: {e}")))?
}

/// A colour preset read from a file the user picked.
#[derive(Debug, Serialize)]
pub struct ImportedPreset {
    pub name: String,
    pub adjust: ColorAdjust,
}

/// What an import found: the presets that are fine, and for each refused file its name and the reason.
#[derive(Debug, Serialize)]
pub struct PresetImport {
    pub presets: Vec<ImportedPreset>,
    pub problems: Vec<(String, String)>,
}

/// Most files one import reads.
const MAX_PRESET_FILES: usize = 50;

/// Native "Import preset" dialog: read the chosen `.cutviipreset` files and return what is in them. Every
/// file is checked as untrusted input (see `read_preset`); a bad file is reported and the others still
/// load. The webview never supplies a path. Empty when the user cancels.
#[tauri::command]
pub async fn import_color_presets(app: AppHandle) -> AppResult<PresetImport> {
    tauri::async_runtime::spawn_blocking(move || {
        let picked = app
            .dialog()
            .file()
            .add_filter("CutVii colour preset", &[PRESET_EXTENSION])
            .blocking_pick_files()
            .unwrap_or_default();
        let mut found = PresetImport {
            presets: Vec::new(),
            problems: Vec::new(),
        };
        for file in picked.into_iter().take(MAX_PRESET_FILES) {
            let Ok(path) = file.into_path() else {
                continue;
            };
            let shown = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            match read_preset(&path) {
                Ok(p) => found.presets.push(ImportedPreset {
                    name: p.name,
                    adjust: p.adjust,
                }),
                Err(e) => found.problems.push((shown, e.to_string())),
            }
        }
        Ok(found)
    })
    .await
    .map_err(|e| AppError::InvalidInput(format!("preset task failed: {e}")))?
}

/// Where CutVii keeps its own copies of imported `.cube` tables.
pub fn cubes_dir(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::InvalidInput(format!("no data directory: {e}")))?
        .join("luts"))
}

/// What a LUT import found: the tables that were taken in, and for each refused file its name and the
/// reason.
#[derive(Debug, Serialize)]
pub struct CubeImport {
    pub luts: Vec<CubeInfo>,
    pub problems: Vec<(String, String)>,
}

/// Native "Import LUT" dialog: read the chosen `.cube` files, check each as untrusted input (see
/// `media/cube.rs`) and keep CutVii's own copy of the good ones. A bad file is reported and the others
/// still load. The webview never supplies a path. Empty when the user cancels.
#[tauri::command]
pub async fn import_color_luts(app: AppHandle) -> AppResult<CubeImport> {
    let dir = cubes_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let picked = app
            .dialog()
            .file()
            .add_filter("3D LUT", &[CUBE_EXTENSION])
            .blocking_pick_files()
            .unwrap_or_default();
        let mut found = CubeImport {
            luts: Vec::new(),
            problems: Vec::new(),
        };
        for file in picked.into_iter().take(MAX_CUBE_FILES) {
            let Ok(path) = file.into_path() else {
                continue;
            };
            let shown = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            match read_cube(&path).and_then(|cube| store_cube(&dir, &cube)) {
                Ok(info) => found.luts.push(info),
                Err(e) => found.problems.push((shown, e.to_string())),
            }
        }
        Ok(found)
    })
    .await
    .map_err(|e| AppError::InvalidInput(format!("LUT task failed: {e}")))?
}

/// The imported LUTs, by name.
#[tauri::command]
pub async fn color_luts(app: AppHandle) -> AppResult<Vec<CubeInfo>> {
    let dir = cubes_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || list_cubes(&dir))
        .await
        .map_err(|e| AppError::InvalidInput(format!("LUT task failed: {e}")))
}

/// Forget an imported LUT (CutVii's copy; the file it came from is never touched).
#[tauri::command]
pub async fn delete_color_lut(app: AppHandle, id: String) -> AppResult<()> {
    delete_cube(&cubes_dir(&app)?, &id)
}

/// The sample picture of a text style (a bundled one or the user's own), drawn by the same rasterizer as
/// every text and cached. `label` is the style's name, shown in the sample.
#[tauri::command]
pub async fn text_style_preview(
    app: AppHandle,
    style: TextStyle,
    label: String,
) -> AppResult<String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::InvalidInput(format!("no cache directory: {e}")))?
        .join("text-style-previews");
    tauri::async_runtime::spawn_blocking(move || {
        Ok(ensure_style_preview(&dir, &style, &label)?
            .to_string_lossy()
            .into_owned())
    })
    .await
    .map_err(|e| AppError::InvalidInput(format!("style task failed: {e}")))?
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
    fn subtitles_are_checked_before_they_are_written() {
        assert!(checked_srt("1\n00:00:01,000 --> 00:00:02,000\nHalo\n").is_ok());
        assert!(checked_srt(" \n").is_err());
        assert!(checked_srt("1\n\0").is_err());
        assert!(checked_srt(&"a".repeat(MAX_SRT_BYTES + 1)).is_err());
    }

    #[test]
    fn lyrics_files_are_read_as_text_only_and_within_a_size_limit() {
        let dir = std::env::temp_dir().join(format!("cutvii-lyrics-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let good = dir.join("song.lrc");
        std::fs::write(&good, "\u{feff}[00:01.00]Halo dunia\n").unwrap();
        assert_eq!(read_lyrics(&good).unwrap(), "[00:01.00]Halo dunia\n");
        let binary = dir.join("song.srt");
        std::fs::write(&binary, [0xff, 0xfe, 0x00, 0x41]).unwrap();
        assert!(
            read_lyrics(&binary)
                .unwrap_err()
                .to_string()
                .contains("not a text file")
        );
        std::fs::write(&binary, b"abc\0def").unwrap();
        assert!(read_lyrics(&binary).is_err());
        let big = dir.join("big.txt");
        std::fs::write(&big, vec![b'a'; MAX_LYRICS_BYTES as usize + 1]).unwrap();
        assert!(
            read_lyrics(&big)
                .unwrap_err()
                .to_string()
                .contains("too large")
        );
        assert!(read_lyrics(&dir.join("missing.lrc")).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

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
