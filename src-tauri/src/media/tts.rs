//! Text to speech (voice-over) with Supertonic 3, on this computer: the text never leaves it.
//!
//! The model is Supertone's Supertonic 3 (code MIT, weights OpenRAIL-M; see `docs/licensing.md`): four ONNX
//! networks run with ONNX Runtime on the CPU, no phonemizer. It is never bundled: the user downloads the
//! official files after agreeing in the UI, each one checked against its published size and SHA-256.
//!
//! The steps follow the model's own example (`supertone-inc/supertonic`, `rust/src/helper.rs`): tidy the
//! text and wrap it in a language tag, turn its characters into ids, predict the length, encode the text,
//! refine noise into a latent in a fixed number of steps, and decode the latent into sound.

use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use ort::session::Session;
use ort::value::Tensor;
use serde::Deserialize;
use unicode_normalization::UnicodeNormalization;

use crate::errors::{AppError, AppResult};

/// Where the model comes from, shown before the user agrees to the download.
pub const SOURCE: &str = "https://huggingface.co/Supertone/supertonic-3";
/// Supertone's own files, at the exact published version the sizes and checksums below belong to.
const OFFICIAL: &str = "https://huggingface.co/Supertone/supertonic-3/resolve/3cadd1ee6394adea1bd021217a0e650ede09a323";
/// The two big networks made smaller (8-bit weights) by the sherpa-onnx project, a third party; pinned too.
const QUANTISED: &str = "https://huggingface.co/csukuangfj2/sherpa-onnx-supertonic-3-tts-int8-2026-05-11/resolve/cca5a0e6c96e1d2c720986bf7e75fcc81dee3ae4";

/// One file of a model: its place in the model folder, where it is fetched from, size and SHA-256.
pub struct ModelFile {
    pub path: &'static str,
    pub from: &'static str,
    pub remote: &'static str,
    pub bytes: u64,
    pub sha256: &'static str,
}

/// The files every size of the model shares: settings, the character table, the two small networks and
/// the ten voices.
const COMMON: &[ModelFile] = &[
    ModelFile {
        path: "onnx/tts.json",
        from: OFFICIAL,
        remote: "onnx/tts.json",
        bytes: 8_253,
        sha256: "42078d3aef1cd43ab43021f3c54f47d2d75ceb4e75f627f118890128b06a0d09",
    },
    ModelFile {
        path: "onnx/unicode_indexer.json",
        from: OFFICIAL,
        remote: "onnx/unicode_indexer.json",
        bytes: 277_676,
        sha256: "9bf7346e43883a81f8645c81224f786d43c5b57f3641f6e7671a7d6c493cb24f",
    },
    ModelFile {
        path: "onnx/duration_predictor.onnx",
        from: OFFICIAL,
        remote: "onnx/duration_predictor.onnx",
        bytes: 3_700_147,
        sha256: "c3eb91414d5ff8a7a239b7fe9e34e7e2bf8a8140d8375ffb14718b1c639325db",
    },
    ModelFile {
        path: "onnx/text_encoder.onnx",
        from: OFFICIAL,
        remote: "onnx/text_encoder.onnx",
        bytes: 36_416_150,
        sha256: "c7befd5ea8c3119769e8a6c1486c4edc6a3bc8365c67621c881bbb774b9902ff",
    },
    ModelFile {
        path: "voice_styles/F1.json",
        from: OFFICIAL,
        remote: "voice_styles/F1.json",
        bytes: 292_046,
        sha256: "bbdec6ee00231c2c742ad05483df5334cab3b52fda3ba38e6a07059c4563dbc2",
    },
    ModelFile {
        path: "voice_styles/F2.json",
        from: OFFICIAL,
        remote: "voice_styles/F2.json",
        bytes: 292_423,
        sha256: "7c722c6a72707b1a77f035d67f0d1351ba187738e06f7683e8c72b1df3477fc6",
    },
    ModelFile {
        path: "voice_styles/F3.json",
        from: OFFICIAL,
        remote: "voice_styles/F3.json",
        bytes: 290_794,
        sha256: "12f6ef2573baa2defa1128069cb59f203e3ab67c92af77b42df8a0e3a2f7c6ab",
    },
    ModelFile {
        path: "voice_styles/F4.json",
        from: OFFICIAL,
        remote: "voice_styles/F4.json",
        bytes: 291_808,
        sha256: "c2fa764c1225a76dfc3e2c73e8aa4f70d9ee48793860eb34c295fff01c2e032b",
    },
    ModelFile {
        path: "voice_styles/F5.json",
        from: OFFICIAL,
        remote: "voice_styles/F5.json",
        bytes: 291_479,
        sha256: "45966e73316415626cf41a7d1c6f3b4c70dbc1ba2bee5c1978ef0ce33244fc8d",
    },
    ModelFile {
        path: "voice_styles/M1.json",
        from: OFFICIAL,
        remote: "voice_styles/M1.json",
        bytes: 291_748,
        sha256: "e35604687f5d23694b8e91593a93eec0e4eca6c0b02bb8ed69139ab2ea6b0a5b",
    },
    ModelFile {
        path: "voice_styles/M2.json",
        from: OFFICIAL,
        remote: "voice_styles/M2.json",
        bytes: 292_055,
        sha256: "b76cbf62bac707c710cf0ae5aba5e31eea1a6339a9734bfae33ab98499534a50",
    },
    ModelFile {
        path: "voice_styles/M3.json",
        from: OFFICIAL,
        remote: "voice_styles/M3.json",
        bytes: 290_198,
        sha256: "ea1ac35ccb91b0d7ecad533a2fbd0eec10c91513d8951e3b25fbba99954e159b",
    },
    ModelFile {
        path: "voice_styles/M4.json",
        from: OFFICIAL,
        remote: "voice_styles/M4.json",
        bytes: 291_522,
        sha256: "ca8eefad4fcd989c9379032ff3e50738adc547eeb5e221b82593a6d7b3bac303",
    },
    ModelFile {
        path: "voice_styles/M5.json",
        from: OFFICIAL,
        remote: "voice_styles/M5.json",
        bytes: 291_469,
        sha256: "dd22b92740314321f8ae11c5e87f8dd60d060f15dd3a632b5adf77f471f77af2",
    },
];

