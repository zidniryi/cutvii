//! Speech to text with Whisper (whisper.cpp, built into the app; MIT). Everything runs on this machine.
//!
//! Models are never bundled: the user downloads one, after agreeing to it, into the app data folder.
//! Automated tests never download a model; the one test that runs a real transcription only does so when
//! `CUTVII_WHISPER_MODEL` and `CUTVII_WHISPER_AUDIO` point at files that are already on disk.

use std::fs;
use std::io::{Read, Write};
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use super::tools::command;
use crate::errors::{AppError, AppResult};

/// Whisper wants 16 kHz mono.
pub const SAMPLE_RATE: u32 = 16_000;
/// Longest stretch transcribed in one go (the audio is held in memory: about 230 MB per hour).
pub const MAX_SECONDS: f64 = 2.0 * 3600.0;
/// Set to any value to keep speech recognition off the GPU.
pub const CPU_ENV: &str = "CUTVII_WHISPER_CPU";
/// First bytes of a ggml model file (the magic number 0x67676d6c, little-endian).
const GGML_MAGIC: [u8; 4] = [0x6c, 0x6d, 0x67, 0x67];
/// A model smaller than this is not a real model (an error page, a truncated file).
const MIN_MODEL_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Clone, Copy)]
pub struct ModelSpec {
    pub id: &'static str,
    pub label: &'static str,
    /// Shown before the download, so the user knows what they agree to.
    pub approx_mb: u32,
    pub file: &'static str,
    pub url: &'static str,
    /// Exact size and SHA-256 of the published file. whisper.cpp loads a truncated model without complaint
    /// and then writes nonsense, so nothing but the exact file is accepted.
    pub bytes: u64,
    pub sha256: &'static str,
}

/// The multilingual models offered, smallest first. They come from the whisper.cpp project's own
/// repository on Hugging Face.
pub const MODELS: &[ModelSpec] = &[
    ModelSpec {
        id: "tiny",
        label: "Tiny (fastest, least accurate)",
        approx_mb: 75,
        file: "ggml-tiny.bin",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
        bytes: 77_691_713,
        sha256: "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
    },
    ModelSpec {
        id: "base",
        label: "Base (fast, good for clear speech)",
        approx_mb: 142,
        file: "ggml-base.bin",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
        bytes: 147_951_465,
        sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
    },
    ModelSpec {
        id: "small",
        label: "Small (slower, more accurate)",
        approx_mb: 466,
        file: "ggml-small.bin",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
        bytes: 487_601_967,
        sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
    },
];

pub fn model_spec(id: &str) -> AppResult<&'static ModelSpec> {
    MODELS
        .iter()
        .find(|m| m.id == id)
        .ok_or_else(|| AppError::InvalidInput(format!("unknown speech model \"{id}\"")))
}

/// Whether `path` looks like a usable model: big enough and starting with the ggml magic number.
pub fn is_model_file(path: &Path) -> bool {
    let mut magic = [0u8; 4];
    fs::metadata(path).is_ok_and(|m| m.len() >= MIN_MODEL_BYTES)
        && fs::File::open(path)
            .and_then(|mut f| f.read_exact(&mut magic))
            .is_ok()
        && magic == GGML_MAGIC
}

/// Whether the file at `path` is this model, complete: a model file of exactly the published size. (The
/// checksum is verified once, when it is downloaded.)
pub fn is_installed(spec: &ModelSpec, path: &Path) -> bool {
    is_model_file(path) && fs::metadata(path).is_ok_and(|m| m.len() == spec.bytes)
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub id: String,
    pub label: String,
    pub approx_mb: u32,
    /// Where it is downloaded from, shown to the user before they agree.
    pub source: String,
    pub installed: bool,
}

pub fn model_statuses(dir: &Path) -> Vec<ModelStatus> {
    MODELS
        .iter()
        .map(|m| ModelStatus {
            id: m.id.into(),
            label: m.label.into(),
            approx_mb: m.approx_mb,
            source: m.url.into(),
            installed: is_installed(m, &dir.join(m.file)),
        })
        .collect()
}

