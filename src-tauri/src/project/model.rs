use serde::{Deserialize, Serialize};

use crate::media::MediaType;
use crate::media::color::ColorAdjust;
use crate::media::text::TextSpec;

pub const SCHEMA_VERSION: u32 = 6;

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
    /// The fades as they are applied: the fade-in is at most the clip's length, the fade-out takes what
    /// is left. The preview uses the same rule.
    pub fn fades(&self) -> (f64, f64) {
        let length = self.timeline_duration();
        let fade_in = self.fade_in.unwrap_or(0.0).clamp(0.0, length);
        let fade_out = self.fade_out.unwrap_or(0.0).clamp(0.0, length - fade_in);
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