/// A size of the voice model on offer. Each has its own folder, so either can be removed on its own.
pub struct Model {
    pub id: &'static str,
    pub label: &'static str,
    pub hint: &'static str,
    /// The two big networks, which are what differs between the sizes.
    networks: &'static [ModelFile],
}

pub const MODELS: &[Model] = &[
    Model {
        id: "supertonic-3",
        label: "Standard",
        hint: "Supertone's own files: the voice as its makers published it.",
        networks: &[
            ModelFile {
                path: "onnx/vector_estimator.onnx",
                from: OFFICIAL,
                remote: "onnx/vector_estimator.onnx",
                bytes: 256_534_781,
                sha256: "883ac868ea0275ef0e991524dc64f16b3c0376efd7c320af6b53f5b780d7c61c",
            },
            ModelFile {
                path: "onnx/vocoder.onnx",
                from: OFFICIAL,
                remote: "onnx/vocoder.onnx",
                bytes: 101_424_195,
                sha256: "085de76dd8e8d5836d6ca66826601f615939218f90e519f70ee8a36ed2a4c4ba",
            },
        ],
    },
    Model {
        id: "supertonic-3-int8",
        label: "Compact",
        hint: "The same voice with its two big networks made smaller by the sherpa-onnx project. A smaller download; the sound can be slightly rougher.",
        networks: &[
            ModelFile {
                path: "onnx/vector_estimator.onnx",
                from: QUANTISED,
                remote: "vector_estimator.int8.onnx",
                bytes: 78_400_833,
                sha256: "20cd86fa5c6effedfda0e7cffe5b0569ca401c440a0c3a1d72bf39286c0db3fd",
            },
            ModelFile {
                path: "onnx/vocoder.onnx",
                from: QUANTISED,
                remote: "vocoder.int8.onnx",
                bytes: 25_991_073,
                sha256: "e923d60f53f95eb1ce235f1dc33ec56d9c057823c96fa6f8acf98f32b0da6152",
            },
        ],
    },
];

pub fn model(id: &str) -> AppResult<&'static Model> {
    MODELS
        .iter()
        .find(|m| m.id == id)
        .ok_or_else(|| bad(format!("unknown voice model \"{id}\"")))
}

impl Model {
    pub fn files(&self) -> impl Iterator<Item = &'static ModelFile> {
        COMMON.iter().chain(self.networks.iter())
    }
    pub fn total_bytes(&self) -> u64 {
        self.files().map(|f| f.bytes).sum()
    }
    /// Whether every file of this model is in `dir`.
    pub fn is_installed(&self, dir: &Path) -> bool {
        self.files().all(|f| has_file(dir, f))
    }
}

/// The model's ten fixed voices: the file under `voice_styles/` and the name shown.
pub const VOICES: &[(&str, &str)] = &[
    ("F1", "Woman 1"),
    ("F2", "Woman 2"),
    ("F3", "Woman 3"),
    ("F4", "Woman 4"),
    ("F5", "Woman 5"),
    ("M1", "Man 1"),
    ("M2", "Man 2"),
    ("M3", "Man 3"),
    ("M4", "Man 4"),
    ("M5", "Man 5"),
];

