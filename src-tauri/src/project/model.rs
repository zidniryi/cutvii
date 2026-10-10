use serde::{Deserialize, Serialize};

use crate::media::MediaType;

pub const SCHEMA_VERSION: u32 = 3;

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
    /// Play the used source range backwards. Absent means false.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reversed: Option<bool>,
}

pub const MIN_SPEED: f64 = 0.1;
pub const MAX_SPEED: f64 = 10.0;

impl TimelineClip {
    pub fn speed(&self) -> f64 {
        self.speed.unwrap_or(1.0)
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
