//! Caption segmentation: the ONE place a long stretch of speech or text is cut into readable captions.
//! Every caption source goes through `split`: Whisper segments, and later pasted / imported text and the
//! "Re-split long captions" action. Pure (no files, no FFmpeg), so it is tested on its own.
//!
//! Rules, in order:
//! - Text is only cut, never rewritten or dropped: captions are whole whitespace-separated words, so a word,
//!   a number ("1.000", "3,5") or a hyphenated word is never split. The words of the pieces, joined, are the
//!   words of the source.
//! - Where to cut is chosen by a small search over word boundaries (fewest captions first, then the best
//!   places): after `. ? !` is free, after `, ; :` is cheap, after a plain word costs more, and after a
//!   function word (`functionWords` in `presets/caption-rules.json`) costs most, so a caption never ends on
//!   one when another cut exists. A caption must fit `maxLines` lines of `maxChars` (a single word longer
//!   than a line stands alone), `maxWords` and `maxSeconds`.
//! - Lines inside a caption are balanced (the smallest sum of squared line lengths), never end on a function
//!   word when they can avoid it, and with bottom-aligned captions the shorter line goes on top when that is
//!   a choice.
//! - Time: with word times a caption runs from its first word's start to the next caption's first word's
//!   start. Without them a segment's time is shared in proportion to the characters of each piece (letters,
//!   digits and punctuation; spaces are not counted). Every caption stays inside its source segment, all
//!   times are whole frames, captions never overlap.
//! - Reading speed: a caption above `maxCps` characters a second (spaces counted) is lengthened into a free
//!   gap after it, leaving at least one frame before the next caption; if it still reads too fast it is
//!   marked `fast`.

use std::collections::HashSet;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use crate::errors::{AppError, AppResult};

pub const RULES_JSON: &str = include_str!("../../../presets/caption-rules.json");

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Limits {
    pub max_lines: u32,
    pub max_chars: u32,
    pub max_words: Option<u32>,
    pub max_seconds: f64,
    pub min_seconds: f64,
    pub max_cps: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Ranges {
    max_lines: [f64; 2],
    max_chars: [f64; 2],
    max_words: [f64; 2],
    max_seconds: [f64; 2],
    min_seconds: [f64; 2],
    max_cps: [f64; 2],
}

/// The UI picks the starting limits from the same file (`timeline/captionRules.ts`); Rust only checks them.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(test), allow(dead_code))]
struct Defaults {
    landscape: Limits,
    square: Limits,
    vertical: Limits,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(test), allow(dead_code))]
pub struct Rules {
    landscape_from: f64,
    vertical_below: f64,
    uppercase_factor: f64,
    defaults: Defaults,
    ranges: Ranges,
    function_words: std::collections::HashMap<String, Vec<String>>,
}

pub fn rules() -> &'static Rules {
    static RULES: OnceLock<Rules> = OnceLock::new();
    RULES.get_or_init(|| {
        serde_json::from_str(RULES_JSON).expect("presets/caption-rules.json is valid")
    })
}

impl Rules {
    #[cfg_attr(not(test), allow(dead_code))]
    /// The starting limits for a canvas of this shape.
    pub fn defaults_for(&self, width: f64, height: f64) -> Limits {
        let aspect = width / height;
        if aspect >= self.landscape_from {
            self.defaults.landscape
        } else if aspect < self.vertical_below {
            self.defaults.vertical
        } else {
            self.defaults.square
        }
    }

    /// Function words of a language; all known ones when the language is unknown (auto-detected speech).
    fn function_words(&self, language: Option<&str>) -> HashSet<String> {
        match language.and_then(|l| self.function_words.get(l)) {
            Some(list) => list.iter().cloned().collect(),
            None => self.function_words.values().flatten().cloned().collect(),
        }
    }
}

