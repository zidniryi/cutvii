//! Auto clips, engine part 1: find short, self-contained stretches in a long talking recording.
//!
//! Pure functions, no files and no AI model: a transcript (speech segments) plus a loudness envelope go in,
//! ranked candidate windows come out. Windows start on a sentence start and end on a sentence end, so a cut
//! never lands mid-sentence. Every score is a sum of five documented rules weighted by [`CONFIG`]; each rule
//! that applies is returned as a reason, so the UI can say why a clip was suggested. The scores are
//! heuristics for suggesting candidates, not a prediction of how a clip will perform.
//!
//! Times inside this module are seconds from the start of the transcribed range ("relative"). The job layer
//! (`clipper_job`) and the command add the clip's source offset and timeline placement.

use serde::{Deserialize, Serialize};

use super::whisper::Segment;

/// How much each rule counts. Weights are relative: the score is the weighted mean of the rule values.
pub struct Weights {
    pub speech_density: f64,
    pub energy_variation: f64,
    pub strong_opening: f64,
    pub low_silence: f64,
    pub self_contained_end: f64,
}

/// Every tunable of the clip finder, in one place. Changing a value here changes the scores everywhere
/// (the documented rule list in `rules()` and the UI both read from here).
pub struct Config {
    pub weights: Weights,
    /// A gap this long after a segment ends the sentence even without punctuation (seconds).
    pub pause_split: f64,
    /// Text without any punctuation is cut at a segment end once it runs this long (seconds).
    pub max_run_on: f64,
    /// A window never spans a silence longer than this (seconds): that is a topic break.
    pub max_internal_gap: f64,
    /// Seconds kept before the first and after the last word, since timestamps are a little early or late.
    pub lead_in: f64,
    pub tail: f64,
    /// Words per second: below `density_floor` or above `density_ceiling` the rule gives 0; between
    /// `density_ideal.0` and `.1` it gives 1.
    pub density_floor: f64,
    pub density_ideal: (f64, f64),
    pub density_ceiling: f64,
    /// Coefficient of variation of the loudness at which the delivery counts as fully lively.
    pub variation_target: f64,
    /// A loudness frame is silent below this share of the recording's loud level (90th percentile).
    pub silence_relative: f64,
    /// Silent share of a window: at or below `.0` the rule gives 1, at or above `.1` it gives 0.
    pub silence_range: (f64, f64),
    /// An opening sentence of at most this many words counts as punchy.
    pub punchy_words: usize,
    /// A rule counts as "met" (shown as a reason chip) at or above this value.
    pub met_at: f64,
    /// Score tiers: `>= high` is High, `>= medium` is Medium, else Low.
    pub tier_high: f64,
    pub tier_medium: f64,
    /// "Auto" count: one clip per this many seconds of recording, between `auto_count.0` and `.1`.
    pub auto_seconds_per_clip: f64,
    pub auto_count: (usize, usize),
    /// With "Auto" count, candidates scoring below this are not suggested at all.
    pub auto_min_score: f64,
    /// Words that open with a contrast or a turn (English and Indonesian).
    pub contrast_words: &'static [&'static str],
    /// A sentence ending in one of these is still open ("... and", "... karena").
    pub dangling_words: &'static [&'static str],
    /// A full stop after one of these (lower case) does not end a sentence.
    pub abbreviations: &'static [&'static str],
}

pub const CONFIG: Config = Config {
    weights: Weights {
        speech_density: 1.0,
        energy_variation: 1.0,
        strong_opening: 1.5,
        low_silence: 1.0,
        self_contained_end: 1.5,
    },
    pause_split: 0.7,
    max_run_on: 18.0,
    max_internal_gap: 5.0,
    lead_in: 0.15,
    tail: 0.3,
    density_floor: 1.0,
    density_ideal: (2.0, 3.5),
    density_ceiling: 5.5,
    variation_target: 0.6,
    silence_relative: 0.12,
    silence_range: (0.05, 0.35),
    punchy_words: 8,
    met_at: 0.6,
    tier_high: 0.7,
    tier_medium: 0.45,
    auto_seconds_per_clip: 120.0,
    auto_count: (3, 10),
    auto_min_score: 0.3,
    contrast_words: &[
        "but",
        "however",
        "actually",
        "yet",
        "instead",
        "never",
        "tapi",
        "namun",
        "padahal",
        "ternyata",
        "sebenarnya",
        "justru",
        "malah",
    ],
    dangling_words: &[
        "and", "but", "so", "or", "because", "that", "which", "dan", "tapi", "atau", "karena",
        "yang", "jadi", "terus",
    ],
    abbreviations: &[
        "mr", "mrs", "ms", "dr", "prof", "vs", "st", "jr", "sr", "dll", "dsb", "tgl", "jl",
    ],
};