/// The languages the model was published for. Indonesian and English first: the ones that were tried.
pub const LANGUAGES: &[(&str, &str)] = &[
    ("id", "Indonesian"),
    ("en", "English"),
    ("ar", "Arabic"),
    ("bg", "Bulgarian"),
    ("cs", "Czech"),
    ("da", "Danish"),
    ("de", "German"),
    ("el", "Greek"),
    ("es", "Spanish"),
    ("et", "Estonian"),
    ("fi", "Finnish"),
    ("fr", "French"),
    ("hi", "Hindi"),
    ("hr", "Croatian"),
    ("hu", "Hungarian"),
    ("it", "Italian"),
    ("ja", "Japanese"),
    ("ko", "Korean"),
    ("lt", "Lithuanian"),
    ("lv", "Latvian"),
    ("nl", "Dutch"),
    ("pl", "Polish"),
    ("pt", "Portuguese"),
    ("ro", "Romanian"),
    ("ru", "Russian"),
    ("sk", "Slovak"),
    ("sl", "Slovenian"),
    ("sv", "Swedish"),
    ("tr", "Turkish"),
    ("uk", "Ukrainian"),
    ("vi", "Vietnamese"),
];

/// The longest text one voice-over may have.
pub const MAX_TEXT_CHARS: usize = 5_000;
/// How fast the voice may speak; 1.05 is the model's own default.
pub const SPEED: (f32, f32, f32) = (0.7, 1.05, 1.6);
/// Refinement steps, the model's own default: more is slower, not clearly better.
pub const STEPS: usize = 8;
/// Silence between two pieces of a long text.
const PAUSE_SECONDS: f32 = 0.3;
/// A piece of text the model gets in one go (120 for Korean and Japanese), as in its example.
const MAX_CHUNK_CHARS: usize = 300;

pub fn file_url(file: &ModelFile) -> String {
    format!("{}/{}", file.from, file.remote)
}

/// Whether this one file is in `dir`, complete (the checksum was verified when it was downloaded).
pub fn has_file(dir: &Path, file: &ModelFile) -> bool {
    fs::metadata(dir.join(file.path)).is_ok_and(|m| m.is_file() && m.len() == file.bytes)
}

fn bad(message: impl Into<String>) -> AppError {
    AppError::InvalidInput(message.into())
}

fn failed(what: &str, e: ort::Error) -> AppError {
    AppError::InvalidInput(format!("text to speech {what}: {e}"))
}

// ---------------------------------------------------------------------------------------------------
// Text

const EMOJI: &[(u32, u32)] = &[
    (0x1F1E6, 0x1F1FF),
    (0x1F300, 0x1F8FF),
    (0x1F900, 0x1FAFF),
    (0x2600, 0x27BF),
];

/// Tidy text the way the model's example does and wrap it in the language tag the model expects.
pub fn prepare_text(text: &str, lang: &str) -> AppResult<String> {
    if !LANGUAGES.iter().any(|(code, _)| *code == lang) {
        return Err(bad(format!(
            "\"{lang}\" is not a language this voice speaks"
        )));
    }
    let mut out: String = text
        .nfkd()
        .filter(|c| {
            let n = *c as u32;
            !EMOJI.iter().any(|(from, to)| (*from..=*to).contains(&n))
        })
        .map(|c| match c {
            '–' | '‑' | '—' => '-',
            '\u{201C}' | '\u{201D}' => '"',
            '\u{2018}' | '\u{2019}' | '´' | '`' => '\'',
            '_' | '[' | ']' | '|' | '/' | '#' | '→' | '←' => ' ',
            c => c,
        })
        .filter(|c| !matches!(c, '♥' | '☆' | '♡' | '©' | '\\'))
        .collect();
    for (from, to) in [
        ("@", " at "),
        ("e.g.,", "for example, "),
        ("i.e.,", "that is, "),
    ] {
        out = out.replace(from, to);
    }
    out = out.split_whitespace().collect::<Vec<_>>().join(" ");
    for mark in [",", ".", "!", "?", ";", ":", "'"] {
        out = out.replace(&format!(" {mark}"), mark);
    }
    while out.contains("\"\"") {
        out = out.replace("\"\"", "\"");
    }
    while out.contains("''") {
        out = out.replace("''", "'");
    }
    if out.is_empty() {
        return Err(bad("there is no text to speak"));
    }
    const ENDINGS: &str = ".!?;:,'\")]}…。」』】〉》›»";
    if !out.ends_with(|c| ENDINGS.contains(c)) {
        out.push('.');
    }
    Ok(format!("<{lang}>{out}</{lang}>"))
}

