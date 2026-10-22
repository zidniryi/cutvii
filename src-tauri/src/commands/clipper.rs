//! Auto clips: find short, self-contained stretches in a long recording (engine only, no UI yet).
//!
//! `find_clips` transcribes the used range of a clip with the downloaded speech model (or reuses the cached
//! transcript), scores candidate windows with the documented rules and returns the best non-overlapping
//! ones. Nothing is written to the project and the media file is only read. It shares the one-AI-job guard
//! with downloads and subtitles, so `cancel_ai_job` stops it too.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use super::ai::{AiJob, models_dir};
use super::clip_tools::{allowed_source, derived_key};
use super::transcript::{TranscriptGrants, load};
use crate::errors::{AppError, AppResult};
use crate::media::clipper::{Placement, energy_envelope};
use crate::media::clipper_job::{
    CACHE_VERSION, ENERGY_STEP, FoundClips, Settings, Transcriber, Transcript, find_clips,
};
use crate::media::tools::{FFMPEG_ENV, locate_tool};
use crate::media::transcript_import;
use crate::media::whisper::{SAMPLE_RATE, is_installed, model_spec, read_samples, transcribe};

pub const CLIPS_EVENT: &str = "auto-clips-progress";

/// Longest and shortest clip length that can be asked for, in seconds.
const MIN_LENGTH: f64 = 5.0;
const MAX_LENGTH: f64 = 180.0;
const MAX_COUNT: usize = 20;
const MAX_EXCLUDE: usize = 200;

