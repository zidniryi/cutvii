//! Beat effects (zoom pulse, shake, flash, glitch) for the export.
//!
//! One function of time decides every effect (`frame_at`), from the clip's beats. The export samples it at
//! every output frame, turns the result into whole numbers (`params`) and hands them to FFmpeg's `sendcmd`
//! as a command file, which changes the `scale` / `crop` / `colorlevels` / `rgbashift` filters of the clip
//! frame by frame. A time formula inside the filters does not work: FFmpeg refuses the filter once a clip
//! has a few hundred beats (measured in the Beat Sync spike).
//!
//! The numbers live in `presets/beat-effects.json`, which the preview reads too (`src/timeline/beatFx.ts`),
//! so both draw the same effect. The effects sit after crop and colour and before fit, scale and position,
//! on the picture itself: a zoom never zooms the bars of a fitted video, and sizes are shares of the picture.
//!
//! - Time: a beat of the clip is at `(source - sourceIn) / speed` seconds from the clip's start. An effect
//!   fires on every `everyNthBeat`-th beat counted from the first beat inside the clip, `offsetMs` later.
//! - Strength `e` (0 to 1) after a trigger, for `x = seconds since the trigger / duration`: "out" `(1-x)^2`,
//!   "linear" `1-x`, "in-out" `sin(pi x)`; 0 once `x >= 1`. The latest trigger counts.
//! - Zoom `+amount * I * e` of the size. Shake moves the picture `amount * I * e` of its width (`amountY` of
//!   its height) along a sine / cosine of `hz` Hz and grows the picture by twice that so no edge shows.
//!   Flash mixes the picture towards white by `amount * I * e`. Glitch moves red and blue apart by
//!   `amount * I * e` of the width.
//! - "Reduce flashing" (default on) caps a flash at `maxFlashIntensity` and drops flash triggers closer than
//!   `minGapSeconds` (at most three flashes a second).

use std::f64::consts::PI;
use std::fmt::Write as _;
use std::sync::OnceLock;

use serde::Deserialize;

use crate::media::beats::BeatGrid;
use crate::project::{BeatEasing, BeatEffect, BeatEffectKind, BeatFx, HalfDouble};

#[derive(Debug, Deserialize)]
struct Pulse {
    duration: f64,
    amount: f64,
}

#[derive(Debug, Deserialize)]
struct Shake {
    duration: f64,
    amount: f64,
    #[serde(rename = "amountY")]
    amount_y: f64,
    hz: f64,
}

#[derive(Debug, Deserialize)]
struct Reduce {
    #[serde(rename = "maxFlashIntensity")]
    max_flash_intensity: f64,
    #[serde(rename = "minGapSeconds")]
    min_gap_seconds: f64,
}

#[derive(Debug, Deserialize)]
struct Table {
    zoom: Pulse,
    shake: Shake,
    flash: Pulse,
    glitch: Pulse,
    #[serde(rename = "reduceFlashing")]
    reduce_flashing: Reduce,
    #[serde(rename = "maxClipSeconds")]
    max_clip_seconds: f64,
}

fn table() -> &'static Table {
    static TABLE: OnceLock<Table> = OnceLock::new();
    TABLE.get_or_init(|| {
        serde_json::from_str(include_str!("../../../presets/beat-effects.json"))
            .expect("presets/beat-effects.json is valid")
    })
}

/// The longest clip (timeline seconds) that beat effects are made for.
pub fn max_clip_seconds() -> f64 {
    table().max_clip_seconds
}

fn duration(kind: BeatEffectKind) -> f64 {
    match kind {
        BeatEffectKind::Zoom => table().zoom.duration,
        BeatEffectKind::Shake => table().shake.duration,
        BeatEffectKind::Flash => table().flash.duration,
        BeatEffectKind::Glitch => table().glitch.duration,
    }
}

fn constant_grid(anchor: f64, period: f64, start: f64, end: f64) -> Vec<f64> {
    let mut out = Vec::new();
    let mut t = anchor - ((anchor - start) / period).floor() * period;
    if t < start - 1e-9 {
        t += period;
    }
    while t < end - 1e-9 {
        out.push(t);
        t += period;
    }
    out
}

