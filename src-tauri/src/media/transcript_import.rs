//! Read a transcript file the user already has (`.json` list, YouTube `json3`, `.srt`, `.vtt`) into the
//! segments Auto Clips works on, instead of running speech recognition.
//!
//! The file is UNTRUSTED input: it is size-limited, read as UTF-8 text only, every number is checked, and
//! nothing in it is executed, fetched or opened. The format is detected from the content, not the extension.
//! Word timing is only reported when a json3 file really carries it and the offsets make sense; it is a
//! flag for the interface (nothing here invents word times).

use std::path::Path;

use serde::Serialize;
use serde_json::Value;

use super::whisper::{Segment, is_speech};
use crate::errors::{AppError, AppResult};

/// Largest transcript file that is read.
pub const MAX_BYTES: u64 = 5 * 1024 * 1024;
/// Most lines kept (a ten-hour talk is about 10 000).
const MAX_LINES: usize = 100_000;
/// Longest text of one line, in characters; a longer line is cut.
const MAX_LINE_CHARS: usize = 2_000;
/// No time in a file may be beyond this (48 hours), in seconds.
const MAX_SECONDS: f64 = 172_800.0;
/// A clamped line shorter than this keeps its own end.
const MIN_LINE: f64 = 0.05;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Format {
    /// `[{ "start", "duration", "text" }]`
    List,
    /// YouTube `json3` (`events[].segs[]`).
    Json3,
    Srt,
    Vtt,
}

impl Format {
    pub fn label(self) -> &'static str {
        match self {
            Format::List => "JSON list",
            Format::Json3 => "YouTube json3",
            Format::Srt => "SubRip (.srt)",
            Format::Vtt => "WebVTT (.vtt)",
        }
    }
}

/// A parsed file: lines in time order, times in seconds on the file's own clock.
#[derive(Debug, Clone, PartialEq)]
pub struct Imported {
    pub format: Format,
    pub segments: Vec<Segment>,
    /// Every line of a json3 file has usable word offsets.
    pub word_level: bool,
    /// Why there is no word timing, in plain words (empty when there is).
    pub word_reason: String,
}

fn bad<T>(m: &str) -> AppResult<T> {
    Err(AppError::InvalidInput(m.to_string()))
}

/// Read the file (text only, size-limited) and parse it.
pub fn read_file(path: &Path) -> AppResult<(Imported, Vec<u8>)> {
    let meta = std::fs::symlink_metadata(path)?;
    if !meta.is_file() {
        return bad("this is not a regular file");
    }
    if meta.len() > MAX_BYTES {
        return bad("the transcript file is too large (5 MB at most)");
    }
    let bytes = std::fs::read(path)?;
    let imported = parse(&bytes)?;
    Ok((imported, bytes))
}

/// Parse a transcript from its bytes.
pub fn parse(bytes: &[u8]) -> AppResult<Imported> {
    if bytes.len() as u64 > MAX_BYTES {
        return bad("the transcript file is too large (5 MB at most)");
    }
    let text = std::str::from_utf8(bytes)
        .map_err(|_| AppError::InvalidInput("this is not a text file".into()))?;
    if text.contains('\0') {
        return bad("this is not a text file");
    }
    let text = text.trim_start_matches('\u{feff}');
    let head = text.trim_start();

    let (format, raw, word_level, word_reason) = if head.starts_with('{') || head.starts_with('[') {
        let value: Value = serde_json::from_str(head)
            .map_err(|_| AppError::InvalidInput("the JSON in this file is not valid".into()))?;
        if value.get("events").is_some_and(Value::is_array) {
            let (raw, word_level, reason) = from_json3(&value)?;
            (Format::Json3, raw, word_level, reason)
        } else if let Some(items) = value.as_array() {
            (
                Format::List,
                from_list(items)?,
                false,
                "this format has only line times".to_string(),
            )
        } else {
            return bad("this JSON is not a transcript (expected a list of lines or a json3 file)");
        }
    } else if head.starts_with("WEBVTT") {
        (
            Format::Vtt,
            from_cues(head)?,
            false,
            "this format has only line times".to_string(),
        )
    } else if head.contains("-->") {
        (
            Format::Srt,
            from_cues(head)?,
            false,
            "this format has only line times".to_string(),
        )
    } else {
        return bad("this file is not a transcript (JSON, json3, .srt or .vtt)");
    };

    let segments = normalise(raw)?;
    let word_level = word_level && !segments.is_empty();
    Ok(Imported {
        format,
        segments,
        word_level,
        word_reason: if word_level {
            String::new()
        } else {
            word_reason
        },
    })
}

