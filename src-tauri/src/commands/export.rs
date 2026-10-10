use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::errors::{AppError, AppResult};
use crate::export::{ExportOptions, ExportReport, prepare_plan};
use crate::media::ffmpeg::FfmpegBackend;
use crate::media::{MediaBackend, RenderRequest};
use crate::project::Project;

pub const PROGRESS_EVENT: &str = "export-progress";

/// The cancel flag of the export in flight (at most one at a time).
#[derive(Default)]
pub struct ExportJob(pub Mutex<Option<Arc<AtomicBool>>>);

#[derive(Clone, Serialize)]
struct Progress {
    fraction: f64,
}

/// Plan -> ask where to save (native dialog, so the webview never picks the path) -> render with progress.
/// Returns `None` when the user dismisses the save dialog.
#[tauri::command]
pub async fn export_project(
    app: AppHandle,
    job: State<'_, ExportJob>,
    project: Project,
    options: ExportOptions,
) -> AppResult<Option<ExportReport>> {
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut slot = job.0.lock().unwrap();
        if slot.is_some() {
            return Err(AppError::InvalidInput(
                "an export is already running".into(),
            ));
        }
        *slot = Some(Arc::clone(&cancel));
    }
    let result = run(&app, project, options, cancel).await;
    *job.0.lock().unwrap() = None;
    result
}

async fn run(
    app: &AppHandle,
    project: Project,
    options: ExportOptions,
    cancel: Arc<AtomicBool>,
) -> AppResult<Option<ExportReport>> {
    let backend = Arc::new(FfmpegBackend::locate()?);

    // validate everything up front so mistakes surface before the save dialog
    let scope = app.asset_protocol_scope();
    let plan = {
        let backend = Arc::clone(&backend);
        let name = project.name.clone();
        let format = options.format;
        tauri::async_runtime::spawn_blocking(move || {
            prepare_plan(&project, &options, backend.as_ref(), &|p| {
                scope.is_allowed(p)
            })
            .map(|plan| (plan, name, format))
        })
        .await
        .map_err(|e| AppError::InvalidInput(format!("export planning failed: {e}")))??
    };
    let (plan, name, format) = plan;

    let output: Option<PathBuf> = {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            app.dialog()
                .file()
                .add_filter(format.label(), &[format.extension()])
                .set_file_name(format!("{name}.{}", format.extension()))
                .blocking_save_file()
                .and_then(|p| p.into_path().ok())
        })
        .await
        .map_err(|e| AppError::InvalidInput(format!("file picker failed: {e}")))?
    };
    let Some(mut output) = output else {
        return Ok(None);
    };
    if output.extension().is_none() {
        output.set_extension(format.extension());
    }

    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut emit = |fraction: f64| {
            app.emit(PROGRESS_EVENT, Progress { fraction }).ok();
        };
        backend
            .render(&RenderRequest { plan, output }, &mut emit, &cancel)
            .map(Some)
    })
    .await
    .map_err(|e| AppError::InvalidInput(format!("export task failed: {e}")))?
}

/// Ask the running export (if any) to stop. Safe to call at any time.
#[tauri::command]
pub fn cancel_export(job: State<'_, ExportJob>) {
    if let Some(flag) = job.0.lock().unwrap().as_ref() {
        flag.store(true, Ordering::Relaxed);
    }
}
