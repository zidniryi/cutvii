//! OS drag & drop into the app.
//!
//! The paths come from the real OS drop event, in Rust. The webview only ever sees `{ id, name }` and later
//! asks to import an id, so it cannot make the app read a path the user did not drop.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::errors::{AppError, AppResult};
use crate::media::ffmpeg::FfmpegBackend;
use crate::media::import::{ImportedMedia, import_one};
use crate::media::probe::{classify_extension, supported_extensions};

/// Dropped files waiting to be imported. Bounded so a huge drop cannot grow memory without limit.
const MAX_PENDING: usize = 2000;

#[derive(Default)]
pub struct DropRegistry {
    next: u64,
    pending: HashMap<u64, PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DroppedFile {
    pub id: u64,
    pub name: String,
}

impl DropRegistry {
    /// Remember dropped paths and hand back ids + display names.
    pub fn register(&mut self, paths: Vec<PathBuf>) -> Vec<DroppedFile> {
        paths
            .into_iter()
            .take(MAX_PENDING.saturating_sub(self.pending.len()))
            .map(|p| {
                self.next += 1;
                let name = p
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| p.to_string_lossy().into_owned());
                self.pending.insert(self.next, p);
                DroppedFile {
                    id: self.next,
                    name,
                }
            })
            .collect()
    }

    /// Each id can be imported once.
    pub fn take(&mut self, id: u64) -> Option<PathBuf> {
        self.pending.remove(&id)
    }
}

#[derive(Default)]
pub struct DropState(pub Mutex<DropRegistry>);

/// A readable reason a dropped path cannot be imported, or Ok.
pub fn check_importable(path: &Path) -> AppResult<()> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    if path.is_dir() {
        return Err(AppError::InvalidInput(format!(
            "“{name}” is a folder. Drop the files inside it instead."
        )));
    }
    if !path.is_file() {
        return Err(AppError::InvalidInput(format!(
            "“{name}” could not be found. It may have been moved or deleted."
        )));
    }
    if classify_extension(path).is_none() {
        let ext = path
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_else(|| "without an extension".into());
        let supported = supported_extensions().collect::<Vec<_>>().join(", ");
        return Err(AppError::InvalidInput(format!(
            "“{name}” is not a supported file type ({ext}). Supported: {supported}."
        )));
    }
    Ok(())
}

#[derive(Clone, Serialize)]
pub struct FilesDropped {
    pub files: Vec<DroppedFile>,
    /// Drop position in logical (CSS) pixels, relative to the window.
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Serialize)]
pub struct DropHover {
    pub active: bool,
}

#[derive(Clone, Serialize)]
pub struct DropOver {
    pub x: f64,
    pub y: f64,
}

pub const FILES_DROPPED_EVENT: &str = "files-dropped";
pub const DROP_HOVER_EVENT: &str = "file-drop-hover";
pub const DROP_OVER_EVENT: &str = "file-drop-over";

/// Called from the window-event hook in `lib.rs` (OS drags arrive as window events).
pub fn handle_drag_drop(app: &AppHandle, event: &tauri::DragDropEvent, scale: f64) {
    use tauri::DragDropEvent::*;
    let scale = if scale > 0.0 { scale } else { 1.0 };
    match event {
        Enter { position, .. } => {
            app.emit(DROP_HOVER_EVENT, DropHover { active: true }).ok();
            app.emit(
                DROP_OVER_EVENT,
                DropOver {
                    x: position.x / scale,
                    y: position.y / scale,
                },
            )
            .ok();
        }
        Over { position } => {
            app.emit(
                DROP_OVER_EVENT,
                DropOver {
                    x: position.x / scale,
                    y: position.y / scale,
                },
            )
            .ok();
        }
        Leave => {
            app.emit(DROP_HOVER_EVENT, DropHover { active: false }).ok();
        }
        Drop { paths, position } => {
            app.emit(DROP_HOVER_EVENT, DropHover { active: false }).ok();
            let files = app
                .state::<DropState>()
                .0
                .lock()
                .unwrap()
                .register(paths.clone());
            app.emit(
                FILES_DROPPED_EVENT,
                FilesDropped {
                    files,
                    x: position.x / scale,
                    y: position.y / scale,
                },
            )
            .ok();
        }
        _ => {}
    }
}

