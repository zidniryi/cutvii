//! Voice-over from text (see `media/tts.rs`). The model is downloaded only after the user agreed in the UI;
//! the text never leaves this computer. The result is a WAV file in the app data folder.

use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use super::ai::{AiJob, DOWNLOAD_EVENT, models_dir};
use super::export::safe_file_stem;
use crate::errors::{AppError, AppResult};
use crate::media::tts::{
    LANGUAGES, MAX_TEXT_CHARS, MODELS, Model, SOURCE, SPEED, Speaker, VOICES, file_url, has_file,
    load_voice, model, write_wav,
};
use crate::media::whisper::download_file;

pub const TTS_EVENT: &str = "tts-progress";
/// The id the download's `ai-download` events carry.
pub const DOWNLOAD_ID: &str = "tts";

#[derive(Clone, Serialize)]
struct TtsProgress {
    fraction: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    id: String,
    received: u64,
    total: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Choice {
    pub id: String,
    pub label: String,
}

/// One size of the voice model and whether it is on this machine.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsModelStatus {
    pub id: String,
    pub label: String,
    pub hint: String,
    /// Size of the download in bytes.
    pub bytes: u64,
    /// The hosts it is downloaded from, shown before the user agrees.
    pub hosts: Vec<String>,
    pub installed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsStatus {
    pub models: Vec<TtsModelStatus>,
    /// The model's own page.
    pub source: String,
    pub voices: Vec<Choice>,
    pub languages: Vec<Choice>,
    pub max_chars: usize,
    pub min_speed: f32,
    pub default_speed: f32,
    pub max_speed: f32,
}

fn dir(app: &AppHandle, model: &Model) -> AppResult<PathBuf> {
    Ok(models_dir(app)?.join("tts").join(model.id))
}

/// The page a file comes from, without the pinned version: `host/owner/repository`.
fn origin(url: &str) -> String {
    url.trim_start_matches("https://")
        .split('/')
        .take(3)
        .collect::<Vec<_>>()
        .join("/")
}

fn choices(list: &[(&str, &str)]) -> Vec<Choice> {
    list.iter()
        .map(|(id, label)| Choice {
            id: id.to_string(),
            label: label.to_string(),
        })
        .collect()
}

/// The voice models on offer, whether each is on this machine, and the voices and languages they speak.
#[tauri::command]
pub fn tts_status(app: AppHandle) -> AppResult<TtsStatus> {
    let mut models = Vec::new();
    for m in MODELS {
        let mut hosts: Vec<String> = m.files().map(|f| origin(f.from)).collect();
        hosts.dedup();
        models.push(TtsModelStatus {
            id: m.id.to_string(),
            label: m.label.to_string(),
            hint: m.hint.to_string(),
            bytes: m.total_bytes(),
            hosts,
            installed: m.is_installed(&dir(&app, m)?),
        });
    }
    Ok(TtsStatus {
        models,
        source: SOURCE.to_string(),
        voices: choices(VOICES),
        languages: choices(LANGUAGES),
        max_chars: MAX_TEXT_CHARS,
        min_speed: SPEED.0,
        default_speed: SPEED.1,
        max_speed: SPEED.2,
    })
}

/// Download a voice model into the app data folder. Called only after the user agreed. Every file is
/// checked against its published size and SHA-256; files already there are kept, so a download that was
/// stopped goes on where it left off. Progress arrives as `ai-download` events with the id `tts`;
/// `cancel_ai_job` stops it.
#[tauri::command]
pub async fn download_tts_model(
    app: AppHandle,
    job: State<'_, AiJob>,
    id: String,
) -> AppResult<()> {
    let spec = model(&id)?;
    let dir = dir(&app, spec)?;
    if spec.is_installed(&dir) {
        return Ok(());
    }
    let cancel = job.start()?;
    let events = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let total = spec.total_bytes();
        let mut done = 0u64;
        for file in spec.files() {
            if !has_file(&dir, file) {
                download_file(
                    &file_url(file),
                    &dir.join(file.path),
                    Some((file.bytes, file.sha256)),
                    false,
                    &mut |received, _| {
                        events
                            .emit(
                                DOWNLOAD_EVENT,
                                DownloadProgress {
                                    id: DOWNLOAD_ID.to_string(),
                                    received: done + received,
                                    total: Some(total),
                                },
                            )
                            .ok();
                    },
                    &cancel,
                )?;
            }
            done += file.bytes;
        }
        Ok(())
    })
    .await;
    job.finish();
    result.map_err(|e| AppError::InvalidInput(format!("download task failed: {e}")))?
}

