//! AI features that run on this machine. Speech-to-text (Whisper) needs a model the user downloads first:
//! the download only ever starts from the user's explicit choice in the UI, and nothing is uploaded.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use super::clip_tools::allowed_source;
use crate::errors::{AppError, AppResult};
use crate::media::tools::{FFMPEG_ENV, locate_tool};
use crate::media::whisper::{
    ModelStatus, Segment, download_model, is_installed, model_spec, model_statuses, read_samples,
    transcribe,
};

pub const DOWNLOAD_EVENT: &str = "ai-download";
pub const TRANSCRIBE_EVENT: &str = "ai-transcribe";

/// The one AI job that may run at a time (a download or a transcription), with its cancel flag.
#[derive(Default)]
pub struct AiJob(pub Mutex<Option<Arc<AtomicBool>>>);

impl AiJob {
    pub(crate) fn start(&self) -> AppResult<Arc<AtomicBool>> {
        let mut slot = self.0.lock().unwrap();
        if slot.is_some() {
            return Err(AppError::InvalidInput(
                "another AI task is still running; wait for it or cancel it".into(),
            ));
        }
        let flag = Arc::new(AtomicBool::new(false));
        *slot = Some(flag.clone());
        Ok(flag)
    }
    pub(crate) fn finish(&self) {
        *self.0.lock().unwrap() = None;
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    id: String,
    received: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    total: Option<u64>,
}

#[derive(Clone, Serialize)]
struct TranscribeProgress {
    percent: i32,
}

pub(crate) fn models_dir(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::InvalidInput(format!("no data directory: {e}")))?
        .join("models"))
}

/// The speech models on offer and whether each is on this machine.
#[tauri::command]
pub fn whisper_models(app: AppHandle) -> AppResult<Vec<ModelStatus>> {
    Ok(model_statuses(&models_dir(&app)?))
}

/// Download a speech model into the app data folder. Called only after the user agreed to the download.
/// Progress arrives as `ai-download` events; `cancel_ai_job` stops it and leaves nothing behind.
#[tauri::command]
pub async fn download_whisper_model(
    app: AppHandle,
    job: State<'_, AiJob>,
    id: String,
) -> AppResult<()> {
    let spec = model_spec(&id)?;
    let out = models_dir(&app)?.join(spec.file);
    if is_installed(spec, &out) {
        return Ok(());
    }
    let cancel = job.start()?;
    let events = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut last = 0u64;
        download_model(
            spec.url,
            &out,
            Some((spec.bytes, spec.sha256)),
            &mut |received, total| {
                // about one event per megabyte is plenty for a progress bar
                if received - last >= 1_000_000 || Some(received) == total {
                    last = received;
                    events
                        .emit(
                            DOWNLOAD_EVENT,
                            DownloadProgress {
                                id: id.clone(),
                                received,
                                total,
                            },
                        )
                        .ok();
                }
            },
            &cancel,
        )
    })
    .await;
    job.finish();
    result.map_err(|e| AppError::InvalidInput(format!("download task failed: {e}")))?
}

/// Stop the running download or transcription, if any.
#[tauri::command]
pub fn cancel_ai_job(job: State<'_, AiJob>) {
    if let Some(flag) = job.0.lock().unwrap().as_ref() {
        flag.store(true, Ordering::Relaxed);
    }
}

/// Remove a downloaded speech model from this machine.
#[tauri::command]
pub fn delete_whisper_model(app: AppHandle, id: String) -> AppResult<()> {
    let path = models_dir(&app)?.join(model_spec(&id)?.file);
    match std::fs::remove_file(&path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
        _ => Ok(()),
    }
}

/// Turn the speech in `[source_in, source_out)` of an imported file into text segments (times in seconds
/// from `source_in`). Runs entirely on this machine with a model the user downloaded. `language` is a code
/// such as "en" or "id"; `None` lets the model detect it. Progress arrives as `ai-transcribe` events.
#[tauri::command]
pub async fn transcribe_media(
    app: AppHandle,
    job: State<'_, AiJob>,
    path: String,
    source_in: f64,
    source_out: f64,
    model: String,
    language: Option<String>,
) -> AppResult<Vec<Segment>> {
    let src = allowed_source(&app, &path)?;
    if !(source_in >= 0.0 && source_out > source_in) {
        return Err(AppError::InvalidInput("invalid range".into()));
    }
    if language
        .as_deref()
        .is_some_and(|l| !(2..=3).contains(&l.len()) || !l.bytes().all(|b| b.is_ascii_lowercase()))
    {
        return Err(AppError::InvalidInput("unknown language".into()));
    }
    let spec = model_spec(&model)?;
    let model_file = models_dir(&app)?.join(spec.file);
    if !is_installed(spec, &model_file) {
        return Err(AppError::InvalidInput(
            "that speech model is not downloaded yet".into(),
        ));
    }
    let cancel = job.start()?;
    let events = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let ffmpeg = locate_tool("ffmpeg", FFMPEG_ENV)?;
        let samples = read_samples(&ffmpeg, &src, source_in, source_out - source_in)?;
        transcribe(
            &model_file,
            &samples,
            spec.language(language.as_deref()),
            Box::new(move |percent| {
                events
                    .emit(TRANSCRIBE_EVENT, TranscribeProgress { percent })
                    .ok();
            }),
            cancel,
        )
    })
    .await;
    job.finish();
    result.map_err(|e| AppError::InvalidInput(format!("transcription task failed: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_one_ai_job_runs_at_a_time_and_it_can_be_cancelled() {
        let job = AiJob::default();
        let flag = job.start().unwrap();
        assert!(
            job.start()
                .unwrap_err()
                .to_string()
                .contains("still running")
        );
        assert!(!flag.load(Ordering::Relaxed));
        if let Some(f) = job.0.lock().unwrap().as_ref() {
            f.store(true, Ordering::Relaxed);
        }
        assert!(
            flag.load(Ordering::Relaxed),
            "the running task sees the cancel"
        );
        job.finish();
        assert!(
            !job.start().unwrap().load(Ordering::Relaxed),
            "a new job starts clean"
        );
    }
}