/// Cut a long text into pieces of at most `max` characters: whole sentences where they fit, otherwise at
/// a space. Every word of the text is in exactly one piece, in order.
pub fn chunks(text: &str, max: usize) -> Vec<String> {
    let mut sentences: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut ended = false;
    for c in text.chars() {
        if ended && c.is_whitespace() {
            sentences.push(std::mem::take(&mut current));
        }
        ended = matches!(c, '.' | '!' | '?' | '…' | '\n');
        current.push(c);
    }
    sentences.push(current);

    let mut out: Vec<String> = Vec::new();
    let mut piece = String::new();
    let flush = |piece: &mut String, out: &mut Vec<String>| {
        if !piece.is_empty() {
            out.push(std::mem::take(piece));
        }
    };
    for sentence in sentences {
        let sentence = sentence.split_whitespace().collect::<Vec<_>>().join(" ");
        let length = sentence.chars().count();
        if length == 0 {
            continue;
        }
        if piece.chars().count() + 1 + length <= max {
            if !piece.is_empty() {
                piece.push(' ');
            }
            piece.push_str(&sentence);
            continue;
        }
        flush(&mut piece, &mut out);
        if length <= max {
            piece = sentence;
            continue;
        }
        // one sentence longer than a piece: word by word (a single endless word is cut where it must be)
        for word in sentence.split(' ') {
            if !piece.is_empty() && piece.chars().count() + 1 + word.chars().count() > max {
                flush(&mut piece, &mut out);
            }
            let letters: Vec<char> = word.chars().collect();
            for part in letters.chunks(max) {
                if !piece.is_empty() {
                    if piece.chars().count() + 1 + part.len() > max {
                        flush(&mut piece, &mut out);
                    } else {
                        piece.push(' ');
                    }
                }
                piece.extend(part);
            }
        }
    }
    flush(&mut piece, &mut out);
    out
}

// ---------------------------------------------------------------------------------------------------
// Noise

/// Small seeded generator of normally distributed numbers (xorshift, then Box-Muller). Seeded from the
/// text, so the same text and voice give the same sound every time.
pub struct Noise(u64);

impl Noise {
    pub fn new(seed: u64) -> Self {
        Self(seed | 1)
    }
    fn unit(&mut self) -> f64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        // 53 bits, never exactly 0
        ((self.0 >> 11) as f64 + 1.0) / (1u64 << 53) as f64
    }
    pub fn normal(&mut self) -> f32 {
        let (a, b) = (self.unit(), self.unit());
        ((-2.0 * a.ln()).sqrt() * (std::f64::consts::TAU * b).cos()) as f32
    }
}

/// FNV-1a: a seed that depends only on the text itself.
pub fn seed_of(text: &str) -> u64 {
    text.bytes().fold(0xcbf2_9ce4_8422_2325, |h, b| {
        (h ^ b as u64).wrapping_mul(0x100_0000_01b3)
    })
}

// ---------------------------------------------------------------------------------------------------
// Model

#[derive(Deserialize)]
struct Config {
    ae: AeConfig,
    ttl: TtlConfig,
}
#[derive(Deserialize)]
struct AeConfig {
    sample_rate: u32,
    base_chunk_size: usize,
}
#[derive(Deserialize)]
struct TtlConfig {
    chunk_compress_factor: usize,
    latent_dim: usize,
}

#[derive(Deserialize)]
struct StyleFile {
    style_ttl: StylePart,
    style_dp: StylePart,
}
#[derive(Deserialize)]
struct StylePart {
    data: Vec<Vec<Vec<f32>>>,
    dims: Vec<usize>,
}

/// One voice: the two style tensors a voice file holds, flattened.
pub struct Voice {
    ttl: ([usize; 3], Vec<f32>),
    dp: ([usize; 3], Vec<f32>),
}

fn style_part(part: StylePart) -> AppResult<([usize; 3], Vec<f32>)> {
    let flat: Vec<f32> = part.data.into_iter().flatten().flatten().collect();
    match part.dims[..] {
        [1, b, c] if b * c == flat.len() && flat.iter().all(|v| v.is_finite()) => {
            Ok(([1, b, c], flat))
        }
        _ => Err(bad(
            "the voice file is damaged; download the voice model again",
        )),
    }
}

/// Read one of the model's voices (`id` from `VOICES`) from the model folder.
pub fn load_voice(dir: &Path, id: &str) -> AppResult<Voice> {
    if !VOICES.iter().any(|(voice, _)| *voice == id) {
        return Err(bad(format!("unknown voice \"{id}\"")));
    }
    let text = fs::read(dir.join("voice_styles").join(format!("{id}.json")))?;
    let file: StyleFile = serde_json::from_slice(&text)
        .map_err(|_| bad("the voice file is damaged; download the voice model again"))?;
    Ok(Voice {
        ttl: style_part(file.style_ttl)?,
        dp: style_part(file.style_dp)?,
    })
}