#[derive(Clone, Serialize)]
struct ClipsProgress {
    percent: i32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeSpan {
    pub start: f64,
    pub end: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindClipsRequest {
    /// The imported file and the part of it the timeline clip uses (source seconds).
    pub path: String,
    pub source_in: f64,
    pub source_out: f64,
    /// Where that timeline clip starts, and its speed; used to place each result on the timeline.
    pub timeline_start: f64,
    #[serde(default)]
    pub speed: Option<f64>,
    /// Reversed clips were not recognised forwards and are skipped.
    #[serde(default)]
    pub reversed: bool,
    /// Speech model; not needed when `transcript` is set.
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub language: Option<String>,
    /// Use this transcript file instead of speech recognition.
    #[serde(default)]
    pub transcript: Option<TranscriptRequest>,
    pub min_seconds: f64,
    pub max_seconds: f64,
    /// `None` = Auto.
    #[serde(default)]
    pub count: Option<usize>,
    /// Project frame rate: cut points snap outwards to whole frames.
    #[serde(default)]
    pub fps: Option<f64>,
    /// Spans (source seconds) already shown; "Find another" passes the ones on screen.
    #[serde(default)]
    pub exclude: Vec<TimeSpan>,
}

/// A transcript file the user chose, and how far to move its times.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptRequest {
    pub path: String,
    /// Seconds added to every time in the file.
    #[serde(default)]
    pub offset: f64,
}

/// Largest shift of an imported transcript, in seconds either way.
const MAX_OFFSET: f64 = 30.0;

/// Check everything the webview sent and turn it into engine settings.
pub fn validate(req: &FindClipsRequest) -> AppResult<Settings> {
    let bad = |m: &str| Err(AppError::InvalidInput(m.to_string()));
    if req.reversed {
        return bad("reversed clips are skipped: speech cannot be found in them");
    }
    if !(req.source_in.is_finite() && req.source_out.is_finite() && req.source_in >= 0.0)
        || req.source_out <= req.source_in
    {
        return bad("invalid range");
    }
    if !(req.timeline_start.is_finite() && req.timeline_start >= 0.0) {
        return bad("invalid timeline position");
    }
    let speed = req.speed.unwrap_or(1.0);
    if !(speed.is_finite() && (0.1..=10.0).contains(&speed)) {
        return bad("invalid speed");
    }
    if !(req.min_seconds.is_finite() && req.max_seconds.is_finite())
        || req.min_seconds < MIN_LENGTH
        || req.max_seconds > MAX_LENGTH
        || req.min_seconds >= req.max_seconds
    {
        return bad("the clip length must be between 5 and 180 seconds, shortest below longest");
    }
    if req.source_out - req.source_in < req.min_seconds {
        return bad("the recording is shorter than the shortest clip length");
    }
    if req.count.is_some_and(|n| n == 0 || n > MAX_COUNT) {
        return bad("the number of clips must be between 1 and 20");
    }
    if req
        .fps
        .is_some_and(|f| !(f.is_finite() && (1.0..=240.0).contains(&f)))
    {
        return bad("invalid frame rate");
    }
    if req.exclude.len() > MAX_EXCLUDE
        || req
            .exclude
            .iter()
            .any(|s| !(s.start.is_finite() && s.end.is_finite() && s.end > s.start))
    {
        return bad("invalid excluded spans");
    }
    if req
        .transcript
        .as_ref()
        .is_some_and(|t| !(t.offset.is_finite() && t.offset.abs() <= MAX_OFFSET))
    {
        return bad("the transcript offset must be between -30 and 30 seconds");
    }
    Ok(Settings {
        min_seconds: req.min_seconds,
        max_seconds: req.max_seconds,
        count: req.count,
        fps: req.fps,
        range_in: req.source_in,
        range_out: req.source_out,
        placement: Placement {
            timeline_start: req.timeline_start,
            source_in: req.source_in,
            speed,
        },
        exclude: req.exclude.iter().map(|s| (s.start, s.end)).collect(),
    })
}

/// Whisper behind the engine's [`Transcriber`] trait.
struct WhisperTranscriber {
    src: PathBuf,
    model_file: PathBuf,
    start: f64,
    seconds: f64,
    language: Option<String>,
}

impl Transcriber for WhisperTranscriber {
    fn transcribe(
        &self,
        progress: Box<dyn FnMut(i32) + 'static>,
        cancel: Arc<AtomicBool>,
    ) -> AppResult<Transcript> {
        let ffmpeg = locate_tool("ffmpeg", FFMPEG_ENV)?;
        let samples = read_samples(&ffmpeg, &self.src, self.start, self.seconds)?;
        let energy = energy_envelope(&samples, SAMPLE_RATE, ENERGY_STEP);
        let segments = transcribe(
            &self.model_file,
            &samples,
            self.language.as_deref(),
            progress,
            cancel,
        )?;
        Ok(Transcript {
            version: CACHE_VERSION,
            segments,
            energy,
        })
    }
}

/// An imported transcript file behind the engine's [`Transcriber`] trait. The file is parsed here, inside the
/// background job; the loudness (which the scoring needs) is read from the video's own sound.
struct ImportedTranscriber {
    src: PathBuf,
    bytes: Vec<u8>,
    offset: f64,
    start: f64,
    seconds: f64,
}

impl Transcriber for ImportedTranscriber {
    fn transcribe(
        &self,
        mut progress: Box<dyn FnMut(i32) + 'static>,
        cancel: Arc<AtomicBool>,
    ) -> AppResult<Transcript> {
        let imported = transcript_import::parse(&self.bytes)?;
        let segments = transcript_import::to_range(
            &imported.segments,
            self.offset,
            self.start,
            self.start + self.seconds,
        );
        if segments.is_empty() {
            return Err(AppError::InvalidInput(
                "the transcript has no lines inside the part of the video you are using; check the offset"
                    .into(),
            ));
        }
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            return Err(AppError::Cancelled);
        }
        let ffmpeg = locate_tool("ffmpeg", FFMPEG_ENV)?;
        let samples = read_samples(&ffmpeg, &self.src, self.start, self.seconds)?;
        progress(100);
        Ok(Transcript {
            version: CACHE_VERSION,
            segments,
            energy: energy_envelope(&samples, SAMPLE_RATE, ENERGY_STEP),
        })
    }
}

