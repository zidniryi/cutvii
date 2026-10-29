use serde::{Deserialize, Serialize};

use crate::media::MediaType;
use crate::media::color::ColorAdjust;
use crate::media::text::TextSpec;

pub const SCHEMA_VERSION: u32 = 10;

/// An imported colour table (`.cube`) on a clip. The table itself is not in the project: CutVii keeps its
/// own checked copy in the app data folder (`media/cube.rs`), found by `id`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClipLut {
    /// Hash of the table's contents.
    pub id: String,
    /// The table's name when it was chosen, so a project can still say which one is missing.
    pub name: String,
    /// How much of the table's result is taken, 0 to 1.
    pub intensity: f64,
}

/// How a clip comes in (`export/transitions.rs`): one of the kinds in `presets/transitions.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClipTransition {
    pub kind: String,
    /// Seconds on the timeline; shortened to the clip's length when it is applied.
    pub duration: f64,
}

/// Clean-up of a clip's sound (`media/clean.rs`). The export applies it; the preview plays the original.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AudioClean {
    /// How strongly steady background noise is lowered, 0 (off) to 1.
    pub noise: f64,
    /// Remove low rumble and hum (below 80 Hz).
    pub rumble: bool,
}

impl AudioClean {
    pub fn is_valid(&self) -> bool {
        (0.0..=1.0).contains(&self.noise)
    }

    /// Nothing is switched on.
    pub fn is_off(&self) -> bool {
        self.noise <= 0.0 && !self.rumble
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AudioStylePreset {
    Sped,
    Slowed,
    Bass,
    Custom,
}

/// Limits of an audio style (`export/audiostyle.rs`). Pitch is a share of the original pitch in percent.
pub const AUDIO_PITCH_RANGE: (f64, f64) = (50.0, 200.0);
pub const AUDIO_BASS_MAX_DB: f64 = 12.0;

/// A style for a clip's sound (sped up, slowed + reverb, bass boost, custom). The tempo is NOT stored here: it
/// is the clip's own `speed` (with `keepPitch`), so the clip's length, the beats and the preview rate follow
/// the one speed formula. `baseSpeed` / `baseKeepPitch` remember what to go back to when the style is removed.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AudioStyle {
    pub preset: AudioStylePreset,
    /// Pitch as a percent of the original (100 = unchanged), moved independently of the tempo.
    pub pitch: f64,
    /// Reverb amount, 0 (none) to 1.
    pub reverb: f64,
    /// Bass boost in dB, 0 to 12.
    pub bass: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_speed: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_keep_pitch: Option<bool>,
}

impl AudioStyle {
    pub fn problem(&self) -> Option<&'static str> {
        if !(AUDIO_PITCH_RANGE.0..=AUDIO_PITCH_RANGE.1).contains(&self.pitch) {
            return Some("pitch: must be between 50 and 200 percent");
        }
        if !(0.0..=1.0).contains(&self.reverb) {
            return Some("reverb: must be between 0 and 1");
        }
        if !(0.0..=AUDIO_BASS_MAX_DB).contains(&self.bass) {
            return Some("bass: must be between 0 and 12 dB");
        }
        if self.base_speed.is_some_and(|s| !(0.1..=10.0).contains(&s)) {
            return Some("baseSpeed: must be between 0.1 and 10");
        }
        None
    }

