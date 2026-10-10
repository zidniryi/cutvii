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

/// Where the last successful export was written. Kept in Rust so the webview can ask to reveal *that*
/// file, never an arbitrary path.
#[derive(Default)]
pub struct LastExport(pub Mutex<Option<PathBuf>>);

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
    if let Ok(Some(report)) = &result {
        *app.state::<LastExport>().0.lock().unwrap() = Some(PathBuf::from(&report.path));
    }
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

/// Arguments for the platform's file manager to show `path` selected (macOS/Windows) or its folder (Linux).
pub fn reveal_command(path: &std::path::Path) -> (&'static str, Vec<std::ffi::OsString>) {
    if cfg!(target_os = "macos") {
        ("open", vec!["-R".into(), path.into()])
    } else if cfg!(target_os = "windows") {
        let mut arg = std::ffi::OsString::from("/select,");
        arg.push(path);
        ("explorer", vec![arg])
    } else {
        ("xdg-open", vec![path.parent().unwrap_or(path).into()])
    }
}

/// Show the last exported file in Finder / Explorer / the file manager.
#[tauri::command]
pub fn reveal_last_export(last: State<'_, LastExport>) -> AppResult<()> {
    let path =
        last.0.lock().unwrap().clone().ok_or_else(|| {
            AppError::InvalidInput("there is no exported file to show yet".into())
        })?;
    if !path.exists() {
        return Err(AppError::InvalidInput(
            "the exported file is no longer there (moved or deleted)".into(),
        ));
    }
    let (program, args) = reveal_command(&path);
    // argument vector, no shell; only a failure to start the file manager counts as an error
    std::process::Command::new(program).args(args).spawn()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reveal_uses_the_platform_file_manager_without_a_shell() {
        let (program, args) = reveal_command(std::path::Path::new("/out/My Movie.mp4"));
        if cfg!(target_os = "macos") {
            assert_eq!(program, "open");
            assert_eq!(
                args,
                vec![std::ffi::OsString::from("-R"), "/out/My Movie.mp4".into()]
            );
        } else if cfg!(target_os = "windows") {
            assert_eq!(program, "explorer");
            assert_eq!(args.len(), 1); // the path with spaces stays one argument
        } else {
            assert_eq!(program, "xdg-open");
            assert_eq!(args, vec![std::ffi::OsString::from("/out")]);
        }
    }
}