/// Find clip candidates in the used range of an imported file. Progress arrives as `auto-clips-progress`
/// events while the speech model runs (none when the transcript is already cached).
#[tauri::command]
pub async fn find_clips_in_media(
    app: AppHandle,
    job: State<'_, AiJob>,
    grants: State<'_, TranscriptGrants>,
    request: FindClipsRequest,
) -> AppResult<FoundClips> {
    let settings = validate(&request)?;
    let src = allowed_source(&app, &request.path)?;
    if request
        .language
        .as_deref()
        .is_some_and(|l| !(2..=3).contains(&l.len()) || !l.bytes().all(|b| b.is_ascii_lowercase()))
    {
        return Err(AppError::InvalidInput("unknown language".into()));
    }
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::InvalidInput(format!("no cache directory: {e}")))?
        .join("auto-clips");
    // The transcript depends on the file, the range and where it came from, and on nothing else. A
    // transcript file is part of the key by its content hash and its offset.
    let (key, transcriber): (String, Box<dyn Transcriber + Send>) = match &request.transcript {
        Some(t) => {
            let (info, bytes) = load(&grants, &t.path)?;
            let key = derived_key(
                &src,
                &format!(
                    "autoclips-v{CACHE_VERSION}|file|{}|{:.3}|{:.3}|{:.3}",
                    info.hash, t.offset, request.source_in, request.source_out
                ),
            )?;
            (
                key,
                Box::new(ImportedTranscriber {
                    src: src.clone(),
                    bytes,
                    offset: t.offset,
                    start: request.source_in,
                    seconds: request.source_out - request.source_in,
                }),
            )
        }
        None => {
            let spec = model_spec(&request.model)?;
            let model_file = models_dir(&app)?.join(spec.file);
            if !is_installed(spec, &model_file) {
                return Err(AppError::InvalidInput(
                    "that speech model is not downloaded yet".into(),
                ));
            }
            let key = derived_key(
                &src,
                &format!(
                    "autoclips-v{CACHE_VERSION}|{:.3}|{:.3}|{}|{}",
                    request.source_in,
                    request.source_out,
                    request.model,
                    spec.language(request.language.as_deref()).unwrap_or("auto")
                ),
            )?;
            (
                key,
                Box::new(WhisperTranscriber {
                    src,
                    model_file,
                    start: request.source_in,
                    seconds: request.source_out - request.source_in,
                    language: spec.language(request.language.as_deref()).map(Into::into),
                }),
            )
        }
    };
    let cache_file = cache_dir.join(format!("{key}.json"));

    let cancel = job.start()?;
    let events = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        find_clips(
            &cache_file,
            transcriber.as_ref(),
            &settings,
            Box::new(move |percent| {
                events.emit(CLIPS_EVENT, ClipsProgress { percent }).ok();
            }),
            &cancel,
        )
    })
    .await;
    job.finish();
    result.map_err(|e| AppError::InvalidInput(format!("clip search task failed: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> FindClipsRequest {
        FindClipsRequest {
            path: "a.mp4".into(),
            source_in: 0.0,
            source_out: 600.0,
            timeline_start: 5.0,
            speed: None,
            reversed: false,
            model: "base".into(),
            language: None,
            transcript: None,
            min_seconds: 30.0,
            max_seconds: 60.0,
            count: None,
            fps: Some(30.0),
            exclude: vec![],
        }
    }

    #[test]
    fn a_good_request_becomes_settings_with_speed_one_by_default() {
        let s = validate(&request()).unwrap();
        assert_eq!(s.placement.speed, 1.0);
        assert_eq!((s.range_in, s.range_out), (0.0, 600.0));
    }

    #[test]
    fn bad_requests_are_rejected() {
        let cases: Vec<(&str, FindClipsRequest)> = vec![
            (
                "reversed",
                FindClipsRequest {
                    reversed: true,
                    ..request()
                },
            ),
            (
                "range",
                FindClipsRequest {
                    source_out: 0.0,
                    ..request()
                },
            ),
            (
                "nan",
                FindClipsRequest {
                    source_in: f64::NAN,
                    ..request()
                },
            ),
            (
                "speed",
                FindClipsRequest {
                    speed: Some(0.0),
                    ..request()
                },
            ),
            (
                "order",
                FindClipsRequest {
                    min_seconds: 60.0,
                    max_seconds: 30.0,
                    ..request()
                },
            ),
            (
                "too long",
                FindClipsRequest {
                    max_seconds: 600.0,
                    ..request()
                },
            ),
            (
                "short recording",
                FindClipsRequest {
                    source_out: 20.0,
                    ..request()
                },
            ),
            (
                "offset",
                FindClipsRequest {
                    transcript: Some(TranscriptRequest {
                        path: "t.srt".into(),
                        offset: 31.0,
                    }),
                    ..request()
                },
            ),
            (
                "count",
                FindClipsRequest {
                    count: Some(0),
                    ..request()
                },
            ),
            (
                "many",
                FindClipsRequest {
                    count: Some(99),
                    ..request()
                },
            ),
            (
                "fps",
                FindClipsRequest {
                    fps: Some(-1.0),
                    ..request()
                },
            ),
            (
                "span",
                FindClipsRequest {
                    exclude: vec![TimeSpan {
                        start: 5.0,
                        end: 1.0,
                    }],
                    ..request()
                },
            ),
        ];
        for (name, r) in cases {
            assert!(validate(&r).is_err(), "{name} should be rejected");
        }
    }
}