/// The beats (source times) after the user's adjustments; the same rules as `adjustedBeats` in
/// `src/timeline/beats.ts`: a tempo override gives a constant grid through the detected first beat, a steady
/// grid is used as a constant grid, an unsteady one as its tracked beats; the nudge moves everything; "half"
/// keeps every other beat from the one nearest the first beat, "double" adds one half-way between each two.
pub fn adjusted_beats(grid: &BeatGrid, fx: &BeatFx) -> Vec<f64> {
    let shift = fx.offset_ms.unwrap_or(0.0) / 1000.0;
    let anchor = grid.offset + shift;
    let mut beats: Vec<f64> = match fx.bpm_override {
        Some(bpm) if bpm > 0.0 => constant_grid(anchor, 60.0 / bpm, grid.start, grid.end),
        _ if grid.steady && grid.bpm > 0.0 => {
            constant_grid(anchor, 60.0 / grid.bpm, grid.start, grid.end)
        }
        _ => grid
            .beats
            .iter()
            .map(|b| b + shift)
            .filter(|b| *b >= grid.start && *b < grid.end)
            .collect(),
    };
    match fx.half_double {
        Some(HalfDouble::Half) => {
            let keep = beats.iter().enumerate().fold(0usize, |best, (i, b)| {
                if (b - anchor).abs() < (beats[best] - anchor).abs() {
                    i
                } else {
                    best
                }
            });
            beats = beats
                .into_iter()
                .enumerate()
                .filter(|(i, _)| (*i as i64 - keep as i64) % 2 == 0)
                .map(|(_, b)| b)
                .collect();
        }
        Some(HalfDouble::Double) => {
            let mut doubled = Vec::with_capacity(beats.len() * 2);
            for (i, b) in beats.iter().enumerate() {
                doubled.push(*b);
                if let Some(next) = beats.get(i + 1) {
                    doubled.push((b + next) / 2.0);
                }
            }
            beats = doubled;
        }
        None => {}
    }
    beats
}

/// The clip's beats in clip time (seconds from its start): only the source range it uses, speed applied.
pub fn clip_beats(
    grid: &BeatGrid,
    fx: &BeatFx,
    source_in: f64,
    source_out: f64,
    speed: f64,
) -> Vec<f64> {
    adjusted_beats(grid, fx)
        .into_iter()
        .filter(|s| *s >= source_in - 1e-9 && *s < source_out - 1e-9)
        .map(|s| (s - source_in) / speed)
        .collect()
}

/// One effect with the times it fires, ready to be sampled.
#[derive(Debug, Clone, PartialEq)]
pub struct Pulses {
    pub kind: BeatEffectKind,
    pub intensity: f64,
    pub easing: BeatEasing,
    pub triggers: Vec<f64>,
}

/// The effects of a clip with their trigger times. Effects at intensity 0 are left out. With
/// `reduce_flashing` a flash is capped and triggers closer together than the minimum gap are dropped.
pub fn pulses(effects: &[BeatEffect], beats: &[f64], reduce_flashing: bool) -> Vec<Pulses> {
    effects
        .iter()
        .filter(|e| e.intensity > 0.0)
        .map(|e| {
            let n = e.every_nth_beat.max(1) as usize;
            let mut triggers: Vec<f64> = beats
                .iter()
                .step_by(n)
                .map(|b| b + e.offset_ms / 1000.0)
                .collect();
            let mut intensity = e.intensity;
            if reduce_flashing && e.kind == BeatEffectKind::Flash {
                let limits = &table().reduce_flashing;
                intensity = intensity.min(limits.max_flash_intensity);
                let mut kept: Vec<f64> = Vec::with_capacity(triggers.len());
                for t in triggers {
                    if kept
                        .last()
                        .is_none_or(|last| t - last >= limits.min_gap_seconds - 1e-9)
                    {
                        kept.push(t);
                    }
                }
                triggers = kept;
            }
            Pulses {
                kind: e.kind,
                intensity,
                easing: e.easing.unwrap_or(BeatEasing::Out),
                triggers,
            }
        })
        .collect()
}

