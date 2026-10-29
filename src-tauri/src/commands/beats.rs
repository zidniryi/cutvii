//! Beat Sync: find the beat grid of the part of a file a clip uses. Runs on this machine, no model, no
//! network. The grid is cached in `$APPCACHE/beats/<gridId>.json`; the project stores only the id.

use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use super::ai::AiJob;
use super::clip_tools::{allowed_source, derived_key};
use crate::errors::{AppError, AppResult};
use crate::media::beats::{
    ALGORITHM_VERSION, BeatGrid, check_range, detect, read_grid, write_grid,
};
use crate::media::tools::{FFMPEG_ENV, locate_tool};

pub const PROGRESS_EVENT: &str = "beats-progress";

/// The one beat detection that may run at a time, with its cancel flag.
#[derive(Default)]
pub struct BeatJob(pub AiJob);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    grid_id: String,
    /// 0..1
    done: f64,
    /// Seconds since the job started, so the UI can estimate the time left from the real rate.
    elapsed: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeatResult {
    pub grid_id: String,
    pub grid: BeatGrid,
}

/// Times are kept to the millisecond, so the same range always gives the same id.
fn millis(t: f64) -> f64 {
    (t * 1000.0).round() / 1000.0
}

fn grid_id(src: &Path, start: f64, end: f64) -> AppResult<String> {
    derived_key(
        src,
        &format!("beats-v{ALGORITHM_VERSION}-{start:.3}-{end:.3}"),
    )
}

/// The folder of cached beat grids; the export reads grids from here.
pub fn beats_dir(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::InvalidInput(format!("no cache directory: {e}")))?
        .join("beats"))
}

fn cache_file(app: &AppHandle, id: &str) -> AppResult<PathBuf> {
    if id.len() != 16 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::InvalidInput("invalid beat grid id".into()));
    }
    Ok(beats_dir(app)?.join(format!("{id}.json")))
}

/// Find (or reuse) the beats of `[start, end)` of an imported file. Progress arrives as `beats-progress`
/// events; `cancel_beat_job` stops it and leaves nothing behind.
#[tauri::command]
pub async fn detect_beats(
    app: AppHandle,
    job: State<'_, BeatJob>,
    path: String,
    start: f64,
    end: f64,
) -> AppResult<BeatResult> {
    let src = allowed_source(&app, &path)?;
    let (start, end) = (millis(start), millis(end));
    check_range(start, end)?;
    let id = grid_id(&src, start, end)?;
    let out = cache_file(&app, &id)?;
    if let Some(grid) = read_grid(&out) {
        return Ok(BeatResult { grid_id: id, grid });
    }
    let ffmpeg = locate_tool("ffmpeg", FFMPEG_ENV)?;
    let cancel = job.0.start()?;
    let emitter = app.clone();
    let key = id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let began = Instant::now();
        let mut sent = -1.0;
        let grid = detect(&ffmpeg, &src, start, end, &cancel, &mut |done| {
            if done - sent >= 0.01 || done >= 1.0 {
                sent = done;
                emitter
                    .emit(
                        PROGRESS_EVENT,
                        Progress {
                            grid_id: key.clone(),
                            done,
                            elapsed: began.elapsed().as_secs_f64(),
                        },
                    )
                    .ok();
            }
        })?;
        write_grid(&grid, &out)?;
        Ok::<_, AppError>(grid)
    })
    .await
    .map_err(|e| AppError::InvalidInput(format!("beat task failed: {e}")));
    job.0.finish();
    Ok(BeatResult {
        grid_id: id,
        grid: result??,
    })
}

#[tauri::command]
pub fn cancel_beat_job(job: State<'_, BeatJob>) {
    if let Some(flag) = job.0.0.lock().unwrap().as_ref() {
        flag.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

/// The cached grid a clip refers to, or `None` when it is gone or the file changed since (the id is made
/// from the file's size and modification time, so a changed file gives a different id).
#[tauri::command]
pub fn beat_grid(app: AppHandle, path: String, grid_id: String) -> AppResult<Option<BeatGrid>> {
    let src = allowed_source(&app, &path)?;
    let Some(grid) = read_grid(&cache_file(&app, &grid_id)?) else {
        return Ok(None);
    };
    Ok((self::grid_id(&src, grid.start, grid.end)? == grid_id).then_some(grid))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_id_depends_on_the_file_and_the_range() {
        let dir = std::env::temp_dir().join(format!("cutvii-beat-id-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (a, b) = (dir.join("a.wav"), dir.join("b.wav"));
        std::fs::write(&a, b"one").unwrap();
        std::fs::write(&b, b"other").unwrap();
        let id = grid_id(&a, 1.0, 9.0).unwrap();
        assert_eq!(id.len(), 16);
        assert_eq!(
            id,
            grid_id(&a, millis(1.0001), 9.0).unwrap(),
            "same range to the ms"
        );
        assert_ne!(id, grid_id(&a, 1.0, 9.5).unwrap());
        assert_ne!(id, grid_id(&b, 1.0, 9.0).unwrap());
        std::fs::remove_dir_all(&dir).ok();
    }
}