    /// Pitch, reverb and bass all at their neutral value (the tempo is the clip's speed).
    pub fn is_neutral(&self) -> bool {
        (self.pitch - 100.0).abs() < 1e-9 && self.reverb <= 0.0 && self.bass <= 0.0
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectSettings {
    pub width: u32,
    pub height: u32,
    /// Always equals `fps_num / fps_den` when those are present.
    pub fps: f64,
    pub background_color: String,
    /// Exact frame rate as a fraction (e.g. 30000/1001). Optional; both or neither.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fps_num: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fps_den: Option<u32>,
    /// "Original" canvas chosen but no media added yet: the first media decides the canvas.
    #[serde(default, skip_serializing_if = "is_false")]
    pub canvas_pending: bool,
}

fn is_false(b: &bool) -> bool {
    !*b
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaAsset {
    pub id: String,
    pub path: String,
    #[serde(rename = "type")]
    pub media_type: MediaType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumbnail_path: Option<String>,
    /// Exact frame rate of a video file; both or neither.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fps_num: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fps_den: Option<u32>,
    /// Present on a text picture: an image asset drawn by CutVii from these properties. `path` is the
    /// drawn picture (made again when it is missing), with transparency kept over the tracks below.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<TextSpec>,
    /// A picture with see-through pixels (a sticker, a logo): kept transparent over the tracks below, like
    /// a text picture. Images only; absent means opaque.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alpha: Option<bool>,
}

/// How a video or image clip is scaled to the canvas. Absent means `Fill`.
/// The picture is never shown at its native pixel size.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum FitMode {
    /// Canvas fully covered, the overflow is cropped.
    #[default]
    #[serde(rename = "fill")]
    Fill,
    /// Whole picture visible, bars filled with the background colour.
    #[serde(rename = "fit")]
    Fit,
    /// Whole picture visible over a blurred, enlarged copy of itself.
    #[serde(rename = "blur-bg")]
    BlurBg,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimelineClip {
    pub id: String,
    pub asset_id: String,
    pub track_id: String,
    pub timeline_start: f64,
    pub source_in: f64,
    pub source_out: f64,
    pub volume: f64,
    pub x: f64,
    pub y: f64,
    pub scale: f64,
    pub opacity: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fit_mode: Option<FitMode>,
    /// Playback speed (0.1 to 10). Absent means 1. Timeline length = (sourceOut - sourceIn) / speed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed: Option<f64>,
    /// Keep the original pitch when the speed changes. Absent means true.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keep_pitch: Option<bool>,
    /// What shows behind the picture where it does not cover the canvas. Absent means black.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fit_background: Option<FitBackground>,
    /// Play the used source range backwards. Absent means false.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reversed: Option<bool>,
    /// Part of the picture cut away on each side before it is scaled to the canvas. Absent means none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crop: Option<Crop>,
    /// Clockwise rotation in degrees, -180..=180. Absent means 0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rotation: Option<f64>,
    /// Mirror the picture left-right / top-bottom. Absent means false.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flip_h: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flip_v: Option<bool>,
    /// This clip makes no sound (its picture still shows). Absent means false.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub muted: Option<bool>,
    /// Seconds over which the sound rises from silence at the start / falls to silence at the end, measured
    /// on the timeline. Absent means 0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fade_in: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fade_out: Option<f64>,
    /// The Adjust sliders of the Color tab. Absent means the picture is left as it is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<ColorAdjust>,
    /// An imported LUT, applied after `color`. Absent means none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lut: Option<ClipLut>,
    /// Noise and rumble clean-up of the clip's sound. Absent means none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clean: Option<AudioClean>,
    /// Ducking: how far this clip is turned down while other clips make sound, 0 to 1. Absent means off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duck: Option<f64>,
    /// Keyframes of position, scale, rotation and opacity. Absent means nothing is animated.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keyframes: Option<Keyframes>,
    /// The transition this clip comes in with. Absent means a plain cut.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition_in: Option<ClipTransition>,
    /// The transition this clip leaves with. Absent means a plain cut.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition_out: Option<ClipTransition>,
    /// Beat Sync: which cached beat grid the clip follows, how it is adjusted, and the beat effects.
    /// Absent means none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub beat_fx: Option<BeatFx>,
    /// A sound style (pitch, reverb, bass; the tempo is `speed`). Absent means none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio_style: Option<AudioStyle>,
}

/// Most beat effects one clip may have.
pub const MAX_BEAT_EFFECTS: usize = 8;
/// Limits of the beat grid adjustments.
pub const BEAT_BPM_RANGE: (f64, f64) = (30.0, 300.0);
pub const MAX_BEAT_OFFSET_MS: f64 = 2000.0;
pub const MAX_EFFECT_OFFSET_MS: f64 = 1000.0;

/// Beat Sync on a clip. The grid itself is not in the project: it is cached by Rust (`media/beats.rs`) and
/// found by `grid_id`. Times of the grid are source times, so trim and speed keep beats on the same sound.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BeatFx {
    /// Effects drawn on the beats (built in a later step); may be empty.
    #[serde(default)]
    pub effects: Vec<BeatEffect>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grid_id: Option<String>,
    /// Beats per minute chosen by the user (typed or tapped) instead of the detected tempo.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bpm_override: Option<f64>,
    /// Use every other beat ("half") or add one between each two ("double").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub half_double: Option<HalfDouble>,
    /// The whole grid moved later (positive) or earlier, in milliseconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset_ms: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HalfDouble {
    Half,
    Double,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BeatEffectKind {
    Zoom,
    Shake,
    Flash,
    Glitch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BeatEasing {
    Out,
    InOut,
    Linear,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BeatEffect {
    pub kind: BeatEffectKind,
    /// 0 (no effect) to 1.
    pub intensity: f64,
    /// 1, 2, 4 or 8.
    pub every_nth_beat: u32,
    pub offset_ms: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub easing: Option<BeatEasing>,
}

impl BeatFx {
    /// The first problem with the values, if any.
    pub fn problem(&self) -> Option<String> {
        if self.effects.len() > MAX_BEAT_EFFECTS {
            return Some(format!("at most {MAX_BEAT_EFFECTS} beat effects"));
        }
        if let Some(id) = &self.grid_id
            && (id.len() != 16 || !id.bytes().all(|b| b.is_ascii_hexdigit()))
        {
            return Some("gridId: invalid".into());
        }
        if let Some(bpm) = self.bpm_override
            && !(BEAT_BPM_RANGE.0..=BEAT_BPM_RANGE.1).contains(&bpm)
        {
            return Some("bpmOverride: must be between 30 and 300".into());
        }
        if self
            .offset_ms
            .is_some_and(|o| !(-MAX_BEAT_OFFSET_MS..=MAX_BEAT_OFFSET_MS).contains(&o))
        {
            return Some("offsetMs: must be between -2000 and 2000".into());
        }
        for e in &self.effects {
            if !(0.0..=1.0).contains(&e.intensity) {
                return Some("effects.intensity: must be between 0 and 1".into());
            }
            if ![1, 2, 4, 8].contains(&e.every_nth_beat) {
                return Some("effects.everyNthBeat: must be 1, 2, 4 or 8".into());
            }
            if !(-MAX_EFFECT_OFFSET_MS..=MAX_EFFECT_OFFSET_MS).contains(&e.offset_ms) {
                return Some("effects.offsetMs: must be between -1000 and 1000".into());
            }
        }
        None
    }
}

/// The longest fade that can be stored. A fade longer than its clip is shortened when it is applied.
pub const MAX_FADE: f64 = 60.0;

/// Limits of the clip transform. `x` and `y` are shares of the canvas (0.1 = a tenth of its width to the
/// right / of its height down); `scale` 1 is the fitted size.
pub const MAX_OFFSET: f64 = 2.0;
pub const MIN_SCALE: f64 = 0.05;
pub const MAX_SCALE: f64 = 4.0;
pub const MAX_ROTATION: f64 = 180.0;

/// Where and how a clip's layer is placed on the canvas. The layer is the whole canvas-sized picture the
/// clip produces (fit mode, background and crop already applied).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Transform {
    pub x: f64,
    pub y: f64,
    pub scale: f64,
    /// Degrees, clockwise.
    pub rotation: f64,
    pub flip_h: bool,
    pub flip_v: bool,
    pub opacity: f64,
}

/// Most keyframes one property of a clip may have.
pub const MAX_KEYS: usize = 64;

/// One keyframe: at source time `t` (seconds in the media, like `sourceIn`) the property is `v`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Key {
    pub t: f64,
    pub v: f64,
}

/// Keyframes of a clip's transform. A property that has keys follows them instead of its fixed value:
/// straight lines between keys, the first value before the first key, the last value after the last.
/// Times are source times, so trimming, splitting and speed keep every key on the same picture.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Keyframes {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<Vec<Key>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<Vec<Key>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale: Option<Vec<Key>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rotation: Option<Vec<Key>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opacity: Option<Vec<Key>>,
}

/// A property's name, its keys, and the range its values must stay in.
pub type KeyTrack<'a> = (&'static str, &'a Option<Vec<Key>>, f64, f64);

impl Keyframes {
    pub fn tracks(&self) -> [KeyTrack<'_>; 5] {
        [
            ("x", &self.x, -MAX_OFFSET, MAX_OFFSET),
            ("y", &self.y, -MAX_OFFSET, MAX_OFFSET),
            ("scale", &self.scale, MIN_SCALE, MAX_SCALE),
            ("rotation", &self.rotation, -MAX_ROTATION, MAX_ROTATION),
            ("opacity", &self.opacity, 0.0, 1.0),
        ]
    }
}

/// A clip's keyframes ready for the export: `(seconds from the clip's start on the timeline, value)` in
/// time order. An empty list means the property is not animated.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Motion {
    pub x: Vec<(f64, f64)>,
    pub y: Vec<(f64, f64)>,
    pub scale: Vec<(f64, f64)>,
    pub rotation: Vec<(f64, f64)>,
    pub opacity: Vec<(f64, f64)>,
}

impl Transform {
    pub fn is_identity(&self) -> bool {
        self.x == 0.0
            && self.y == 0.0
            && self.scale == 1.0
            && self.rotation == 0.0
            && !self.flip_h
            && !self.flip_v
            && self.opacity == 1.0
    }
}

/// Shares of the source picture (0..=0.9) removed from each side. At least a tenth must remain each way.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Crop {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
}