/// Download `url` to `out` through a temp file. `progress` gets (bytes so far, total if known). A cancelled
/// or failed download, a file that is not a model, or one whose size or SHA-256 differs from `expected`,
/// leaves nothing behind and never replaces `out`.
pub fn download_model(
    url: &str,
    out: &Path,
    expected: Option<(u64, &str)>,
    progress: &mut dyn FnMut(u64, Option<u64>),
    cancel: &AtomicBool,
) -> AppResult<()> {
    let failed = |what: String| AppError::InvalidInput(format!("the download failed: {what}"));
    if let Some(parent) = out.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = out.with_extension(format!("part-{}", std::process::id()));
    let result = (|| -> AppResult<()> {
        let mut response = ureq::get(url).call().map_err(|e| failed(e.to_string()))?;
        let total = response.body().content_length();
        let mut reader = response.body_mut().as_reader();
        let mut file = fs::File::create(&tmp)?;
        let mut buf = vec![0u8; 256 * 1024];
        let mut received = 0u64;
        let mut hasher = Sha256::new();
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err(AppError::Cancelled);
            }
            let n = reader.read(&mut buf).map_err(|e| failed(e.to_string()))?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n])?;
            hasher.update(&buf[..n]);
            received += n as u64;
            progress(received, total);
        }
        file.sync_all()?;
        drop(file);
        if total.is_some_and(|t| t != received) {
            return Err(failed(
                "the connection ended before the file was complete".into(),
            ));
        }
        if !is_model_file(&tmp) {
            return Err(failed("what arrived is not a speech model".into()));
        }
        if let Some((bytes, sha256)) = expected {
            let digest: String = hasher
                .finalize()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect();
            if received != bytes || !digest.eq_ignore_ascii_case(sha256) {
                return Err(failed(
                    "the file does not match the published model (wrong size or checksum)".into(),
                ));
            }
        }
        fs::rename(&tmp, out)?;
        Ok(())
    })();
    if result.is_err() {
        fs::remove_file(&tmp).ok();
    }
    result
}

