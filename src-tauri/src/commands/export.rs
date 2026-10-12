use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
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

pub const BATCH_PROGRESS_EVENT: &str = "export-clips-progress";
/// Most files one batch may write.
const MAX_BATCH: usize = 50;

#[derive(Clone, Serialize)]
struct BatchProgress {
    /// Which file is being written (0-based) out of `total`, and how far it is (0..=1).
    index: usize,
    total: usize,
    fraction: f64,
}

/// One file of a batch: a small project holding just that clip, and the title its file is named after.
#[derive(Debug, Deserialize)]
pub struct BatchItem {
    pub title: String,
    pub project: Project,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchFile {
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report: Option<ExportReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchReport {
    pub folder: String,
    pub files: Vec<BatchFile>,
    /// The user stopped the batch; files written before that are kept.
    pub cancelled: bool,
}

/// A title as a file name: no path separators, control or reserved characters, not empty, not too long.
/// The webview's text never becomes a path on its own; it is only ever a name inside the chosen folder.
pub fn safe_file_stem(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => ' ',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    let joined = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed: String = joined.trim_matches(['.', ' ']).chars().take(60).collect();
    let trimmed = trimmed.trim_end_matches(['.', ' ']).to_string();
    if trimmed.is_empty() {
        "Clip".to_string()
    } else {
        trimmed
    }
}

/// File names for a batch: numbered in order, from the titles, each different from the others and from
/// anything `taken` says is already in the folder (nothing is ever overwritten).
pub fn batch_file_names(
    titles: &[String],
    extension: &str,
    taken: &dyn Fn(&str) -> bool,
) -> Vec<String> {
    let mut used: Vec<String> = Vec::new();
    for (i, title) in titles.iter().enumerate() {
        let stem = format!("{:02} {}", i + 1, safe_file_stem(title));
        let mut name = format!("{stem}.{extension}");
        let mut n = 2;
        while taken(&name) || used.iter().any(|u| u.eq_ignore_ascii_case(&name)) {
            name = format!("{stem} ({n}).{extension}");
            n += 1;
        }
        used.push(name);
    }
    used
}

/// Export several small projects (one per clip) into a folder the user picks once. Every project is
/// validated before the folder is asked for. Files are named from the titles and never overwrite anything.
/// A file that fails is reported and the rest still run; cancelling keeps the files already written.
/// Returns `None` when the folder dialog is dismissed.
#[tauri::command]
pub async fn export_clips(
    app: AppHandle,
    job: State<'_, ExportJob>,
    items: Vec<BatchItem>,
    options: ExportOptions,
) -> AppResult<Option<BatchReport>> {
    if items.is_empty() || items.len() > MAX_BATCH {
        return Err(AppError::InvalidInput(format!(
            "a batch exports between 1 and {MAX_BATCH} clips"
        )));
    }
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
    let result = run_batch(&app, items, options, cancel).await;
    if let Ok(Some(report)) = &result
        && let Some(last) = report.files.iter().rev().find_map(|f| f.report.as_ref())
    {
        *app.state::<LastExport>().0.lock().unwrap() = Some(PathBuf::from(&last.path));
    }
    *job.0.lock().unwrap() = None;
    result
}

async fn run_batch(
    app: &AppHandle,
    items: Vec<BatchItem>,
    options: ExportOptions,
    cancel: Arc<AtomicBool>,
) -> AppResult<Option<BatchReport>> {
    let backend = Arc::new(FfmpegBackend::locate()?);
    let scope = app.asset_protocol_scope();
    let format = options.format;
    let planned = {
        let backend = Arc::clone(&backend);
        tauri::async_runtime::spawn_blocking(move || {
            items
                .into_iter()
                .map(|item| {
                    prepare_plan(&item.project, &options, backend.as_ref(), &|p| {
                        scope.is_allowed(p)
                    })
                    .map(|plan| (item.title, plan))
                })
                .collect::<AppResult<Vec<_>>>()
        })
        .await
        .map_err(|e| AppError::InvalidInput(format!("export planning failed: {e}")))??
    };

    let folder: Option<PathBuf> = {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            app.dialog()
                .file()
                .blocking_pick_folder()
                .and_then(|p| p.into_path().ok())
        })
        .await
        .map_err(|e| AppError::InvalidInput(format!("folder picker failed: {e}")))?
    };
    let Some(folder) = folder else {
        return Ok(None);
    };
    if !folder.is_dir() {
        return Err(AppError::InvalidInput("that folder does not exist".into()));
    }

    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let titles: Vec<String> = planned.iter().map(|(t, _)| t.clone()).collect();
        let names = batch_file_names(&titles, format.extension(), &|n| folder.join(n).exists());
        let total = planned.len();
        let mut files = Vec::with_capacity(total);
        let mut cancelled = false;
        for (index, ((title, plan), name)) in planned.into_iter().zip(names).enumerate() {
            if cancel.load(Ordering::Relaxed) {
                cancelled = true;
                break;
            }
            let mut emit = |fraction: f64| {
                app.emit(
                    BATCH_PROGRESS_EVENT,
                    BatchProgress {
                        index,
                        total,
                        fraction,
                    },
                )
                .ok();
            };
            let output = folder.join(name);
            match backend.render(&RenderRequest { plan, output }, &mut emit, &cancel) {
                Ok(report) => files.push(BatchFile {
                    title,
                    report: Some(report),
                    error: None,
                }),
                Err(AppError::Cancelled) => {
                    cancelled = true;
                    break;
                }
                Err(e) => files.push(BatchFile {
                    title,
                    report: None,
                    error: Some(e.to_string()),
                }),
            }
        }
        Ok(Some(BatchReport {
            folder: folder.to_string_lossy().into_owned(),
            files,
            cancelled,
        }))
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
    fn titles_become_safe_file_names() {
        assert_eq!(safe_file_stem("Why it works?"), "Why it works");
        assert_eq!(safe_file_stem("../../etc/passwd"), "etc passwd");
        assert_eq!(safe_file_stem("a\\b:c*d\"e<f>g|h"), "a b c d e f g h");
        assert_eq!(safe_file_stem("  ...  "), "Clip");
        assert_eq!(safe_file_stem("line\nbreak\ttab"), "line break tab");
        assert_eq!(safe_file_stem(&"x".repeat(200)).chars().count(), 60);
        assert_eq!(safe_file_stem("Kenapa begitu, ya"), "Kenapa begitu, ya");
    }

    #[test]
    fn batch_names_are_numbered_unique_and_never_overwrite() {
        let titles = vec![
            "Same".to_string(),
            "Same".to_string(),
            "Other/one".to_string(),
        ];
        let names = batch_file_names(&titles, "mp4", &|_| false);
        assert_eq!(names, ["01 Same.mp4", "02 Same.mp4", "03 Other one.mp4"]);
        // a file with that name is already in the folder
        let names = batch_file_names(&titles, "mp4", &|n| {
            n == "01 Same.mp4" || n == "01 Same (2).mp4"
        });
        assert_eq!(names[0], "01 Same (3).mp4");
        assert!(names.iter().all(|n| !n.contains('/') && !n.contains("..")));
    }

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