/// One line before the overlap rule: start and the end the file asked for.
struct Raw {
    start: f64,
    end: f64,
    text: String,
}

fn time_ok(v: f64) -> bool {
    v.is_finite() && (0.0..=MAX_SECONDS).contains(&v)
}

fn push(out: &mut Vec<Raw>, start: f64, duration: f64, text: &str) -> AppResult<()> {
    if !time_ok(start) || !duration.is_finite() || !(0.0..=MAX_SECONDS).contains(&duration) {
        return bad("a line has a time outside the allowed range");
    }
    if out.len() >= MAX_LINES {
        return bad("the transcript has too many lines (100 000 at most)");
    }
    out.push(Raw {
        start,
        end: start + duration,
        text: text.to_string(),
    });
    Ok(())
}

fn from_list(items: &[Value]) -> AppResult<Vec<Raw>> {
    let mut out = Vec::new();
    for item in items {
        let (Some(start), Some(duration), Some(text)) = (
            item.get("start").and_then(Value::as_f64),
            item.get("duration").and_then(Value::as_f64),
            item.get("text").and_then(Value::as_str),
        ) else {
            return bad("every line needs a number \"start\", a number \"duration\" and a text");
        };
        push(&mut out, start, duration, text)?;
    }
    Ok(out)
}

/// json3 events, plus whether every line has sound word offsets.
fn from_json3(value: &Value) -> AppResult<(Vec<Raw>, bool, String)> {
    let events = value["events"].as_array().map_or(&[][..], Vec::as_slice);
    let mut out = Vec::new();
    let mut any_offsets = false;
    let mut broken: Option<&str> = None;
    for event in events {
        let Some(segs) = event.get("segs").and_then(Value::as_array) else {
            continue;
        };
        let start_ms = event.get("tStartMs").and_then(Value::as_f64);
        let duration_ms = event.get("dDurationMs").and_then(Value::as_f64);
        let (Some(start_ms), duration_ms) = (start_ms, duration_ms.unwrap_or(0.0)) else {
            return bad("a json3 event has no start time");
        };
        let mut text = String::new();
        let mut offsets = Vec::new();
        for seg in segs {
            let Some(piece) = seg.get("utf8").and_then(Value::as_str) else {
                return bad("a json3 segment has no text");
            };
            text.push_str(piece);
            if !piece.trim().is_empty() {
                offsets.push(seg.get("tOffsetMs").and_then(Value::as_f64));
            }
        }
        if text.trim().is_empty() {
            continue;
        }
        push(&mut out, start_ms / 1000.0, duration_ms / 1000.0, &text)?;

        // The first word of an event may leave its offset out (it is 0); later words need one.
        let mut last = 0.0f64;
        for (n, offset) in offsets.iter().enumerate() {
            match offset {
                Some(o) => {
                    any_offsets = true;
                    if !o.is_finite() || *o < last || *o > duration_ms.max(0.0) {
                        broken.get_or_insert("the word times in this file are not in order");
                    }
                    last = o.max(last);
                }
                None if n > 0 => {
                    broken.get_or_insert("some words have no time in this file");
                }
                None => {}
            }
        }
    }
    let reason = if !any_offsets {
        "this file has line times but no word times"
    } else {
        broken.unwrap_or("")
    };
    Ok((out, any_offsets && broken.is_none(), reason.to_string()))
}

/// `00:00:01,500` / `00:01.500` / `1:02:03.4` to seconds.
fn clock(token: &str) -> Option<f64> {
    let token = token.trim().replace(',', ".");
    let parts: Vec<&str> = token.split(':').collect();
    if !(2..=3).contains(&parts.len()) {
        return None;
    }
    let mut total = 0.0;
    for part in &parts {
        if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
            return None;
        }
        total = total * 60.0 + part.parse::<f64>().ok()?;
    }
    Some(total)
}