/// The loaded model. Runs on the CPU.
pub struct Speaker {
    config: Config,
    /// Unicode code point -> the model's id for that character.
    indexer: Vec<i64>,
    duration: Session,
    encoder: Session,
    estimator: Session,
    vocoder: Session,
}

fn session(path: &Path) -> AppResult<Session> {
    Session::builder()
        .map_err(|e| failed("could not start", e))?
        .commit_from_file(path)
        .map_err(|e| failed("could not load the model", e))
}

fn tensor(shape: &[usize], data: Vec<f32>) -> AppResult<Tensor<f32>> {
    Tensor::from_array((shape.to_vec(), data)).map_err(|e| failed("failed", e))
}

fn id_tensor(shape: &[usize], data: Vec<i64>) -> AppResult<Tensor<i64>> {
    Tensor::from_array((shape.to_vec(), data)).map_err(|e| failed("failed", e))
}

impl Speaker {
    /// Load a model from its folder.
    pub fn load(dir: &Path, model: &Model) -> AppResult<Self> {
        if !model.is_installed(dir) {
            return Err(bad("the voice model is not downloaded yet"));
        }
        let onnx = dir.join("onnx");
        let damaged = |_| bad("the voice model is damaged; download it again");
        let config: Config =
            serde_json::from_slice(&fs::read(onnx.join("tts.json"))?).map_err(damaged)?;
        let indexer: Vec<i64> =
            serde_json::from_slice(&fs::read(onnx.join("unicode_indexer.json"))?)
                .map_err(damaged)?;
        if config.ae.sample_rate == 0 || config.ae.base_chunk_size == 0 {
            return Err(bad("the voice model is damaged; download it again"));
        }
        Ok(Self {
            config,
            indexer,
            duration: session(&onnx.join("duration_predictor.onnx"))?,
            encoder: session(&onnx.join("text_encoder.onnx"))?,
            estimator: session(&onnx.join("vector_estimator.onnx"))?,
            vocoder: session(&onnx.join("vocoder.onnx"))?,
        })
    }

    pub fn sample_rate(&self) -> u32 {
        self.config.ae.sample_rate
    }

    /// Speak one piece of text. Returns mono samples in -1..1.
    fn speak_piece(
        &mut self,
        piece: &str,
        lang: &str,
        voice: &Voice,
        speed: f32,
        cancel: &AtomicBool,
    ) -> AppResult<Vec<f32>> {
        let tagged = prepare_text(piece, lang)?;
        let ids: Vec<i64> = tagged
            .chars()
            .map(|c| self.indexer.get(c as usize).copied().unwrap_or(-1))
            .collect();
        let n = ids.len();
        let mask = vec![1f32; n];

        let seconds = {
            let outputs = self
                .duration
                .run(ort::inputs![
                    "text_ids" => id_tensor(&[1, n], ids.clone())?,
                    "style_dp" => tensor(&voice.dp.0, voice.dp.1.clone())?,
                    "text_mask" => tensor(&[1, 1, n], mask.clone())?,
                ])
                .map_err(|e| failed("failed", e))?;
            let (_, data) = outputs["duration"]
                .try_extract_tensor::<f32>()
                .map_err(|e| failed("failed", e))?;
            data.first().copied().unwrap_or(0.0) / speed
        };
        if !seconds.is_finite() || seconds <= 0.0 || seconds > 120.0 {
            return Err(bad("text to speech could not time this text"));
        }

        let (emb_shape, emb) = {
            let outputs = self
                .encoder
                .run(ort::inputs![
                    "text_ids" => id_tensor(&[1, n], ids)?,
                    "style_ttl" => tensor(&voice.ttl.0, voice.ttl.1.clone())?,
                    "text_mask" => tensor(&[1, 1, n], mask.clone())?,
                ])
                .map_err(|e| failed("failed", e))?;
            let (shape, data) = outputs["text_emb"]
                .try_extract_tensor::<f32>()
                .map_err(|e| failed("failed", e))?;
            let shape: Vec<usize> = shape.iter().map(|d| *d as usize).collect();
            (shape, data.to_vec())
        };

        let rate = self.config.ae.sample_rate as f32;
        let samples = (seconds * rate) as usize;
        let hop = self.config.ae.base_chunk_size * self.config.ttl.chunk_compress_factor;
        let frames = samples.div_ceil(hop).max(1);
        let channels = self.config.ttl.latent_dim * self.config.ttl.chunk_compress_factor;
        let mut noise = Noise::new(seed_of(&tagged));
        let mut latent: Vec<f32> = (0..channels * frames).map(|_| noise.normal()).collect();
        let latent_shape = [1, channels, frames];
        let latent_mask = vec![1f32; frames];

        for step in 0..STEPS {
            if cancel.load(Ordering::Relaxed) {
                return Err(AppError::Cancelled);
            }
            let outputs = self
                .estimator
                .run(ort::inputs![
                    "noisy_latent" => tensor(&latent_shape, latent)?,
                    "text_emb" => tensor(&emb_shape, emb.clone())?,
                    "style_ttl" => tensor(&voice.ttl.0, voice.ttl.1.clone())?,
                    "latent_mask" => tensor(&[1, 1, frames], latent_mask.clone())?,
                    "text_mask" => tensor(&[1, 1, n], mask.clone())?,
                    "current_step" => tensor(&[1], vec![step as f32])?,
                    "total_step" => tensor(&[1], vec![STEPS as f32])?,
                ])
                .map_err(|e| failed("failed", e))?;
            let (_, data) = outputs["denoised_latent"]
                .try_extract_tensor::<f32>()
                .map_err(|e| failed("failed", e))?;
            if data.len() != channels * frames {
                return Err(bad("text to speech gave sound of the wrong length"));
            }
            latent = data.to_vec();
        }

        let outputs = self
            .vocoder
            .run(ort::inputs!["latent" => tensor(&latent_shape, latent)?])
            .map_err(|e| failed("failed", e))?;
        let (_, wav) = outputs["wav_tts"]
            .try_extract_tensor::<f32>()
            .map_err(|e| failed("failed", e))?;
        Ok(wav[..samples.min(wav.len())].to_vec())
    }