/// The most that can be cropped away along one axis (both sides together).
pub const MAX_CROP: f64 = 0.9;

impl Crop {
    pub fn is_none(&self) -> bool {
        self.left == 0.0 && self.top == 0.0 && self.right == 0.0 && self.bottom == 0.0
    }
    pub fn is_valid(&self) -> bool {
        [self.left, self.top, self.right, self.bottom]
            .iter()
            .all(|v| (0.0..=MAX_CROP).contains(v))
            && self.left + self.right <= MAX_CROP + 1e-9
            && self.top + self.bottom <= MAX_CROP + 1e-9
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum BackgroundKind {
    #[default]
    Black,
    Color,
    Image,
}

/// Background behind a fitted (or transparent) picture, plus the blur strength used by `blur-bg`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FitBackground {
    pub kind: BackgroundKind,
    /// `#RRGGBB`, required for `color`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// An image asset of the project, required for `image`. It is scaled to cover the canvas.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<String>,
    /// Blur amount 0..=100 for `blur-bg` (30 = a blur radius of 3 % of the canvas height). Absent means 30.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blur: Option<f64>,
}

pub const DEFAULT_BLUR_AMOUNT: f64 = 30.0;
pub const MAX_BLUR_AMOUNT: f64 = 100.0;

pub const MIN_SPEED: f64 = 0.1;
pub const MAX_SPEED: f64 = 10.0;

impl TimelineClip {
    pub fn transform(&self) -> Transform {
        Transform {
            x: self.x,
            y: self.y,
            scale: self.scale,
            rotation: self.rotation.unwrap_or(0.0),
            flip_h: self.flip_h.unwrap_or(false),
            flip_v: self.flip_v.unwrap_or(false),
            opacity: self.opacity,
        }
    }
    pub fn speed(&self) -> f64 {
        self.speed.unwrap_or(1.0)
    }
    /// The keyframes in clip time (source time through trim, speed and reverse). `None` when there are none.
    pub fn motion(&self) -> Option<Motion> {
        let keys = self.keyframes.as_ref()?;
        let (speed, reversed) = (self.speed(), self.reversed.unwrap_or(false));
        let local = |list: &Option<Vec<Key>>| -> Vec<(f64, f64)> {
            let mut out: Vec<(f64, f64)> = list
                .iter()
                .flatten()
                .map(|k| {
                    let used = if reversed {
                        self.source_out - k.t
                    } else {
                        k.t - self.source_in
                    };
                    (used / speed, k.v)
                })
                .collect();
            out.sort_by(|a, b| a.0.total_cmp(&b.0));
            out
        };
        let motion = Motion {
            x: local(&keys.x),
            y: local(&keys.y),
            scale: local(&keys.scale),
            rotation: local(&keys.rotation),
            opacity: local(&keys.opacity),
        };
        (motion != Motion::default()).then_some(motion)
    }
    /// The fades as they are applied: the fade-in is at most the clip's length, the fade-out takes what
    /// is left. The preview uses the same rule.
    pub fn fades(&self) -> (f64, f64) {
        self.fades_with(0.0, 0.0)
    }
    /// The fades of the clip's SOUND when it comes in or leaves with a transition of these lengths: the
    /// sound fades for at least as long as the picture takes.
    pub fn fades_with(&self, coming: f64, leaving: f64) -> (f64, f64) {
        let length = self.timeline_duration();
        let fade_in = self.fade_in.unwrap_or(0.0).max(coming).clamp(0.0, length);
        let fade_out = self
            .fade_out
            .unwrap_or(0.0)
            .max(leaving)
            .clamp(0.0, length - fade_in);
        (fade_in, fade_out)
    }
    pub fn keep_pitch(&self) -> bool {
        self.keep_pitch.unwrap_or(true)
    }
    /// Length on the timeline, in seconds.
    pub fn timeline_duration(&self) -> f64 {
        (self.source_out - self.source_in) / self.speed()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrackType {
    Video,
    Audio,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimelineTrack {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub track_type: TrackType,
    pub order: u32,
    pub muted: bool,
    pub hidden: bool,
    pub clips: Vec<TimelineClip>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub schema_version: u32,
    pub created_at: String,
    pub modified_at: String,
    pub settings: ProjectSettings,
    pub assets: Vec<MediaAsset>,
    pub tracks: Vec<TimelineTrack>,
}