/// Rule ids, as returned in [`Reason::rule`].
pub const RULE_SPEECH_DENSITY: &str = "speech-density";
pub const RULE_ENERGY_VARIATION: &str = "energy-variation";
pub const RULE_STRONG_OPENING: &str = "strong-opening";
pub const RULE_LOW_SILENCE: &str = "low-silence";
pub const RULE_SELF_CONTAINED_END: &str = "self-contained-end";

/// How a sentence ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Closing {
    /// Ended by `.`, `!`, `?` or `…`.
    Punctuation,
    /// The speaker paused (or the recording ended) without punctuation.
    Pause,
    /// A run of text with no punctuation or pause, cut at a segment end.
    Forced,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Sentence {
    pub start: f64,
    pub end: f64,
    pub text: String,
    pub words: usize,
    pub closing: Closing,
}

/// Loudness over time: root-mean-square per `step` seconds, plus the level under which a frame is silent.
pub struct Envelope {
    pub step: f64,
    pub rms: Vec<f32>,
    silent_below: f32,
}

impl Envelope {
    pub fn new(rms: Vec<f32>, step: f64) -> Self {
        let mut sorted: Vec<f32> = rms.iter().copied().filter(|v| v.is_finite()).collect();
        sorted.sort_by(f32::total_cmp);
        let loud = sorted
            .get(sorted.len().saturating_sub(1) * 9 / 10)
            .copied()
            .unwrap_or(0.0);
        // never below a faint noise floor, so digital silence in a quiet recording still reads as silent
        let silent_below = (loud * CONFIG.silence_relative as f32).max(1e-4);
        Self {
            step,
            rms,
            silent_below,
        }
    }

    /// The frames that cover `[start, end)`.
    fn frames(&self, start: f64, end: f64) -> &[f32] {
        if self.step <= 0.0 || self.rms.is_empty() {
            return &[];
        }
        let from = ((start / self.step).floor().max(0.0) as usize).min(self.rms.len());
        let to = ((end / self.step).ceil().max(0.0) as usize).min(self.rms.len());
        &self.rms[from..to.max(from)]
    }
}

/// Reduce 16 kHz-style mono samples to one RMS value per `step` seconds.
pub fn energy_envelope(samples: &[f32], sample_rate: u32, step: f64) -> Vec<f32> {
    let per = ((sample_rate as f64 * step).round() as usize).max(1);
    samples
        .chunks(per)
        .map(|chunk| {
            let sum: f64 = chunk.iter().map(|s| (*s as f64) * (*s as f64)).sum();
            (sum / chunk.len() as f64).sqrt() as f32
        })
        .collect()
}

// ---------------------------------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------------------------------

fn is_terminator(c: char) -> bool {
    matches!(c, '.' | '!' | '?' | '…' | '。' | '！' | '？')
}

fn is_closer(c: char) -> bool {
    matches!(c, '"' | '\'' | ')' | ']' | '”' | '’' | '»')
}

/// A piece of one segment: text and the (interpolated) time it spans.
struct Piece {
    start: f64,
    end: f64,
    text: String,
    terminated: bool,
}

/// Split one segment at sentence terminators. A terminator ends a sentence only when whitespace or the
/// end of the text follows (so "3.5" stays whole) and the word before a full stop is not an abbreviation.
/// Whisper gives no word times, so the time inside a segment is shared out by character count.
fn split_segment(seg: &Segment, cfg: &Config) -> Vec<Piece> {
    let text = seg.text.trim();
    let chars: Vec<char> = text.chars().collect();
    let total = chars.len().max(1) as f64;
    let at = |c: usize| seg.start + (seg.end - seg.start) * (c as f64 / total);

    let mut pieces = Vec::new();
    let mut from = 0usize;
    let mut i = 0usize;
    while i < chars.len() {
        if !is_terminator(chars[i]) {
            i += 1;
            continue;
        }
        let mut j = i;
        while j + 1 < chars.len() && (is_terminator(chars[j + 1]) || is_closer(chars[j + 1])) {
            j += 1;
        }
        let next_is_break = chars.get(j + 1).is_none_or(|c| c.is_whitespace());
        let abbreviation = chars[i] == '.' && j == i && {
            let word: String = chars[from..i]
                .iter()
                .rev()
                .take_while(|c| c.is_alphabetic() || **c == '.')
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<String>()
                .to_lowercase();
            cfg.abbreviations.contains(&word.as_str())
        };
        if next_is_break && !abbreviation {
            let piece: String = chars[from..=j].iter().collect();
            if piece.chars().any(|c| c.is_alphanumeric()) {
                pieces.push(Piece {
                    start: at(from),
                    end: at(j + 1),
                    text: piece.trim().to_string(),
                    terminated: true,
                });
            }
            from = j + 1;
        }
        i = j + 1;
    }
    if from < chars.len() {
        let rest: String = chars[from..].iter().collect();
        if rest.chars().any(|c| c.is_alphanumeric()) {
            pieces.push(Piece {
                start: at(from),
                end: seg.end,
                text: rest.trim().to_string(),
                terminated: false,
            });
        }
    }
    pieces
}