/// What the effects do at one moment, as shares of the picture.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Frame {
    /// Size of the picture (1 = as it is), zoom and the margin shake needs together.
    pub zoom: f64,
    /// How far the picture is moved, as shares of its width / height (right and down are positive).
    pub dx: f64,
    pub dy: f64,
    /// Mix towards white, 0 to 1.
    pub flash: f64,
    /// Red and blue moved apart by this share of the width.
    pub glitch: f64,
}

fn strength(easing: BeatEasing, x: f64) -> f64 {
    if !(0.0..1.0).contains(&x) {
        return 0.0;
    }
    match easing {
        BeatEasing::Out => (1.0 - x) * (1.0 - x),
        BeatEasing::Linear => 1.0 - x,
        BeatEasing::InOut => (PI * x).sin(),
    }
}

/// The effects at clip time `t`.
pub fn frame_at(pulses: &[Pulses], t: f64) -> Frame {
    let k = table();
    let mut f = Frame {
        zoom: 1.0,
        ..Frame::default()
    };
    for p in pulses {
        // the latest trigger at or before t
        let i = p.triggers.partition_point(|trigger| *trigger <= t + 1e-9);
        if i == 0 {
            continue;
        }
        let u = (t - p.triggers[i - 1]).max(0.0);
        let e = p.intensity * strength(p.easing, u / duration(p.kind));
        match p.kind {
            BeatEffectKind::Zoom => f.zoom += k.zoom.amount * e,
            BeatEffectKind::Shake => {
                f.zoom += 2.0 * k.shake.amount * e;
                f.dx += k.shake.amount * e * (2.0 * PI * k.shake.hz * u).sin();
                f.dy += k.shake.amount_y * e * (2.0 * PI * k.shake.hz * u).cos();
            }
            BeatEffectKind::Flash => f.flash = (f.flash + k.flash.amount * e).min(1.0),
            BeatEffectKind::Glitch => f.glitch += k.glitch.amount * e,
        }
    }
    f
}

/// A `Frame` as the whole numbers FFmpeg gets, for a picture of `w` x `h` pixels (both even).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Params {
    /// Size the picture is scaled to before it is cropped back to `w` x `h` (even).
    pub scaled_w: u32,
    pub scaled_h: u32,
    /// Top-left of the window cut out of the scaled picture.
    pub x: u32,
    pub y: u32,
    /// Flash as a thousandth: the lowest level an output value can have, 0 to 1000.
    pub flash: u32,
    /// Pixels red moves one way and blue the other.
    pub split: u32,
}

fn even(v: f64) -> u32 {
    ((v / 2.0).round() as u32).max(1) * 2
}

pub fn params(f: &Frame, w: u32, h: u32) -> Params {
    let (scaled_w, scaled_h) = (
        even(w as f64 * f.zoom).max(w),
        even(h as f64 * f.zoom).max(h),
    );
    let place = |slack: u32, d: f64, size: u32| {
        (((slack as f64) / 2.0 - d * size as f64).round().max(0.0) as u32).min(slack)
    };
    Params {
        scaled_w,
        scaled_h,
        x: place(scaled_w - w, f.dx, w),
        y: place(scaled_h - h, f.dy, h),
        flash: (f.flash.clamp(0.0, 1.0) * 1000.0).round() as u32,
        split: (f.glitch * w as f64).round().max(0.0) as u32,
    }
}

/// Which filters a set of effects needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Uses {
    pub geometry: bool,
    pub flash: bool,
    pub glitch: bool,
}

pub fn uses(pulses: &[Pulses]) -> Uses {
    let has = |kinds: &[BeatEffectKind]| pulses.iter().any(|p| kinds.contains(&p.kind));
    Uses {
        geometry: has(&[BeatEffectKind::Zoom, BeatEffectKind::Shake]),
        flash: has(&[BeatEffectKind::Flash]),
        glitch: has(&[BeatEffectKind::Glitch]),
    }
}

/// Names of the filters in the graph, so the command file can reach them; `tag` is unique per clip.
fn names(tag: &str) -> (String, String, String, String) {
    (
        format!("scale@bs{tag}"),
        format!("crop@bc{tag}"),
        format!("colorlevels@bf{tag}"),
        format!("rgbashift@bg{tag}"),
    )
}