/// SRT and VTT cues: any block that has a `start --> end` line.
fn from_cues(text: &str) -> AppResult<Vec<Raw>> {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut out = Vec::new();
    let mut block: Vec<&str> = Vec::new();
    let flush = |block: &mut Vec<&str>, out: &mut Vec<Raw>| -> AppResult<()> {
        if let Some(at) = block.iter().position(|l| l.contains("-->")) {
            let (a, rest) = block[at].split_once("-->").unwrap_or(("", ""));
            // VTT cue settings follow the end time ("align:start")
            let b = rest.split_whitespace().next().unwrap_or("");
            let (Some(start), Some(end)) = (clock(a), clock(b)) else {
                return bad("a cue has a time that cannot be read");
            };
            if end < start {
                return bad("a cue ends before it starts");
            }
            let body = block[at + 1..].join(" ");
            push(out, start, end - start, &body)?;
        }
        block.clear();
        Ok(())
    };
    for line in text.lines() {
        if line.trim().is_empty() {
            flush(&mut block, &mut out)?;
        } else {
            block.push(line);
        }
    }
    flush(&mut block, &mut out)?;
    Ok(out)
}

/// Plain text of a line: markup tags (`<i>`, `<c>`, VTT word stamps) removed, spaces collapsed.
fn clean(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_tag = false;
    for c in text.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if in_tag => {}
            '\n' | '\r' | '\t' => out.push(' '),
            _ => out.push(c),
        }
    }
    let joined = out.split_whitespace().collect::<Vec<_>>().join(" ");
    joined.chars().take(MAX_LINE_CHARS).collect()
}

/// Order the lines, drop empty / tag-only / repeated ones and apply the rolling-caption rule:
/// a line ends where the next one starts when they overlap.
fn normalise(mut raw: Vec<Raw>) -> AppResult<Vec<Segment>> {
    for r in &mut raw {
        r.text = clean(&r.text);
    }
    // "[Music]", "(applause)", "♪" and empty lines are not speech
    raw.retain(|r| is_speech(&r.text));
    raw.sort_by(|a, b| a.start.total_cmp(&b.start));

    let mut kept: Vec<Raw> = Vec::new();
    for r in raw {
        if let Some(last) = kept.last() {
            // the same words again while the previous line is still on screen (rolling captions)
            if last.text == r.text && r.start <= last.end + 1e-6 {
                continue;
            }
        }
        kept.push(r);
    }
    if kept.is_empty() {
        return bad("the file has no spoken lines");
    }
    let starts: Vec<f64> = kept.iter().map(|r| r.start).collect();
    Ok(kept
        .into_iter()
        .enumerate()
        .map(|(i, r)| {
            let mut end = r.end;
            if let Some(next) = starts.get(i + 1)
                && *next - r.start >= MIN_LINE
            {
                end = end.min(*next);
            }
            if end - r.start < MIN_LINE {
                end = r.end.max(r.start + MIN_LINE);
            }
            Segment {
                start: r.start,
                end,
                text: r.text,
            }
        })
        .collect())
}