    /// Speak `text` in language `lang` (a code from `LANGUAGES`) with `voice`. Long texts are spoken piece
    /// by piece with a short pause between. `progress` gets 0.0..=1.0; set `cancel` to stop early.
    pub fn speak(
        &mut self,
        text: &str,
        lang: &str,
        voice: &Voice,
        speed: f32,
        progress: &mut dyn FnMut(f64),
        cancel: &AtomicBool,
    ) -> AppResult<Vec<f32>> {
        if text.chars().count() > MAX_TEXT_CHARS {
            return Err(bad(format!(
                "the text is too long for one voice-over ({MAX_TEXT_CHARS} characters at most)"
            )));
        }
        if !(SPEED.0..=SPEED.2).contains(&speed) {
            return Err(bad("that speed is outside what the voice can do"));
        }
        let max = if lang == "ko" || lang == "ja" {
            120
        } else {
            MAX_CHUNK_CHARS
        };
        let pieces = chunks(text, max);
        if pieces.is_empty() {
            return Err(bad("there is no text to speak"));
        }
        let pause = (PAUSE_SECONDS * self.config.ae.sample_rate as f32) as usize;
        let mut out: Vec<f32> = Vec::new();
        progress(0.0);
        for (i, piece) in pieces.iter().enumerate() {
            if i > 0 {
                out.resize(out.len() + pause, 0.0);
            }
            out.extend(self.speak_piece(piece, lang, voice, speed, cancel)?);
            progress((i + 1) as f64 / pieces.len() as f64);
        }
        Ok(out)
    }
}

