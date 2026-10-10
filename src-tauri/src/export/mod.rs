//! Exporting a project to MP4: plan (pure) -> filter graph (pure) -> FFmpeg render -> ffprobe verification.
//!
//! Rules shared with the preview (`docs/export-rules.md`):
//! - Tracks are composited in ascending `order`; the clip on the highest visible video track covers the ones below.
//! - Each clip is letter/pillar-boxed onto the project background; gaps show the background and are silent.
//! - Hidden tracks contribute no picture; muted tracks contribute no sound.
//! - Clips are placed at `timelineStart`, play `sourceOut - sourceIn` seconds at speed 1.

pub mod encoder;
pub mod plan;
pub mod render;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Quality {
    Draft,
    Standard,
    High,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportOptions {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub quality: Quality,
    /// What kind of file to write. Defaults to MP4 video.
    #[serde(default)]
    pub format: ExportFormat,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    /// H.264 + AAC video.
    #[default]
    Mp4,
    /// Audio only, AAC in an MPEG-4 container.
    M4a,
    /// Audio only, MP3 (needs an FFmpeg built with libmp3lame).
    Mp3,
    /// Audio only, uncompressed 16-bit PCM.
    Wav,
}

impl ExportFormat {
    pub fn is_audio(self) -> bool {
        self != ExportFormat::Mp4
    }
    pub fn extension(self) -> &'static str {
        match self {
            ExportFormat::Mp4 => "mp4",
            ExportFormat::M4a => "m4a",
            ExportFormat::Mp3 => "mp3",
            ExportFormat::Wav => "wav",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            ExportFormat::Mp4 => "MP4 video",
            ExportFormat::M4a => "M4A audio",
            ExportFormat::Mp3 => "MP3 audio",
            ExportFormat::Wav => "WAV audio",
        }
    }
}

impl ExportOptions {
    pub fn validate(&self) -> Result<(), String> {
        if !(16..=7680).contains(&self.width) || !(16..=4320).contains(&self.height) {
            return Err("resolution must be between 16x16 and 7680x4320".into());
        }
        if !self.width.is_multiple_of(2) || !self.height.is_multiple_of(2) {
            return Err("width and height must be even numbers (H.264 4:2:0)".into());
        }
        if !(1.0..=120.0).contains(&self.fps) {
            return Err("frame rate must be between 1 and 120".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    pub path: String,
    pub duration: f64,
    pub width: u32,
    pub height: u32,
    pub has_audio: bool,
    pub size_bytes: u64,
    pub encoder: String,
    /// Things the user should know (for example sound muted at high speed).
    pub warnings: Vec<String>,
}

use std::collections::HashMap;
use std::path::Path;

use crate::errors::{AppError, AppResult};
use crate::media::MediaBackend;
use crate::project::Project;
use plan::{AssetFacts, ExportPlan, build_plan};

/// Look at every source file once: does it exist, and does it carry audio?
/// Probe failures count as "no audio" so a broken file surfaces as a render error with FFmpeg's message.
pub fn gather_facts(project: &Project, backend: &dyn MediaBackend) -> HashMap<String, AssetFacts> {
    project
        .assets
        .iter()
        .map(|a| {
            let exists = Path::new(&a.path).is_file();
            let has_audio = exists && backend.has_audio(Path::new(&a.path)).unwrap_or(false);
            (a.path.clone(), AssetFacts { exists, has_audio })
        })
        .collect()
}

/// Everything that can be checked before asking the user where to save: options, project, missing media,
/// audio streams, and that every source is a file the app is allowed to read (imported or opened).
pub fn prepare_plan(
    project: &Project,
    options: &ExportOptions,
    backend: &dyn MediaBackend,
    allowed: &dyn Fn(&Path) -> bool,
) -> AppResult<ExportPlan> {
    let facts = gather_facts(project, backend);
    let plan =
        build_plan(project, options, &facts).map_err(|e| AppError::InvalidInput(e.join("; ")))?;
    let sources = plan
        .clips
        .iter()
        .flat_map(|c| std::iter::once(&c.path).chain(c.bg_image.iter()));
    if let Some(path) = sources.into_iter().find(|p| !allowed(p)) {
        return Err(AppError::InvalidInput(format!(
            "{} was not imported or opened in this session; import it again before exporting",
            path.display()
        )));
    }
    Ok(plan)
}
