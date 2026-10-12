//! Auto clips, engine part 2: the job that turns a recording into ranked clip candidates.
//!
//! Transcribing is the slow step, so its result (speech segments plus a loudness envelope) is cached under
//! a key built from the file, the range, the model and the language. Target length, clip count and the
//! scoring are NOT in that key: changing them re-scores the cached transcript in milliseconds and never
//! transcribes again. Candidates themselves are not cached for the same reason (scoring a ten-minute
//! transcript is far cheaper than keeping a second cache valid).
//!
//! Speech recognition sits behind [`Transcriber`], so the job is tested without a model.

use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};

use super::clipper::{
    CONFIG, Candidate, Config, Envelope, Placement, Reason, Sentence, Tier, auto_count, candidates,
    select, snap_to_frames, split_sentences, title_from,
};
use super::whisper::Segment;
use crate::errors::{AppError, AppResult};

/// Seconds per loudness frame stored with a transcript.
pub const ENERGY_STEP: f64 = 0.25;
/// Bumped when the stored transcript layout changes; an older file is ignored and rebuilt.
pub const CACHE_VERSION: u32 = 1;
/// A cache file larger than this is not trusted (a two-hour transcript is well under a megabyte).
const MAX_CACHE_BYTES: u64 = 16 * 1024 * 1024;
/// Title length, in words.
const TITLE_WORDS: usize = 6;

/// What the speech model produced for the range, times in seconds from its start.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Transcript {
    pub version: u32,
    pub segments: Vec<Segment>,
    /// RMS loudness per [`ENERGY_STEP`] seconds.
    pub energy: Vec<f32>,
}

/// Speech recognition for one fixed range of one file. `progress` gets 0..=100.
pub trait Transcriber {
    fn transcribe(
        &self,
        progress: Box<dyn FnMut(i32) + 'static>,
        cancel: Arc<AtomicBool>,
    ) -> AppResult<Transcript>;
}

/// What to look for, already validated by the command.
#[derive(Debug, Clone)]
pub struct Settings {
    pub min_seconds: f64,
    pub max_seconds: f64,
    /// `None` = Auto.
    pub count: Option<usize>,
    pub fps: Option<f64>,
    /// Source-file seconds of the transcribed range.
    pub range_in: f64,
    pub range_out: f64,
    pub placement: Placement,
    /// Spans already on screen (source-file seconds); candidates avoid them ("Find another").
    pub exclude: Vec<(f64, f64)>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    /// Stable for the same cut points, so the UI can keep selection and edits across re-scoring.
    pub id: String,
    pub title: String,
    pub text: String,
    /// Source-file seconds (frame-aligned when a frame rate was given).
    pub source_in: f64,
    pub source_out: f64,
    /// Where the clip's start would sit on the timeline, and how long it plays there (speed applied).
    pub timeline_start: f64,
    pub timeline_duration: f64,
    pub score: f64,
    pub tier: Tier,
    pub reasons: Vec<Reason>,
}

/// A sentence in source-file seconds, for the review transcript.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SentenceOut {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundClips {
    pub clips: Vec<Clip>,
    pub sentences: Vec<SentenceOut>,
    /// The transcript came from the cache: no speech recognition ran.
    pub from_cache: bool,
    /// Said when fewer clips than asked for could be found, or none.
    pub notice: Option<String>,
}

fn read_cached(path: &Path) -> Option<Transcript> {
    let meta = fs::metadata(path).ok()?;
    if meta.len() > MAX_CACHE_BYTES {
        return None;
    }
    let t: Transcript = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    let sane = t.version == CACHE_VERSION
        && t.segments
            .iter()
            .all(|s| s.start.is_finite() && s.end.is_finite() && s.end >= s.start)
        && t.energy.iter().all(|v| v.is_finite());
    sane.then_some(t)
}

/// Write through a temporary file so a crash or cancel never leaves a half-written cache entry.
fn write_cached(path: &Path, transcript: &Transcript) -> AppResult<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    let result = (|| {
        fs::write(
            &tmp,
            serde_json::to_vec(transcript).map_err(std::io::Error::other)?,
        )?;
        fs::rename(&tmp, path)?;
        AppResult::Ok(())
    })();
    if result.is_err() {
        fs::remove_file(&tmp).ok();
    }
    result
}

