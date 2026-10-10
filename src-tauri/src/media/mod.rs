//! Media engine boundary. The UI and commands only talk to [`MediaBackend`];
//! desktop uses an FFmpeg/FFprobe sidecar, Android will pick its own implementation (Phase 8).

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use serde::{Deserialize, Serialize};

pub mod ffmpeg;
pub mod import;
pub mod probe;
pub mod tools;

use crate::errors::AppResult;
use crate::export::ExportReport;
use crate::export::plan::ExportPlan;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaType {
    Video,
    Audio,
    Image,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub media_type: MediaType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    /// Exact frame rate of a video as a reduced fraction (e.g. 30000/1001); never a rounded float.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fps_num: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fps_den: Option<u32>,
}

/// Everything a backend needs to render: the resolved plan and where to write.
#[derive(Debug, Clone)]
pub struct RenderRequest {
    pub plan: ExportPlan,
    pub output: PathBuf,
}

pub trait MediaBackend: Send + Sync {
    /// Read metadata (type, duration, dimensions) without modifying the file.
    fn probe(&self, path: &Path) -> AppResult<MediaInfo>;
    /// Write a thumbnail for `path` at `at_seconds` into `out`.
    fn thumbnail(&self, path: &Path, at_seconds: f64, out: &Path) -> AppResult<()>;
    /// Whether the file contains at least one audio stream.
    fn has_audio(&self, path: &Path) -> AppResult<bool>;
    /// Render `request`. `progress` receives 0.0..=1.0; set `cancel` to stop early (the output is untouched).
    fn render(
        &self,
        request: &RenderRequest,
        progress: &mut dyn FnMut(f64),
        cancel: &AtomicBool,
    ) -> AppResult<ExportReport>;
}
