//! Transcript files for Auto Clips: choose one, check it, describe it. The webview never gets to read a file
//! by path: a path works only after the native dialog (or, later, the drop handler) granted it.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use super::clip_tools::allowed_source;
use crate::errors::{AppError, AppResult};
use crate::media::transcript_import::{Imported, read_file};

/// Paths the user picked in this session.
#[derive(Default)]
pub struct TranscriptGrants(pub Mutex<HashSet<PathBuf>>);

impl TranscriptGrants {
    pub fn allow(&self, path: &Path) {
        self.0.lock().unwrap().insert(path.to_path_buf());
    }
    pub fn check(&self, path: &str) -> AppResult<PathBuf> {
        let p = PathBuf::from(path);
        if self.0.lock().unwrap().contains(&p) {
            Ok(p)
        } else {
            Err(AppError::InvalidInput(
                "that transcript file was not chosen in this session; choose it again".into(),
            ))
        }
    }
}

/// Extensions a transcript file may have. The format itself is found from the content.
const EXTENSIONS: &[&str] = &["json", "json3", "srt", "vtt"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptInfo {
    pub path: String,
    pub name: String,
    pub format: String,
    pub lines: usize,
    pub word_level: bool,
    pub word_reason: String,
    /// First line start and last line end, in the file's own seconds.
    pub span_start: f64,
    pub span_end: f64,
    /// Short hash of the file's bytes.
    pub hash: String,
}

pub fn hash_of(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .take(8)
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn describe(path: &Path) -> AppResult<(TranscriptInfo, Imported, Vec<u8>)> {
    let ok_ext = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()));
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    if !ok_ext {
        return Err(AppError::InvalidInput(format!(
            "“{name}” is not a transcript file (.json, .json3, .srt or .vtt)"
        )));
    }
    let (imported, bytes) =
        read_file(path).map_err(|e| AppError::InvalidInput(format!("“{name}”: {}", e)))?;
    let first = imported.segments.first().map_or(0.0, |s| s.start);
    let last = imported.segments.iter().map(|s| s.end).fold(0.0, f64::max);
    let info = TranscriptInfo {
        path: path.to_string_lossy().into_owned(),
        name,
        format: imported.format.label().to_string(),
        lines: imported.segments.len(),
        word_level: imported.word_level,
        word_reason: imported.word_reason.clone(),
        span_start: first,
        span_end: last,
        hash: hash_of(&bytes),
    };
    Ok((info, imported, bytes))
}

/// Read, check and hash a granted file; the bytes come back so the caller hashes what it parses.
pub fn load(grants: &TranscriptGrants, path: &str) -> AppResult<(TranscriptInfo, Vec<u8>)> {
    let p = grants.check(path)?;
    let (info, _, bytes) = describe(&p)?;
    Ok((info, bytes))
}

/// Native "choose transcript" dialog. `None` when the user cancels.
#[tauri::command]
pub async fn choose_transcript_file(
    app: AppHandle,
    grants: State<'_, TranscriptGrants>,
) -> AppResult<Option<TranscriptInfo>> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("Transcript", EXTENSIONS)
            .blocking_pick_file()
            .and_then(|p| p.into_path().ok())
    })
    .await
    .map_err(|e| AppError::InvalidInput(format!("file task failed: {e}")))?;
    let Some(path) = picked else {
        return Ok(None);
    };
    // check first, grant only a file that is a transcript
    let info = tauri::async_runtime::spawn_blocking({
        let path = path.clone();
        move || describe(&path).map(|(info, _, _)| info)
    })
    .await
    .map_err(|e| AppError::InvalidInput(format!("file task failed: {e}")))??;
    grants.allow(&path);
    Ok(Some(info))
}

/// Describe a transcript file chosen earlier in this session (again, after it changed on disk).
#[tauri::command]
pub async fn inspect_transcript(
    grants: State<'_, TranscriptGrants>,
    path: String,
) -> AppResult<TranscriptInfo> {
    let p = grants.check(&path)?;
    tauri::async_runtime::spawn_blocking(move || describe(&p).map(|(info, _, _)| info))
        .await
        .map_err(|e| AppError::InvalidInput(format!("file task failed: {e}")))?
}

/// Most files in the video's folder that are looked at.
const MAX_SCANNED: usize = 20;

/// Lower is better: json3 with word offsets, then `transcript.json`, then other json3, then srt / vtt,
/// then any other json.
fn rank(info: &TranscriptInfo) -> u8 {
    let name = info.name.to_ascii_lowercase();
    let ext = name.rsplit('.').next().unwrap_or("");
    match ext {
        "json3" if info.word_level => 0,
        "json" if name == "transcript.json" => 1,
        "json3" => 2,
        "srt" | "vtt" => 3,
        _ => 4,
    }
}