/// Write mono samples as a 16-bit WAV file, through a temp file so `out` is never half written.
pub fn write_wav(out: &Path, samples: &[f32], sample_rate: u32) -> AppResult<()> {
    let data_bytes = (samples.len() * 2) as u32;
    let mut bytes: Vec<u8> = Vec::with_capacity(44 + samples.len() * 2);
    bytes.extend(b"RIFF");
    bytes.extend((36 + data_bytes).to_le_bytes());
    bytes.extend(b"WAVEfmt ");
    bytes.extend(16u32.to_le_bytes());
    bytes.extend(1u16.to_le_bytes()); // PCM
    bytes.extend(1u16.to_le_bytes()); // mono
    bytes.extend(sample_rate.to_le_bytes());
    bytes.extend((sample_rate * 2).to_le_bytes());
    bytes.extend(2u16.to_le_bytes());
    bytes.extend(16u16.to_le_bytes());
    bytes.extend(b"data");
    bytes.extend(data_bytes.to_le_bytes());
    for sample in samples {
        bytes.extend(((sample.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
    }
    if let Some(parent) = out.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = out.with_extension(format!("part-{}", std::process::id()));
    if let Err(e) = fs::write(&tmp, bytes) {
        fs::remove_file(&tmp).ok();
        return Err(e.into());
    }
    fs::rename(&tmp, out)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_is_tidied_and_wrapped_in_its_language_tag() {
        assert_eq!(
            prepare_text("  Halo ,  dunia  ", "id").unwrap(),
            "<id>Halo, dunia.</id>"
        );
        assert_eq!(
            prepare_text("“Hi” — it’s me_😀 !", "en").unwrap(),
            "<en>\"Hi\" - it's me!</en>"
        );
        // letters with marks are split the way the model was trained (e + combining accent)
        assert_eq!(
            prepare_text("café?", "en").unwrap(),
            "<en>cafe\u{301}?</en>"
        );
        assert!(prepare_text("   ", "en").is_err());
        assert!(prepare_text("Hello", "xx").is_err());
    }

    #[test]
    fn long_text_is_cut_at_sentences_and_no_word_is_lost() {
        let text =
            "Satu dua tiga. Empat lima enam! Tujuh delapan sembilan sepuluh sebelas? Dua belas.";
        let pieces = chunks(text, 40);
        assert_eq!(
            pieces,
            vec![
                "Satu dua tiga. Empat lima enam!",
                "Tujuh delapan sembilan sepuluh sebelas?",
                "Dua belas."
            ]
        );
        assert!(pieces.iter().all(|p| p.chars().count() <= 40));
        // a sentence longer than a piece is cut at spaces, an endless word where it must be
        let long = format!("{} {}", "kata ".repeat(30).trim(), "x".repeat(50));
        let cut = chunks(&long, 20);
        assert!(cut.iter().all(|p| p.chars().count() <= 20));
        assert_eq!(cut.join(" ").replace(' ', ""), long.replace(' ', ""));
        assert_eq!(chunks("Pendek", 300), vec!["Pendek"]);
        assert!(chunks(" \n ", 300).is_empty());
    }

    #[test]
    fn noise_is_the_same_for_the_same_text_and_looks_normal() {
        let draw = |text: &str| {
            let mut noise = Noise::new(seed_of(text));
            (0..20_000).map(|_| noise.normal()).collect::<Vec<f32>>()
        };
        let a = draw("<id>Halo.</id>");
        assert_eq!(a, draw("<id>Halo.</id>"));
        assert_ne!(a, draw("<id>Halo!</id>"));
        let mean = a.iter().sum::<f32>() / a.len() as f32;
        let variance = a.iter().map(|v| (v - mean).powi(2)).sum::<f32>() / a.len() as f32;
        assert!(mean.abs() < 0.03, "mean {mean}");
        assert!((variance - 1.0).abs() < 0.05, "variance {variance}");
        assert!(a.iter().all(|v| v.is_finite()));
    }

    #[test]
    fn the_model_lists_are_complete_and_a_folder_counts_only_when_every_file_is_whole() {
        let [standard, compact] = MODELS else {
            panic!("two sizes are offered")
        };
        assert_eq!(standard.files().count(), 16);
        assert_eq!(standard.total_bytes(), 401_276_744);
        assert_eq!(compact.files().count(), 16);
        assert_eq!(compact.total_bytes(), 147_709_674);
        for m in MODELS {
            assert!(m.files().all(|f| f.sha256.len() == 64));
            for (id, _) in VOICES {
                assert!(
                    m.files()
                        .any(|f| f.path == format!("voice_styles/{id}.json"))
                );
            }
            // every address is pinned to one published version of one of the two known sources
            assert!(m.files().all(|f| {
                let url = file_url(f);
                url.starts_with("https://huggingface.co/Supertone/supertonic-3/resolve/3cadd1ee")
                    || url.starts_with("https://huggingface.co/csukuangfj2/sherpa-onnx-supertonic-3-tts-int8-2026-05-11/resolve/cca5a0e6")
            }));
        }
        assert!(model("supertonic-3-int8").is_ok() && model("other").is_err());
        let dir = std::env::temp_dir().join(format!("cutvii-tts-{}", std::process::id()));
        assert!(!standard.is_installed(&dir));
        assert!(Speaker::load(&dir, standard).is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_wav_file_has_the_right_header_and_clipped_samples() {
        let dir = std::env::temp_dir().join(format!("cutvii-tts-wav-{}", std::process::id()));
        let out = dir.join("voice.wav");
        write_wav(&out, &[0.0, 0.5, 2.0, -2.0], 44_100).unwrap();
        let bytes = fs::read(&out).unwrap();
        assert_eq!(bytes.len(), 44 + 8);
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(
            u32::from_le_bytes(bytes[24..28].try_into().unwrap()),
            44_100
        );
        let sample =
            |i: usize| i16::from_le_bytes(bytes[44 + i * 2..46 + i * 2].try_into().unwrap());
        assert_eq!(
            (sample(0), sample(1), sample(2), sample(3)),
            (0, 16383, 32767, -32767)
        );
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1); // no temp file left
        fs::remove_dir_all(&dir).ok();
    }

    /// Touches the network, so it only runs when asked: `cargo test tts_net -- --ignored`. Fetches the two
    /// smallest files of the model (under 300 KB) the way the app does and checks them.
    #[test]
    #[ignore = "downloads two small files from the model's page"]
    fn tts_net_small_files_arrive_and_match_their_checksums() {
        use crate::media::whisper::download_file;
        let dir = std::env::temp_dir().join(format!("cutvii-tts-net-{}", std::process::id()));
        let cancel = AtomicBool::new(false);
        for file in MODELS[0].files().take(2) {
            download_file(
                &file_url(file),
                &dir.join(file.path),
                Some((file.bytes, file.sha256)),
                false,
                &mut |_, _| {},
                &cancel,
            )
            .unwrap();
            assert!(has_file(&dir, file));
        }
        // a wrong checksum is refused and leaves nothing behind
        let wrong = dir.join("wrong.json");
        assert!(
            download_file(
                &file_url(&COMMON[0]),
                &wrong,
                Some((COMMON[0].bytes, COMMON[1].sha256)),
                false,
                &mut |_, _| {},
                &cancel
            )
            .is_err()
        );
        assert!(!wrong.exists());
        fs::remove_dir_all(&dir).ok();
    }

    /// Needs a real model: `CUTVII_TTS_DIR=<folder with onnx/ and voice_styles/> cargo test tts_real -- --ignored`
    /// (`CUTVII_TTS_MODEL=supertonic-3-int8` for the compact one).
    /// Writes `tts-id.wav` and `tts-en.wav` into `CUTVII_TTS_OUT` (or the temp folder). Never downloads.
    /// With `CUTVII_WHISPER_MODEL=<ggml file>` the sound is also read back and the words printed.
    #[test]
    #[ignore = "needs the downloaded voice model (set CUTVII_TTS_DIR)"]
    fn tts_real_model_speaks_indonesian_and_english() {
        let Ok(dir) = std::env::var("CUTVII_TTS_DIR") else {
            eprintln!("skipped: CUTVII_TTS_DIR is not set");
            return;
        };
        let out = std::env::var("CUTVII_TTS_OUT")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| std::env::temp_dir());
        let size = std::env::var("CUTVII_TTS_MODEL").unwrap_or_else(|_| "supertonic-3".into());
        let mut speaker = Speaker::load(Path::new(&dir), model(&size).unwrap()).unwrap();
        let cancel = AtomicBool::new(false);
        for (lang, voice, text) in [
            (
                "id",
                "F1",
                "Halo, nama saya Budi Santoso. Pada tanggal 17 Agustus 2025, harga tiketnya Rp 125.000 untuk 3 orang. Jangan lupa subscribe dan share video ini di YouTube ya!",
            ),
            (
                "en",
                "M1",
                "Hi, my name is Sarah O'Connor. On March 3rd, 2025, the ticket cost $49.99 for 3 people. My friend Budi Santoso from Yogyakarta says terima kasih for watching.",
            ),
        ] {
            let voice = load_voice(Path::new(&dir), voice).unwrap();
            let started = std::time::Instant::now();
            let samples = speaker
                .speak(text, lang, &voice, SPEED.1, &mut |_| {}, &cancel)
                .unwrap();
            let seconds = samples.len() as f32 / speaker.sample_rate() as f32;
            let peak = samples.iter().fold(0f32, |a, s| a.max(s.abs()));
            eprintln!(
                "{lang}: {seconds:.2} s of sound in {:.2} s, peak {peak:.2}",
                started.elapsed().as_secs_f32()
            );
            assert!((5.0..40.0).contains(&seconds));
            assert!(peak > 0.05 && samples.iter().all(|s| s.is_finite()));
            write_wav(
                &out.join(format!("tts-{lang}.wav")),
                &samples,
                speaker.sample_rate(),
            )
            .unwrap();
            // with a speech model at hand, read the sound back: the words should be the ones written
            if let Ok(model) = std::env::var("CUTVII_WHISPER_MODEL") {
                use crate::media::tools::{FFMPEG_ENV, locate_tool};
                use crate::media::whisper::{read_samples, transcribe};
                let heard = read_samples(
                    &locate_tool("ffmpeg", FFMPEG_ENV).unwrap(),
                    &out.join(format!("tts-{lang}.wav")),
                    0.0,
                    seconds as f64,
                )
                .unwrap();
                let segments = transcribe(
                    Path::new(&model),
                    &heard,
                    Some(lang),
                    Box::new(|_| {}),
                    std::sync::Arc::new(AtomicBool::new(false)),
                )
                .unwrap();
                let words: Vec<String> = segments.into_iter().map(|s| s.text).collect();
                eprintln!("{lang} heard: {}", words.join(" "));
            }
        }
    }
}
