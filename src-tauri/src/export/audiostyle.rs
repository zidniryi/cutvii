//! Audio styles for the export: pitch, bass and reverb with FFmpeg filters only (no model, no download).
//!
//! The tempo of a style is the clip's own `speed` (see `AudioStyle`), already handled by the speed filters in
//! `plan.rs`, so the clip's length, the beat grid and the overlap rule follow the one speed formula. What is
//! built here goes right after the speed and before volume and fades:
//!
//! 1. pitch: `asetrate` moves tempo and pitch together, `aresample` brings the rate back, and `atempo` undoes
//!    the tempo change, so only the pitch has moved;
//! 2. bass: the `bass` shelf (110 Hz) by the given dB;
//! 3. reverb: `aecho` with four reflections (40 to 160 ms) whose strength follows the amount;
//! 4. `alimiter` (auto level off) so boosted bass or echo cannot clip.
//!
//! A reverb tail is cut at the clip's end; the clip keeps its length.

use super::plan::atempo_chain;
use crate::project::AudioStyle;

/// Sample rate the export's sound is mixed at (the same as `plan.rs`).
const RATE: u32 = 48_000;
/// The loudest sample a styled clip may reach.
pub const LIMIT: f64 = 0.95;
/// Filters the chain needs; checked against `ffmpeg -filters` before an export starts.
pub const REQUIRED_FILTERS: [&str; 6] = [
    "asetrate",
    "aresample",
    "atempo",
    "bass",
    "aecho",
    "alimiter",
];

/// The filter text for a style, each filter followed by a comma, or "" when the style changes nothing.
pub fn filters(style: &AudioStyle) -> String {
    if style.is_neutral() {
        return String::new();
    }
    let mut out = String::new();
    let ratio = style.pitch / 100.0;
    if (ratio - 1.0).abs() > 1e-9 {
        out.push_str(&format!(
            "asetrate={:.0},aresample={RATE},",
            RATE as f64 * ratio
        ));
        for f in atempo_chain(1.0 / ratio) {
            out.push_str(&format!("atempo={f:.6},"));
        }
    }
    if style.bass > 0.0 {
        out.push_str(&format!("bass=g={:.2}:f=110:w=0.6,", style.bass));
    }
    if style.reverb > 0.0 {
        let a = style.reverb;
        out.push_str(&format!(
            "aecho=0.8:0.9:40|70|110|160:{:.3}|{:.3}|{:.3}|{:.3},",
            0.5 * a,
            0.4 * a,
            0.3 * a,
            0.2 * a
        ));
    }
    out.push_str(&format!("alimiter=limit={LIMIT}:level=disabled,"));
    out
}

/// Which of the required filters an FFmpeg `-filters` listing lacks.
pub fn missing_filters(listing: &str) -> Vec<&'static str> {
    REQUIRED_FILTERS
        .into_iter()
        .filter(|name| {
            !listing
                .lines()
                .any(|l| l.split_whitespace().nth(1) == Some(name))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::AudioStylePreset;

    fn style(pitch: f64, reverb: f64, bass: f64) -> AudioStyle {
        AudioStyle {
            preset: AudioStylePreset::Custom,
            pitch,
            reverb,
            bass,
            base_speed: None,
            base_keep_pitch: None,
        }
    }

    #[test]
    fn a_neutral_style_adds_no_filters() {
        assert_eq!(filters(&style(100.0, 0.0, 0.0)), "");
    }

    #[test]
    fn sped_up_raises_the_pitch_and_slowed_reverb_lowers_it_and_adds_echo() {
        let up = filters(&style(125.0, 0.0, 0.0));
        assert!(
            up.starts_with("asetrate=60000,aresample=48000,atempo=0.800000,"),
            "{up}"
        );
        assert!(up.ends_with("alimiter=limit=0.95:level=disabled,"), "{up}");
        assert!(!up.contains("aecho") && !up.contains("bass="));
        let down = filters(&style(85.0, 0.5, 0.0));
        assert!(
            down.starts_with("asetrate=40800,aresample=48000,atempo=1.176471,"),
            "{down}"
        );
        assert!(
            down.contains("aecho=0.8:0.9:40|70|110|160:0.250|0.200|0.150|0.100,"),
            "{down}"
        );
    }

    #[test]
    fn bass_boost_keeps_the_pitch_and_is_limited() {
        let f = filters(&style(100.0, 0.0, 8.0));
        assert_eq!(
            f,
            "bass=g=8.00:f=110:w=0.6,alimiter=limit=0.95:level=disabled,"
        );
        assert!(!f.contains("asetrate"));
    }

    #[test]
    fn a_big_pitch_shift_is_chained_within_the_good_range_of_atempo() {
        let f = filters(&style(50.0, 0.0, 0.0));
        assert!(
            f.contains("asetrate=24000,aresample=48000,atempo=2.000000,"),
            "{f}"
        );
    }

    #[test]
    fn missing_filters_are_named() {
        let listing = " ... asetrate         A->A       Change the sample rate.\n ... aresample        A->A       Resample.\n ... atempo           A->A       Adjust tempo.\n ... bass             A->A       Boost or cut lower frequencies.\n";
        assert_eq!(missing_filters(listing), vec!["aecho", "alimiter"]);
        assert!(missing_filters("").len() == REQUIRED_FILTERS.len());
    }
}