/// The `sendcmd` file: a line for every output frame whose numbers differ from the frame before. A line
/// fires on its frame (half a frame early). Returns the text and the numbers of the first frame, which the
/// filters start with.
pub fn command_file(
    pulses: &[Pulses],
    clip_seconds: f64,
    fps: f64,
    w: u32,
    h: u32,
    tag: &str,
) -> (String, Params) {
    let used = uses(pulses);
    let (scale, crop, levels, shift) = names(tag);
    let frames = (clip_seconds * fps).ceil() as usize + 1;
    let first = params(&frame_at(pulses, 0.0), w, h);
    let mut text = String::new();
    let mut last: Option<Params> = None;
    for n in 0..frames {
        let p = params(&frame_at(pulses, n as f64 / fps), w, h);
        if last == Some(p) || (last.is_none() && p == first) {
            last = Some(p);
            continue;
        }
        let before = last.unwrap_or(first);
        let mut cmds: Vec<String> = Vec::new();
        if used.geometry {
            if (p.scaled_w, p.scaled_h) != (before.scaled_w, before.scaled_h) {
                cmds.push(format!("[enter] {scale} w {}", p.scaled_w));
                cmds.push(format!("[enter] {scale} h {}", p.scaled_h));
            }
            if (p.x, p.y) != (before.x, before.y) {
                cmds.push(format!("[enter] {crop} x {}", p.x));
                cmds.push(format!("[enter] {crop} y {}", p.y));
            }
        }
        if used.flash && p.flash != before.flash {
            let v = p.flash as f64 / 1000.0;
            for c in ["romin", "gomin", "bomin"] {
                cmds.push(format!("[enter] {levels} {c} {v:.3}"));
            }
        }
        if used.glitch && p.split != before.split {
            cmds.push(format!("[enter] {shift} rh {}", p.split));
            cmds.push(format!("[enter] {shift} bh -{}", p.split));
        }
        last = Some(p);
        if cmds.is_empty() {
            continue;
        }
        let at = ((n as f64 - 0.5) / fps).max(0.0);
        let _ = writeln!(text, "{at:.6} {};", cmds.join(", "));
    }
    (text, first)
}