/// Decode `[start, start + seconds)` of the first audio stream of `src` to 16 kHz mono samples.
pub fn read_samples(ffmpeg: &Path, src: &Path, start: f64, seconds: f64) -> AppResult<Vec<f32>> {
    if !(start >= 0.0 && seconds > 0.0) {
        return Err(AppError::InvalidInput("invalid range".into()));
    }
    if seconds > MAX_SECONDS {
        return Err(AppError::InvalidInput(
            "at most two hours can be transcribed at once; split the clip first".into(),
        ));
    }
    let mut child = command(ffmpeg)
        .args(["-v", "error", "-nostdin", "-ss"])
        .arg(format!("{start:.6}"))
        .arg("-t")
        .arg(format!("{seconds:.6}"))
        .arg("-i")
        .arg(src)
        .args(["-map", "0:a:0", "-vn", "-ac", "1", "-ar"])
        .arg(SAMPLE_RATE.to_string())
        .args(["-f", "f32le", "-"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let mut bytes = Vec::new();
    let read = child
        .stdout
        .take()
        .map(|mut out| out.read_to_end(&mut bytes));
    let status = child.wait()?;
    read.transpose()?;
    if !status.success() || bytes.len() < 4 {
        return Err(AppError::InvalidInput(
            "there is no sound to transcribe in that clip".into(),
        ));
    }
    Ok(bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect())
}

/// One stretch of speech. Times are seconds from the start of the audio that was transcribed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Segment {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

/// What Whisper writes for silence, music and noises ("[BLANK_AUDIO]", "(music)", "♪"): not speech.
pub fn is_speech(text: &str) -> bool {
    let t = text.trim();
    let bracketed =
        (t.starts_with('[') && t.ends_with(']')) || (t.starts_with('(') && t.ends_with(')'));
    !t.is_empty() && !bracketed && t.chars().any(|c| c.is_alphanumeric())
}

/// Tidy raw segments: trim, drop non-speech and empty ones, keep them in order inside `[0, length]`.
pub fn clean_segments(raw: Vec<Segment>, length: f64) -> Vec<Segment> {
    raw.into_iter()
        .filter(|s| is_speech(&s.text))
        .filter_map(|s| {
            let start = s.start.clamp(0.0, length);
            let end = s.end.clamp(0.0, length);
            (end - start > 0.05).then(|| Segment {
                start,
                end,
                text: s.text.trim().to_string(),
            })
        })
        .collect()
}

/// whisper.cpp asks this between steps; `flag` points at the caller's cancel flag.
unsafe extern "C" fn abort_requested(flag: *mut std::ffi::c_void) -> bool {
    // SAFETY: see the call site in `transcribe`: the pointer is a live `AtomicBool`.
    unsafe { &*(flag as *const AtomicBool) }.load(Ordering::Relaxed)
}

/// Transcribe 16 kHz mono `samples` with the model at `model`. `language` is a code such as "en" or "id";
/// `None` lets Whisper detect it. `progress` gets 0..=100; set `cancel` to stop early.
pub fn transcribe(
    model: &Path,
    samples: &[f32],
    language: Option<&str>,
    progress: Box<dyn FnMut(i32) + 'static>,
    cancel: Arc<AtomicBool>,
) -> AppResult<Vec<Segment>> {
    let failed = |what: &str, e: whisper_rs::WhisperError| {
        AppError::InvalidInput(format!("speech recognition {what}: {e}"))
    };
    if !is_model_file(model) {
        return Err(AppError::InvalidInput(
            "the speech model is missing or damaged; download it again".into(),
        ));
    }
    // The GPU is used where the build supports it; `CUTVII_WHISPER_CPU=1` forces the CPU (slower, but a
    // way out when a graphics driver misbehaves).
    let mut context_params = WhisperContextParameters::default();
    if std::env::var_os(CPU_ENV).is_some() {
        context_params.use_gpu = false;
    }
    // whisper.cpp is chatty on stderr; route its log lines to the (silent by default) log hooks
    whisper_rs::install_logging_hooks();
    let context = WhisperContext::new_with_params(model, context_params)
        .map_err(|e| failed("could not load the model", e))?;
    let mut state = context
        .create_state()
        .map_err(|e| failed("could not start", e))?;

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(language);
    params.set_translate(false);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_progress_callback_safe(progress);
    // The crate's safe abort hook (whisper-rs 0.16) reads its closure through the wrong pointer type, which
    // aborts every run. The raw hook with a plain flag behind the pointer does the same job correctly.
    // SAFETY: `cancel` is an `Arc` this function holds until after `state.full` has returned, so the
    // pointer stays valid for every call whisper.cpp makes; the hook only reads an atomic.
    unsafe {
        params.set_abort_callback(Some(abort_requested));
        params.set_abort_callback_user_data(Arc::as_ptr(&cancel) as *mut std::ffi::c_void);
    }

    let ran = state.full(params, samples);
    if cancel.load(Ordering::Relaxed) {
        return Err(AppError::Cancelled);
    }
    ran.map_err(|e| failed("failed", e))?;

    let raw: Vec<Segment> = state
        .as_iter()
        .map(|segment| Segment {
            // whisper counts in hundredths of a second
            start: segment.start_timestamp() as f64 / 100.0,
            end: segment.end_timestamp() as f64 / 100.0,
            text: segment
                .to_str_lossy()
                .map(|t| t.into_owned())
                .unwrap_or_default(),
        })
        .collect();
    let heard = non_speech_note(&raw);
    let segments = clean_segments(raw, samples.len() as f64 / SAMPLE_RATE as f64);
    match heard {
        Some(note) if segments.is_empty() => Err(AppError::InvalidInput(note)),
        _ => Ok(segments),
    }
}

/// When the model recognised something but none of it is words (it labels music as "[Music]" or "♪"),
/// say so: that is a different problem from a silent clip, and a larger model or naming the language
/// often helps with singing.
pub fn non_speech_note(raw: &[Segment]) -> Option<String> {
    let labels: Vec<&str> = raw
        .iter()
        .map(|s| s.text.trim())
        .filter(|t| !t.is_empty() && !is_speech(t))
        .collect();
    let first = labels.first()?;
    let label: String = first.chars().take(24).collect();
    Some(format!(
        "only music or other sounds were recognised, no words (the model heard \u{201c}{label}\u{201d}). \
         Singing is harder than speech: try the Small model and choose the language instead of Auto"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::net::TcpListener;
    use std::path::PathBuf;

    fn temp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("cutvii-whisper-{tag}-{}", std::process::id()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// A fake "model": the right first bytes and just over the minimum size.
    fn fake_model() -> Vec<u8> {
        let mut bytes = GGML_MAGIC.to_vec();
        bytes.resize(MIN_MODEL_BYTES as usize + 16, 7);
        bytes
    }

    /// Serve `body` once on a local port (nothing leaves this machine). Returns the URL.
    fn serve(body: Vec<u8>, claim_length: Option<usize>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/model.bin", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut lines = BufReader::new(stream.try_clone().unwrap()).lines();
            while lines.next().is_some_and(|l| l.is_ok_and(|l| !l.is_empty())) {}
            let length = claim_length.unwrap_or(body.len());
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n"
            )
            .ok();
            stream.write_all(&body).ok();
        });
        url
    }

    #[test]
    fn models_are_known_by_id_and_recognised_by_their_first_bytes() {
        assert_eq!(
            MODELS.iter().map(|m| m.id).collect::<Vec<_>>(),
            ["tiny", "base", "small"]
        );
        assert!(
            MODELS
                .iter()
                .all(|m| m.url.starts_with("https://") && m.url.ends_with(m.file))
        );
        assert!(model_spec("large-v9").is_err());

        let dir = temp("magic");
        let good = dir.join("ggml-tiny.bin");
        fs::write(&good, fake_model()).unwrap();
        assert!(is_model_file(&good));
        let small = dir.join("small.bin");
        fs::write(&small, GGML_MAGIC).unwrap();
        assert!(!is_model_file(&small), "too small to be a model");
        let wrong = dir.join("wrong.bin");
        fs::write(&wrong, vec![b'<'; MIN_MODEL_BYTES as usize + 1]).unwrap();
        assert!(!is_model_file(&wrong), "an error page is not a model");
        assert!(!is_model_file(&dir.join("missing.bin")));

        let statuses = model_statuses(&dir);
        // a model-looking file of the wrong size (truncated, or another model) does not count as installed
        assert!(statuses.iter().all(|s| !s.installed));
        assert!(is_installed(
            &ModelSpec {
                bytes: fake_model().len() as u64,
                ..*model_spec("tiny").unwrap()
            },
            &good
        ));
        assert!(
            MODELS
                .iter()
                .all(|m| m.sha256.len() == 64 && m.bytes > MIN_MODEL_BYTES)
        );
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_download_arrives_whole_or_not_at_all() {
        let dir = temp("download");
        let out = dir.join("models").join("ggml-tiny.bin");
        let never = AtomicBool::new(false);
        let model = fake_model();
        let total = model.len() as u64;
        let sha: String = Sha256::digest(&model)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let get = |body: Vec<u8>, claim: Option<usize>, expected: Option<(u64, &str)>| {
            download_model(&serve(body, claim), &out, expected, &mut |_, _| {}, &never)
                .map_err(|e| e.to_string())
        };

        let mut seen = Vec::new();
        download_model(
            &serve(model.clone(), None),
            &out,
            Some((total, &sha)),
            &mut |got, all| seen.push((got, all)),
            &never,
        )
        .unwrap();
        assert_eq!(fs::read(&out).unwrap(), model);
        assert_eq!(
            seen.last(),
            Some(&(total, Some(total))),
            "progress reaches the end"
        );
        assert!(seen.windows(2).all(|w| w[0].0 < w[1].0), "and only goes up");
        let files = || fs::read_dir(out.parent().unwrap()).unwrap().count();
        assert_eq!(files(), 1, "no temp file left");

        // something that is not a model never replaces a good one
        assert!(
            get(b"<html>not found</html>".to_vec(), None, None)
                .unwrap_err()
                .contains("not a speech model")
        );
        // a connection that ends early
        assert!(
            get(model.clone(), Some(model.len() * 2), None)
                .unwrap_err()
                .contains("download failed")
        );
        // a different file of the right kind: one byte changed, or a few bytes short
        let mut altered = model.clone();
        altered[100] ^= 1;
        assert!(
            get(altered, None, Some((total, &sha)))
                .unwrap_err()
                .contains("does not match")
        );
        let short = model[..model.len() - 8].to_vec();
        assert!(
            get(short, None, Some((total, &sha)))
                .unwrap_err()
                .contains("does not match")
        );
        // cancelled part-way
        let cancel = AtomicBool::new(false);
        let r = download_model(
            &serve(model.clone(), None),
            &out,
            None,
            &mut |_, _| cancel.store(true, Ordering::Relaxed),
            &cancel,
        );
        assert!(matches!(r, Err(AppError::Cancelled)));
        // nobody listening
        assert!(
            download_model(
                "http://127.0.0.1:9/none.bin",
                &out,
                None,
                &mut |_, _| {},
                &never
            )
            .is_err()
        );

        assert_eq!(
            fs::read(&out).unwrap(),
            model,
            "the good model is untouched"
        );
        assert_eq!(files(), 1);
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn only_speech_becomes_segments() {
        for noise in [
            "",
            "  ",
            "[BLANK_AUDIO]",
            " (music) ",
            "♪♪",
            "...",
            "[ Silence ]",
        ] {
            assert!(!is_speech(noise), "{noise:?}");
        }
        for speech in ["Hello.", " Selamat datang ", "5 menit", "(well) I think so"] {
            assert!(is_speech(speech), "{speech:?}");
        }
        let seg = |start: f64, end: f64, text: &str| Segment {
            start,
            end,
            text: text.into(),
        };
        let cleaned = clean_segments(
            vec![
                seg(0.0, 1.5, " Hello there. "),
                seg(1.5, 3.0, "[BLANK_AUDIO]"),
                seg(3.0, 3.02, "uh"),
                seg(4.0, 12.0, "Past the end"),
                seg(11.0, 12.0, "Entirely past the end"),
            ],
            10.0,
        );
        assert_eq!(
            cleaned,
            vec![
                seg(0.0, 1.5, "Hello there."),
                seg(4.0, 10.0, "Past the end")
            ]
        );
    }

    #[test]
    fn a_missing_or_damaged_model_is_reported_before_anything_runs() {
        let dir = temp("nomodel");
        let bad = dir.join("ggml-tiny.bin");
        fs::write(&bad, b"nope").unwrap();
        for model in [bad.clone(), dir.join("absent.bin")] {
            let e = transcribe(
                &model,
                &[0.0; 16_000],
                None,
                Box::new(|_| {}),
                Arc::new(AtomicBool::new(false)),
            )
            .unwrap_err()
            .to_string();
            assert!(e.contains("missing or damaged"), "{e}");
        }
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn music_only_results_are_explained_instead_of_looking_like_silence() {
        let seg = |text: &str| Segment {
            start: 0.0,
            end: 5.0,
            text: text.into(),
        };
        let note = non_speech_note(&[seg(" [Music] "), seg("(applause)")]).unwrap();
        assert!(
            note.contains("[Music]") && note.contains("Small model"),
            "{note}"
        );
        assert!(non_speech_note(&[seg("  ♪  ")]).unwrap().contains("♪"));
        assert_eq!(
            non_speech_note(&[]),
            None,
            "nothing heard at all: a silent clip"
        );
        assert_eq!(non_speech_note(&[seg("Hello there.")]), None);
        assert_eq!(non_speech_note(&[seg("   ")]), None);
    }

    /// Runs a real transcription, but only with files that are already on this machine: set
    /// `CUTVII_WHISPER_MODEL` (a ggml model) and `CUTVII_WHISPER_AUDIO` (speech), and optionally
    /// `CUTVII_WHISPER_EXPECT` (a word that must be heard). Never downloads anything.
    #[test]
    fn real_speech_is_transcribed_when_a_model_is_provided() {
        let (Ok(model), Ok(audio)) = (
            std::env::var("CUTVII_WHISPER_MODEL"),
            std::env::var("CUTVII_WHISPER_AUDIO"),
        ) else {
            eprintln!(
                "SKIPPED: set CUTVII_WHISPER_MODEL and CUTVII_WHISPER_AUDIO to run a real transcription"
            );
            return;
        };
        let ffmpeg =
            crate::media::tools::locate_tool("ffmpeg", crate::media::tools::FFMPEG_ENV).unwrap();
        let samples = read_samples(&ffmpeg, Path::new(&audio), 0.0, 600.0).unwrap();
        assert!(
            samples.len() > SAMPLE_RATE as usize,
            "at least a second of sound"
        );
        let started = std::time::Instant::now();
        let segments = transcribe(
            Path::new(&model),
            &samples,
            Some("en"),
            Box::new(|_| {}),
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        let length = samples.len() as f64 / SAMPLE_RATE as f64;
        eprintln!(
            "TRANSCRIBED {length:.1}s in {:?}: {segments:?}",
            started.elapsed()
        );
        assert!(!segments.is_empty());
        assert!(segments.windows(2).all(|w| w[0].start <= w[1].start));
        assert!(
            segments
                .iter()
                .all(|s| s.start >= 0.0 && s.end <= length + 0.01 && s.end > s.start)
        );
        if let Ok(word) = std::env::var("CUTVII_WHISPER_EXPECT") {
            let heard = segments
                .iter()
                .map(|s| s.text.to_lowercase())
                .collect::<Vec<_>>()
                .join(" ");
            assert!(
                heard.contains(&word.to_lowercase()),
                "expected {word:?} in {heard:?}"
            );
        }
    }
}
