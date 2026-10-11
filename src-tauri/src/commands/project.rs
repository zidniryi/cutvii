use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::errors::{AppError, AppResult};
use crate::project::Project;
use crate::project::persistence::{self, FILE_EXTENSION};

/// The file the current project lives in. Set only by the native dialogs below, so the webview can
/// never ask us to write to an arbitrary path.
#[derive(Default)]
pub struct CurrentProjectPath(pub Mutex<Option<PathBuf>>);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedProject {
    pub path: String,
    pub project: Project,
    /// Asset paths that no longer exist on disk (offered for relink).
    pub missing_paths: Vec<String>,
}

fn display(p: &std::path::Path) -> String {
    p.to_string_lossy().into_owned()
}

/// Native "Open project" dialog -> parse, migrate, validate. `None` when the user cancels.
#[tauri::command]
pub async fn open_project(
    app: AppHandle,
    state: State<'_, CurrentProjectPath>,
) -> AppResult<Option<OpenedProject>> {
    let picked = {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            app.dialog()
                .file()
                .add_filter("CutVii project", &[FILE_EXTENSION])
                .blocking_pick_file()
        })
        .await
        .map_err(|e| AppError::InvalidInput(format!("file picker failed: {e}")))?
    };
    let Some(path) = picked.and_then(|p| p.into_path().ok()) else {
        return Ok(None);
    };

    let read_path = path.clone();
    let mut project =
        tauri::async_runtime::spawn_blocking(move || persistence::read_project(&read_path))
            .await
            .map_err(|e| AppError::InvalidInput(format!("open failed: {e}")))??;

    // text pictures that are gone are drawn again before anything is reported missing
    if let Ok(data) = app.path().app_data_dir() {
        project = tauri::async_runtime::spawn_blocking(move || {
            persistence::restore_text_pictures(&mut project, &data);
            project
        })
        .await
        .map_err(|e| AppError::InvalidInput(format!("open failed: {e}")))?;
    }
    let missing_paths = persistence::missing_paths(&project);
    persistence::drop_stale_thumbnails(&mut project);

    // Re-grant preview access to the media this project references (and only that).
    let scope = app.asset_protocol_scope();
    for asset in project
        .assets
        .iter()
        .filter(|a| !missing_paths.contains(&a.path))
    {
        scope.allow_file(&asset.path).ok();
    }

    *state.0.lock().unwrap() = Some(path.clone());
    Ok(Some(OpenedProject {
        path: display(&path),
        project,
        missing_paths,
    }))
}

/// Save to the current file, or ask for one (`save_as`, or no file yet). Returns the saved path,
/// or `None` when the user cancels the dialog.
#[tauri::command]
pub async fn save_project(
    app: AppHandle,
    state: State<'_, CurrentProjectPath>,
    project: Project,
    save_as: bool,
) -> AppResult<Option<String>> {
    let current = state.0.lock().unwrap().clone();
    let target = match (save_as, current) {
        (false, Some(p)) => p,
        _ => {
            let app = app.clone();
            let name = format!("{}.{FILE_EXTENSION}", project.name);
            let picked = tauri::async_runtime::spawn_blocking(move || {
                app.dialog()
                    .file()
                    .add_filter("CutVii project", &[FILE_EXTENSION])
                    .set_file_name(name)
                    .blocking_save_file()
            })
            .await
            .map_err(|e| AppError::InvalidInput(format!("file picker failed: {e}")))?;
            let Some(mut p) = picked.and_then(|p| p.into_path().ok()) else {
                return Ok(None);
            };
            if p.extension().is_none() {
                p.set_extension(FILE_EXTENSION);
            }
            p
        }
    };

    let write_path = target.clone();
    tauri::async_runtime::spawn_blocking(move || {
        persistence::write_project_atomic(&write_path, &project)
    })
    .await
    .map_err(|e| AppError::InvalidInput(format!("save failed: {e}")))??;

    *state.0.lock().unwrap() = Some(target.clone());
    Ok(Some(display(&target)))
}

/// A new, unsaved project has no file yet.
#[tauri::command]
pub fn forget_project_path(state: State<'_, CurrentProjectPath>) {
    *state.0.lock().unwrap() = None;
}