/// The filter text that goes after the clip's crop and colour: the picture is made exactly `w` x `h`, then
/// changed frame by frame by the command file at `cmd_path` (already escaped for a filter argument).
pub fn filter(
    pulses: &[Pulses],
    first: &Params,
    w: u32,
    h: u32,
    tag: &str,
    cmd_path: &str,
) -> String {
    let used = uses(pulses);
    let (scale, crop, levels, shift) = names(tag);
    let mut f = format!(",scale={w}:{h}:flags=bilinear,setpts=PTS-STARTPTS,sendcmd=f={cmd_path}");
    if used.geometry {
        let _ = write!(
            f,
            ",{scale}={}:{}:flags=bilinear,{crop}={w}:{h}:{}:{}",
            first.scaled_w, first.scaled_h, first.x, first.y
        );
    }
    if used.flash || used.glitch {
        f.push_str(",format=rgb24");
    }
    if used.flash {
        let v = first.flash as f64 / 1000.0;
        let _ = write!(f, ",{levels}=romin={v:.3}:gomin={v:.3}:bomin={v:.3}");
    }
    if used.glitch {
        let _ = write!(
            f,
            ",{shift}=rh={}:bh=-{}:edge=smear",
            first.split, first.split
        );
    }
    f
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grid(bpm: f64) -> BeatGrid {
        BeatGrid {
            version: 1,
            start: 0.0,
            end: 10.0,
            bpm,
            offset: 0.25,
            clarity: 0.9,
            clear: true,
            steady: true,
            beats: (0..20).map(|i| 0.25 + i as f64 * 0.5).collect(),
        }
    }
    fn fx() -> BeatFx {
        BeatFx::default()
    }
    fn effect(kind: BeatEffectKind, intensity: f64, nth: u32) -> BeatEffect {
        BeatEffect {
            kind,
            intensity,
            every_nth_beat: nth,
            offset_ms: 0.0,
            easing: None,
        }
    }
    fn close(a: &[f64], b: &[f64]) {
        assert_eq!(a.len(), b.len(), "{a:?} vs {b:?}");
        for (x, y) in a.iter().zip(b) {
            assert!((x - y).abs() < 1e-6, "{a:?} vs {b:?}");
        }
    }

    /// The same cases as `beat grid adjustments` in `src/timeline/beats.test.tsx`: both sides must agree.
    #[test]
    fn the_beats_are_adjusted_like_the_preview_does() {
        let g = grid(120.0);
        close(&adjusted_beats(&g, &fx()), &g.beats);
        let half = BeatFx {
            half_double: Some(HalfDouble::Half),
            ..fx()
        };
        close(
            &adjusted_beats(&g, &half),
            &g.beats.iter().step_by(2).copied().collect::<Vec<_>>(),
        );
        let double = BeatFx {
            half_double: Some(HalfDouble::Double),
            ..fx()
        };
        let d = adjusted_beats(&g, &double);
        assert_eq!(d.len(), 39);
        assert!((d[1] - 0.5).abs() < 1e-9);
        let slow = BeatFx {
            bpm_override: Some(60.0),
            ..fx()
        };
        close(
            &adjusted_beats(&g, &slow),
            &[0.25, 1.25, 2.25, 3.25, 4.25, 5.25, 6.25, 7.25, 8.25, 9.25],
        );
        let nudged = BeatFx {
            offset_ms: Some(-300.0),
            ..fx()
        };
        close(&adjusted_beats(&g, &nudged)[..2], &[0.45, 0.95]);
        // unsteady: the tracked beats, moved by the nudge
        let changing = BeatGrid {
            steady: false,
            beats: vec![0.5, 1.0, 1.5, 1.9, 2.3, 2.7],
            ..grid(120.0)
        };
        close(&adjusted_beats(&changing, &fx()), &changing.beats);
        let moved = BeatFx {
            offset_ms: Some(100.0),
            ..fx()
        };
        close(
            &adjusted_beats(&changing, &moved),
            &[0.6, 1.1, 1.6, 2.0, 2.4, 2.8],
        );
    }

    #[test]
    fn beats_follow_trim_and_speed() {
        let g = grid(120.0);
        let got = clip_beats(&g, &fx(), 1.0, 5.0, 2.0);
        let want: Vec<f64> = [1.25, 1.75, 2.25, 2.75, 3.25, 3.75, 4.25, 4.75]
            .iter()
            .map(|s| (s - 1.0) / 2.0)
            .collect();
        close(&got, &want);
    }

    #[test]
    fn strength_is_one_at_the_beat_and_gone_after_its_duration() {
        let beats = [1.0, 2.0];
        let zoom = pulses(&[effect(BeatEffectKind::Zoom, 1.0, 1)], &beats, true);
        let at = |t: f64| frame_at(&zoom, t).zoom;
        assert_eq!(at(0.5), 1.0, "before the first beat");
        assert!((at(1.0) - 1.15).abs() < 1e-9);
        assert!(at(1.1) < at(1.0) && at(1.1) > 1.0);
        assert_eq!(at(1.0 + duration(BeatEffectKind::Zoom)), 1.0);
        assert_eq!(at(1.6), 1.0, "between beats");
        assert!(
            (at(2.0) - 1.15).abs() < 1e-9,
            "the next beat fires it again"
        );
        // every 2nd beat, and a delay
        let slow = pulses(&[effect(BeatEffectKind::Zoom, 1.0, 2)], &beats, true);
        assert!(frame_at(&slow, 2.0).zoom == 1.0 && frame_at(&slow, 1.0).zoom > 1.1);
        let late = BeatEffect {
            offset_ms: 100.0,
            ..effect(BeatEffectKind::Zoom, 1.0, 1)
        };
        let late = pulses(&[late], &beats, true);
        assert_eq!(frame_at(&late, 1.0).zoom, 1.0);
        assert!((frame_at(&late, 1.1).zoom - 1.15).abs() < 1e-9);
    }

    #[test]
    fn the_three_easings_have_their_shapes() {
        let at = |easing, t| {
            let e = BeatEffect {
                easing: Some(easing),
                ..effect(BeatEffectKind::Zoom, 1.0, 1)
            };
            frame_at(&pulses(&[e], &[0.0], true), t).zoom - 1.0
        };
        let d = duration(BeatEffectKind::Zoom);
        assert!((at(BeatEasing::Out, d / 2.0) - 0.15 * 0.25).abs() < 1e-9);
        assert!((at(BeatEasing::Linear, d / 2.0) - 0.15 * 0.5).abs() < 1e-9);
        assert!((at(BeatEasing::InOut, d / 2.0) - 0.15).abs() < 1e-9);
        assert!(at(BeatEasing::InOut, 0.0).abs() < 1e-9);
    }

    #[test]
    fn intensity_zero_is_the_original_picture() {
        let off = pulses(
            &[
                effect(BeatEffectKind::Zoom, 0.0, 1),
                effect(BeatEffectKind::Flash, 0.0, 1),
            ],
            &[1.0],
            true,
        );
        assert!(off.is_empty());
        assert_eq!(
            frame_at(&off, 1.0),
            Frame {
                zoom: 1.0,
                ..Frame::default()
            }
        );
    }

    #[test]
    fn reduce_flashing_caps_a_flash_and_drops_triggers_that_come_too_fast() {
        let beats: Vec<f64> = (0..8).map(|i| i as f64 * 0.25).collect(); // four a second
        let flash = [effect(BeatEffectKind::Flash, 1.0, 1)];
        let safe = pulses(&flash, &beats, true);
        assert_eq!(safe[0].intensity, 0.5);
        assert!(
            safe[0]
                .triggers
                .windows(2)
                .all(|w| w[1] - w[0] >= 0.34 - 1e-9)
        );
        assert_eq!(safe[0].triggers, vec![0.0, 0.5, 1.0, 1.5]);
        let raw = pulses(&flash, &beats, false);
        assert_eq!((raw[0].intensity, raw[0].triggers.len()), (1.0, 8));
        // other effects are left alone
        let zoom = pulses(&[effect(BeatEffectKind::Zoom, 1.0, 1)], &beats, true);
        assert_eq!((zoom[0].intensity, zoom[0].triggers.len()), (1.0, 8));
        // the strongest flash that is allowed never gets past a quarter white
        assert!(frame_at(&safe, 0.0).flash <= 0.25 + 1e-9);
    }

    #[test]
    fn numbers_for_ffmpeg_are_whole_even_and_keep_the_picture_covered() {
        let pulses = pulses(
            &[
                effect(BeatEffectKind::Zoom, 1.0, 1),
                effect(BeatEffectKind::Shake, 1.0, 1),
                effect(BeatEffectKind::Glitch, 1.0, 1),
            ],
            &[0.0],
            true,
        );
        for n in 0..12 {
            let f = frame_at(&pulses, n as f64 / 30.0);
            let p = params(&f, 540, 960);
            assert!(
                p.scaled_w >= 540
                    && p.scaled_h >= 960
                    && p.scaled_w.is_multiple_of(2)
                    && p.scaled_h.is_multiple_of(2)
            );
            assert!(
                p.x + 540 <= p.scaled_w && p.y + 960 <= p.scaled_h,
                "window inside the scaled picture"
            );
        }
        let at_beat = params(&frame_at(&pulses, 0.0), 540, 960);
        assert!(at_beat.split > 0 && at_beat.scaled_w > 540);
        assert_eq!(params(&frame_at(&pulses, 1.0), 540, 960).scaled_w, 540);
    }

    #[test]
    fn the_command_file_has_a_line_only_where_the_numbers_change() {
        let p = pulses(
            &[
                effect(BeatEffectKind::Zoom, 1.0, 1),
                effect(BeatEffectKind::Flash, 0.8, 1),
            ],
            &[0.5, 1.5],
            false,
        );
        let (text, first) = command_file(&p, 3.0, 30.0, 320, 240, "0");
        assert_eq!(first.scaled_w, 320);
        let lines: Vec<&str> = text.lines().collect();
        assert!(lines.len() > 6 && lines.len() < 60, "{} lines", lines.len());
        assert!(
            lines[0].starts_with("0.483333 "),
            "fires half a frame before frame 15: {}",
            lines[0]
        );
        assert!(
            lines[0].contains("[enter] scale@bs0 w ")
                && lines[0].contains("[enter] colorlevels@bf0 romin ")
        );
        assert!(
            !text.contains("rgbashift"),
            "no glitch effect, no glitch commands"
        );
        assert!(lines.iter().all(|l| l.ends_with(';')));
        // the last frames, long after the second beat, are back to the original
        assert!(text.contains("scale@bs0 w 320"));
    }

    #[test]
    fn the_filter_text_names_what_the_command_file_changes() {
        let p = pulses(
            &[
                effect(BeatEffectKind::Shake, 1.0, 1),
                effect(BeatEffectKind::Glitch, 1.0, 1),
            ],
            &[0.5],
            true,
        );
        let (_, first) = command_file(&p, 2.0, 30.0, 320, 240, "3");
        let f = filter(&p, &first, 320, 240, "3", "'/tmp/x.txt'");
        assert!(f.starts_with(
            ",scale=320:240:flags=bilinear,setpts=PTS-STARTPTS,sendcmd=f='/tmp/x.txt'"
        ));
        assert!(
            f.contains("scale@bs3=320:240")
                && f.contains("crop@bc3=320:240:")
                && f.contains("rgbashift@bg3=rh=0:bh=-0")
        );
        assert!(!f.contains("colorlevels"));
    }
    /// The shared case of `src/timeline/beatFxMath.test.tsx`: both sides must print these numbers.
    fn agreement_params() -> Vec<(f64, Params)> {
        let g = grid(120.0);
        let list = vec![
            effect(BeatEffectKind::Zoom, 1.0, 1),
            BeatEffect {
                offset_ms: 40.0,
                easing: Some(BeatEasing::Linear),
                ..effect(BeatEffectKind::Shake, 0.8, 2)
            },
            BeatEffect {
                easing: Some(BeatEasing::InOut),
                ..effect(BeatEffectKind::Flash, 1.0, 1)
            },
            effect(BeatEffectKind::Glitch, 0.9, 1),
        ];
        let beats = clip_beats(&g, &fx(), 0.0, 10.0, 1.0);
        let p = pulses(&list, &beats, true);
        [0.1, 0.25, 0.3, 0.45, 0.52, 0.75, 0.8, 1.27, 1.6]
            .iter()
            .map(|t| (*t, params(&frame_at(&p, *t), 540, 960)))
            .collect()
    }

    #[test]
    #[ignore = "prints the numbers for the preview's agreement test"]
    fn print_agreement_params() {
        for (t, p) in agreement_params() {
            println!(
                "[{t}, {}, {}, {}, {}, {}, {}],",
                p.scaled_w, p.scaled_h, p.x, p.y, p.flash, p.split
            );
        }
    }

    #[test]
    fn the_preview_gets_the_same_numbers() {
        let want: [[f64; 7]; 9] = [
            [0.1, 540., 960., 0., 0., 0., 0.],
            [0.25, 622., 1104., 41., 72., 0., 10.],
            [0.3, 616., 1096., 34., 59., 217., 5.],
            [0.45, 562., 998., 10., 23., 0., 0.],
            [0.52, 546., 970., 3., 4., 0., 0.],
            [0.75, 622., 1104., 41., 72., 0., 10.],
            [0.8, 600., 1066., 30., 53., 217., 5.],
            [1.27, 612., 1088., 36., 64., 102., 8.],
            [1.6, 540., 960., 0., 0., 0., 0.],
        ];
        for ((t, p), w) in agreement_params().iter().zip(want) {
            let got = [
                *t,
                p.scaled_w as f64,
                p.scaled_h as f64,
                p.x as f64,
                p.y as f64,
                p.flash as f64,
                p.split as f64,
            ];
            assert_eq!(got, w, "at {t} s");
        }
    }
}