impl Limits {
    /// Refuse limits outside the documented ranges (they come from the webview).
    pub fn check(&self) -> AppResult<()> {
        let r = &rules().ranges;
        let within = |v: f64, [lo, hi]: [f64; 2]| v.is_finite() && v >= lo && v <= hi;
        let ok = within(self.max_lines as f64, r.max_lines)
            && within(self.max_chars as f64, r.max_chars)
            && self.max_words.is_none_or(|w| within(w as f64, r.max_words))
            && within(self.max_seconds, r.max_seconds)
            && within(self.min_seconds, r.min_seconds)
            && within(self.max_cps, r.max_cps)
            && self.min_seconds <= self.max_seconds;
        if ok {
            Ok(())
        } else {
            Err(AppError::InvalidInput(
                "caption limits are out of range".into(),
            ))
        }
    }

    /// Uppercase letters are wider: fewer of them fit a line.
    fn for_case(mut self, uppercase: bool) -> Self {
        if uppercase {
            let fewer = (self.max_chars as f64 * rules().uppercase_factor).floor() as u32;
            self.max_chars = fewer.max(rules().ranges.max_chars[0] as u32);
        }
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Word {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

/// A stretch of text with its time (seconds). `words`, when given, must hold the same words as `text`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Source {
    pub start: f64,
    pub end: f64,
    pub text: String,
    #[serde(default)]
    pub words: Option<Vec<Word>>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Caption {
    pub start: f64,
    pub end: f64,
    /// Lines joined with `\n`.
    pub text: String,
    pub lines: u32,
    /// Reads faster than `maxCps` and there was no room to show it longer.
    pub fast: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub sources: Vec<Source>,
    pub limits: Limits,
    pub language: Option<String>,
    pub fps: f64,
    /// Nothing may run past this time (the end of the clip the captions belong to).
    pub end_limit: f64,
    #[serde(default)]
    pub uppercase: bool,
    #[serde(default = "yes")]
    pub bottom: bool,
}
fn yes() -> bool {
    true
}

pub const MAX_SOURCES: usize = 20_000;
pub const MAX_SOURCE_CHARS: usize = 20_000;

const CAPTION_COST: f64 = 3.0;
const CUT_SENTENCE: f64 = 0.0;
const CUT_CLAUSE: f64 = 0.3;
const CUT_PLAIN: f64 = 1.0;
const CUT_FUNCTION_WORD: f64 = 6.0;
const TOO_SHORT: f64 = 1.0;
const LINE_ENDS_ON_FUNCTION_WORD: f64 = 2.0;
const LINE_PLAIN_END: f64 = 0.1;
const TOP_LONGER: f64 = 0.05;
/// Weight of uneven lines against a line ending on punctuation (which costs nothing).
const BALANCE: f64 = 3.0;

fn chars(s: &str) -> usize {
    s.chars().count()
}

fn bare(word: &str) -> String {
    word.trim_matches(|c: char| !c.is_alphanumeric())
        .to_lowercase()
}

fn ends_sentence(word: &str) -> bool {
    word.trim_end_matches(['"', '\'', ')', '”', '’'])
        .ends_with(['.', '?', '!', '…'])
}

fn ends_clause(word: &str) -> bool {
    word.ends_with([',', ';', ':', '–', '—'])
}

struct Words<'a> {
    list: Vec<&'a str>,
    function: &'a HashSet<String>,
}

impl Words<'_> {
    /// A cut after word `i` that ends on a function word (punctuation after it makes it a real end).
    fn is_function_end(&self, i: usize) -> bool {
        let w = self.list[i];
        !ends_sentence(w) && !ends_clause(w) && self.function.contains(&bare(w))
    }

    fn cut_cost(&self, i: usize) -> f64 {
        let w = self.list[i];
        if ends_sentence(w) {
            CUT_SENTENCE
        } else if ends_clause(w) {
            CUT_CLAUSE
        } else if self.is_function_end(i) {
            CUT_FUNCTION_WORD
        } else {
            CUT_PLAIN
        }
    }

    fn line_len(&self, from: usize, to: usize) -> usize {
        self.list[from..to].iter().map(|w| chars(w)).sum::<usize>() + (to - from - 1)
    }

    /// Lay words `from..to` out in as few lines as fit, balanced. Line start indices and a cost, or `None`
    /// when they need more than `max_lines` lines.
    fn lay_out(
        &self,
        from: usize,
        to: usize,
        lim: &Limits,
        bottom: bool,
    ) -> Option<(Vec<usize>, f64)> {
        let max = lim.max_chars as usize;
        // fewest lines, filling greedily
        let mut needed = 1;
        let mut len = 0;
        for i in from..to {
            let w = chars(self.list[i]);
            if len > 0 && len + 1 + w > max {
                needed += 1;
                len = w;
            } else {
                len += if len > 0 { 1 + w } else { w };
            }
        }
        if needed > lim.max_lines as usize {
            return None;
        }
        let mut best: Option<(Vec<usize>, f64)> = None;
        let mut starts = vec![from];
        self.place_lines(from, to, needed, max, bottom, &mut starts, &mut best);
        best
    }

    #[allow(clippy::too_many_arguments)]
    fn place_lines(
        &self,
        at: usize,
        to: usize,
        left: usize,
        max: usize,
        bottom: bool,
        starts: &mut Vec<usize>,
        best: &mut Option<(Vec<usize>, f64)>,
    ) {
        if left == 1 {
            if to - at > 1 && self.line_len(at, to) > max {
                return;
            }
            let mut ends: Vec<usize> = starts[1..].to_vec();
            ends.push(to);
            let lens: Vec<f64> = starts
                .iter()
                .zip(&ends)
                .map(|(&a, &b)| self.line_len(a, b) as f64 / max as f64)
                .collect();
            let mean = lens.iter().sum::<f64>() / lens.len() as f64;
            let mut cost: f64 = BALANCE * lens.iter().map(|l| (l - mean) * (l - mean)).sum::<f64>();
            for &end in &ends[..ends.len() - 1] {
                cost += if self.is_function_end(end - 1) {
                    LINE_ENDS_ON_FUNCTION_WORD
                } else if ends_sentence(self.list[end - 1]) || ends_clause(self.list[end - 1]) {
                    0.0
                } else {
                    LINE_PLAIN_END
                };
            }
            if bottom && lens.len() >= 2 && lens[0] > lens[lens.len() - 1] {
                cost += TOP_LONGER;
            }
            if best.as_ref().is_none_or(|(_, c)| cost < *c) {
                *best = Some((starts.clone(), cost));
            }
            return;
        }
        // this line is at..next; at least one word on every remaining line
        for next in at + 1..=to - (left - 1) {
            if next - at > 1 && self.line_len(at, next) > max {
                break;
            }
            starts.push(next);
            self.place_lines(next, to, left - 1, max, bottom, starts, best);
            starts.pop();
        }
    }

    fn text(&self, to: usize, starts: &[usize]) -> String {
        let mut ends: Vec<usize> = starts[1..].to_vec();
        ends.push(to);
        starts
            .iter()
            .zip(&ends)
            .map(|(&a, &b)| self.list[a..b].join(" "))
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// One source cut into pieces: (first word, end word, line starts) per piece, plus their times in seconds.
fn cut_source(
    src: &Source,
    words: &Words,
    lim: &Limits,
    bottom: bool,
) -> Vec<(String, u32, f64, f64)> {
    let n = words.list.len();
    let timed = src
        .words
        .as_ref()
        .filter(|w| w.len() == n && w.iter().zip(&words.list).all(|(a, b)| a.text.trim() == *b));
    let weight: Vec<usize> = words.list.iter().map(|w| chars(w)).collect();
    let mut cum = vec![0usize; n + 1];
    for i in 0..n {
        cum[i + 1] = cum[i] + weight[i];
    }
    let total = cum[n].max(1) as f64;
    let length = (src.end - src.start).max(0.0);
    let at = |i: usize| -> f64 {
        match timed {
            Some(_) if i == 0 => src.start,
            Some(_) if i == n => src.end,
            Some(t) => t[i].start.clamp(src.start, src.end),
            None => src.start + length * cum[i] as f64 / total,
        }
    };

    // best[j] = cheapest way to cut words 0..j; from[j] = where its last piece starts
    let mut best = vec![f64::INFINITY; n + 1];
    let mut from = vec![0usize; n + 1];
    let mut layout: Vec<Option<(Vec<usize>, f64)>> = vec![None; n + 1];
    best[0] = 0.0;
    for j in 1..=n {
        for i in (0..j).rev() {
            let count = j - i;
            let seconds = at(j) - at(i);
            if count > 1
                && (lim.max_words.is_some_and(|m| count > m as usize) || seconds > lim.max_seconds)
            {
                break;
            }
            let Some((starts, line_cost)) = words.lay_out(i, j, lim, bottom).or_else(|| {
                // a single word longer than a whole caption still has to go somewhere
                (count == 1).then(|| (vec![i], 0.0))
            }) else {
                break;
            };
            if !best[i].is_finite() {
                continue;
            }
            let cut = if j == n { 0.0 } else { words.cut_cost(j - 1) };
            let short = if seconds < lim.min_seconds {
                TOO_SHORT
            } else {
                0.0
            };
            let cost = best[i] + CAPTION_COST + cut + short + line_cost;
            if cost < best[j] {
                best[j] = cost;
                from[j] = i;
                layout[j] = Some((starts, line_cost));
            }
        }
    }
    let mut pieces = Vec::new();
    let mut j = n;
    while j > 0 {
        let i = from[j];
        let (starts, _) = layout[j].clone().expect("every end has a layout");
        pieces.push((words.text(j, &starts), starts.len() as u32, at(i), at(j)));
        j = i;
    }
    pieces.reverse();
    pieces
}

/// Cut every source into captions under `limits`. See the module notes for the rules.
pub fn split(req: &Request) -> AppResult<Vec<Caption>> {
    req.limits.check()?;
    if !(req.fps.is_finite() && (1.0..=240.0).contains(&req.fps)) {
        return Err(AppError::InvalidInput("frame rate is out of range".into()));
    }
    if req.sources.len() > MAX_SOURCES {
        return Err(AppError::InvalidInput("too many captions at once".into()));
    }
    let lim = req.limits.for_case(req.uppercase);
    let function = rules().function_words(req.language.as_deref());
    let fps = req.fps;
    let limit_frame = (req.end_limit * fps + 1e-6).floor() as i64;

    let mut sources: Vec<&Source> = req
        .sources
        .iter()
        .filter(|s| s.start.is_finite() && s.end.is_finite())
        .collect();
    sources.sort_by(|a, b| a.start.total_cmp(&b.start));

    // (start frame, end frame, text, lines)
    let mut out: Vec<(i64, i64, String, u32)> = Vec::new();
    for src in sources {
        if chars(&src.text) > MAX_SOURCE_CHARS {
            return Err(AppError::InvalidInput("a caption is too long".into()));
        }
        let list: Vec<&str> = src.text.split_whitespace().collect();
        if list.is_empty() {
            continue;
        }
        let words = Words {
            list,
            function: &function,
        };
        let pieces = cut_source(src, &words, &lim, req.bottom);
        let floor = out.last().map_or(i64::MIN, |c| c.1);
        let first = ((src.start * fps - 1e-6).ceil() as i64).max(floor);
        let last = ((src.end * fps + 1e-6).floor() as i64).min(limit_frame);
        if last - first < pieces.len() as i64 {
            // too short to give every piece a frame: keep it whole rather than lose text
            let text = words.list.join(" ");
            let lines = words
                .lay_out(0, words.list.len(), &lim, req.bottom)
                .map_or(lim.max_lines + 1, |l| l.0.len() as u32);
            let end = (first + 1).max(last);
            out.push((first, end, text, lines));
            continue;
        }
        let k = pieces.len();
        let mut bounds = vec![first];
        for (idx, p) in pieces.iter().enumerate().skip(1) {
            let lo = bounds[idx - 1] + 1;
            let hi = last - (k - idx) as i64;
            bounds.push(((p.2 * fps).round() as i64).clamp(lo, hi));
        }
        bounds.push(last);
        for (idx, p) in pieces.into_iter().enumerate() {
            out.push((bounds[idx], bounds[idx + 1], p.0, p.1));
        }
    }

    // reading speed: lengthen into a free gap, never into the next caption
    let mut captions = Vec::with_capacity(out.len());
    for idx in 0..out.len() {
        let (start, mut end, text, lines) =
            (out[idx].0, out[idx].1, out[idx].2.clone(), out[idx].3);
        let needed = (chars(&text) as f64 / lim.max_cps * fps).ceil() as i64;
        let mut fast = false;
        if end - start < needed {
            let next = out.get(idx + 1).map_or(limit_frame + 1, |c| c.0);
            let room = next - 1;
            if room > end {
                end = (start + needed).min(room);
            }
            fast = end - start < needed;
        }
        out[idx].1 = end;
        captions.push(Caption {
            start: start as f64 / fps,
            end: end as f64 / fps,
            text,
            lines,
            fast,
        });
    }
    Ok(captions)
}

#[cfg(test)]
mod tests {
    use super::*;

    const LONG_ID: &str = "Hari ini kita akan belajar cara membuat video pendek yang menarik untuk media sosial, \
        mulai dari memilih musik yang tepat sampai menambahkan teks dan transisi yang halus di aplikasi sederhana ini.";

    fn landscape() -> Limits {
        rules().defaults_for(1920.0, 1080.0)
    }
    fn vertical() -> Limits {
        rules().defaults_for(1080.0, 1920.0)
    }
    fn req(sources: Vec<Source>, limits: Limits) -> Request {
        Request {
            sources,
            limits,
            language: Some("id".into()),
            fps: 30.0,
            end_limit: 1000.0,
            uppercase: false,
            bottom: true,
        }
    }
    fn src(start: f64, end: f64, text: &str) -> Source {
        Source {
            start,
            end,
            text: text.into(),
            words: None,
        }
    }
    fn squash(s: &str) -> String {
        s.split_whitespace().collect::<Vec<_>>().join(" ")
    }
    fn joined(c: &[Caption]) -> String {
        squash(
            &c.iter()
                .map(|c| c.text.as_str())
                .collect::<Vec<_>>()
                .join(" "),
        )
    }
    fn on_frame(t: f64) -> bool {
        ((t * 30.0) - (t * 30.0).round()).abs() < 1e-6
    }

    #[test]
    fn the_rules_file_loads_and_defaults_follow_the_canvas_shape() {
        assert_eq!(landscape().max_chars, 42);
        assert_eq!(rules().defaults_for(1080.0, 1080.0).max_chars, 32);
        assert_eq!(rules().defaults_for(1080.0, 1350.0).max_chars, 32);
        assert_eq!(vertical().max_chars, 24);
        assert_eq!(vertical().max_words, Some(5));
        for l in [landscape(), vertical(), rules().defaults_for(1.0, 1.0)] {
            l.check().unwrap();
        }
    }

    #[test]
    fn a_long_indonesian_sentence_on_a_wide_canvas_becomes_short_captions() {
        assert_eq!(LONG_ID.split_whitespace().count(), 31);
        let c = split(&req(vec![src(1.0, 12.0, LONG_ID)], landscape())).unwrap();
        assert!(c.len() >= 3, "{c:#?}");
        for cap in &c {
            assert!(cap.lines <= 2 && cap.text.lines().count() <= 2, "{cap:?}");
            assert!(cap.text.lines().all(|l| chars(l) <= 42), "{cap:?}");
        }
        assert_eq!(joined(&c), squash(LONG_ID));
    }

    #[test]
    fn on_a_vertical_canvas_lines_are_shorter_and_captions_hold_about_five_words() {
        let c = split(&req(vec![src(1.0, 12.0, LONG_ID)], vertical())).unwrap();
        for cap in &c {
            assert!(cap.text.lines().all(|l| chars(l) <= 24), "{cap:?}");
            assert!(cap.text.split_whitespace().count() <= 5, "{cap:?}");
        }
        assert_eq!(joined(&c), squash(LONG_ID));
    }

    #[test]
    fn uppercase_styles_get_fewer_characters_a_line() {
        let mut r = req(vec![src(1.0, 12.0, LONG_ID)], landscape());
        r.uppercase = true;
        for cap in split(&r).unwrap() {
            assert!(cap.text.lines().all(|l| chars(l) <= 35), "{cap:?}");
        }
    }

    #[test]
    fn no_caption_or_line_ends_on_a_function_word_and_lines_are_balanced() {
        let function = rules().function_words(Some("id"));
        for limits in [landscape(), vertical()] {
            let c = split(&req(vec![src(1.0, 12.0, LONG_ID)], limits)).unwrap();
            for cap in &c {
                for line in cap.text.lines() {
                    let last = line.split_whitespace().last().unwrap();
                    let ends_on = !ends_clause(last)
                        && !ends_sentence(last)
                        && function.contains(&bare(last));
                    assert!(!ends_on, "line ends on a function word: {cap:?}");
                }
                let lens: Vec<usize> = cap.text.lines().map(chars).collect();
                if lens.len() == 2 {
                    assert!(lens[0].abs_diff(lens[1]) <= 12, "unbalanced: {cap:?}");
                    assert!(lens[0] <= lens[1] + 6, "top much longer: {cap:?}");
                }
            }
        }
    }

    #[test]
    fn words_numbers_and_hyphenated_words_are_never_split() {
        let text = "Harga tiket naik menjadi Rp1.500.000 untuk kelas ekonomi-bisnis mulai tanggal 17-08-2026, \
            kata juru bicara maskapai pada konferensi pers di Jakarta kemarin sore.";
        let c = split(&req(vec![src(0.0, 10.0, text)], vertical())).unwrap();
        let pieces: Vec<&str> = c.iter().flat_map(|c| c.text.split_whitespace()).collect();
        assert_eq!(pieces, text.split_whitespace().collect::<Vec<_>>());
    }

    #[test]
    fn times_are_whole_frames_inside_the_segment_and_never_overlap() {
        let c = split(&req(
            vec![
                src(1.013, 12.27, LONG_ID),
                src(12.27, 14.0, "Selamat mencoba."),
            ],
            landscape(),
        ))
        .unwrap();
        for w in c.windows(2) {
            assert!(w[0].end <= w[1].start + 1e-9, "{w:?}");
        }
        for cap in &c {
            assert!(
                on_frame(cap.start) && on_frame(cap.end) && cap.end > cap.start,
                "{cap:?}"
            );
        }
        let first: Vec<&Caption> = c.iter().filter(|c| c.end <= 12.27 + 1e-9).collect();
        assert!(first[0].start >= 1.013 && first.last().unwrap().end <= 12.27);
    }

    #[test]
    fn time_is_shared_in_proportion_to_characters() {
        // two sentences, one three times as long in letters
        let text = "Satu dua. Ini kalimat yang jauh lebih panjang sekali.";
        let mut l = landscape();
        l.max_chars = 20;
        l.max_lines = 1;
        l.max_cps = 40.0;
        l.min_seconds = 0.2;
        let c = split(&req(vec![src(0.0, 30.0, text)], l)).unwrap();
        let total: usize = text.split_whitespace().map(chars).sum();
        let mut at = 0usize;
        for cap in &c {
            let start = 30.0 * at as f64 / total as f64;
            at += cap.text.split_whitespace().map(chars).sum::<usize>();
            let end = 30.0 * at as f64 / total as f64;
            assert!(
                (cap.start - start).abs() <= 1.0 / 30.0 + 1e-9,
                "{cap:?} vs {start}"
            );
            assert!(
                (cap.end - end).abs() <= 1.0 / 30.0 + 1e-9,
                "{cap:?} vs {end}"
            );
        }
    }

    #[test]
    fn with_word_times_captions_are_cut_at_word_starts() {
        let text = "one two three four five six seven eight nine ten eleven twelve";
        let words: Vec<Word> = text
            .split_whitespace()
            .enumerate()
            .map(|(i, w)| Word {
                start: 2.0 + i as f64 * 0.5 + if i >= 6 { 1.0 } else { 0.0 },
                end: 2.4 + i as f64 * 0.5,
                text: w.into(),
            })
            .collect();
        let starts: Vec<f64> = words.iter().map(|w| w.start).collect();
        let mut s = src(2.0, 9.0, text);
        s.words = Some(words);
        let mut r = req(vec![s], vertical());
        r.language = Some("en".into());
        let c = split(&r).unwrap();
        assert!(c.len() >= 3);
        for cap in &c[1..] {
            assert!(
                starts
                    .iter()
                    .any(|t| (t - cap.start).abs() <= 0.5 / 30.0 + 1e-9),
                "{cap:?}"
            );
        }
    }

    #[test]
    fn a_fast_caption_runs_on_into_a_gap_but_never_into_the_next_caption() {
        let quick = "Ini kalimat yang cukup panjang untuk dibaca.";
        let mut r = req(
            vec![src(1.0, 1.5, quick), src(5.0, 6.0, "Lalu.")],
            landscape(),
        );
        let c = split(&r).unwrap();
        let needed = chars(quick) as f64 / 20.0;
        assert!((c[0].end - c[0].start) >= needed - 1.0 / 30.0, "{c:?}");
        assert!(!c[0].fast);
        // the next caption starts right after: it stops a frame before it and is marked fast
        r.sources = vec![src(1.0, 1.5, quick), src(1.6, 2.6, "Lalu.")];
        let c = split(&r).unwrap();
        assert!(c[0].end <= 1.6 - 1.0 / 30.0 + 1e-9, "{c:?}");
        assert!(c[0].fast);
        assert!(c[0].end <= c[1].start);
    }

    #[test]
    fn limits_outside_their_ranges_are_refused() {
        let mut l = landscape();
        l.max_lines = 9;
        assert!(split(&req(vec![], l)).is_err());
        let mut l = landscape();
        l.max_cps = f64::NAN;
        assert!(split(&req(vec![], l)).is_err());
        let mut l = landscape();
        l.min_seconds = 5.0;
        l.max_seconds = 2.0;
        assert!(split(&req(vec![], l)).is_err());
        let mut r = req(vec![], landscape());
        r.fps = 0.0;
        assert!(split(&r).is_err());
    }

    #[test]
    fn a_word_longer_than_a_line_stands_alone_and_short_text_is_kept_whole() {
        let c = split(&req(
            vec![src(0.0, 5.0, "Supercalifragilisticexpialidocious")],
            vertical(),
        ))
        .unwrap();
        assert_eq!(c.len(), 1);
        let c = split(&req(vec![src(0.0, 2.0, "Halo semua.")], landscape())).unwrap();
        assert_eq!(
            c,
            vec![Caption {
                start: 0.0,
                end: 2.0,
                text: "Halo semua.".into(),
                lines: 1,
                fast: false
            }]
        );
    }
}