fn word_count(text: &str) -> usize {
    text.split_whitespace()
        .filter(|w| w.chars().any(|c| c.is_alphanumeric()))
        .count()
}

/// Sentences of a transcript, in time order, from punctuation and pauses. Segments are expected in time
/// order (as Whisper returns them).
pub fn split_sentences(segments: &[Segment], cfg: &Config) -> Vec<Sentence> {
    let mut out = Vec::new();
    let mut pending: Vec<Piece> = Vec::new();

    let flush = |pending: &mut Vec<Piece>, closing: Closing, out: &mut Vec<Sentence>| {
        if pending.is_empty() {
            return;
        }
        let text = pending
            .iter()
            .map(|p| p.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        out.push(Sentence {
            start: pending[0].start,
            end: pending[pending.len() - 1].end,
            words: word_count(&text),
            text,
            closing,
        });
        pending.clear();
    };

    for (index, seg) in segments.iter().enumerate() {
        let pieces = split_segment(seg, cfg);
        let last = pieces.len().saturating_sub(1);
        let gap_after = segments
            .get(index + 1)
            .map_or(f64::INFINITY, |next| next.start - seg.end);
        for (n, piece) in pieces.into_iter().enumerate() {
            let terminated = piece.terminated;
            pending.push(piece);
            if terminated {
                flush(&mut pending, Closing::Punctuation, &mut out);
            } else if n == last {
                let length = pending[pending.len() - 1].end - pending[0].start;
                if gap_after >= cfg.pause_split {
                    flush(&mut pending, Closing::Pause, &mut out);
                } else if length >= cfg.max_run_on {
                    flush(&mut pending, Closing::Forced, &mut out);
                }
            }
        }
    }
    flush(&mut pending, Closing::Pause, &mut out);
    out
}

// ---------------------------------------------------------------------------------------------------
// Candidates and scoring
// ---------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Tier {
    Low,
    Medium,
    High,
}

/// One rule's result for one candidate.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reason {
    /// Stable id of the rule (the `RULE_*` constants).
    pub rule: String,
    /// Plain-language reason, for the tooltip and chips.
    pub label: String,
    /// What the rule measured, 0..=1.
    pub value: f64,
    /// `value` reached [`Config::met_at`]: show it as a reason for choosing this clip.
    pub met: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    /// Seconds from the start of the transcribed range, padded by lead-in / tail.
    pub start: f64,
    pub end: f64,
    /// Index range into the sentence list (inclusive).
    pub first: usize,
    pub last: usize,
    /// Weighted mean of the rule values, 0..=1. Use for ordering; it is not a probability of anything.
    pub score: f64,
    pub tier: Tier,
    pub reasons: Vec<Reason>,
}

fn ramp(value: f64, zero: f64, one: f64) -> f64 {
    if (one - zero).abs() < f64::EPSILON {
        return if value >= one { 1.0 } else { 0.0 };
    }
    ((value - zero) / (one - zero)).clamp(0.0, 1.0)
}

fn lower_words(text: &str) -> Vec<String> {
    text.split_whitespace()
        .map(|w| {
            w.trim_matches(|c: char| !c.is_alphanumeric())
                .to_lowercase()
        })
        .filter(|w| !w.is_empty())
        .collect()
}

fn reason(rule: &str, label: String, value: f64, cfg: &Config) -> Reason {
    Reason {
        rule: rule.to_string(),
        label,
        value,
        met: value >= cfg.met_at,
    }
}

