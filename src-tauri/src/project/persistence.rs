//! Reading and writing project files. Pure filesystem + validation; no Tauri types, so it is unit-testable.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use super::migrate::migrate_to_current;
use super::model::Project;
use super::validation::validate;
use crate::errors::{AppError, AppResult};

pub const FILE_EXTENSION: &str = "cutvii";
/// Refuse absurdly large files instead of loading them into memory.
const MAX_PROJECT_BYTES: u64 = 64 * 1024 * 1024;

fn invalid_project(errors: Vec<String>) -> AppError {
    const SHOWN: usize = 8;
    let more = errors.len().saturating_sub(SHOWN);
    let mut msg = errors
        .into_iter()
        .take(SHOWN)
        .collect::<Vec<_>>()
        .join("; ");
    if more > 0 {
        msg.push_str(&format!("; and {more} more"));
    }
    AppError::InvalidInput(format!("invalid project: {msg}"))
}

/// Parse, migrate and validate project JSON.
pub fn parse_project_json(text: &str) -> AppResult<Project> {
    let value: serde_json::Value = serde_json::from_str(text)
        .map_err(|e| AppError::InvalidInput(format!("not a valid project file (bad JSON: {e})")))?;
    let value = migrate_to_current(value)?;
    let project: Project = serde_json::from_value(value)
        .map_err(|e| AppError::InvalidInput(format!("invalid project: {e}")))?;
    validate(&project).map_err(invalid_project)?;
    Ok(project)
}

pub fn read_project(path: &Path) -> AppResult<Project> {
    let size = fs::metadata(path)?.len();
    if size > MAX_PROJECT_BYTES {
        return Err(AppError::InvalidInput(format!(
            "project file is too large ({size} bytes)"
        )));
    }
    parse_project_json(&fs::read_to_string(path)?)
}

/// Validate, then write via a temp file in the same directory and rename over the target,
/// so a crash or failure can never leave a half-written project behind.
pub fn write_project_atomic(path: &Path, project: &Project) -> AppResult<()> {
    validate(project).map_err(invalid_project)?;
    let json = serde_json::to_string_pretty(project)
        .map_err(|e| AppError::InvalidInput(format!("could not serialize project: {e}")))?;

    let tmp = tmp_path(path);
    let result = (|| -> std::io::Result<()> {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(json.as_bytes())?;
        f.write_all(b"\n")?;
        f.sync_all()?;
        fs::rename(&tmp, path)
    })();
    if let Err(e) = result {
        fs::remove_file(&tmp).ok();
        return Err(e.into());
    }
    Ok(())
}

fn tmp_path(path: &Path) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".tmp");
    path.with_file_name(name)
}

/// Asset paths whose file no longer exists.
pub fn missing_paths(project: &Project) -> Vec<String> {
    project
        .assets
        .iter()
        .filter(|a| !Path::new(&a.path).is_file())
        .map(|a| a.path.clone())
        .collect()
}

/// Cached thumbnails can disappear (cache cleared); drop dangling references so the UI falls back to an icon.
pub fn drop_stale_thumbnails(project: &mut Project) {
    for a in &mut project.assets {
        if a.thumbnail_path
            .as_deref()
            .is_some_and(|t| !Path::new(t).is_file())
        {
            a.thumbnail_path = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../../fixtures/project-v1.json");

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("cutvii-persist-{tag}-{}", std::process::id()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn save_then_load_round_trips_exactly() {
        let dir = temp_dir("roundtrip");
        let path = dir.join("p.cutvii");
        let project = parse_project_json(FIXTURE).unwrap();

        write_project_atomic(&path, &project).unwrap();
        assert_eq!(read_project(&path).unwrap(), project);
        assert!(
            !tmp_path(&path).exists(),
            "temp file must not be left behind"
        );
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_failed_save_leaves_the_existing_file_untouched() {
        let dir = temp_dir("atomic");
        let path = dir.join("p.cutvii");
        let good = parse_project_json(FIXTURE).unwrap();
        write_project_atomic(&path, &good).unwrap();
        let before = fs::read_to_string(&path).unwrap();

        let mut bad = good.clone();
        bad.tracks[0].clips[0].asset_id = "does-not-exist".into();
        assert!(write_project_atomic(&path, &bad).is_err());

        assert_eq!(fs::read_to_string(&path).unwrap(), before);
        assert!(!tmp_path(&path).exists());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn rejects_garbage_future_and_invalid_documents_with_readable_errors() {
        let e = parse_project_json("not json").unwrap_err().to_string();
        assert!(e.contains("bad JSON"), "{e}");

        let e = parse_project_json("{\"hello\": 1}")
            .unwrap_err()
            .to_string();
        assert!(e.contains("missing schemaVersion"), "{e}");

        let future = FIXTURE.replace("\"schemaVersion\": 1", "\"schemaVersion\": 7");
        assert!(
            parse_project_json(&future)
                .unwrap_err()
                .to_string()
                .contains("newer CutVii")
        );

        let broken = FIXTURE.replace("\"assetId\": \"asset-video\"", "\"assetId\": \"ghost\"");
        let e = parse_project_json(&broken).unwrap_err().to_string();
        assert!(e.contains("unknown asset"), "{e}");

        let extra = FIXTURE.replacen(
            "\"name\": \"Fixture project\",",
            "\"name\": \"Fixture project\", \"bogus\": 1,",
            1,
        );
        assert!(
            parse_project_json(&extra)
                .unwrap_err()
                .to_string()
                .contains("bogus")
        );
    }

    #[test]
    fn detects_missing_media_and_stale_thumbnails() {
        let dir = temp_dir("missing");
        let present = dir.join("present.mp4");
        fs::write(&present, b"x").unwrap();

        let mut p = parse_project_json(FIXTURE).unwrap();
        p.assets[0].path = present.to_string_lossy().into_owned();
        let missing = missing_paths(&p);
        assert_eq!(
            missing,
            vec![
                "/media/music.mp3".to_string(),
                "/media/logo.png".to_string()
            ]
        );

        assert!(p.assets[2].thumbnail_path.is_some());
        drop_stale_thumbnails(&mut p);
        assert!(p.assets[2].thumbnail_path.is_none());
        fs::remove_dir_all(dir).ok();
    }
}