/// Probe and thumbnail one previously dropped file. Runs off the UI thread; the original is only read.
#[tauri::command]
pub async fn import_dropped_file(
    app: AppHandle,
    state: State<'_, DropState>,
    id: u64,
) -> AppResult<ImportedMedia> {
    let path = state.0.lock().unwrap().take(id).ok_or_else(|| {
        AppError::InvalidInput("this file is no longer available; drop it again".into())
    })?;
    check_importable(&path)?;

    let backend = FfmpegBackend::locate()?;
    let thumb_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::InvalidInput(format!("no cache directory: {e}")))?
        .join("thumbnails");
    let scope = app.asset_protocol_scope();

    tauri::async_runtime::spawn_blocking(move || {
        let media = import_one(&backend, &path, &thumb_dir)?;
        scope.allow_file(&path).map_err(|e| {
            AppError::InvalidInput(format!("could not enable preview for this file: {e}"))
        })?;
        Ok(media)
    })
    .await
    .map_err(|e| AppError::InvalidInput(format!("import task failed: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("cutvii-drop-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn ids_are_unique_single_use_and_unknown_ids_are_refused() {
        let mut r = DropRegistry::default();
        let files = r.register(vec![
            PathBuf::from("/a/one.mp4"),
            PathBuf::from("/b/two.mp3"),
        ]);
        assert_eq!(
            files.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(),
            ["one.mp4", "two.mp3"]
        );
        assert_ne!(files[0].id, files[1].id);

        assert_eq!(r.take(files[0].id), Some(PathBuf::from("/a/one.mp4")));
        assert_eq!(r.take(files[0].id), None, "an id can be imported once");
        assert_eq!(r.take(9999), None, "ids the OS never delivered are refused");
    }

    #[test]
    fn registry_is_bounded() {
        let mut r = DropRegistry::default();
        let many: Vec<PathBuf> = (0..MAX_PENDING + 50)
            .map(|i| PathBuf::from(format!("/x/{i}.mp4")))
            .collect();
        assert_eq!(r.register(many).len(), MAX_PENDING);
        assert!(r.register(vec![PathBuf::from("/y/more.mp4")]).is_empty());
    }

    #[test]
    fn explains_why_a_dropped_path_cannot_be_imported() {
        let dir = tmp("check");
        let doc = dir.join("notes.docx");
        std::fs::write(&doc, b"x").unwrap();
        let noext = dir.join("README");
        std::fs::write(&noext, b"x").unwrap();
        let ok = dir.join("clip.MP4");
        std::fs::write(&ok, b"x").unwrap();

        let e = check_importable(&doc).unwrap_err().to_string();
        assert!(
            e.contains("“notes.docx”")
                && e.contains("not a supported file type (.docx)")
                && e.contains("mp4"),
            "{e}"
        );
        assert!(
            check_importable(&noext)
                .unwrap_err()
                .to_string()
                .contains("without an extension")
        );
        assert!(
            check_importable(&dir)
                .unwrap_err()
                .to_string()
                .contains("is a folder")
        );
        assert!(
            check_importable(&dir.join("gone.mp4"))
                .unwrap_err()
                .to_string()
                .contains("could not be found")
        );
        assert!(
            check_importable(&ok).is_ok(),
            "extension match is case-insensitive"
        );
        std::fs::remove_dir_all(dir).ok();
    }
}

/// Read a dropped `.cutvii-pack` file by its drop id (the path stays in Rust). The file is checked as
/// untrusted input like any other pack.
#[tauri::command]
pub async fn read_dropped_pack(
    state: State<'_, DropState>,
    id: u64,
) -> AppResult<crate::media::pack::CheckedPack> {
    let path =
        state.0.lock().unwrap().take(id).ok_or_else(|| {
            AppError::InvalidInput("that dropped file is no longer available".into())
        })?;
    tauri::async_runtime::spawn_blocking(move || crate::media::pack::read_pack(&path))
        .await
        .map_err(|e| AppError::InvalidInput(format!("pack task failed: {e}")))?
}
