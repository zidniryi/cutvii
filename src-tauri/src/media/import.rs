use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::time::UNIX_EPOCH;

use serde::Serialize;

use super::{MediaBackend, MediaInfo, MediaType};
use crate::errors::AppResult;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedMedia {
    pub path: String,
    #[serde(flatten)]
    pub info: MediaInfo,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail_path: Option<String>,
}

/// Cache key from path + size + mtime, so an edited file gets a fresh thumbnail.
/// `DefaultHasher::new()` is deterministic, but not guaranteed stable across Rust versions;
/// that only costs a regenerated thumbnail after a toolchain upgrade.
pub fn cache_key(path: &Path) -> AppResult<String> {
    let meta = fs::metadata(path)?;
    let mtime = meta
        .modified()?
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut h = DefaultHasher::new();
    (path, meta.len(), mtime).hash(&mut h);
    Ok(format!("{:016x}", h.finish()))
}

/// Probe a file and (for video/image) produce or reuse a cached thumbnail.
/// A thumbnail failure never fails the import; the asset just has no thumbnail.
pub fn import_one(
    backend: &dyn MediaBackend,
    path: &Path,
    thumb_dir: &Path,
) -> AppResult<ImportedMedia> {
    let info = backend.probe(path)?;

    let thumbnail_path = if info.media_type == MediaType::Audio {
        None
    } else {
        let out = thumb_dir.join(format!("{}.jpg", cache_key(path)?));
        let ready = out.is_file() || {
            fs::create_dir_all(thumb_dir)?;
            let at = info.duration.map(|d| (d / 2.0).min(1.0)).unwrap_or(0.0);
            backend.thumbnail(path, at, &out).is_ok()
        };
        ready.then(|| out.to_string_lossy().into_owned())
    };

    Ok(ImportedMedia {
        path: path.to_string_lossy().into_owned(),
        info,
        thumbnail_path,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::ffmpeg::FfmpegBackend;
    use crate::media::tools::{FFMPEG_ENV, command, locate_tool};
    use std::path::PathBuf;

    fn generate(ffmpeg: &Path, out: &Path, args: &[&str]) {
        let status = command(ffmpeg)
            .args(["-y", "-v", "error"])
            .args(args)
            .arg(out)
            .status()
            .unwrap();
        assert!(
            status.success(),
            "ffmpeg failed to generate {}",
            out.display()
        );
    }

    /// Runs against a real FFmpeg; skipped (loudly) when none is installed.
    #[test]
    fn imports_video_audio_image_and_reuses_thumbnails() {
        let Ok(backend) = FfmpegBackend::locate() else {
            eprintln!("SKIPPED: ffmpeg/ffprobe not found");
            return;
        };
        let ffmpeg = locate_tool("ffmpeg", FFMPEG_ENV).unwrap();
        let dir: PathBuf =
            std::env::temp_dir().join(format!("cutvii-import-{}", std::process::id()));
        let thumbs = dir.join("thumbs");
        fs::create_dir_all(&dir).unwrap();

        let video = dir.join("v.mp4");
        let audio = dir.join("a.wav");
        let image = dir.join("i.png");
        generate(
            &ffmpeg,
            &video,
            &[
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=640x360:rate=30:duration=2",
                "-pix_fmt",
                "yuv420p",
            ],
        );
        generate(
            &ffmpeg,
            &audio,
            &["-f", "lavfi", "-i", "sine=frequency=440:duration=3"],
        );
        generate(
            &ffmpeg,
            &image,
            &[
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=320x200:rate=1",
                "-frames:v",
                "1",
            ],
        );

        let v = import_one(&backend, &video, &thumbs).unwrap();
        assert_eq!(
            (v.info.media_type, v.info.width, v.info.height),
            (MediaType::Video, Some(640), Some(360))
        );
        assert!((v.info.duration.unwrap() - 2.0).abs() < 0.1);
        let thumb = PathBuf::from(v.thumbnail_path.clone().expect("video thumbnail"));
        assert!(thumb.is_file());

        // second import reuses the cached file instead of regenerating it
        let before = fs::metadata(&thumb).unwrap().modified().unwrap();
        let again = import_one(&backend, &video, &thumbs).unwrap();
        assert_eq!(again.thumbnail_path, v.thumbnail_path);
        assert_eq!(fs::metadata(&thumb).unwrap().modified().unwrap(), before);

        let a = import_one(&backend, &audio, &thumbs).unwrap();
        assert_eq!(a.info.media_type, MediaType::Audio);
        assert!(a.thumbnail_path.is_none());
        assert!((a.info.duration.unwrap() - 3.0).abs() < 0.1);

        let i = import_one(&backend, &image, &thumbs).unwrap();
        assert_eq!(
            (i.info.media_type, i.info.width, i.info.duration),
            (MediaType::Image, Some(320), None)
        );
        assert!(i.thumbnail_path.is_some());

        // a text file renamed to .mp4 is rejected, not imported
        let fake = dir.join("fake.mp4");
        fs::write(&fake, "not media").unwrap();
        assert!(import_one(&backend, &fake, &thumbs).is_err());
        assert!(import_one(&backend, &dir.join("x.exe"), &thumbs).is_err());

        fs::remove_dir_all(&dir).ok();
    }
}