/// The lines that fall into `[range_in, range_out]` of the video, moved by `offset` seconds, as seconds
/// from `range_in` (what the speech model's segments look like). A line that crosses an edge is cut.
pub fn to_range(segments: &[Segment], offset: f64, range_in: f64, range_out: f64) -> Vec<Segment> {
    segments
        .iter()
        .filter_map(|s| {
            let start = (s.start + offset).max(range_in);
            let end = (s.end + offset).min(range_out);
            (end - start >= MIN_LINE).then(|| Segment {
                start: start - range_in,
                end: end - range_in,
                text: s.text.clone(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(start: f64, end: f64, text: &str) -> Segment {
        Segment {
            start,
            end,
            text: text.into(),
        }
    }

    #[test]
    fn a_list_ends_each_line_where_the_next_one_starts() {
        let json = r#"[{"start":0.08,"duration":3.52,"text":"Nge-blank gimana sih? Gua training lu"},
            {"start":1.439,"duration":3.801,"text":"biar enggak nge-blank. Oke. Salah satu"},
            {"start":3.6,"duration":4.68,"text":"trainingnya adalah nih"}]"#;
        let got = parse(json.as_bytes()).unwrap();
        assert_eq!(got.format, Format::List);
        assert_eq!(got.segments[0].end, 1.439);
        assert_eq!(got.segments[1].end, 3.6);
        assert!(
            (got.segments[2].end - 8.28).abs() < 1e-9,
            "the last line keeps its own end"
        );
        assert!(!got.word_level);
        assert!(got.word_reason.contains("only line times"));
    }

    fn json3(first_offset: &str, second_offset: &str) -> String {
        format!(
            r#"{{"events":[
            {{"tStartMs":0,"dDurationMs":9000,"id":1}},
            {{"tStartMs":80,"dDurationMs":3520,"segs":[{{"utf8":"Nge-blank"}},{{"utf8":" gimana"{first_offset}}},{{"utf8":" sih?"{second_offset}}}]}},
            {{"tStartMs":1429,"dDurationMs":2171,"aAppend":1,"segs":[{{"utf8":"\n"}}]}},
            {{"tStartMs":1439,"dDurationMs":3801,"segs":[{{"utf8":"biar"}},{{"utf8":" enggak","tOffsetMs":500}}]}}]}}"#
        )
    }

    #[test]
    fn json3_with_good_word_offsets_is_word_level() {
        let got = parse(json3(r#","tOffsetMs":400"#, r#","tOffsetMs":639"#).as_bytes()).unwrap();
        assert_eq!(got.format, Format::Json3);
        assert_eq!(
            got.segments.len(),
            2,
            "the newline-only and window events are dropped"
        );
        assert_eq!(got.segments[0].text, "Nge-blank gimana sih?");
        assert_eq!(got.segments[0].end, 1.439);
        assert!(got.word_level, "{}", got.word_reason);
    }

    #[test]
    fn json3_without_or_with_wrong_offsets_is_line_level_with_a_reason() {
        let none = parse(json3("", "").as_bytes()).unwrap();
        // the second line still has an offset, the first has a word with none
        assert!(!none.word_level);
        assert!(none.word_reason.contains("no time"));

        let backwards =
            parse(json3(r#","tOffsetMs":700"#, r#","tOffsetMs":600"#).as_bytes()).unwrap();
        assert!(!backwards.word_level);
        assert!(backwards.word_reason.contains("not in order"));

        let outside =
            parse(json3(r#","tOffsetMs":400"#, r#","tOffsetMs":99999"#).as_bytes()).unwrap();
        assert!(!outside.word_level);

        let plain =
            r#"{"events":[{"tStartMs":0,"dDurationMs":2000,"segs":[{"utf8":"hello there"}]}]}"#;
        let got = parse(plain.as_bytes()).unwrap();
        assert!(!got.word_level);
        assert!(got.word_reason.contains("no word times"));
    }

    #[test]
    fn srt_and_vtt_are_read_and_markup_is_removed() {
        let srt = "1\r\n00:00:01,000 --> 00:00:03,500\r\n<i>Hello</i>\r\nthere\r\n\r\n2\r\n00:00:04,000 --> 00:00:06,000\r\nBye now\r\n";
        let got = parse(srt.as_bytes()).unwrap();
        assert_eq!(got.format, Format::Srt);
        assert_eq!(
            got.segments,
            vec![seg(1.0, 3.5, "Hello there"), seg(4.0, 6.0, "Bye now")]
        );

        let vtt = "WEBVTT\n\n00:01.000 --> 00:03.500 align:start\nHello <c>wor</c><00:00:02.000>ld\n\n1:00:00.000 --> 1:00:01.000\nLate\n";
        let got = parse(vtt.as_bytes()).unwrap();
        assert_eq!(got.format, Format::Vtt);
        assert_eq!(got.segments[0], seg(1.0, 3.5, "Hello world"));
        assert_eq!(got.segments[1].start, 3600.0);
    }

    #[test]
    fn empty_tag_only_and_repeated_lines_are_dropped() {
        let json = r#"[{"start":0,"duration":2,"text":"[Music]"},
            {"start":1,"duration":2,"text":"   "},
            {"start":2,"duration":2,"text":"Real words"},
            {"start":3,"duration":2,"text":"Real words"},
            {"start":9,"duration":2,"text":"Real words"}]"#;
        let got = parse(json.as_bytes()).unwrap();
        // the repeat while the line is on screen goes; the same words later are kept
        assert_eq!(got.segments.len(), 2);
        assert_eq!(got.segments[0].start, 2.0);
        assert_eq!(got.segments[1].start, 9.0);
    }

    #[test]
    fn bad_files_are_rejected_with_a_message() {
        let cases: Vec<(&str, Vec<u8>)> = vec![
            ("not text", vec![0xff, 0xfe, 0x00, 0x01]),
            (
                "nul",
                b"[{\"start\":0,\"duration\":1,\"text\":\"a\\u0000\"}]\0".to_vec(),
            ),
            ("plain", b"just some words".to_vec()),
            ("json object", br#"{"hello":1}"#.to_vec()),
            ("broken json", b"[{\"start\":".to_vec()),
            (
                "wrong types",
                br#"[{"start":"0","duration":1,"text":"a"}]"#.to_vec(),
            ),
            ("missing text", br#"[{"start":0,"duration":1}]"#.to_vec()),
            (
                "negative start",
                br#"[{"start":-1,"duration":1,"text":"a"}]"#.to_vec(),
            ),
            (
                "huge time",
                br#"[{"start":1e12,"duration":1,"text":"a"}]"#.to_vec(),
            ),
            (
                "negative length",
                br#"[{"start":0,"duration":-2,"text":"a"}]"#.to_vec(),
            ),
            (
                "no speech",
                br#"[{"start":0,"duration":1,"text":"[Music]"}]"#.to_vec(),
            ),
            ("empty list", b"[]".to_vec()),
            ("bad cue", b"1\n00:00:xx --> 00:00:02,000\nhi\n".to_vec()),
            (
                "backwards cue",
                b"1\n00:00:05,000 --> 00:00:02,000\nhi\n".to_vec(),
            ),
        ];
        for (name, bytes) in cases {
            assert!(parse(&bytes).is_err(), "{name} should be rejected");
        }
    }

    #[test]
    fn an_oversized_file_is_rejected_before_it_is_parsed() {
        let big = vec![b' '; MAX_BYTES as usize + 1];
        let err = parse(&big).unwrap_err().to_string();
        assert!(err.contains("too large"), "{err}");
    }

    #[test]
    fn a_text_in_any_encoding_marker_is_found_by_content() {
        let with_bom = "\u{feff}[{\"start\":0,\"duration\":1,\"text\":\"hi\"}]";
        assert_eq!(parse(with_bom.as_bytes()).unwrap().format, Format::List);
        // a list saved as `.srt` is still a list
        assert!(parse(b"  \n[{\"start\":0,\"duration\":1,\"text\":\"hi\"}]").is_ok());
    }

    #[test]
    fn the_range_and_the_offset_move_and_cut_the_lines() {
        let lines = vec![
            seg(0.0, 10.0, "a"),
            seg(10.0, 20.0, "b"),
            seg(30.0, 40.0, "c"),
        ];
        // video part 5..25, offset +2: a = 2..12, b = 12..22, c = 32..42 (outside)
        let got = to_range(&lines, 2.0, 5.0, 25.0);
        assert_eq!(got, vec![seg(0.0, 7.0, "a"), seg(7.0, 17.0, "b")]);
        // a negative offset moves lines earlier
        let got = to_range(&lines, -8.0, 0.0, 100.0);
        assert_eq!(got[0], seg(0.0, 2.0, "a"));
        assert_eq!(got.len(), 3);
    }

    #[test]
    fn lines_without_punctuation_still_become_sentences_by_pause() {
        use crate::media::clipper::{CONFIG, split_sentences};
        let lines = vec![
            seg(0.0, 2.0, "tidak ada tanda baca di sini"),
            seg(2.0, 4.0, "dan ini lanjutannya"),
            seg(9.0, 11.0, "setelah jeda panjang"),
        ];
        let got = split_sentences(&lines, &CONFIG);
        assert_eq!(got.len(), 2, "a pause closes the sentence: {got:?}");
    }

    #[test]
    fn the_real_youtube_samples_agree_and_json3_has_word_times() {
        let list = parse(include_bytes!("../../fixtures/transcript-sample.json")).unwrap();
        let rich = parse(include_bytes!("../../fixtures/transcript-sample.json3")).unwrap();
        assert_eq!((list.format, rich.format), (Format::List, Format::Json3));
        assert!(!list.word_level && rich.word_level, "{}", rich.word_reason);
        let n = rich.segments.len();
        assert!(n >= 6, "{n}");
        // the same words and the same line starts in both files
        for (a, b) in list.segments.iter().zip(&rich.segments).take(n - 1) {
            assert_eq!(a.text, b.text);
            assert!((a.start - b.start).abs() < 1e-9);
        }
        assert_eq!(rich.segments[0].start, 0.08);
    }
}