/// The transcript files that sit in `dir` itself, best first. Looks at nothing else: not subfolders, not
/// symlinks, not other folders; a file that is too big or not a valid transcript is skipped quietly.
pub fn scan_folder(dir: &Path) -> Vec<TranscriptInfo> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    let mut looked = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        // macOS leaves "._name" shadow files next to files copied from other disks
        if name.starts_with('.') {
            continue;
        }
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        let wanted = path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()));
        if !meta.is_file() || !wanted || meta.len() > crate::media::transcript_import::MAX_BYTES {
            continue;
        }
        looked += 1;
        if looked > MAX_SCANNED {
            break;
        }
        if let Ok((info, _, _)) = describe(&path) {
            found.push(info);
        }
    }
    found.sort_by(|a, b| rank(a).cmp(&rank(b)).then_with(|| a.name.cmp(&b.name)));
    found
}

/// Transcript files next to an imported video, best first. An empty list when there is none or the folder
/// cannot be read: that is not an error, "Choose file…" still works.
#[tauri::command]
pub async fn find_transcripts_near(
    app: AppHandle,
    grants: State<'_, TranscriptGrants>,
    path: String,
) -> AppResult<Vec<TranscriptInfo>> {
    let video = allowed_source(&app, &path)?;
    let Some(dir) = video.parent().map(Path::to_path_buf) else {
        return Ok(Vec::new());
    };
    let found = tauri::async_runtime::spawn_blocking(move || scan_folder(&dir))
        .await
        .map_err(|e| AppError::InvalidInput(format!("folder task failed: {e}")))?;
    for info in &found {
        grants.allow(Path::new(&info.path));
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_chosen_path_can_be_read() {
        let grants = TranscriptGrants::default();
        assert!(grants.check("/etc/passwd").is_err());
        grants.allow(Path::new("/tmp/a.srt"));
        assert!(grants.check("/tmp/a.srt").is_ok());
        assert!(grants.check("/tmp/b.srt").is_err());
    }

    #[test]
    fn a_file_with_the_wrong_extension_or_content_is_refused_with_its_name() {
        let dir = std::env::temp_dir().join(format!("cutvii-tr-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let txt = dir.join("notes.txt");
        std::fs::write(&txt, "hello").unwrap();
        let err = describe(&txt).unwrap_err().to_string();
        assert!(
            err.contains("notes.txt") && err.contains("not a transcript"),
            "{err}"
        );

        let json = dir.join("x.json");
        std::fs::write(&json, r#"{"a":1}"#).unwrap();
        assert!(describe(&json).unwrap_err().to_string().contains("x.json"));

        let ok = dir.join("ok.json");
        std::fs::write(&ok, r#"[{"start":1,"duration":2,"text":"hi there"}]"#).unwrap();
        let (info, _, bytes) = describe(&ok).unwrap();
        assert_eq!((info.lines, info.span_start, info.span_end), (1, 1.0, 3.0));
        assert_eq!(info.hash, hash_of(&bytes));
        std::fs::remove_dir_all(dir).ok();
    }

    fn write(dir: &Path, name: &str, text: &str) {
        std::fs::write(dir.join(name), text).unwrap();
    }

    #[test]
    fn only_the_videos_own_folder_is_scanned_and_the_best_file_comes_first() {
        let base = std::env::temp_dir().join(format!("cutvii-near-{}", std::process::id()));
        std::fs::remove_dir_all(&base).ok();
        let dir = base.join("video");
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        let list = r#"[{"start":0,"duration":2,"text":"hello there"}]"#;
        let rich = r#"{"events":[{"tStartMs":0,"dDurationMs":2000,"segs":[{"utf8":"hello"},{"utf8":" there","tOffsetMs":500}]}]}"#;
        let srt = "1\n00:00:00,000 --> 00:00:02,000\nhello there\n";
        write(&dir, "talk.srt", srt);
        write(&dir, "transcript.json", list);
        write(&dir, "talk.id.json3", rich);
        write(&dir, "notes.txt", "not wanted");
        write(&dir, "broken.json", "{nope");
        write(&dir, "._talk.srt", srt);
        write(&dir.join("sub"), "deep.srt", srt);
        write(&base, "outside.srt", srt);
        #[cfg(unix)]
        std::os::unix::fs::symlink(base.join("outside.srt"), dir.join("link.srt")).unwrap();

        let names: Vec<String> = scan_folder(&dir).into_iter().map(|i| i.name).collect();
        assert_eq!(names, ["talk.id.json3", "transcript.json", "talk.srt"]);
        assert!(scan_folder(&base.join("missing")).is_empty());
        std::fs::remove_dir_all(base).ok();
    }
}