/// Score the sentences `first..=last` (padded to `start..end`) with the five rules.
fn score(
    sentences: &[Sentence],
    first: usize,
    last: usize,
    start: f64,
    end: f64,
    envelope: &Envelope,
    cfg: &Config,
) -> (f64, Vec<Reason>) {
    let span = &sentences[first..=last];
    let duration = (end - start).max(0.001);
    let opening = &span[0];
    let closing = &span[span.len() - 1];

    // 1. Speech density: words per second inside the window; a steady talking pace scores highest.
    let words: usize = span.iter().map(|s| s.words).sum();
    let pace = words as f64 / duration;
    let (lo, hi) = cfg.density_ideal;
    let density = if pace < lo {
        ramp(pace, cfg.density_floor, lo)
    } else if pace > hi {
        ramp(pace, cfg.density_ceiling, hi)
    } else {
        1.0
    };

    // 2. Energy variation: how much the loudness moves among the non-silent frames (a lively delivery).
    let frames = envelope.frames(start, end);
    let loud: Vec<f64> = frames
        .iter()
        .filter(|v| **v >= envelope.silent_below)
        .map(|v| *v as f64)
        .collect();
    let variation = if loud.len() >= 4 {
        let mean = loud.iter().sum::<f64>() / loud.len() as f64;
        let var = loud.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / loud.len() as f64;
        ramp(var.sqrt() / mean.max(1e-9), 0.0, cfg.variation_target)
    } else {
        0.0
    };

    // 3. Strong opening: a question, a number, a contrast word near the start, or a short punchy sentence.
    let open_words = lower_words(&opening.text);
    let (opening_value, opening_label) = if opening.text.trim_end().ends_with('?') {
        (1.0, "Opens with a question")
    } else if open_words
        .iter()
        .take(6)
        .any(|w| cfg.contrast_words.contains(&w.as_str()))
    {
        (0.8, "Opens with a contrast")
    } else if opening.text.chars().any(|c| c.is_ascii_digit()) {
        (0.8, "Opens with a number")
    } else if opening.words > 0
        && opening.words <= cfg.punchy_words
        && opening.closing == Closing::Punctuation
    {
        (0.6, "Opens with a short, punchy sentence")
    } else {
        (0.0, "No strong opening")
    };

    // 4. Low silence: the share of the window that is silent (falls back to the gaps between sentences
    //    when there is no loudness data).
    let silent_share = if frames.is_empty() {
        let spoken: f64 = span.iter().map(|s| s.end - s.start).sum();
        (1.0 - spoken / duration).clamp(0.0, 1.0)
    } else {
        frames
            .iter()
            .filter(|v| **v < envelope.silent_below)
            .count() as f64
            / frames.len() as f64
    };
    let silence = 1.0 - ramp(silent_share, cfg.silence_range.0, cfg.silence_range.1);

    // 5. Self-contained ending: finished with punctuation, not trailing off into "and ...".
    let last_word = lower_words(&closing.text).pop().unwrap_or_default();
    let trailing = closing.text.trim_end().ends_with([',', ':', ';', '-'])
        || cfg.dangling_words.contains(&last_word.as_str());
    let ending = match closing.closing {
        _ if trailing => 0.0,
        Closing::Punctuation => 1.0,
        Closing::Pause => 0.5,
        Closing::Forced => 0.0,
    };

    let w = &cfg.weights;
    let reasons = vec![
        reason(
            RULE_STRONG_OPENING,
            opening_label.to_string(),
            opening_value,
            cfg,
        ),
        reason(
            RULE_SELF_CONTAINED_END,
            if ending >= cfg.met_at {
                "Ends on a finished sentence".to_string()
            } else {
                "Does not end cleanly".to_string()
            },
            ending,
            cfg,
        ),
        reason(
            RULE_SPEECH_DENSITY,
            format!("Steady pace ({pace:.1} words per second)"),
            density,
            cfg,
        ),
        reason(
            RULE_ENERGY_VARIATION,
            "Lively delivery (loudness varies)".to_string(),
            variation,
            cfg,
        ),
        reason(
            RULE_LOW_SILENCE,
            format!("Little silence ({:.0}% quiet)", silent_share * 100.0),
            silence,
            cfg,
        ),
    ];
    let weights = [
        w.strong_opening,
        w.self_contained_end,
        w.speech_density,
        w.energy_variation,
        w.low_silence,
    ];
    let total: f64 = weights.iter().sum();
    let sum: f64 = reasons
        .iter()
        .zip(weights)
        .map(|(r, weight)| r.value * weight)
        .sum();
    (if total > 0.0 { sum / total } else { 0.0 }, reasons)
}

pub fn tier_for(score: f64, cfg: &Config) -> Tier {
    if score >= cfg.tier_high {
        Tier::High
    } else if score >= cfg.tier_medium {
        Tier::Medium
    } else {
        Tier::Low
    }
}