/// The transcript for `cache_file`: the stored one if it is valid, otherwise a fresh one that is stored.
/// Returns whether it came from the cache.
pub fn load_or_transcribe(
    cache_file: &Path,
    transcriber: &dyn Transcriber,
    progress: Box<dyn FnMut(i32) + 'static>,
    cancel: &Arc<AtomicBool>,
) -> AppResult<(Transcript, bool)> {
    if let Some(hit) = read_cached(cache_file) {
        return Ok((hit, true));
    }
    let transcript = transcriber.transcribe(progress, cancel.clone())?;
    if cancel.load(Ordering::Relaxed) {
        return Err(AppError::Cancelled);
    }
    // a failed cache write only costs a repeat transcription next time
    write_cached(cache_file, &transcript).ok();
    Ok((transcript, false))
}

/// Score a transcript and pick the clips. Pure and fast: this is what runs again when only the settings
/// change.
pub fn clips_from_transcript(
    transcript: &Transcript,
    settings: &Settings,
    cfg: &Config,
) -> (Vec<Clip>, Vec<Sentence>, Option<String>) {
    let length = settings.range_out - settings.range_in;
    let sentences = split_sentences(&transcript.segments, cfg);
    let envelope = Envelope::new(transcript.energy.clone(), ENERGY_STEP);
    let pool = candidates(
        &sentences,
        &envelope,
        length,
        settings.min_seconds,
        settings.max_seconds,
        cfg,
    );
    let taken: Vec<(f64, f64)> = settings
        .exclude
        .iter()
        .map(|(a, b)| (a - settings.range_in, b - settings.range_in))
        .collect();
    let (count, floor) = match settings.count {
        Some(n) => (n, None),
        None => (auto_count(length, cfg), Some(cfg.auto_min_score)),
    };
    let chosen = select(pool, count, &taken, floor);

    let clips: Vec<Clip> = chosen
        .iter()
        .map(|c| to_clip(c, &sentences, settings))
        .collect();
    let notice = if sentences.is_empty() {
        Some("No speech was found in this range.".to_string())
    } else if clips.is_empty() {
        Some("No stretch of speech fits the chosen length. Try a wider length range.".to_string())
    } else if settings.count.is_some_and(|n| clips.len() < n) {
        Some(format!(
            "Only {} clip{} found for this length.",
            clips.len(),
            if clips.len() == 1 { "" } else { "s" }
        ))
    } else {
        None
    };
    (clips, sentences, notice)
}

