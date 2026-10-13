//! Transitions: how a clip comes in over what was there before it.
//!
//! A transition belongs to the incoming clip. For its length the clip starts out moved, scaled, turned or
//! see-through (`from`) and eases to where it belongs. A clip that ends on the same track exactly where the
//! incoming one starts holds its last frame underneath for that time, so there is something to come in over.
//!
//! The kinds are in `presets/transitions.json`, read by the preview too (`src/timeline/transitions.ts`),
//! and the easing below is the same table there: both sides draw the same straight-line pieces.

use std::sync::OnceLock;

use serde::Deserialize;

/// Where the incoming clip starts, relative to where it belongs: `x` / `y` are added (shares of the canvas),
/// `rotation` is added (degrees), `scale` and `opacity` multiply.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct From {
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    #[serde(default = "one")]
    pub scale: f64,
    #[serde(default)]
    pub rotation: f64,
    #[serde(default = "one")]
    pub opacity: f64,
}

fn one() -> f64 {
    1.0
}

impl Default for From {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            scale: 1.0,
            rotation: 0.0,
            opacity: 1.0,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Kind {
    pub id: String,
    /// Shown by the app (the preview reads the same file); read here so the whole file is checked.
    #[allow(dead_code)]
    pub name: String,
    /// The name when the clip leaves this way (it then ends where `from` is).
    #[allow(dead_code)]
    #[serde(rename = "outName")]
    pub out_name: String,
    /// Coming in: does the clip before it hold its last frame underneath? `false` comes in over nothing
    /// (black, or the tracks below), as "Fade from black" does.
    #[serde(default = "yes")]
    pub hold: bool,
    pub from: From,
}

fn yes() -> bool {
    true
}

pub const MIN_TRANSITION: f64 = 0.1;
pub const MAX_TRANSITION: f64 = 3.0;

/// How much of `from` is left at each share of the transition's length: an ease in and out (smoothstep at
/// quarter points), drawn as straight lines.
pub const EASE: [(f64, f64); 5] = [
    (0.0, 1.0),
    (0.25, 0.84375),
    (0.5, 0.5),
    (0.75, 0.15625),
    (1.0, 0.0),
];

pub fn kinds() -> &'static [Kind] {
    static KINDS: OnceLock<Vec<Kind>> = OnceLock::new();
    KINDS.get_or_init(|| {
        serde_json::from_str(include_str!("../../../presets/transitions.json"))
            .expect("presets/transitions.json is valid")
    })
}

pub fn find(id: &str) -> Option<&'static Kind> {
    kinds().iter().find(|k| k.id == id)
}

/// Keys `(clip time, share of "from" reached)` for a clip of `length` seconds that leaves over its last
/// `seconds`: the same ease, run the other way.
pub fn leaving(length: f64, seconds: f64) -> Vec<(f64, f64)> {
    EASE.iter()
        .map(|(u, left)| (length - seconds + u * seconds, 1.0 - left))
        .collect()
}

/// Keys `(clip time, share of "from" left)` for a transition of `seconds`.
pub fn remaining(seconds: f64) -> Vec<(f64, f64)> {
    EASE.iter().map(|(u, left)| (u * seconds, *left)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_kinds_are_readable_and_stay_inside_what_a_clip_may_be() {
        assert_eq!(kinds().len(), 16);
        let mut ids: Vec<&str> = kinds().iter().map(|k| k.id.as_str()).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), 16, "ids are unique");
        assert!(kinds().iter().all(|k| !k.out_name.trim().is_empty()));
        assert!(find("dissolve").unwrap().hold && !find("fade-black").unwrap().hold);
        assert_eq!(leaving(5.0, 2.0)[0], (3.0, 0.0));
        assert_eq!(leaving(5.0, 2.0)[4], (5.0, 1.0));
        for k in kinds() {
            assert!(
                !k.name.trim().is_empty() && k.from != From::default(),
                "{}",
                k.id
            );
            assert!(k.from.x.abs() <= 1.0 && k.from.y.abs() <= 1.0, "{}", k.id);
            assert!((0.05..=2.0).contains(&k.from.scale), "{}", k.id);
            assert!(k.from.rotation.abs() <= 180.0 && (0.0..=1.0).contains(&k.from.opacity));
        }
        assert_eq!(find("dissolve").unwrap().from.opacity, 0.0);
        assert!(find("nothing").is_none());
        assert_eq!(remaining(2.0)[2], (1.0, 0.5));
    }
}