/// Every window of whole sentences whose length is within `[min, max]` seconds, scored. `length` is the
/// length of the transcribed range: windows are padded by lead-in / tail but never leave `[0, length]` and
/// never reach into a neighbouring sentence.
pub fn candidates(
    sentences: &[Sentence],
    envelope: &Envelope,
    length: f64,
    min: f64,
    max: f64,
    cfg: &Config,
) -> Vec<Candidate> {
    let mut out = Vec::new();
    for first in 0..sentences.len() {
        for last in first..sentences.len() {
            if last > first
                && sentences[last].start - sentences[last - 1].end > cfg.max_internal_gap
            {
                break;
            }
            let span = sentences[last].end - sentences[first].start;
            if span > max {
                break;
            }
            if span < min {
                continue;
            }
            // pad, but stay clear of the neighbours: stop half way into the gap
            let before = if first == 0 {
                0.0
            } else {
                (sentences[first - 1].end + sentences[first].start) / 2.0
            };
            let after = if last + 1 == sentences.len() {
                length
            } else {
                (sentences[last].end + sentences[last + 1].start) / 2.0
            };
            let start = (sentences[first].start - cfg.lead_in).max(before).max(0.0);
            let end = (sentences[last].end + cfg.tail).min(after).min(length);
            let (value, reasons) = score(sentences, first, last, start, end, envelope, cfg);
            out.push(Candidate {
                start,
                end,
                first,
                last,
                score: value,
                tier: tier_for(value, cfg),
                reasons,
            });
        }
    }
    out
}

/// How many clips "Auto" asks for in a recording of `length` seconds.
pub fn auto_count(length: f64, cfg: &Config) -> usize {
    let n = (length / cfg.auto_seconds_per_clip).round() as usize;
    n.clamp(cfg.auto_count.0, cfg.auto_count.1)
}

fn overlaps(a: (f64, f64), b: (f64, f64)) -> bool {
    a.0 < b.1 && b.0 < a.1
}

/// The best `count` candidates that overlap neither each other nor any span in `taken` (relative
/// seconds). Best first by score; ties go to the earlier one so the result is repeatable. With
/// `min_score` set, weaker candidates are not suggested at all.
pub fn select(
    mut pool: Vec<Candidate>,
    count: usize,
    taken: &[(f64, f64)],
    min_score: Option<f64>,
) -> Vec<Candidate> {
    pool.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then(a.start.total_cmp(&b.start))
            .then(a.end.total_cmp(&b.end))
    });
    let mut chosen: Vec<Candidate> = Vec::new();
    for c in pool {
        if chosen.len() >= count {
            break;
        }
        if min_score.is_some_and(|m| c.score < m) {
            continue;
        }
        let span = (c.start, c.end);
        if taken.iter().any(|t| overlaps(span, *t))
            || chosen.iter().any(|o| overlaps(span, (o.start, o.end)))
        {
            continue;
        }
        chosen.push(c);
    }
    chosen
}

// ---------------------------------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------------------------------

/// Where a stretch of a source file lands on the timeline: the clip that uses `[source_in, ..)` of the file
/// starts at `timeline_start` and plays at `speed`.
#[derive(Debug, Clone, Copy)]
pub struct Placement {
    pub timeline_start: f64,
    pub source_in: f64,
    pub speed: f64,
}

impl Placement {
    /// Timeline seconds for a source time (trim and speed applied).
    pub fn timeline_at(&self, source_time: f64) -> f64 {
        self.timeline_start + (source_time - self.source_in) / self.speed
    }
}

/// Snap `[start, end)` outwards to whole frames (start down, end up) inside `[min, max]`. A frame rate
/// that is not positive and finite leaves the times as they are.
pub fn snap_to_frames(start: f64, end: f64, fps: f64, min: f64, max: f64) -> (f64, f64) {
    if !(fps.is_finite() && fps > 0.0) {
        return (start, end);
    }
    // the small epsilon keeps a time already on a frame from slipping a frame because of float noise
    let s = ((start * fps + 1e-6).floor() / fps).max(min);
    let e = ((end * fps - 1e-6).ceil() / fps).min(max);
    (s, e.max(s))
}