/// Remove a downloaded voice model from this machine.
#[tauri::command]
pub fn delete_tts_model(app: AppHandle, id: String) -> AppResult<()> {
    match fs::remove_dir_all(dir(&app, model(&id)?)?) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
        _ => Ok(()),
    }
}

/// A voice-over that was made: the sound file and its length in seconds.
#[derive(Debug, Serialize)]
pub struct Spoken {
    pub path: String,
    pub duration: f64,
}

/// Speak `text` with a downloaded model (`model_id`) and write (or reuse) a WAV file in the app data folder.
/// `language` and `voice` are ids from `tts_status`. Progress arrives as `tts-progress` events;
/// `cancel_ai_job` stops it and leaves nothing behind.
#[tauri::command]
pub async fn speak_text(
    app: AppHandle,
    job: State<'_, AiJob>,
    model_id: String,
    text: String,
    language: String,
    voice: String,
    speed: f32,
) -> AppResult<Spoken> {
    let spec = model(&model_id)?;
    let model = dir(&app, spec)?;
    if !spec.is_installed(&model) {
        return Err(AppError::InvalidInput(
            "that voice model is not downloaded yet".into(),
        ));
    }
    let speed = (speed * 100.0).round() / 100.0;
    let mut hasher = DefaultHasher::new();
    (
        "voiceover-v1",
        spec.id,
        &text,
        &language,
        &voice,
        (speed * 100.0) as i32,
    )
        .hash(&mut hasher);
    let out = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::InvalidInput(format!("no data directory: {e}")))?
        .join("voiceover")
        // the clip on the timeline is called after its file: the first words, then the key
        .join(format!(
            "{} {:08x}.wav",
            safe_file_stem(&text.chars().take(28).collect::<String>()),
            hasher.finish() as u32
        ));
    let scope = app.asset_protocol_scope();
    let cancel = job.start()?;
    let events = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        // the WAV header says how long a file made earlier is: 16-bit mono, 44 bytes before the samples
        let reused = fs::metadata(&out)
            .ok()
            .filter(|m| m.len() > 44)
            .and_then(|m| {
                let bytes = fs::read(&out).ok()?;
                let rate = u32::from_le_bytes(bytes.get(24..28)?.try_into().ok()?);
                (rate > 0).then(|| (m.len() - 44) as f64 / 2.0 / rate as f64)
            });
        let duration = match reused {
            Some(seconds) => seconds,
            None => {
                let mut speaker = Speaker::load(&model, spec)?;
                let style = load_voice(&model, &voice)?;
                let samples = speaker.speak(
                    &text,
                    &language,
                    &style,
                    speed,
                    &mut |fraction| {
                        events.emit(TTS_EVENT, TtsProgress { fraction }).ok();
                    },
                    &cancel,
                )?;
                write_wav(&out, &samples, speaker.sample_rate())?;
                samples.len() as f64 / speaker.sample_rate() as f64
            }
        };
        scope.allow_file(&out).map_err(|e| {
            AppError::InvalidInput(format!("could not enable playback of the voice-over: {e}"))
        })?;
        Ok(Spoken {
            path: out.to_string_lossy().into_owned(),
            duration,
        })
    })
    .await;
    job.finish();
    result.map_err(|e| AppError::InvalidInput(format!("voice-over task failed: {e}")))?
}