fn to_clip(c: &Candidate, sentences: &[Sentence], s: &Settings) -> Clip {
    let (source_in, source_out) = match s.fps {
        Some(fps) => snap_to_frames(
            s.range_in + c.start,
            s.range_in + c.end,
            fps,
            s.range_in,
            s.range_out,
        ),
        None => (s.range_in + c.start, s.range_in + c.end),
    };
    let text = sentences[c.first..=c.last]
        .iter()
        .map(|x| x.text.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    Clip {
        id: format!(
            "clip-{}-{}",
            (source_in * 1000.0).round() as i64,
            (source_out * 1000.0).round() as i64
        ),
        title: title_from(&sentences[c.first].text, TITLE_WORDS),
        text,
        source_in,
        source_out,
        timeline_start: s.placement.timeline_at(source_in),
        timeline_duration: (source_out - source_in) / s.placement.speed,
        score: c.score,
        tier: c.tier,
        reasons: c.reasons.clone(),
    }
}

/// The whole job: cached or fresh transcript, then candidates. `progress` gets the speech model's 0..=100
/// (it is not called on a cache hit; scoring takes milliseconds and has no progress of its own).
pub fn find_clips(
    cache_file: &Path,
    transcriber: &dyn Transcriber,
    settings: &Settings,
    progress: Box<dyn FnMut(i32) + 'static>,
    cancel: &Arc<AtomicBool>,
) -> AppResult<FoundClips> {
    let (transcript, from_cache) = load_or_transcribe(cache_file, transcriber, progress, cancel)?;
    if cancel.load(Ordering::Relaxed) {
        return Err(AppError::Cancelled);
    }
    let (clips, sentences, notice) = clips_from_transcript(&transcript, settings, &CONFIG);
    Ok(FoundClips {
        clips,
        sentences: sentences
            .iter()
            .map(|s| SentenceOut {
                start: settings.range_in + s.start,
                end: settings.range_in + s.end,
                text: s.text.clone(),
            })
            .collect(),
        from_cache,
        notice,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::path::PathBuf;

    fn temp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("cutvii-clipper-{tag}-{}", std::process::id()));
        fs::remove_dir_all(&d).ok();
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// Counts how often "speech recognition" ran; can be told to cancel while running.
    struct Fake {
        runs: Cell<u32>,
        transcript: Transcript,
        cancel_inside: bool,
    }

    impl Transcriber for Fake {
        fn transcribe(
            &self,
            mut progress: Box<dyn FnMut(i32) + 'static>,
            cancel: Arc<AtomicBool>,
        ) -> AppResult<Transcript> {
            self.runs.set(self.runs.get() + 1);
            progress(50);
            if self.cancel_inside {
                cancel.store(true, Ordering::Relaxed);
                return Err(AppError::Cancelled);
            }
            Ok(self.transcript.clone())
        }
    }

    fn fake(cancel_inside: bool) -> Fake {
        // 3 minutes: a 5 s sentence every 5.5 s, the first of each group of three a question
        let mut segments = Vec::new();
        let mut t = 0.0;
        for i in 0..32 {
            let text = if i % 3 == 0 {
                " Why does this keep happening to us?"
            } else {
                " It is a simple thing that people forget."
            };
            segments.push(Segment {
                start: t,
                end: t + 5.0,
                text: text.to_string(),
            });
            t += 5.5;
        }
        let frames = (t / ENERGY_STEP) as usize;
        let energy = (0..frames)
            .map(|i| if i % 2 == 0 { 0.1 } else { 0.25 })
            .collect();
        Fake {
            runs: Cell::new(0),
            transcript: Transcript {
                version: CACHE_VERSION,
                segments,
                energy,
            },
            cancel_inside,
        }
    }

    fn settings() -> Settings {
        Settings {
            min_seconds: 15.0,
            max_seconds: 30.0,
            count: Some(3),
            fps: Some(30.0),
            range_in: 100.0,
            range_out: 100.0 + 176.0,
            placement: Placement {
                timeline_start: 20.0,
                source_in: 100.0,
                speed: 2.0,
            },
            exclude: vec![],
        }
    }

    fn run(file: &Path, fake: &Fake, s: &Settings) -> AppResult<FoundClips> {
        find_clips(
            file,
            fake,
            s,
            Box::new(|_| {}),
            &Arc::new(AtomicBool::new(false)),
        )
    }

    #[test]
    fn a_second_run_reads_the_cache_and_changed_settings_do_not_transcribe_again() {
        let dir = temp("cache");
        let file = dir.join("t.json");
        let fake = fake(false);

        let first = run(&file, &fake, &settings()).unwrap();
        assert!(!first.from_cache);
        assert_eq!(fake.runs.get(), 1);
        assert_eq!(first.clips.len(), 3);

        // same settings, then another length and count: all from the cache
        let again = run(&file, &fake, &settings()).unwrap();
        assert!(again.from_cache);
        assert_eq!(again.clips, first.clips, "repeatable");
        let other = Settings {
            min_seconds: 30.0,
            max_seconds: 60.0,
            count: Some(2),
            ..settings()
        };
        let longer = run(&file, &fake, &other).unwrap();
        assert!(longer.from_cache);
        assert_eq!(longer.clips.len(), 2);
        assert!(
            longer
                .clips
                .iter()
                .all(|c| c.source_out - c.source_in >= 30.0)
        );
        assert_eq!(fake.runs.get(), 1, "transcribed once in total");
    }

    #[test]
    fn a_damaged_or_old_cache_entry_is_ignored_and_rebuilt() {
        let dir = temp("damaged");
        let file = dir.join("t.json");
        let fake = fake(false);
        fs::write(&file, b"{ not json").unwrap();
        assert!(!run(&file, &fake, &settings()).unwrap().from_cache);
        assert_eq!(fake.runs.get(), 1);
        // now valid again
        assert!(run(&file, &fake, &settings()).unwrap().from_cache);

        let mut old = fake.transcript.clone();
        old.version = CACHE_VERSION + 1;
        fs::write(&file, serde_json::to_vec(&old).unwrap()).unwrap();
        assert!(!run(&file, &fake, &settings()).unwrap().from_cache);
        assert_eq!(fake.runs.get(), 2);
    }

    #[test]
    fn cancelling_leaves_no_cache_entry_and_no_temporary_file() {
        let dir = temp("cancel");
        let file = dir.join("sub").join("t.json");
        let fake = fake(true);
        let err = run(&file, &fake, &settings()).unwrap_err();
        assert!(matches!(err, AppError::Cancelled));
        assert!(!file.exists());
        let leftovers = fs::read_dir(dir.join("sub"))
            .map(|d| d.count())
            .unwrap_or(0);
        assert_eq!(leftovers, 0, "nothing left behind");

        // a flag raised after the model returned also stops the job before anything is written
        let ok = Fake {
            cancel_inside: false,
            ..fake
        };
        let cancel = Arc::new(AtomicBool::new(true));
        let err = find_clips(&file, &ok, &settings(), Box::new(|_| {}), &cancel).unwrap_err();
        assert!(matches!(err, AppError::Cancelled));
        assert!(!file.exists());
    }

    #[test]
    fn clips_carry_source_times_and_timeline_placement_with_trim_and_speed() {
        let dir = temp("place");
        let found = run(&dir.join("t.json"), &fake(false), &settings()).unwrap();
        for c in &found.clips {
            // source times are file times inside the transcribed range, on whole frames
            assert!(c.source_in >= 100.0 && c.source_out <= 276.0);
            assert!((c.source_in * 30.0 - (c.source_in * 30.0).round()).abs() < 1e-6);
            assert!((c.source_out * 30.0 - (c.source_out * 30.0).round()).abs() < 1e-6);
            // clip sits at 20 s, plays at 2x
            assert!((c.timeline_start - (20.0 + (c.source_in - 100.0) / 2.0)).abs() < 1e-9);
            assert!((c.timeline_duration - (c.source_out - c.source_in) / 2.0).abs() < 1e-9);
            assert!(!c.title.is_empty() && c.title.split_whitespace().count() <= TITLE_WORDS);
        }
        // the transcript sentences are in file seconds too
        assert!(
            found
                .sentences
                .iter()
                .all(|s| s.start >= 100.0 && s.end <= 276.0 + 1e-9)
        );
    }

    #[test]
    fn excluded_spans_are_avoided_and_clips_never_overlap() {
        let dir = temp("exclude");
        let fake = fake(false);
        let base = run(&dir.join("t.json"), &fake, &settings()).unwrap();
        let taken: Vec<(f64, f64)> = base
            .clips
            .iter()
            .map(|c| (c.source_in, c.source_out))
            .collect();
        let another = Settings {
            count: Some(1),
            exclude: taken.clone(),
            ..settings()
        };
        let next = run(&dir.join("t.json"), &fake, &another).unwrap();
        assert_eq!(next.clips.len(), 1);
        let n = &next.clips[0];
        assert!(
            taken
                .iter()
                .all(|(a, b)| n.source_out <= *a || n.source_in >= *b)
        );
        for (i, a) in base.clips.iter().enumerate() {
            for b in &base.clips[i + 1..] {
                assert!(a.source_out <= b.source_in || b.source_out <= a.source_in);
            }
        }
    }

    #[test]
    fn an_empty_transcript_says_so_instead_of_returning_silently() {
        let dir = temp("empty");
        let mut f = fake(false);
        f.transcript.segments.clear();
        let found = run(&dir.join("t.json"), &f, &settings()).unwrap();
        assert!(found.clips.is_empty());
        assert!(found.notice.unwrap().contains("No speech"));
    }
}