/// First words of a sentence as a title: up to `max_words`, without trailing punctuation.
pub fn title_from(text: &str, max_words: usize) -> String {
    let words: Vec<&str> = text.split_whitespace().take(max_words).collect();
    let joined = words.join(" ");
    joined
        .trim_end_matches(|c: char| !c.is_alphanumeric())
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(start: f64, end: f64, text: &str) -> Segment {
        Segment {
            start,
            end,
            text: text.to_string(),
        }
    }

    fn sentence(start: f64, end: f64, text: &str, closing: Closing) -> Sentence {
        Sentence {
            start,
            end,
            text: text.to_string(),
            words: word_count(text),
            closing,
        }
    }

    /// Four minutes of a made-up talk: sentences of about five seconds with short pauses, a long silence
    /// in the middle, English first and Indonesian after it.
    fn talk() -> Vec<Segment> {
        let lines = [
            "Why do most people never finish what they start?",
            "Because they plan too much and act too little.",
            "I used to be exactly the same.",
            "Then I tried one small change, and everything moved.",
            "Write down one task every morning.",
            "Finish it before lunch.",
            "That is the whole trick.",
            "It sounds too simple, but it works.",
            "After thirty days you have thirty finished things.",
            "Most people have zero.",
            "So pick your task right now.",
            "Do it first, and then check your phone.",
        ];
        let mut out = Vec::new();
        let mut t = 0.0;
        for line in lines {
            // five seconds each, half a second of pause between
            out.push(seg(t, t + 5.0, &format!(" {line}")));
            t += 5.5;
        }
        // a long silence: a topic break
        t += 12.0;
        let lines_id = [
            "Kenapa banyak orang tidak pernah menyelesaikan apa yang mereka mulai?",
            "Karena mereka terlalu banyak merencanakan dan terlalu sedikit bertindak.",
            "Tapi ada satu cara sederhana yang bisa kamu coba hari ini.",
            "Tulis satu tugas setiap pagi dan selesaikan sebelum makan siang.",
            "Itu saja, tidak ada yang lain.",
            "Setelah tiga puluh hari kamu punya tiga puluh hal yang selesai.",
        ];
        for line in lines_id {
            out.push(seg(t, t + 5.0, &format!(" {line}")));
            t += 5.5;
        }
        out
    }

    fn flat_envelope(length: f64) -> Envelope {
        // alternating loudness so the variation rule has something to measure
        let frames = (length / 0.25).ceil() as usize;
        let rms = (0..frames)
            .map(|i| if i % 3 == 0 { 0.05 } else { 0.2 })
            .collect();
        Envelope::new(rms, 0.25)
    }

    #[test]
    fn sentences_split_on_punctuation_inside_and_between_segments() {
        let s = split_sentences(
            &[
                seg(0.0, 6.0, " First one. Second one! Third"),
                seg(6.0, 8.0, " goes on?"),
            ],
            &CONFIG,
        );
        let texts: Vec<&str> = s.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(texts, ["First one.", "Second one!", "Third goes on?"]);
        assert!(s.iter().all(|s| s.closing == Closing::Punctuation));
        // times are shared out by characters inside a segment and stay ordered
        assert!(s[0].start == 0.0 && s[0].end > 0.0 && s[0].end <= s[1].start + 1e-9);
        assert!(s[2].end == 8.0);
        assert!(s.windows(2).all(|w| w[0].end <= w[1].start + 1e-9));
    }

    #[test]
    fn decimals_and_abbreviations_do_not_end_a_sentence() {
        let s = split_sentences(
            &[seg(0.0, 8.0, "Dr. Smith paid 3.5 dollars for it. Fine.")],
            &CONFIG,
        );
        let texts: Vec<&str> = s.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(texts, ["Dr. Smith paid 3.5 dollars for it.", "Fine."]);
    }

    #[test]
    fn a_pause_ends_an_unpunctuated_sentence_and_a_short_gap_does_not() {
        let s = split_sentences(
            &[
                seg(0.0, 2.0, "this keeps going"),
                seg(2.2, 4.0, "and finishes here"),
                seg(6.0, 8.0, "after a pause"),
            ],
            &CONFIG,
        );
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].text, "this keeps going and finishes here");
        assert_eq!(s[0].closing, Closing::Pause);
        assert_eq!((s[0].start, s[0].end), (0.0, 4.0));
    }

    #[test]
    fn a_long_unpunctuated_run_is_cut_at_a_segment_end() {
        let segs: Vec<Segment> = (0..8)
            .map(|i| seg(i as f64 * 3.0, i as f64 * 3.0 + 3.0, "word word word"))
            .collect();
        let s = split_sentences(&segs, &CONFIG);
        assert!(s.len() > 1);
        assert_eq!(s[0].closing, Closing::Forced);
        assert!(s[0].end - s[0].start >= CONFIG.max_run_on);
    }

    #[test]
    fn windows_respect_length_and_start_and_end_on_sentences() {
        let sentences = split_sentences(&talk(), &CONFIG);
        let length = 4.0 * 60.0;
        let found = candidates(
            &sentences,
            &flat_envelope(length),
            length,
            15.0,
            30.0,
            &CONFIG,
        );
        assert!(!found.is_empty());
        for c in &found {
            let first = &sentences[c.first];
            let last = &sentences[c.last];
            // the unpadded window is inside the target length
            assert!(last.end - first.start >= 15.0 - 1e-9 && last.end - first.start <= 30.0 + 1e-9);
            // padded by at most lead-in / tail, never into the neighbour sentences
            assert!(c.start <= first.start && first.start - c.start <= CONFIG.lead_in + 1e-9);
            assert!(c.end >= last.end && c.end - last.end <= CONFIG.tail + 1e-9);
            if c.first > 0 {
                assert!(c.start >= sentences[c.first - 1].end);
            }
            if c.last + 1 < sentences.len() {
                assert!(c.end <= sentences[c.last + 1].start);
            }
            // whole sentences only: nothing inside the window is split
            assert!(c.first <= c.last);
        }
    }

    #[test]
    fn a_window_never_spans_a_long_silence() {
        let sentences = split_sentences(&talk(), &CONFIG);
        let length = 4.0 * 60.0;
        let found = candidates(
            &sentences,
            &flat_envelope(length),
            length,
            15.0,
            120.0,
            &CONFIG,
        );
        for c in &found {
            for pair in sentences[c.first..=c.last].windows(2) {
                assert!(pair[1].start - pair[0].end <= CONFIG.max_internal_gap);
            }
        }
    }

    #[test]
    fn scoring_is_deterministic_and_each_reason_maps_to_a_rule() {
        let sentences = split_sentences(&talk(), &CONFIG);
        let length = 4.0 * 60.0;
        let env = flat_envelope(length);
        let a = candidates(&sentences, &env, length, 15.0, 45.0, &CONFIG);
        let b = candidates(&sentences, &env, length, 15.0, 45.0, &CONFIG);
        assert_eq!(a, b);

        let rules = [
            RULE_SPEECH_DENSITY,
            RULE_ENERGY_VARIATION,
            RULE_STRONG_OPENING,
            RULE_LOW_SILENCE,
            RULE_SELF_CONTAINED_END,
        ];
        for c in &a {
            let ids: Vec<&str> = c.reasons.iter().map(|r| r.rule.as_str()).collect();
            assert_eq!(ids.len(), rules.len());
            assert!(rules.iter().all(|r| ids.contains(r)));
            assert!((0.0..=1.0).contains(&c.score));
            assert!(c.reasons.iter().all(|r| (0.0..=1.0).contains(&r.value)));
            assert!(
                c.reasons
                    .iter()
                    .all(|r| r.met == (r.value >= CONFIG.met_at))
            );
        }
    }

    #[test]
    fn a_question_opening_and_a_clean_ending_outscore_a_trailing_one() {
        let sentences = vec![
            sentence(0.0, 6.0, "Why does this work?", Closing::Punctuation),
            sentence(
                6.5,
                14.0,
                "Because the habit is tiny and daily.",
                Closing::Punctuation,
            ),
            sentence(15.0, 22.0, "and then we kept going and", Closing::Pause),
        ];
        let env = Envelope::new(vec![], 0.25);
        let (good, reasons) = score(&sentences, 0, 1, 0.0, 14.0, &env, &CONFIG);
        let (bad, bad_reasons) = score(&sentences, 1, 2, 6.5, 22.0, &env, &CONFIG);
        assert!(good > bad);
        let by = |rs: &[Reason], id: &str| rs.iter().find(|r| r.rule == id).unwrap().value;
        assert_eq!(by(&reasons, RULE_STRONG_OPENING), 1.0);
        assert_eq!(by(&reasons, RULE_SELF_CONTAINED_END), 1.0);
        // a sentence trailing off into "and" is not self-contained
        assert_eq!(by(&bad_reasons, RULE_SELF_CONTAINED_END), 0.0);
    }

    #[test]
    fn silence_lowers_the_score_of_a_window() {
        let sentences = vec![sentence(
            0.0,
            20.0,
            "One long sentence here.",
            Closing::Punctuation,
        )];
        // frames: loud for the first ten seconds, silent for the rest
        let mut rms = vec![0.2f32; 40];
        rms.extend(vec![0.0f32; 40]);
        let env = Envelope::new(rms, 0.25);
        let (_, quiet) = score(&sentences, 0, 0, 0.0, 20.0, &env, &CONFIG);
        let (_, loud) = score(&sentences, 0, 0, 0.0, 10.0, &env, &CONFIG);
        let silence = |rs: &[Reason]| {
            rs.iter()
                .find(|r| r.rule == RULE_LOW_SILENCE)
                .unwrap()
                .value
        };
        assert!(silence(&loud) > silence(&quiet));
        assert_eq!(silence(&loud), 1.0);
        assert_eq!(silence(&quiet), 0.0);
    }

    #[test]
    fn the_top_clips_do_not_overlap_and_find_another_avoids_what_is_taken() {
        let sentences = split_sentences(&talk(), &CONFIG);
        let length = 4.0 * 60.0;
        let pool = candidates(
            &sentences,
            &flat_envelope(length),
            length,
            15.0,
            30.0,
            &CONFIG,
        );
        let top = select(pool.clone(), 3, &[], None);
        assert_eq!(top.len(), 3);
        for (i, a) in top.iter().enumerate() {
            for b in &top[i + 1..] {
                assert!(!overlaps((a.start, a.end), (b.start, b.end)));
            }
        }
        // best first
        assert!(top.windows(2).all(|w| w[0].score >= w[1].score));
        // the same input gives the same answer
        assert_eq!(top, select(pool.clone(), 3, &[], None));

        // "Find another": one more candidate that avoids everything already on screen
        let taken: Vec<(f64, f64)> = top.iter().map(|c| (c.start, c.end)).collect();
        let more = select(pool, 1, &taken, None);
        assert_eq!(more.len(), 1);
        assert!(
            taken
                .iter()
                .all(|t| !overlaps((more[0].start, more[0].end), *t))
        );
    }

    #[test]
    fn auto_count_follows_the_length_and_a_minimum_score_drops_weak_clips() {
        assert_eq!(auto_count(60.0, &CONFIG), 3);
        assert_eq!(auto_count(600.0, &CONFIG), 5);
        assert_eq!(auto_count(7200.0, &CONFIG), 10);
        let weak = Candidate {
            start: 0.0,
            end: 20.0,
            first: 0,
            last: 0,
            score: 0.1,
            tier: Tier::Low,
            reasons: vec![],
        };
        assert_eq!(select(vec![weak.clone()], 3, &[], Some(0.3)).len(), 0);
        assert_eq!(select(vec![weak], 3, &[], None).len(), 1);
    }

    #[test]
    fn tiers_follow_the_configured_thresholds() {
        assert_eq!(tier_for(0.9, &CONFIG), Tier::High);
        assert_eq!(tier_for(CONFIG.tier_medium, &CONFIG), Tier::Medium);
        assert_eq!(tier_for(0.1, &CONFIG), Tier::Low);
    }

    #[test]
    fn source_times_map_to_the_timeline_with_trim_and_speed() {
        // the clip uses the file from 30 s on, sits at 10 s on the timeline and plays twice as fast
        let p = Placement {
            timeline_start: 10.0,
            source_in: 30.0,
            speed: 2.0,
        };
        assert_eq!(p.timeline_at(30.0), 10.0);
        assert_eq!(p.timeline_at(40.0), 15.0);
        let slow = Placement { speed: 0.5, ..p };
        assert_eq!(slow.timeline_at(40.0), 30.0);
    }

    #[test]
    fn frame_snapping_widens_to_whole_frames_inside_the_range() {
        let (s, e) = snap_to_frames(1.013, 4.981, 30.0, 0.0, 60.0);
        assert!((s * 30.0 - (s * 30.0).round()).abs() < 1e-9);
        assert!((e * 30.0 - (e * 30.0).round()).abs() < 1e-9);
        assert!(s <= 1.013 && e >= 4.981);
        // already on frames: unchanged
        let (s, e) = snap_to_frames(1.0, 2.0, 25.0, 0.0, 60.0);
        assert_eq!((s, e), (1.0, 2.0));
        // clamped to the range
        let (s, e) = snap_to_frames(0.001, 59.999, 30.0, 0.0, 60.0);
        assert!(s >= 0.0 && e <= 60.0);
        // a bad frame rate leaves the times alone
        assert_eq!(snap_to_frames(1.013, 2.0, 0.0, 0.0, 9.0), (1.013, 2.0));
    }

    #[test]
    fn titles_use_the_first_words_without_trailing_punctuation() {
        assert_eq!(
            title_from("Why do most people never finish what they start?", 6),
            "Why do most people never finish"
        );
        assert_eq!(title_from("Wait, really?!", 6), "Wait, really");
    }

    #[test]
    fn the_loudness_envelope_has_one_value_per_step() {
        let samples = vec![0.5f32; 16_000]; // one second
        let env = energy_envelope(&samples, 16_000, 0.25);
        assert_eq!(env.len(), 4);
        assert!(env.iter().all(|v| (v - 0.5).abs() < 1e-6));
    }
}
