//! Running FFmpeg for an [`ExportPlan`]: progress, cancel, ffprobe verification, atomic output.

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::encoder::Encoder;
use super::plan::{AUDIO_RATE, ExportPlan, build_filter_graph, rate_expr};
use super::{ExportFormat, ExportReport};
use crate::errors::{AppError, AppResult};
use crate::media::probe::parse_stream_summary;
use crate::media::tools::command;

pub struct RenderJob<'a> {
    pub ffmpeg: &'a Path,
    pub ffprobe: &'a Path,
    pub plan: &'a ExportPlan,
    /// The H.264 encoder; `None` for audio-only exports.
    pub encoder: Option<Encoder>,
    pub output: &'a Path,
}

/// Full FFmpeg argument list (everything after the program name) for rendering to `tmp`.
pub fn build_args(plan: &ExportPlan, encoder: Option<Encoder>, tmp: &Path) -> Vec<String> {
    let g = build_filter_graph(plan);
    let s = |v: &str| v.to_string();

    let mut a: Vec<String> = [
        "-y",
        "-v",
        "error",
        "-nostdin",
        "-progress",
        "pipe:1",
        "-nostats",
    ]
    .map(String::from)
    .to_vec();
    a.extend(g.input_args);
    a.extend([s("-filter_complex"), g.graph]);

    let duration = format!("{:.6}", plan.duration);
    let rate = AUDIO_RATE.to_string();
    match (plan.format, g.video_label, encoder) {
        (ExportFormat::Mp4, Some(video), Some(encoder)) => {
            a.extend([s("-map"), s(video), s("-map"), s(g.audio_label)]);
            a.extend(encoder.video_args(plan.quality, plan.width, plan.height, plan.fps));
            a.extend([s("-r"), rate_expr(plan.fps)]);
            a.extend(
                [
                    "-c:a", "aac", "-b:a", "192k", "-ar", &rate, "-ac", "2", "-t", &duration,
                ]
                .map(String::from),
            );
            a.extend(["-movflags", "+faststart", "-f", "mp4"].map(String::from));
        }
        (ExportFormat::Wav, ..) => {
            a.extend(
                [
                    "-map",
                    g.audio_label,
                    "-vn",
                    "-c:a",
                    "pcm_s16le",
                    "-ar",
                    &rate,
                    "-ac",
                    "2",
                ]
                .map(String::from),
            );
            a.extend(["-t", &duration, "-f", "wav"].map(String::from));
        }
        (ExportFormat::Mp3, ..) => {
            a.extend(
                [
                    "-map",
                    g.audio_label,
                    "-vn",
                    "-c:a",
                    "libmp3lame",
                    "-b:a",
                    "192k",
                    "-ar",
                    &rate,
                    "-ac",
                    "2",
                ]
                .map(String::from),
            );
            // no Xing/ID3 extras needed for correctness; keep the default header so players can seek
            a.extend(["-t", &duration, "-f", "mp3"].map(String::from));
        }
        // M4A (and, defensively, anything without a video encoder): AAC audio only
        _ => {
            a.extend(
                [
                    "-map",
                    g.audio_label,
                    "-vn",
                    "-c:a",
                    "aac",
                    "-b:a",
                    "192k",
                    "-ar",
                    &rate,
                    "-ac",
                    "2",
                ]
                .map(String::from),
            );
            a.extend(["-t", &duration, "-movflags", "+faststart", "-f", "ipod"].map(String::from));
        }
    }
    a.push(tmp.to_string_lossy().into_owned());
    a
}

fn temp_path(output: &Path, format: ExportFormat) -> PathBuf {
    let stem = output
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("export");
    output.with_file_name(format!(".{stem}.cutvii-part.{}", format.extension()))
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
    }
}

/// `out_time_us=1234567` -> seconds
fn parse_progress_line(line: &str) -> Option<f64> {
    let v = line.strip_prefix("out_time_us=")?;
    v.trim().parse::<f64>().ok().map(|us| us / 1_000_000.0)
}

pub fn run(
    job: &RenderJob,
    on_progress: &mut dyn FnMut(f64),
    cancel: &AtomicBool,
) -> AppResult<ExportReport> {
    let plan = job.plan;

    // never write over a source file, and never into a missing folder
    if plan.clips.iter().any(|c| same_file(&c.path, job.output)) {
        return Err(AppError::InvalidInput(
            "the export file would overwrite a source media file".into(),
        ));
    }
    if job
        .output
        .parent()
        .is_some_and(|p| !p.as_os_str().is_empty() && !p.is_dir())
    {
        return Err(AppError::InvalidInput(
            "the export folder does not exist".into(),
        ));
    }

    let tmp = temp_path(job.output, plan.format);
    fs::remove_file(&tmp).ok();
    let cleanup = || {
        fs::remove_file(&tmp).ok();
    };

    let mut child = command(job.ffmpeg)
        .args(build_args(plan, job.encoder, &tmp))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    // stdout: progress lines. stderr: keep the tail for error messages.
    let (tx, rx) = mpsc::channel::<String>();
    let stdout = child.stdout.take().expect("piped stdout");
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    let tail: Arc<Mutex<Vec<String>>> = Arc::default();
    let stderr = child.stderr.take().expect("piped stderr");
    let tail_writer = Arc::clone(&tail);
    let err_reader = std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let mut t = tail_writer.lock().unwrap();
            t.push(line);
            if t.len() > 12 {
                t.remove(0);
            }
        }
    });

    let mut last = 0.0_f64;
    loop {
        if cancel.load(Ordering::Relaxed) {
            child.kill().ok();
            child.wait().ok();
            cleanup();
            return Err(AppError::Cancelled);
        }
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(line) => {
                if let Some(t) = parse_progress_line(&line) {
                    // 0.99 until verified, so "100%" always means finished and checked
                    let f = (t / plan.duration).clamp(0.0, 0.99);
                    if f > last {
                        last = f;
                        on_progress(f);
                    }
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }

    let status = child.wait()?;
    reader.join().ok();
    err_reader.join().ok();

    if cancel.load(Ordering::Relaxed) {
        cleanup();
        return Err(AppError::Cancelled);
    }
    if !status.success() {
        cleanup();
        let msg = tail
            .lock()
            .unwrap()
            .iter()
            .rev()
            .take(3)
            .rev()
            .cloned()
            .collect::<Vec<_>>()
            .join(" | ");
        return Err(AppError::InvalidInput(format!(
            "FFmpeg failed: {}",
            if msg.is_empty() {
                "unknown error".to_string()
            } else {
                msg
            }
        )));
    }

    let report = match verify(job, &tmp) {
        Ok(r) => r,
        Err(e) => {
            cleanup();
            return Err(e);
        }
    };

    // only now does the finished file replace anything at the destination
    if let Err(e) = fs::rename(&tmp, job.output) {
        cleanup();
        return Err(e.into());
    }
    on_progress(1.0);
    Ok(ExportReport {
        path: job.output.to_string_lossy().into_owned(),
        ..report
    })
}

/// ffprobe the rendered file and compare it with what the plan promised.
fn verify(job: &RenderJob, file: &Path) -> AppResult<ExportReport> {
    let out = command(job.ffprobe)
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            "-i",
        ])
        .arg(file)
        .output()?;
    let fail = |m: String| AppError::InvalidInput(format!("export verification failed: {m}"));
    if !out.status.success() {
        return Err(fail("the output file could not be read".into()));
    }
    let s = parse_stream_summary(&String::from_utf8_lossy(&out.stdout))?;
    let plan = job.plan;

    let audio_only = plan.format.is_audio();
    if audio_only && s.has_video {
        return Err(fail("an audio export must not contain video".into()));
    }
    if !audio_only && !s.has_video {
        return Err(fail("no video stream".into()));
    }
    if !s.has_audio {
        return Err(fail("no audio stream".into()));
    }
    let (w, h) = (s.width.unwrap_or(0), s.height.unwrap_or(0));
    if !audio_only && (w, h) != (plan.width, plan.height) {
        return Err(fail(format!(
            "size is {w}x{h}, expected {}x{}",
            plan.width, plan.height
        )));
    }
    let duration = s.duration.unwrap_or(0.0);
    let tolerance = 3.0 / plan.fps + 0.1;
    if (duration - plan.duration).abs() > tolerance {
        return Err(fail(format!(
            "duration is {duration:.2}s, expected {:.2}s",
            plan.duration
        )));
    }

    Ok(ExportReport {
        path: file.to_string_lossy().into_owned(),
        duration,
        width: w,
        height: h,
        has_audio: true,
        size_bytes: fs::metadata(file)?.len(),
        warnings: plan.warnings.clone(),
        encoder: match (plan.format, job.encoder) {
            (ExportFormat::Wav, _) => "pcm_s16le".to_string(),
            (ExportFormat::Mp3, _) => "libmp3lame".to_string(),
            (ExportFormat::M4a, _) | (_, None) => "aac".to_string(),
            (_, Some(e)) => e.name().to_string(),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::export::plan::{AssetFacts, build_plan};
    use crate::export::{ExportOptions, Quality, gather_facts};
    use crate::media::ffmpeg::FfmpegBackend;
    use crate::media::tools::{FFMPEG_ENV, locate_tool};
    use crate::media::{MediaBackend, RenderRequest};
    use crate::project::Project;
    use serde_json::{Value, json};
    use std::collections::HashMap;

    #[test]
    fn parses_progress_lines() {
        assert_eq!(parse_progress_line("out_time_us=1500000"), Some(1.5));
        assert_eq!(parse_progress_line("out_time_us=N/A"), None);
        assert_eq!(parse_progress_line("frame=12"), None);
    }

    #[test]
    fn args_map_both_outputs_and_write_only_to_the_temp_file() {
        let plan = ExportPlan {
            width: 640,
            height: 360,
            fps: 30.0,
            quality: Quality::Standard,
            format: ExportFormat::Mp4,
            duration: 2.0,
            background: "#000000".into(),
            clips: vec![],
            warnings: vec![],
        };
        let tmp = PathBuf::from("/out/.x.cutvii-part.mp4");
        let a = build_args(&plan, Some(Encoder::Libx264), &tmp);
        let joined = a.join(" ");
        assert!(joined.contains("-map [vout] -map [aout]"));
        assert!(joined.contains("-c:v libx264 -preset medium -crf 23"));
        assert!(joined.contains("-movflags +faststart -f mp4"));
        assert_eq!(a.last().unwrap(), "/out/.x.cutvii-part.mp4");
        assert_eq!(
            temp_path(Path::new("/out/final.mp4"), ExportFormat::Mp4),
            PathBuf::from("/out/.final.cutvii-part.mp4")
        );
    }

    // ---------- real FFmpeg end-to-end tests (skipped loudly when FFmpeg is not installed) ----------

    struct Env {
        backend: FfmpegBackend,
        ffmpeg: PathBuf,
        dir: PathBuf,
    }

    impl Drop for Env {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.dir).ok();
        }
    }

    fn env(tag: &str) -> Option<Env> {
        let Ok(backend) = FfmpegBackend::locate() else {
            eprintln!("SKIPPED ({tag}): ffmpeg/ffprobe not found");
            return None;
        };
        let ffmpeg = locate_tool("ffmpeg", FFMPEG_ENV).unwrap();
        let dir = std::env::temp_dir().join(format!("cutvii-export-{tag}-{}", std::process::id()));
        fs::remove_dir_all(&dir).ok();
        fs::create_dir_all(&dir).unwrap();
        Some(Env {
            backend,
            ffmpeg,
            dir,
        })
    }

    impl Env {
        fn make(&self, name: &str, args: &[&str]) -> String {
            let out = self.dir.join(name);
            let st = command(&self.ffmpeg)
                .args(["-y", "-v", "error"])
                .args(args)
                .arg(&out)
                .status()
                .unwrap();
            assert!(st.success(), "could not generate {name}");
            out.to_string_lossy().into_owned()
        }

        /// 4s red video with a 1 kHz tone.
        fn red(&self) -> String {
            self.make(
                "red.mp4",
                &[
                    "-f",
                    "lavfi",
                    "-i",
                    "color=c=red:s=320x180:r=30:d=4",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=1000:duration=4",
                    "-shortest",
                    "-pix_fmt",
                    "yuv420p",
                ],
            )
        }
        /// 4s blue video, no audio stream.
        fn blue(&self) -> String {
            self.make(
                "blue.mp4",
                &[
                    "-f",
                    "lavfi",
                    "-i",
                    "color=c=blue:s=320x180:r=30:d=4",
                    "-pix_fmt",
                    "yuv420p",
                ],
            )
        }
        fn green_png(&self) -> String {
            self.make(
                "green.png",
                &[
                    "-f",
                    "lavfi",
                    "-i",
                    "color=c=green:s=200x100",
                    "-frames:v",
                    "1",
                ],
            )
        }
        fn clear_png(&self) -> String {
            self.make(
                "clear.png",
                &[
                    "-f",
                    "lavfi",
                    "-i",
                    "color=c=red@0.0:s=64x64,format=rgba",
                    "-frames:v",
                    "1",
                ],
            )
        }
        fn tone(&self) -> String {
            self.make(
                "tone.wav",
                &["-f", "lavfi", "-i", "sine=frequency=440:duration=3"],
            )
        }

        /// Plan + render exactly like the app does (facts via the backend), returning the progress seen.
        fn export(
            &self,
            project: &Project,
            opts: &ExportOptions,
            out: &Path,
        ) -> (AppResult<ExportReport>, Vec<f64>) {
            let facts = gather_facts(project, &self.backend);
            let mut plan = match build_plan(project, opts, &facts) {
                Ok(p) => p,
                Err(e) => return (Err(AppError::InvalidInput(e.join("; "))), vec![]),
            };
            // imported LUTs come from the test's own folder, as the app's come from the app data folder
            if let Err(e) = plan.bake_user_luts(&self.dir.join("luts")) {
                return (Err(e), vec![]);
            }
            let mut seen = Vec::new();
            let r = self.backend.render(
                &RenderRequest {
                    plan,
                    output: out.to_path_buf(),
                },
                &mut |f| seen.push(f),
                &AtomicBool::new(false),
            );
            (r, seen)
        }

        /// Decode every frame and sample of the file; any decoder complaint fails the check.
        fn decodes_cleanly(&self, video: &Path) -> bool {
            let out = command(&self.ffmpeg)
                .args(["-v", "error", "-xerror", "-i"])
                .arg(video)
                .args(["-f", "null", "-"])
                .output()
                .unwrap();
            out.status.success() && out.stderr.is_empty()
        }

        /// 200x100 still: left half red, right half blue.
        fn two_tone_jpg(&self, name: &str) -> String {
            self.make(
                name,
                &[
                    "-f",
                    "lavfi",
                    "-i",
                    "color=c=red:s=100x100",
                    "-f",
                    "lavfi",
                    "-i",
                    "color=c=blue:s=100x100",
                    "-filter_complex",
                    "hstack",
                    "-frames:v",
                    "1",
                    "-q:v",
                    "2",
                ],
            )
        }

        /// Same picture with an EXIF Orientation tag of 6 ("rotate 90 degrees clockwise to display").
        fn exif_rotated_jpg(&self) -> String {
            let plain = fs::read(self.two_tone_jpg("plain_src.jpg")).unwrap();
            assert_eq!(&plain[..2], &[0xFF, 0xD8], "JPEG SOI");
            let mut exif: Vec<u8> = vec![0xFF, 0xE1, 0x00, 0x22];
            exif.extend_from_slice(b"Exif\0\0");
            exif.extend_from_slice(&[b'I', b'I', 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00]); // TIFF header, IFD at 8
            exif.extend_from_slice(&[0x01, 0x00]); // one entry
            exif.extend_from_slice(&[
                0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00,
            ]); // Orientation = 6
            exif.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]); // no next IFD
            let mut out = plain[..2].to_vec();
            out.extend_from_slice(&exif);
            out.extend_from_slice(&plain[2..]);
            let path = self.dir.join("rot6.jpg");
            fs::write(&path, out).unwrap();
            path.to_string_lossy().into_owned()
        }

        /// Average RGB of a `crop=w:h:x:y` region of the frame at `t`.
        fn region(&self, video: &Path, t: f64, crop: &str) -> (u8, u8, u8) {
            let out = command(&self.ffmpeg)
                .args(["-v", "error", "-ss", &format!("{t}"), "-i"])
                .arg(video)
                .args([
                    "-frames:v",
                    "1",
                    "-vf",
                    &format!("crop={crop},scale=1:1"),
                    "-f",
                    "rawvideo",
                    "-pix_fmt",
                    "rgb24",
                    "-",
                ])
                .output()
                .unwrap();
            assert_eq!(out.stdout.len(), 3, "no frame at t={t}");
            (out.stdout[0], out.stdout[1], out.stdout[2])
        }

        /// Average RGB of the frame at `t`.
        fn color_at(&self, video: &Path, t: f64) -> (u8, u8, u8) {
            let out = command(&self.ffmpeg)
                .args(["-v", "error", "-ss", &format!("{t}"), "-i"])
                .arg(video)
                .args([
                    "-frames:v",
                    "1",
                    "-vf",
                    "scale=1:1",
                    "-f",
                    "rawvideo",
                    "-pix_fmt",
                    "rgb24",
                    "-",
                ])
                .output()
                .unwrap();
            assert_eq!(out.stdout.len(), 3, "no frame at t={t}");
            (out.stdout[0], out.stdout[1], out.stdout[2])
        }

        /// Mean volume (dB) of `len` seconds of audio starting at `from`.
        fn volume(&self, video: &Path, from: f64, len: f64) -> f64 {
            let out = command(&self.ffmpeg)
                .args([
                    "-hide_banner",
                    "-ss",
                    &format!("{from}"),
                    "-t",
                    &format!("{len}"),
                    "-i",
                ])
                .arg(video)
                .args(["-vn", "-af", "volumedetect", "-f", "null", "-"])
                .output()
                .unwrap();
            let text = String::from_utf8_lossy(&out.stderr).into_owned();
            text.lines()
                .find_map(|l| l.split("mean_volume:").nth(1))
                .and_then(|v| v.trim().trim_end_matches("dB").trim().parse::<f64>().ok())
                .unwrap_or_else(|| panic!("no mean_volume in:\n{text}"))
        }
    }

    fn clip(
        id: &str,
        asset: &str,
        track: &str,
        start: f64,
        sin: f64,
        sout: f64,
        volume: f64,
    ) -> Value {
        json!({"id": id, "assetId": asset, "trackId": track, "timelineStart": start, "sourceIn": sin,
               "sourceOut": sout, "volume": volume, "x": 0, "y": 0, "scale": 1, "opacity": 1,
               "fitBackground": {"kind": "color", "color": "#202020"}})
    }
    fn track(
        id: &str,
        ty: &str,
        order: u32,
        muted: bool,
        hidden: bool,
        clips: Vec<Value>,
    ) -> Value {
        json!({"id": id, "name": id, "type": ty, "order": order, "muted": muted, "hidden": hidden, "clips": clips})
    }
    fn project(assets: Vec<Value>, tracks: Vec<Value>) -> Project {
        serde_json::from_value(json!({
            "id": "p", "name": "t", "schemaVersion": 8,
            "createdAt": "2026-01-01T00:00:00.000Z", "modifiedAt": "2026-01-01T00:00:00.000Z",
            "settings": {"width": 640, "height": 360, "fps": 30, "backgroundColor": "#202020"},
            "assets": assets, "tracks": tracks
        }))
        .unwrap()
    }
    fn asset(id: &str, path: &str, ty: &str, duration: Option<f64>) -> Value {
        match duration {
            Some(d) => json!({"id": id, "path": path, "type": ty, "duration": d}),
            None => json!({"id": id, "path": path, "type": ty}),
        }
    }
    fn opts(quality: Quality) -> ExportOptions {
        ExportOptions {
            width: 640,
            height: 360,
            fps: 30.0,
            quality,
            format: ExportFormat::Mp4,
        }
    }

    fn near(c: (u8, u8, u8), expect: (u8, u8, u8), tol: i32) -> bool {
        let d = |a: u8, b: u8| (a as i32 - b as i32).abs() <= tol;
        d(c.0, expect.0) && d(c.1, expect.1) && d(c.2, expect.2)
    }

    #[test]
    fn composites_tracks_gaps_and_stills_with_correct_timing_and_sound() {
        let Some(e) = env("composite") else { return };
        let (red, blue, green, tone) = (e.red(), e.blue(), e.green_png(), e.tone());
        let p = project(
            vec![
                asset("red", &red, "video", Some(4.0)),
                asset("blue", &blue, "video", Some(4.0)),
                asset("green", &green, "image", None),
                asset("tone", &tone, "audio", Some(3.0)),
            ],
            vec![
                track(
                    "v1",
                    "video",
                    0,
                    false,
                    false,
                    vec![
                        clip("c1", "red", "v1", 0.0, 0.0, 2.0, 1.0),
                        clip("c2", "blue", "v1", 3.0, 0.0, 2.0, 1.0),
                    ],
                ),
                track(
                    "v2",
                    "video",
                    1,
                    false,
                    false,
                    vec![clip("c3", "green", "v2", 1.0, 0.0, 1.5, 1.0)],
                ),
                track(
                    "a1",
                    "audio",
                    2,
                    false,
                    false,
                    vec![clip("c4", "tone", "a1", 5.0, 0.0, 2.0, 1.0)],
                ),
            ],
        );
        let out = e.dir.join("out.mp4");
        let (report, progress) = e.export(&p, &opts(Quality::Draft), &out);
        let report = report.expect("export should succeed");

        // container: size, duration, streams, encoder
        assert_eq!((report.width, report.height), (640, 360));
        assert!(
            (report.duration - 7.0).abs() < 0.2,
            "duration {}",
            report.duration
        );
        assert!(report.has_audio && report.size_bytes > 1000);
        assert_eq!(report.encoder, "libx264");
        assert!(out.is_file());
        assert!(!temp_path(&out, ExportFormat::Mp4).exists());
        assert!(
            e.decodes_cleanly(&out),
            "the exported MP4 must decode end to end without errors"
        );

        // progress is monotonic and ends at 100%
        assert!(progress.windows(2).all(|w| w[0] <= w[1]), "{progress:?}");
        assert_eq!(progress.last(), Some(&1.0));

        // picture at specific times
        let red_px = e.color_at(&out, 0.5);
        assert!(
            red_px.0 > 200 && red_px.1 < 70 && red_px.2 < 70,
            "red clip: {red_px:?}"
        );
        let green_px = e.color_at(&out, 1.5);
        assert!(
            green_px.1 > 90 && green_px.0 < 60 && green_px.2 < 60,
            "still over red: {green_px:?}"
        );
        let tail_px = e.color_at(&out, 2.25);
        assert!(
            tail_px.1 > 90 && tail_px.0 < 60,
            "still persists after the red clip ends: {tail_px:?}"
        );
        let gap_px = e.color_at(&out, 2.75);
        assert!(
            near(gap_px, (32, 32, 32), 14),
            "gap shows the background: {gap_px:?}"
        );
        let blue_px = e.color_at(&out, 3.5);
        assert!(
            blue_px.2 > 200 && blue_px.0 < 70 && blue_px.1 < 70,
            "blue clip after the gap: {blue_px:?}"
        );
        let end_px = e.color_at(&out, 6.0);
        assert!(
            near(end_px, (32, 32, 32), 14),
            "background after the last picture: {end_px:?}"
        );

        // sound: tone from the red clip, silence in the gap, the wav at 5-7s
        assert!(e.volume(&out, 0.2, 1.6) > -40.0, "red clip audio");
        assert!(e.volume(&out, 2.2, 0.6) < -80.0, "gap is silent");
        assert!(e.volume(&out, 3.2, 1.6) < -80.0, "blue has no audio");
        assert!(e.volume(&out, 5.2, 1.6) > -40.0, "wav placed at 5s");
    }

    #[test]
    fn honours_mute_volume_hidden_tracks_and_transparency() {
        let Some(e) = env("mix") else { return };
        let (red, clear) = (e.red(), e.clear_png());
        let base_assets = vec![
            asset("red", &red, "video", Some(4.0)),
            asset("clear", &clear, "image", None),
        ];

        let render = |name: &str, tracks: Vec<Value>| {
            let out = e.dir.join(name);
            let (r, _) = e.export(
                &project(base_assets.clone(), tracks),
                &opts(Quality::Draft),
                &out,
            );
            r.unwrap_or_else(|err| panic!("{name}: {err}"));
            out
        };

        let loud = render(
            "loud.mp4",
            vec![track(
                "v1",
                "video",
                0,
                false,
                false,
                vec![clip("c", "red", "v1", 0.0, 0.0, 2.0, 1.0)],
            )],
        );
        let half = render(
            "half.mp4",
            vec![track(
                "v1",
                "video",
                0,
                false,
                false,
                vec![clip("c", "red", "v1", 0.0, 0.0, 2.0, 0.5)],
            )],
        );
        let muted = render(
            "muted.mp4",
            vec![track(
                "v1",
                "video",
                0,
                true,
                false,
                vec![clip("c", "red", "v1", 0.0, 0.0, 2.0, 1.0)],
            )],
        );
        let hidden = render(
            "hidden.mp4",
            vec![track(
                "v1",
                "video",
                0,
                false,
                true,
                vec![clip("c", "red", "v1", 0.0, 0.0, 2.0, 1.0)],
            )],
        );

        let (l, h) = (e.volume(&loud, 0.2, 1.6), e.volume(&half, 0.2, 1.6));
        assert!(l > -40.0);
        assert!(
            (l - h - 6.0).abs() < 1.5,
            "volume 0.5 should be ~6 dB quieter: {l} vs {h}"
        );
        assert!(e.volume(&muted, 0.2, 1.6) < -80.0, "muted track is silent");
        assert!(
            near(e.color_at(&muted, 1.0), (255, 0, 0), 60),
            "muted track still shows picture"
        );
        assert!(
            near(e.color_at(&hidden, 1.0), (32, 32, 32), 14),
            "hidden track shows no picture"
        );
        assert!(
            e.volume(&hidden, 0.2, 1.6) > -40.0,
            "hidden track still plays its sound"
        );

        // a fully transparent still must not show its (red) hidden RGB: it is flattened onto the background
        let transparent = render(
            "clear.mp4",
            vec![track(
                "v1",
                "video",
                0,
                false,
                false,
                vec![clip("c", "clear", "v1", 0.0, 0.0, 1.0, 1.0)],
            )],
        );
        let px = e.color_at(&transparent, 0.5);
        assert!(
            near(px, (32, 32, 32), 14),
            "transparent still over background: {px:?}"
        );
    }

    #[test]
    fn text_is_drawn_over_the_video_below_it() {
        let Some(e) = env("text") else { return };
        let red = e.red();
        let spec = crate::media::text::TextSpec {
            content: "HHHH".into(),
            font_size: 150.0,
            color: "#FFFFFF".into(),
            bold: true,
            font: None,
            uppercase: false,
            outline: None,
            shadow: None,
            backdrop: None,
            highlight: None,
            wrap: None,
            align: Default::default(),
            x: 0.5,
            y: 0.5,
        };
        let picture = crate::media::text::ensure_text_picture(&e.dir, &spec, 640, 360).unwrap();
        let mut text = asset("text", &picture.to_string_lossy(), "image", None);
        text["text"] = serde_json::to_value(&spec).unwrap();
        let p = project(
            vec![asset("red", &red, "video", Some(4.0)), text],
            vec![
                track(
                    "v1",
                    "video",
                    0,
                    false,
                    false,
                    vec![clip("c1", "red", "v1", 0.0, 0.0, 3.0, 1.0)],
                ),
                track(
                    "v2",
                    "video",
                    1,
                    false,
                    false,
                    vec![clip("c2", "text", "v2", 1.0, 0.0, 1.0, 1.0)],
                ),
            ],
        );
        let out = e.dir.join("text.mp4");
        let (r, _) = e.export(&p, &opts(Quality::Draft), &out);
        r.unwrap();
        assert!(e.decodes_cleanly(&out));

        // while the text shows: the video is still there around it, and the letters are white on top
        let corner = e.region(&out, 1.5, "80:60:0:0");
        assert!(
            near(corner, (255, 0, 0), 60),
            "video beside the text: {corner:?}"
        );
        let middle = e.region(&out, 1.5, "400:90:120:135");
        assert!(
            middle.0 > 200 && middle.1 > 60 && middle.2 > 60,
            "white letters over red: {middle:?}"
        );
        // before and after the text clip: only the video
        for t in [0.5, 2.5] {
            let middle = e.region(&out, t, "400:90:120:135");
            assert!(near(middle, (255, 0, 0), 60), "no text at {t}: {middle:?}");
        }
    }

    /// A sticker (a picture with see-through pixels) is found to be one on import and keeps its transparency
    /// in the export: the video below shows around it, not the clip's background colour. A fully opaque RGBA
    /// picture stays an ordinary one.
    #[test]
    fn a_see_through_picture_is_laid_over_the_video_below_it() {
        let Some(e) = env("alpha") else { return };
        let red = e.red();
        // a blue square in the middle of an otherwise fully transparent 320x180 picture
        let sticker = e.make(
            "sticker.png",
            &[
                "-f",
                "lavfi",
                "-i",
                "color=c=black@0.0:s=320x180,format=rgba,drawbox=x=110:y=40:w=100:h=100:c=blue@1.0:t=fill:replace=1",
                "-frames:v",
                "1",
            ],
        );
        let opaque = e.make(
            "opaque.png",
            &[
                "-f",
                "lavfi",
                "-i",
                "color=c=blue:s=320x180",
                "-frames:v",
                "1",
                "-pix_fmt",
                "rgba",
            ],
        );
        assert!(e.backend.probe(Path::new(&sticker)).unwrap().alpha);
        assert!(!e.backend.probe(Path::new(&opaque)).unwrap().alpha);

        let mut picture = asset("sticker", &sticker, "image", None);
        picture["alpha"] = json!(true);
        let mut on_top = clip("c2", "sticker", "v2", 1.0, 0.0, 1.0, 1.0);
        // a fit choice with a background would hide the video; a see-through picture never has one
        on_top["fitMode"] = json!("fill");
        let p = project(
            vec![asset("red", &red, "video", Some(4.0)), picture],
            vec![
                track(
                    "v1",
                    "video",
                    0,
                    false,
                    false,
                    vec![clip("c1", "red", "v1", 0.0, 0.0, 3.0, 1.0)],
                ),
                track("v2", "video", 1, false, false, vec![on_top]),
            ],
        );
        let out = e.dir.join("alpha.mp4");
        let (r, _) = e.export(&p, &opts(Quality::Draft), &out);
        r.unwrap();
        assert!(e.decodes_cleanly(&out));
        // the 320x180 picture is fitted whole to the 640x360 canvas: the square is 200x200 in the middle
        let corner = e.region(&out, 1.5, "80:60:0:0");
        assert!(
            near(corner, (255, 0, 0), 60),
            "video around the sticker: {corner:?}"
        );
        let middle = e.region(&out, 1.5, "120:120:260:120");
        assert!(
            near(middle, (0, 0, 255), 60),
            "the sticker's square: {middle:?}"
        );
        let middle = e.region(&out, 2.5, "120:120:260:120");
        assert!(
            near(middle, (255, 0, 0), 60),
            "after the sticker clip: {middle:?}"
        );
    }

    /// Auto clips export: each clip is its own small 9:16 project holding one trimmed, canvas-filling clip.
    #[test]
    fn a_trimmed_clip_alone_exports_vertical_with_exactly_its_length() {
        let Some(e) = env("autoclip") else { return };
        let red = e.red();
        let vertical = ExportOptions {
            width: 360,
            height: 640,
            fps: 30.0,
            quality: Quality::Draft,
            format: ExportFormat::Mp4,
        };
        for (n, (sin, sout)) in [(0.5, 2.5), (1.0, 2.2)].into_iter().enumerate() {
            let mut c = clip("c", "red", "v1", 0.0, sin, sout, 1.0);
            c["fitMode"] = json!("fill");
            let mut p = project(
                vec![asset("red", &red, "video", Some(4.0))],
                vec![track("v1", "video", 0, false, false, vec![c])],
            );
            p.settings.width = 360;
            p.settings.height = 640;
            let out = e.dir.join(format!("clip{n}.mp4"));
            let r = e.export(&p, &vertical, &out).0.unwrap();
            // the report comes from FFprobe reading the finished file
            assert_eq!((r.width, r.height), (360, 640));
            assert!(
                (r.duration - (sout - sin)).abs() < 0.08,
                "clip {n}: {} s, wanted {}",
                r.duration,
                sout - sin
            );
            assert!(r.has_audio);
            assert!(e.decodes_cleanly(&out));
            // filled, not letterboxed: the top edge is the red picture
            assert!(near(e.region(&out, 0.5, "360:20:0:0"), (254, 0, 0), 40));
        }
    }

    #[test]
    fn exports_the_requested_size_and_letterboxes_with_the_background() {
        let Some(e) = env("size") else { return };
        let green = e.green_png(); // 2:1 still
        let p = still_project(&green, Some("fit"));
        let out = e.dir.join("sq.mp4");
        let o = ExportOptions {
            width: 360,
            height: 360,
            fps: 24.0,
            quality: Quality::Standard,
            format: ExportFormat::Mp4,
        };
        let r = e.export(&p, &o, &out).0.unwrap();
        assert_eq!((r.width, r.height), (360, 360));

        // 2:1 picture in a square: bars on top/bottom, picture in the middle
        assert!(near(e.color_at(&out, 0.5), (0, 128, 0), 40) || e.color_at(&out, 0.5).1 > 60);
        let probe_top = command(&e.ffmpeg)
            .args(["-v", "error", "-ss", "0.5", "-i"])
            .arg(&out)
            .args([
                "-frames:v",
                "1",
                "-vf",
                "crop=360:20:0:0,scale=1:1",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgb24",
                "-",
            ])
            .output()
            .unwrap();
        let top = (
            probe_top.stdout[0],
            probe_top.stdout[1],
            probe_top.stdout[2],
        );
        assert!(
            near(top, (32, 32, 32), 14),
            "letterbox bar is the background: {top:?}"
        );
    }

    fn still_project(path: &str, fit: Option<&str>) -> Project {
        let mut c = clip("c", "img", "v1", 0.0, 0.0, 1.0, 1.0);
        if let Some(f) = fit {
            c["fitMode"] = json!(f);
        }
        project(
            vec![asset("img", path, "image", None)],
            vec![track("v1", "video", 0, false, false, vec![c])],
        )
    }
    fn square() -> ExportOptions {
        ExportOptions {
            width: 360,
            height: 360,
            fps: 30.0,
            quality: Quality::Draft,
            format: ExportFormat::Mp4,
        }
    }
    fn is_red(c: (u8, u8, u8)) -> bool {
        c.0 > 170 && c.1 < 90 && c.2 < 90
    }
    fn is_blue(c: (u8, u8, u8)) -> bool {
        c.2 > 170 && c.0 < 90 && c.1 < 90
    }

    #[test]
    fn stills_honour_exif_orientation_in_probe_thumbnail_and_export() {
        use crate::media::import::import_one;
        let Some(e) = env("exif") else { return };
        let rotated = e.exif_rotated_jpg();

        // probe: displayed size, not stored size (stored is 200x100)
        let imported = import_one(&e.backend, Path::new(&rotated), &e.dir.join("thumbs")).unwrap();
        assert_eq!(
            (imported.info.width, imported.info.height),
            (Some(100), Some(200))
        );

        // thumbnail is upright too: portrait, red on top
        let thumb = PathBuf::from(imported.thumbnail_path.unwrap());
        let probe = command(&e.ffmpeg)
            .args(["-v", "error", "-i"])
            .arg(&thumb)
            .args([
                "-vf",
                "scale=1:2",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgb24",
                "-",
            ])
            .output()
            .unwrap();
        assert!(
            is_red((probe.stdout[0], probe.stdout[1], probe.stdout[2])),
            "thumbnail top should be red"
        );

        // export: 100x200 portrait fitted into 360x360 -> 180 px wide, centred; red above blue, bars left/right
        let out = e.dir.join("exif.mp4");
        e.export(&still_project(&rotated, Some("fit")), &square(), &out)
            .0
            .unwrap();
        assert!(
            is_red(e.region(&out, 0.5, "100:100:130:30")),
            "top of the picture is red: {:?}",
            e.region(&out, 0.5, "100:100:130:30")
        );
        assert!(
            is_blue(e.region(&out, 0.5, "100:100:130:230")),
            "bottom is blue"
        );
        assert!(
            near(e.region(&out, 0.5, "60:300:10:30"), (32, 32, 32), 14),
            "left bar is background"
        );
    }

    #[test]
    fn fit_fill_and_blur_place_a_still_differently() {
        let Some(e) = env("fit") else { return };
        let img = e.two_tone_jpg("wide.jpg"); // 2:1, red | blue, into a square canvas
        let render = |name: &str, fit: Option<&str>| {
            let out = e.dir.join(name);
            e.export(&still_project(&img, fit), &square(), &out)
                .0
                .unwrap_or_else(|err| panic!("{name}: {err}"));
            out
        };
        let top_left = "120:50:10:10"; // inside the top bar when the picture is fitted
        let mid_left = "100:100:30:130";
        let mid_right = "100:100:230:130";

        // fit (also the default): bars are the background colour, whole picture visible
        let out = render("fit.mp4", Some("fit"));
        assert!(
            near(e.region(&out, 0.5, top_left), (32, 32, 32), 14),
            "fit: top bar is background"
        );
        assert!(is_red(e.region(&out, 0.5, mid_left)) && is_blue(e.region(&out, 0.5, mid_right)));

        // fill: no bars at all, the canvas is covered edge to edge
        let fill = render("fill.mp4", None); // fill is the default
        assert!(
            is_red(e.region(&fill, 0.5, top_left)),
            "fill: top-left is picture: {:?}",
            e.region(&fill, 0.5, top_left)
        );
        assert!(
            is_blue(e.region(&fill, 0.5, "120:50:230:300")),
            "fill: bottom-right is picture"
        );

        // blur: bars are a blurred copy (reddish on the left), the sharp picture stays in the middle
        let blur = render("blur.mp4", Some("blur-bg"));
        let bar = e.region(&blur, 0.5, top_left);
        assert!(
            bar.0 > 120 && bar.1 < 90,
            "blur: top-left bar is blurred red, not background: {bar:?}"
        );
        assert!(!near(bar, (32, 32, 32), 40));
        assert!(is_red(e.region(&blur, 0.5, mid_left)) && is_blue(e.region(&blur, 0.5, mid_right)));
    }

    #[test]
    fn crop_keeps_only_the_chosen_part_of_the_picture() {
        let Some(e) = env("crop") else { return };
        let img = e.two_tone_jpg("wide.jpg"); // 2:1, red | blue
        let render = |name: &str, crop: crate::project::Crop| {
            let mut p = still_project(&img, Some("fit"));
            p.tracks[0].clips[0].crop = Some(crop);
            let out = e.dir.join(name);
            e.export(&p, &square(), &out)
                .0
                .unwrap_or_else(|err| panic!("{name}: {err}"));
            out
        };
        let (left, right, top) = ("100:100:30:130", "100:100:230:130", "120:50:10:10");

        // left half cut away: the blue half is square, so it fits the square canvas with no bars
        let blue = render(
            "blue.mp4",
            crate::project::Crop {
                left: 0.5,
                ..Default::default()
            },
        );
        for at in [left, right, top] {
            assert!(
                is_blue(e.region(&blue, 0.5, at)),
                "{at}: {:?}",
                e.region(&blue, 0.5, at)
            );
        }
        // right half cut away: all red
        let red = render(
            "red.mp4",
            crate::project::Crop {
                right: 0.5,
                ..Default::default()
            },
        );
        assert!(is_red(e.region(&red, 0.5, left)) && is_red(e.region(&red, 0.5, right)));
        // top and bottom cut: the picture gets flatter (4:1), so the bars grow and both colours remain
        let flat = render(
            "flat.mp4",
            crate::project::Crop {
                top: 0.25,
                bottom: 0.25,
                ..Default::default()
            },
        );
        assert!(
            is_red(e.region(&flat, 0.5, "60:40:60:160"))
                && is_blue(e.region(&flat, 0.5, "60:40:240:160"))
        );
        assert!(
            near(e.region(&flat, 0.5, "100:60:130:60"), (32, 32, 32), 14),
            "above the flatter picture is background: {:?}",
            e.region(&flat, 0.5, "100:60:130:60")
        );
    }

    #[test]
    fn keyframes_move_scale_turn_and_fade_a_clip_over_time() {
        use crate::project::{Key, Keyframes};
        let Some(e) = env("keyframes") else { return };
        let (red, blue) = (e.red(), e.blue());
        // red fills the 640x360 canvas for 2 s; blue lies over it and is animated
        let render = |name: &str, change: &dyn Fn(&mut crate::project::TimelineClip)| {
            let mut p = project(
                vec![
                    asset("red", &red, "video", Some(4.0)),
                    asset("blue", &blue, "video", Some(4.0)),
                ],
                vec![
                    track(
                        "v1",
                        "video",
                        0,
                        false,
                        false,
                        vec![clip("c1", "red", "v1", 0.0, 0.0, 2.0, 1.0)],
                    ),
                    track(
                        "v2",
                        "video",
                        1,
                        false,
                        false,
                        vec![clip("c2", "blue", "v2", 0.0, 0.0, 2.0, 1.0)],
                    ),
                ],
            );
            change(&mut p.tracks[1].clips[0]);
            let out = e.dir.join(name);
            e.export(&p, &opts(Quality::Draft), &out)
                .0
                .unwrap_or_else(|err| panic!("{name}: {err}"));
            out
        };
        let keys = |a: (f64, f64), b: (f64, f64)| {
            Some(vec![Key { t: a.0, v: a.1 }, Key { t: b.0, v: b.1 }])
        };
        let check = |file: &Path, t: f64, crop: &str, blue: bool| {
            let c = e.region(file, t, crop);
            assert!(
                if blue { is_blue(c) } else { is_red(c) },
                "{} at {t} s in {crop}: {c:?}",
                file.display()
            );
        };

        // grows from a quarter to three quarters: a spot left of the middle is reached late
        let grown = render("scale.mp4", &|c| {
            c.keyframes = Some(Keyframes {
                scale: keys((0.0, 0.25), (2.0, 0.75)),
                ..Default::default()
            })
        });
        check(&grown, 0.2, "40:30:180:165", false);
        check(&grown, 1.8, "40:30:180:165", true);
        check(&grown, 0.2, "40:30:300:165", true);

        // half size, sliding right; the clip starts at 1 s, so its keys are a second later on the timeline
        let moved = render("move.mp4", &|c| {
            (c.timeline_start, c.source_out, c.scale) = (1.0, 1.0, 0.5);
            c.keyframes = Some(Keyframes {
                x: keys((0.0, 0.0), (1.0, 0.5)),
                ..Default::default()
            })
        });
        check(&moved, 0.5, "80:60:280:150", false); // not there yet
        check(&moved, 1.1, "80:60:280:150", true);
        check(&moved, 1.1, "80:60:500:150", false);
        check(&moved, 1.9, "80:60:500:150", true);
        check(&moved, 1.9, "80:60:200:150", false);

        // fades away
        let faded = render("fade.mp4", &|c| {
            c.keyframes = Some(Keyframes {
                opacity: keys((0.0, 1.0), (2.0, 0.0)),
                ..Default::default()
            })
        });
        check(&faded, 0.1, "80:60:280:150", true);
        check(&faded, 1.9, "80:60:280:150", false);
        let half = e.region(&faded, 1.0, "80:60:280:150");
        assert!(half.0 > 70 && half.2 > 70, "half way both show: {half:?}");

        // half size, turning a quarter: the 320x180 box ends up standing, so it reaches above the middle
        let turned = render("turn.mp4", &|c| {
            c.scale = 0.5;
            c.keyframes = Some(Keyframes {
                rotation: keys((0.0, 0.0), (2.0, 90.0)),
                ..Default::default()
            })
        });
        check(&turned, 0.1, "40:30:300:40", false);
        check(&turned, 1.9, "40:30:300:40", true);
        check(&turned, 1.9, "40:30:120:165", false); // and no longer out to the side
        check(&turned, 0.1, "40:30:180:165", true);
    }

    #[test]
    fn a_transition_brings_a_clip_in_over_the_held_last_frame_of_the_one_before() {
        use crate::project::ClipTransition;
        let Some(e) = env("transitions") else { return };
        let (red, blue) = (e.red(), e.blue());
        // one track: red for a second, then blue for a second
        let render = |name: &str, kind: Option<&str>| {
            let mut p = project(
                vec![
                    asset("red", &red, "video", Some(4.0)),
                    asset("blue", &blue, "video", Some(4.0)),
                ],
                vec![track(
                    "v1",
                    "video",
                    0,
                    false,
                    false,
                    vec![
                        clip("c1", "red", "v1", 0.0, 0.0, 1.0, 1.0),
                        clip("c2", "blue", "v1", 1.0, 0.0, 1.0, 1.0),
                    ],
                )],
            );
            p.tracks[0].clips[1].transition_in = kind.map(|k| ClipTransition {
                kind: k.into(),
                duration: 0.8,
            });
            let out = e.dir.join(name);
            e.export(&p, &opts(Quality::Draft), &out)
                .0
                .unwrap_or_else(|err| panic!("{name}: {err}"));
            out
        };
        let (left, right) = ("80:60:60:150", "80:60:500:150");

        let cut = render("cut.mp4", None);
        assert!(is_red(e.region(&cut, 0.5, left)) && is_blue(e.region(&cut, 1.1, left)));

        // dissolve: just after the cut the red frame still shows, then both, then blue
        let dissolve = render("dissolve.mp4", Some("dissolve"));
        assert!(is_red(e.region(&dissolve, 0.5, left)));
        let early = e.region(&dissolve, 1.1, left);
        assert!(
            is_red(early),
            "red is held under the incoming clip: {early:?}"
        );
        let middle = e.region(&dissolve, 1.4, left);
        assert!(middle.0 > 60 && middle.2 > 60, "both show: {middle:?}");
        assert!(is_blue(e.region(&dissolve, 1.9, left)));

        // slide from the left: blue enters at the left edge and reaches the right side last
        let slide = render("slide.mp4", Some("slide-left"));
        assert!(
            is_red(e.region(&slide, 1.15, right)),
            "{:?}",
            e.region(&slide, 1.15, right)
        );
        assert!(
            is_blue(e.region(&slide, 1.5, left)),
            "{:?}",
            e.region(&slide, 1.5, left)
        );
        assert!(is_blue(e.region(&slide, 1.9, right)));

        // fade through black: the first clip fades out, the second fades in from black (no held frame)
        let through = {
            let mut p = project(
                vec![
                    asset("red", &red, "video", Some(4.0)),
                    asset("blue", &blue, "video", Some(4.0)),
                ],
                vec![track(
                    "v1",
                    "video",
                    0,
                    false,
                    false,
                    vec![
                        clip("c1", "red", "v1", 0.0, 0.0, 1.0, 1.0),
                        clip("c2", "blue", "v1", 1.0, 0.0, 1.0, 1.0),
                    ],
                )],
            );
            p.tracks[0].clips[0].transition_out = Some(ClipTransition {
                kind: "dissolve".into(),
                duration: 0.5,
            });
            p.tracks[0].clips[1].transition_in = Some(ClipTransition {
                kind: "fade-black".into(),
                duration: 0.5,
            });
            let out = e.dir.join("through.mp4");
            e.export(&p, &opts(Quality::Draft), &out)
                .0
                .unwrap_or_else(|err| panic!("through: {err}"));
            out
        };
        let dark = |c: (u8, u8, u8)| c.0 < 60 && c.1 < 60 && c.2 < 60;
        assert!(
            is_red(e.region(&through, 0.3, left)),
            "{:?}",
            e.region(&through, 0.3, left)
        );
        let at_cut = e.region(&through, 1.03, left);
        assert!(dark(at_cut), "black at the cut: {at_cut:?}");
        let before_cut = e.region(&through, 0.9, left);
        assert!(
            before_cut.0 < 140 && before_cut.2 < 60,
            "red on its way out: {before_cut:?}"
        );
        let late = (
            e.region(&through, 1.3, left),
            e.region(&through, 1.6, left),
            e.region(&through, 1.8, left),
        );
        assert!(is_blue(late.2), "blue at the end: {late:?}");
        // the sound follows: silent at the cut, there before and after (both sources have a tone)
        assert!(e.volume(&through, 0.2, 0.2) > -40.0);
        assert!(e.volume(&through, 0.97, 0.06) < e.volume(&through, 0.2, 0.2) - 12.0);

        // every kind renders
        for kind in crate::export::transitions::kinds() {
            let out = render(&format!("{}.mp4", kind.id), Some(&kind.id));
            assert!(
                is_blue(e.region(&out, 1.9, left)),
                "{} ends on the clip",
                kind.id
            );
        }
    }

    #[test]
    fn transformed_clips_show_the_track_below_around_them() {
        let Some(e) = env("transform") else { return };
        let (red, blue) = (e.red(), e.blue());
        let render = |name: &str, change: &dyn Fn(&mut crate::project::TimelineClip)| {
            let mut p = project(
                vec![
                    asset("red", &red, "video", Some(4.0)),
                    asset("blue", &blue, "video", Some(4.0)),
                ],
                vec![
                    track(
                        "v1",
                        "video",
                        0,
                        false,
                        false,
                        vec![clip("c1", "red", "v1", 0.0, 0.0, 2.0, 1.0)],
                    ),
                    track(
                        "v2",
                        "video",
                        1,
                        false,
                        false,
                        vec![clip("c2", "blue", "v2", 0.0, 0.0, 2.0, 1.0)],
                    ),
                ],
            );
            change(&mut p.tracks[1].clips[0]);
            let out = e.dir.join(name);
            e.export(&p, &opts(Quality::Draft), &out)
                .0
                .unwrap_or_else(|err| panic!("{name}: {err}"));
            out
        };
        let (centre, corner) = ("80:60:280:150", "80:60:10:10");

        // untouched: the top clip covers everything
        let plain = render("plain.mp4", &|_| {});
        assert!(is_blue(e.region(&plain, 1.0, corner)));

        // half size: blue in the middle (320x180), the red clip around it
        let small = render("small.mp4", &|c| c.scale = 0.5);
        assert!(
            is_blue(e.region(&small, 1.0, centre)),
            "{:?}",
            e.region(&small, 1.0, centre)
        );
        assert!(
            is_red(e.region(&small, 1.0, corner)),
            "{:?}",
            e.region(&small, 1.0, corner)
        );

        // moved a quarter of the canvas right and down: its box is now 320..640 x 180..360
        let moved = render("moved.mp4", &|c| (c.scale, c.x, c.y) = (0.5, 0.25, 0.25));
        assert!(is_blue(e.region(&moved, 1.0, "80:60:500:260")));
        assert!(
            is_red(e.region(&moved, 1.0, "80:60:180:100")),
            "where it used to be"
        );

        // turned 90 degrees: the 320x180 box becomes 180x320, so it reaches above the old box and no longer
        // reaches its old left end
        let turned = render("turned.mp4", &|c| (c.scale, c.rotation) = (0.5, Some(90.0)));
        assert!(
            is_blue(e.region(&turned, 1.0, "40:30:300:40")),
            "{:?}",
            e.region(&turned, 1.0, "40:30:300:40")
        );
        assert!(
            is_red(e.region(&turned, 1.0, "40:60:170:150")),
            "{:?}",
            e.region(&turned, 1.0, "40:60:170:150")
        );

        // half see-through: a mix of both clips everywhere
        let faded = render("faded.mp4", &|c| c.opacity = 0.5);
        let mix = e.region(&faded, 1.0, centre);
        assert!(
            mix.0 > 70 && mix.2 > 70 && mix.1 < 60,
            "red and blue mixed: {mix:?}"
        );
        assert!(e.decodes_cleanly(&faded));
    }

    #[test]
    fn mirroring_swaps_the_sides_of_the_picture() {
        let Some(e) = env("flip") else { return };
        let img = e.two_tone_jpg("wide.jpg"); // 2:1, red | blue
        let render = |name: &str, h: bool, v: bool| {
            let mut p = still_project(&img, Some("fit"));
            (p.tracks[0].clips[0].flip_h, p.tracks[0].clips[0].flip_v) = (Some(h), Some(v));
            let out = e.dir.join(name);
            e.export(&p, &square(), &out)
                .0
                .unwrap_or_else(|err| panic!("{name}: {err}"));
            out
        };
        let (left, right) = ("100:100:30:130", "100:100:230:130");
        let mirrored = render("h.mp4", true, false);
        assert!(is_blue(e.region(&mirrored, 0.5, left)) && is_red(e.region(&mirrored, 0.5, right)));
        // top-bottom only: the sides stay where they were
        let upside = render("v.mp4", false, true);
        assert!(is_red(e.region(&upside, 0.5, left)) && is_blue(e.region(&upside, 0.5, right)));
    }

    #[test]
    fn a_ducking_clip_is_turned_down_only_while_another_clip_sounds() {
        let Some(e) = env("duck") else { return };
        let (red, tone) = (e.red(), e.tone());
        // music (440 Hz) for 3 s; the video's own sound (1000 Hz) comes in at 1.5 s
        let render = |name: &str, duck: Option<f64>| {
            let mut p = project(
                vec![
                    asset("red", &red, "video", Some(4.0)),
                    asset("tone", &tone, "audio", Some(3.0)),
                ],
                vec![
                    track(
                        "v1",
                        "video",
                        0,
                        false,
                        false,
                        vec![clip("c1", "red", "v1", 1.5, 0.0, 1.5, 1.0)],
                    ),
                    track(
                        "a1",
                        "audio",
                        1,
                        false,
                        false,
                        vec![clip("c2", "tone", "a1", 0.0, 0.0, 3.0, 1.0)],
                    ),
                ],
            );
            p.tracks[1].clips[0].duck = duck;
            let out = e.dir.join(name);
            e.export(&p, &opts(Quality::Draft), &out)
                .0
                .unwrap_or_else(|err| panic!("{name}: {err}"));
            out
        };
        let plain = render("plain.mp4", None);
        let (alone, under) = (
            band_volume(&e, &plain, 0.3, 0.9, 440),
            band_volume(&e, &plain, 2.0, 0.8, 440),
        );
        assert!(
            (alone - under).abs() < 2.0,
            "no ducking: {alone} vs {under}"
        );

        let ducked = render("ducked.mp4", Some(1.0));
        let (alone, under) = (
            band_volume(&e, &ducked, 0.3, 0.9, 440),
            band_volume(&e, &ducked, 2.0, 0.8, 440),
        );
        assert!(
            under < alone - 6.0,
            "ducked under the voice: {alone} vs {under}"
        );
        // the other clip keeps its level, and the music runs to its end
        let voice = (
            band_volume(&e, &plain, 2.0, 0.8, 1000),
            band_volume(&e, &ducked, 2.0, 0.8, 1000),
        );
        assert!((voice.0 - voice.1).abs() < 1.5, "{voice:?}");
        assert!(band_volume(&e, &ducked, 2.6, 0.3, 440) > -70.0);
    }

    #[test]
    fn fades_ramp_the_sound_and_a_muted_clip_is_silent() {
        let Some(e) = env("fades") else { return };
        let (red, tone) = (e.red(), e.tone());
        let render = |name: &str, change: &dyn Fn(&mut Project)| {
            let mut p = project(
                vec![
                    asset("red", &red, "video", Some(4.0)),
                    asset("tone", &tone, "audio", Some(3.0)),
                ],
                vec![
                    track(
                        "v1",
                        "video",
                        0,
                        false,
                        false,
                        vec![clip("c1", "red", "v1", 0.0, 0.0, 3.0, 1.0)],
                    ),
                    track(
                        "a1",
                        "audio",
                        1,
                        false,
                        false,
                        vec![clip("c2", "tone", "a1", 0.0, 0.0, 3.0, 1.0)],
                    ),
                ],
            );
            // the video has a tone of its own: muted here, so only the audio clip is heard
            p.tracks[0].clips[0].muted = Some(true);
            change(&mut p);
            let out = e.dir.join(name);
            e.export(&p, &opts(Quality::Draft), &out)
                .0
                .unwrap_or_else(|err| panic!("{name}: {err}"));
            out
        };
        let plain = render("plain.mp4", &|_| {});
        let level = e.volume(&plain, 1.2, 0.6);
        assert!(level > -40.0, "the tone is there: {level}");

        // 1 s in, 1 s out on a 3 s clip: quiet at both ends, full in the middle
        let faded = render("faded.mp4", &|p| {
            let c = &mut p.tracks[1].clips[0];
            (c.fade_in, c.fade_out) = (Some(1.0), Some(1.0));
        });
        // measured on decoded samples (a seek before decoding is not exact enough for a 0.2 s window)
        let between = |from: f64, to: f64| {
            let out = command(&e.ffmpeg)
                .args(["-hide_banner", "-i"])
                .arg(&faded)
                .args(["-vn", "-af"])
                .arg(format!("atrim={from}:{to},volumedetect"))
                .args(["-f", "null", "-"])
                .output()
                .unwrap();
            let text = String::from_utf8_lossy(&out.stderr).into_owned();
            text.lines()
                .find_map(|l| l.split("mean_volume:").nth(1))
                .and_then(|v| v.trim().trim_end_matches("dB").trim().parse::<f64>().ok())
                .unwrap_or_else(|| panic!("no mean_volume in:\n{text}"))
        };
        let (start, middle, end) = (between(0.0, 0.2), between(1.2, 1.8), between(2.75, 2.95));
        assert!(
            (middle - level).abs() < 1.5,
            "full level in the middle: {middle} vs {level}"
        );
        assert!(start < middle - 12.0, "fading in: {start} vs {middle}");
        assert!(end < middle - 12.0, "fading out: {end} vs {middle}");

        let muted = render("muted.mp4", &|p| p.tracks[1].clips[0].muted = Some(true));
        assert!(e.volume(&muted, 1.2, 0.6) < -80.0, "a muted clip is silent");
        assert!(
            near(e.color_at(&muted, 1.0), (255, 0, 0), 60),
            "the picture is untouched"
        );
    }

    #[test]
    fn colour_adjustments_reach_the_exported_picture() {
        let Some(e) = env("colour") else { return };
        let red = e.red();
        let render = |name: &str, color: crate::media::color::ColorAdjust| {
            let mut p = project(
                vec![asset("red", &red, "video", Some(4.0))],
                vec![track(
                    "v1",
                    "video",
                    0,
                    false,
                    false,
                    vec![clip("c1", "red", "v1", 0.0, 0.0, 1.0, 1.0)],
                )],
            );
            p.tracks[0].clips[0].color = Some(color);
            let out = e.dir.join(name);
            e.export(&p, &opts(Quality::Draft), &out)
                .0
                .unwrap_or_else(|err| panic!("{name}: {err}"));
            e.color_at(&out, 0.5)
        };
        let neutral = crate::media::color::ColorAdjust::default();
        let plain = render("plain.mp4", neutral);
        assert!(
            near(plain, (255, 0, 0), 60),
            "nothing set: still red, {plain:?}"
        );

        // no saturation: the red becomes its own grey
        let grey = render(
            "grey.mp4",
            crate::media::color::ColorAdjust {
                saturation: -1.0,
                ..neutral
            },
        );
        let spread = grey.0.max(grey.1).max(grey.2) - grey.0.min(grey.1).min(grey.2);
        assert!(spread < 14, "grey has no colour left: {grey:?}");
        // 21 % of full scale: 0.2126 * 255 = 54
        assert!((40..70).contains(&grey.0), "the grey of pure red: {grey:?}");

        // two stops darker: clearly darker, still red
        let dark = render(
            "dark.mp4",
            crate::media::color::ColorAdjust {
                exposure: -1.0,
                ..neutral
            },
        );
        assert!(
            dark.0 < plain.0.saturating_sub(60) && dark.0 > dark.1 + 40,
            "{dark:?} vs {plain:?}"
        );
    }

    #[test]
    fn an_imported_lut_reaches_the_exported_picture_on_top_of_adjust() {
        use crate::media::cube::{store_cube, tests::cube_of};
        use crate::project::ClipLut;
        let Some(e) = env("user-lut") else { return };
        let red = e.red();
        // a table that swaps red and blue: easy to tell apart from anything Adjust can do
        let swap = store_cube(&e.dir.join("luts"), &cube_of(17, |c| [c[2], c[1], c[0]])).unwrap();
        let render = |name: &str, intensity: f64, id: &str, saturation: f64| {
            let mut p = project(
                vec![asset("red", &red, "video", Some(4.0))],
                vec![track(
                    "v1",
                    "video",
                    0,
                    false,
                    false,
                    vec![clip("c1", "red", "v1", 0.0, 0.0, 1.0, 1.0)],
                )],
            );
            p.tracks[0].clips[0].lut = Some(ClipLut {
                id: id.into(),
                name: "Swap".into(),
                intensity,
            });
            if saturation != 0.0 {
                p.tracks[0].clips[0].color = Some(crate::media::color::ColorAdjust {
                    saturation,
                    ..Default::default()
                });
            }
            let out = e.dir.join(name);
            e.export(&p, &opts(Quality::Draft), &out)
                .0
                .map(|_| e.color_at(&out, 0.5))
        };
        let full = render("full.mp4", 1.0, &swap.id, 0.0).unwrap();
        assert!(near(full, (0, 0, 255), 60), "red became blue: {full:?}");
        let half = render("half.mp4", 0.5, &swap.id, 0.0).unwrap();
        assert!(
            (90..170).contains(&half.0) && (90..170).contains(&half.2) && half.1 < 60,
            "half way between red and blue: {half:?}"
        );
        let none = render("none.mp4", 0.0, &swap.id, 0.0).unwrap();
        assert!(
            near(none, (255, 0, 0), 60),
            "intensity 0 changes nothing: {none:?}"
        );
        // Adjust runs first: grey in, and swapping the channels of grey leaves grey
        let grey = render("grey.mp4", 1.0, &swap.id, -1.0).unwrap();
        let spread = grey.0.max(grey.1).max(grey.2) - grey.0.min(grey.1).min(grey.2);
        assert!(spread < 14 && (40..70).contains(&grey.0), "{grey:?}");

        // a LUT that is not on this computer stops the export and is named; nothing is written
        let missing = render("missing.mp4", 1.0, "0123456789abcdef01234567", 0.0)
            .unwrap_err()
            .to_string();
        assert!(
            missing.contains("\"Swap\"") && missing.contains("Import it again"),
            "{missing}"
        );
        assert!(!e.dir.join("missing.mp4").exists());
    }

    #[test]
    fn exports_audio_only_as_m4a_and_wav() {
        let Some(e) = env("audio") else { return };
        let (red, tone, green) = (e.red(), e.tone(), e.green_png());
        let p = project(
            vec![
                asset("red", &red, "video", Some(4.0)),
                asset("tone", &tone, "audio", Some(3.0)),
                asset("green", &green, "image", None),
            ],
            vec![
                track(
                    "v1",
                    "video",
                    0,
                    false,
                    false,
                    vec![
                        clip("c1", "red", "v1", 0.0, 0.0, 2.0, 1.0),
                        clip("c2", "green", "v1", 2.0, 0.0, 2.0, 1.0), // silent still: 2..4 s
                    ],
                ),
                track(
                    "a1",
                    "audio",
                    1,
                    false,
                    false,
                    vec![clip("c3", "tone", "a1", 4.0, 0.0, 2.0, 1.0)],
                ),
            ],
        );
        let has_video = |f: &Path| {
            let o = command(&e.ffmpeg)
                .args(["-hide_banner", "-i"])
                .arg(f)
                .output()
                .unwrap();
            String::from_utf8_lossy(&o.stderr).contains("Video:")
        };

        for (format, name, encoder) in [
            (ExportFormat::M4a, "mix.m4a", "aac"),
            (ExportFormat::Mp3, "mix.mp3", "libmp3lame"),
            (ExportFormat::Wav, "mix.wav", "pcm_s16le"),
        ] {
            let out = e.dir.join(name);
            let o = ExportOptions {
                format,
                ..opts(Quality::Standard)
            };
            let (r, progress) = e.export(&p, &o, &out);
            let r = r.unwrap_or_else(|err| panic!("{name}: {err}"));

            assert_eq!(r.encoder, encoder);
            assert!(
                r.has_audio && (r.duration - 6.0).abs() < 0.2,
                "{name}: duration {}",
                r.duration
            );
            assert!(!has_video(&out), "{name} must not contain a video stream");
            assert!(e.decodes_cleanly(&out));
            assert_eq!(progress.last(), Some(&1.0));
            assert!(!temp_path(&out, format).exists());

            // the same mix as the video export: clip audio, silence under the still, then the wav
            assert!(
                e.volume(&out, 0.2, 1.6) > -40.0,
                "{name}: sound of the video clip"
            );
            assert!(
                e.volume(&out, 2.3, 1.4) < -80.0,
                "{name}: silence under the still"
            );
            assert!(e.volume(&out, 4.2, 1.6) > -40.0, "{name}: the audio clip");
        }

        // nothing audible: refuse with a clear reason instead of writing a silent file
        let silent = project(
            vec![asset("green", &green, "image", None)],
            vec![track(
                "v1",
                "video",
                0,
                false,
                false,
                vec![clip("c", "green", "v1", 0.0, 0.0, 2.0, 1.0)],
            )],
        );
        let o = ExportOptions {
            format: ExportFormat::M4a,
            ..opts(Quality::Draft)
        };
        let err = e
            .export(&silent, &o, &e.dir.join("none.m4a"))
            .0
            .unwrap_err()
            .to_string();
        assert!(err.contains("no sound to export"), "{err}");
        assert!(!e.dir.join("none.m4a").exists());
    }

    #[test]
    fn audio_args_carry_no_video_mapping() {
        let plan = ExportPlan {
            width: 640,
            height: 360,
            fps: 30.0,
            quality: Quality::Standard,
            format: ExportFormat::Wav,
            duration: 2.0,
            background: "#000000".into(),
            clips: vec![],
            warnings: vec![],
        };
        let plan_mp3 = plan.clone();
        let wav = build_args(&plan, None, Path::new("/o/.x.cutvii-part.wav")).join(" ");
        assert!(wav.contains("-map [aout] -vn -c:a pcm_s16le") && wav.contains("-f wav"));
        assert!(!wav.contains("[vout]") && !wav.contains("libx264"), "{wav}");
        let m4a = build_args(
            &ExportPlan {
                format: ExportFormat::M4a,
                ..plan
            },
            None,
            Path::new("/o/x.m4a"),
        )
        .join(" ");
        assert!(
            m4a.contains("-c:a aac -b:a 192k")
                && m4a.contains("-f ipod")
                && !m4a.contains("[vout]")
        );
        let mp3 = build_args(
            &ExportPlan {
                format: ExportFormat::Mp3,
                ..plan_mp3
            },
            None,
            Path::new("/o/x.mp3"),
        )
        .join(" ");
        assert!(
            mp3.contains("-map [aout] -vn -c:a libmp3lame -b:a 192k") && mp3.contains("-f mp3"),
            "{mp3}"
        );
        assert!(!mp3.contains("[vout]") && !mp3.contains("ipod"));
        assert_eq!(
            temp_path(Path::new("/o/song.mp3"), ExportFormat::Mp3),
            PathBuf::from("/o/.song.cutvii-part.mp3")
        );
        assert_eq!(
            temp_path(Path::new("/o/song.m4a"), ExportFormat::M4a),
            PathBuf::from("/o/.song.cutvii-part.m4a")
        );
    }

    /// Loudest frequency band of the audio in [from, from+len): which of two bands holds more energy.
    fn band_volume(e: &Env, file: &Path, from: f64, len: f64, centre: u32) -> f64 {
        let out = command(&e.ffmpeg)
            .args([
                "-hide_banner",
                "-ss",
                &format!("{from}"),
                "-t",
                &format!("{len}"),
                "-i",
            ])
            .arg(file)
            .args([
                "-vn",
                "-af",
                &format!("bandpass=f={centre}:width_type=h:w=120,volumedetect"),
                "-f",
                "null",
                "-",
            ])
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&out.stderr).into_owned();
        text.lines()
            .find_map(|l| l.split("mean_volume:").nth(1))
            .and_then(|v| v.trim().trim_end_matches("dB").trim().parse::<f64>().ok())
            .unwrap_or(-120.0)
    }

    #[test]
    fn speed_changes_exported_duration_pitch_and_mutes_above_4x() {
        let Some(e) = env("speed") else { return };
        let red = e.red(); // 4 s, 1 kHz tone
        let render = |name: &str, speed: f64, keep_pitch: bool| {
            let mut c = clip("c", "red", "v1", 0.0, 0.0, 4.0, 1.0);
            c["speed"] = json!(speed);
            c["keepPitch"] = json!(keep_pitch);
            let p = project(
                vec![asset("red", &red, "video", Some(4.0))],
                vec![track("v1", "video", 0, false, false, vec![c])],
            );
            let out = e.dir.join(name);
            let r = e
                .export(&p, &opts(Quality::Draft), &out)
                .0
                .unwrap_or_else(|err| panic!("{name}: {err}"));
            (out, r)
        };

        // 2x: half as long (checked by ffprobe inside verify, and here), picture intact, pitch kept
        let (fast, r) = render("fast.mp4", 2.0, true);
        assert!(
            (r.duration - 2.0).abs() < 0.15,
            "2x of 4 s should be 2 s, got {}",
            r.duration
        );
        assert!(r.warnings.is_empty());
        assert!(e.decodes_cleanly(&fast));
        assert!(is_red(e.region(&fast, 1.0, "100:100:270:130")));
        assert!(
            band_volume(&e, &fast, 0.3, 1.4, 1000) > band_volume(&e, &fast, 0.3, 1.4, 2000) + 10.0,
            "pitch kept at 1 kHz"
        );

        // 2x without keep-pitch: the tone moves up an octave
        let (chip, _) = render("chipmunk.mp4", 2.0, false);
        assert!(
            band_volume(&e, &chip, 0.3, 1.4, 2000) > band_volume(&e, &chip, 0.3, 1.4, 1000) + 10.0,
            "pitch doubled to 2 kHz"
        );

        // 0.5x: twice as long, pitch kept (needs no chain); 0.25x needs the atempo chain
        let (slow, r) = render("slow.mp4", 0.5, true);
        assert!(
            (r.duration - 8.0).abs() < 0.2,
            "0.5x of 4 s should be 8 s, got {}",
            r.duration
        );
        assert!(
            band_volume(&e, &slow, 1.0, 5.0, 1000) > band_volume(&e, &slow, 1.0, 5.0, 500) + 10.0
        );
        let (slower, r) = render("slower.mp4", 0.25, true);
        assert!(
            (r.duration - 16.0).abs() < 0.3,
            "0.25x of 4 s should be 16 s, got {}",
            r.duration
        );
        assert!(
            e.volume(&slower, 2.0, 10.0) > -40.0,
            "chained atempo still produces sound"
        );

        // 8x: 0.5 s long, silent, and the report says why
        let (hyper, r) = render("hyper.mp4", 8.0, true);
        assert!(
            (r.duration - 0.5).abs() < 0.15,
            "8x of 4 s should be 0.5 s, got {}",
            r.duration
        );
        assert!(e.volume(&hyper, 0.0, 0.5) < -80.0, "muted above 4x");
        assert!(
            r.warnings.len() == 1 && r.warnings[0].contains("muted above 4"),
            "{:?}",
            r.warnings
        );
    }

    /// 4 s clip: red with a 500 Hz tone for 2 s, then blue with a 1500 Hz tone for 2 s.
    fn red_then_blue(e: &Env) -> String {
        e.make(
            "redblue.mp4",
            &[
                "-f",
                "lavfi",
                "-i",
                "color=c=red:s=320x180:r=30:d=2",
                "-f",
                "lavfi",
                "-i",
                "color=c=blue:s=320x180:r=30:d=2",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=500:duration=2",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=1500:duration=2",
                "-filter_complex",
                "[0:v][1:v]concat=n=2:v=1:a=0[v];[2:a][3:a]concat=n=2:v=0:a=1[a]",
                "-map",
                "[v]",
                "-map",
                "[a]",
                "-pix_fmt",
                "yuv420p",
            ],
        )
    }
    fn frame_count(e: &Env, file: &Path) -> u32 {
        let ffprobe =
            crate::media::tools::locate_tool("ffprobe", crate::media::tools::FFPROBE_ENV).unwrap();
        let out = command(&ffprobe)
            .args([
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-count_frames",
                "-show_entries",
                "stream=nb_read_frames",
                "-of",
                "csv=p=0",
            ])
            .arg(file)
            .output()
            .unwrap();
        let _ = e;
        String::from_utf8_lossy(&out.stdout)
            .trim()
            .parse()
            .unwrap_or(0)
    }

    #[test]
    fn chunked_reverse_plays_backwards_with_every_frame_and_sound() {
        use crate::media::reverse::{ReverseProfile, reverse_range};
        let Some(e) = env("reverse") else { return };
        let src = red_then_blue(&e);
        let shape = e.backend.shape(Path::new(&src)).unwrap();
        assert!(shape.has_video && shape.has_audio && (shape.fps - 30.0).abs() < 0.01);

        // force small chunks (0.7 s -> 6 pieces) so the chunk joins are really exercised
        let out = e.dir.join("rev.mkv");
        let mut seen = Vec::new();
        reverse_range(
            &e.ffmpeg,
            Path::new(&src),
            &shape,
            0.0,
            4.0,
            &out,
            ReverseProfile::Lossless,
            Some(0.7),
            &mut |f| seen.push(f),
            &AtomicBool::new(false),
        )
        .unwrap();

        assert_eq!(
            frame_count(&e, &out),
            frame_count(&e, Path::new(&src)),
            "no frame lost or doubled at chunk joins"
        );
        assert!(
            is_blue(e.region(&out, 0.5, "100:100:110:40")),
            "starts with what was the end"
        );
        assert!(
            is_red(e.region(&out, 3.5, "100:100:110:40")),
            "ends with what was the start"
        );
        assert!(
            band_volume(&e, &out, 0.3, 1.4, 1500) > band_volume(&e, &out, 0.3, 1.4, 500) + 10.0,
            "sound is reversed too"
        );
        assert!(
            band_volume(&e, &out, 2.3, 1.4, 500) > band_volume(&e, &out, 2.3, 1.4, 1500) + 10.0
        );
        assert!(seen.windows(2).all(|w| w[0] <= w[1]) && seen.last() == Some(&1.0));
        // no chunk folder or partial file is left behind
        let leftovers: Vec<_> = fs::read_dir(&e.dir)
            .unwrap()
            .filter_map(|d| d.ok())
            .map(|d| d.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains("chunks") || n.contains("part"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");

        // a sub-range reverses only that range: 1..3 s is red then blue, so reversed is blue then red, 2 s long
        let part = e.dir.join("part.mkv");
        reverse_range(
            &e.ffmpeg,
            Path::new(&src),
            &shape,
            1.0,
            3.0,
            &part,
            ReverseProfile::Lossless,
            Some(0.7),
            &mut |_| {},
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(frame_count(&e, &part), 60);
        assert!(
            is_blue(e.region(&part, 0.3, "100:100:110:40"))
                && is_red(e.region(&part, 1.7, "100:100:110:40"))
        );

        // cancel stops between chunks and cleans up
        let cancelled = e.dir.join("never.mkv");
        let flag = AtomicBool::new(false);
        let r = reverse_range(
            &e.ffmpeg,
            Path::new(&src),
            &shape,
            0.0,
            4.0,
            &cancelled,
            ReverseProfile::Lossless,
            Some(0.5),
            &mut |_| flag.store(true, Ordering::Relaxed),
            &flag,
        );
        assert!(matches!(r, Err(AppError::Cancelled)));
        assert!(!cancelled.exists());
    }

    #[test]
    fn reverse_preview_is_a_small_playable_file() {
        let Some(e) = env("revpreview") else { return };
        let src = red_then_blue(&e);
        let out = e.dir.join("preview.mp4");
        e.backend
            .reverse_preview(
                Path::new(&src),
                0.0,
                4.0,
                &out,
                &mut |_| {},
                &AtomicBool::new(false),
            )
            .unwrap();
        assert!(e.decodes_cleanly(&out));
        assert!(
            is_blue(e.region(&out, 0.5, "100:100:110:40"))
                && is_red(e.region(&out, 3.5, "100:100:110:40"))
        );
        assert_eq!(frame_count(&e, &out), 120);
    }

    #[test]
    fn exports_reversed_clips_alone_and_combined_with_speed() {
        let Some(e) = env("revexport") else { return };
        let src = red_then_blue(&e);
        let render = |name: &str, speed: f64| {
            let mut c = clip("c", "rb", "v1", 0.0, 0.0, 4.0, 1.0);
            c["reversed"] = json!(true);
            c["speed"] = json!(speed);
            let p = project(
                vec![asset("rb", &src, "video", Some(4.0))],
                vec![track("v1", "video", 0, false, false, vec![c])],
            );
            let out = e.dir.join(name);
            let (r, progress) = e.export(&p, &opts(Quality::Draft), &out);
            (
                out,
                r.unwrap_or_else(|err| panic!("{name}: {err}")),
                progress,
            )
        };

        let (out, r, progress) = render("reversed.mp4", 1.0);
        assert!((r.duration - 4.0).abs() < 0.15, "duration {}", r.duration);
        assert!(
            is_blue(e.region(&out, 0.5, "200:120:220:120")),
            "reversed export starts blue"
        );
        assert!(
            is_red(e.region(&out, 3.5, "200:120:220:120")),
            "and ends red"
        );
        assert!(
            band_volume(&e, &out, 0.3, 1.4, 1500) > band_volume(&e, &out, 0.3, 1.4, 500) + 10.0
        );
        assert!(
            progress.windows(2).all(|w| w[0] <= w[1]) && progress.last() == Some(&1.0),
            "{progress:?}"
        );
        assert!(
            !e.dir.join(".reversed.cutvii-reverse").exists(),
            "temporary reversed copies are removed"
        );
        assert!(e.decodes_cleanly(&out));

        // reversed and 2x: 2 s long, still blue first
        let (fast, r, _) = render("reversed2x.mp4", 2.0);
        assert!((r.duration - 2.0).abs() < 0.15, "duration {}", r.duration);
        assert!(
            is_blue(e.region(&fast, 0.3, "200:120:220:120"))
                && is_red(e.region(&fast, 1.7, "200:120:220:120"))
        );
    }

    #[test]
    fn freeze_frame_is_the_exact_frame_at_full_resolution() {
        let Some(e) = env("freeze") else { return };
        let src = red_then_blue(&e); // 320x180
        let before = e.dir.join("before.png");
        let after = e.dir.join("after.png");
        e.backend
            .extract_frame(Path::new(&src), 1.9, &before)
            .unwrap();
        e.backend
            .extract_frame(Path::new(&src), 2.05, &after)
            .unwrap();

        let info = e.backend.probe(&before).unwrap();
        assert_eq!(
            (info.width, info.height),
            (Some(320), Some(180)),
            "full source resolution, not a thumbnail"
        );
        assert!(
            is_red(e.region(&before, 0.0, "100:100:110:40")),
            "1.9 s is still red"
        );
        assert!(
            is_blue(e.region(&after, 0.0, "100:100:110:40")),
            "2.05 s is already blue: the cut is frame-accurate"
        );
        assert!(
            e.backend
                .extract_frame(Path::new(&src), 99.0, &e.dir.join("none.png"))
                .is_err()
        );
        assert!(!e.dir.join("none.png").exists() && !e.dir.join("none.part.png").exists());
    }

    #[test]
    fn video_fills_fits_or_blurs_into_a_canvas_of_another_shape() {
        let Some(e) = env("videofit") else { return };
        // 16:9 landscape video, left half red and right half blue, into a 9:16 portrait canvas
        let wide = e.make(
            "wide.mp4",
            &[
                "-f",
                "lavfi",
                "-i",
                "color=c=red:s=160x180:r=30:d=2",
                "-f",
                "lavfi",
                "-i",
                "color=c=blue:s=160x180:r=30:d=2",
                "-filter_complex",
                "hstack",
                "-pix_fmt",
                "yuv420p",
            ],
        );
        let portrait = ExportOptions {
            width: 360,
            height: 640,
            fps: 30.0,
            quality: Quality::Draft,
            format: ExportFormat::Mp4,
        };
        let render = |name: &str, mode: Option<&str>| {
            let mut c = clip("c", "w", "v1", 0.0, 0.0, 2.0, 1.0);
            if let Some(m) = mode {
                c["fitMode"] = json!(m);
            }
            let p = project(
                vec![asset("w", &wide, "video", Some(2.0))],
                vec![track("v1", "video", 0, false, false, vec![c])],
            );
            let out = e.dir.join(name);
            let r = e
                .export(&p, &portrait, &out)
                .0
                .unwrap_or_else(|err| panic!("{name}: {err}"));
            assert_eq!((r.width, r.height), (360, 640));
            out
        };
        let top = "200:60:80:20"; // far above the middle band a fitted 16:9 picture occupies (202 px tall)
        let mid_left = "60:100:40:270";
        let mid_right = "60:100:260:270";

        // default = fill: the canvas is covered top to bottom, the sides are cropped away equally
        let fill = render("fill.mp4", None);
        let t = e.region(&fill, 1.0, "100:60:20:20");
        assert!(
            is_red(t),
            "fill: the top-left corner is picture, not a bar: {t:?}"
        );
        assert!(
            is_blue(e.region(&fill, 1.0, "100:60:240:560")),
            "fill: bottom-right too"
        );

        // fit: whole picture in the middle, background bars above and below
        let fit = render("fit.mp4", Some("fit"));
        assert!(
            near(e.region(&fit, 1.0, top), (32, 32, 32), 14),
            "fit: bar is the background colour"
        );
        assert!(
            is_red(e.region(&fit, 1.0, mid_left)) && is_blue(e.region(&fit, 1.0, mid_right)),
            "fit: whole picture visible"
        );

        // blur-bg: same sharp picture in the middle, bars are a blurred copy instead of the background
        let blur = render("blur.mp4", Some("blur-bg"));
        let bar = e.region(&blur, 1.0, "100:60:20:20");
        assert!(
            bar.0 > 120 && bar.1 < 90,
            "blur-bg: the bar is blurred picture: {bar:?}"
        );
        assert!(is_red(e.region(&blur, 1.0, mid_left)) && is_blue(e.region(&blur, 1.0, mid_right)));

        // and the other way round: a 9:16 video into a 16:9 canvas is filled edge to edge by default
        let tall = e.make(
            "tall.mp4",
            &[
                "-f",
                "lavfi",
                "-i",
                "color=c=red:s=180x160:r=30:d=1",
                "-f",
                "lavfi",
                "-i",
                "color=c=blue:s=180x160:r=30:d=1",
                "-filter_complex",
                "vstack",
                "-pix_fmt",
                "yuv420p",
            ],
        );
        let p = project(
            vec![asset("t", &tall, "video", Some(1.0))],
            vec![track(
                "v1",
                "video",
                0,
                false,
                false,
                vec![clip("c", "t", "v1", 0.0, 0.0, 1.0, 1.0)],
            )],
        );
        let out = e.dir.join("tall-fill.mp4");
        e.export(&p, &opts(Quality::Draft), &out).0.unwrap();
        let left_edge = e.region(&out, 0.5, "40:100:10:20");
        assert!(
            is_red(left_edge),
            "9:16 into 16:9 with fill: no side bars: {left_edge:?}"
        );
    }

    #[test]
    fn fit_background_renders_black_colour_or_an_image_behind_the_picture() {
        let Some(e) = env("fitbg") else { return };
        let red = e.red(); // 16:9 video
        let blue_png = e.make(
            "blue.png",
            &[
                "-f",
                "lavfi",
                "-i",
                "color=c=blue:s=300x300",
                "-frames:v",
                "1",
            ],
        );
        let portrait = ExportOptions {
            width: 360,
            height: 640,
            fps: 30.0,
            quality: Quality::Draft,
            format: ExportFormat::Mp4,
        };
        let render = |name: &str, background: Value| {
            let mut c = clip("c", "red", "v1", 0.0, 0.0, 2.0, 1.0);
            c["fitMode"] = json!("fit");
            match background {
                Value::Null => {
                    c.as_object_mut().unwrap().remove("fitBackground");
                }
                other => c["fitBackground"] = other,
            }
            let p = project(
                vec![
                    asset("red", &red, "video", Some(4.0)),
                    asset("bg", &blue_png, "image", None),
                ],
                vec![track("v1", "video", 0, false, false, vec![c])],
            );
            let out = e.dir.join(name);
            e.export(&p, &portrait, &out)
                .0
                .unwrap_or_else(|err| panic!("{name}: {err}"));
            out
        };
        let bar = "200:80:80:40"; // above the fitted 16:9 picture
        let picture = "200:80:80:280";

        let black = render("black.mp4", Value::Null); // default
        assert!(
            near(e.region(&black, 1.0, bar), (0, 0, 0), 12),
            "default bars are black: {:?}",
            e.region(&black, 1.0, bar)
        );
        assert!(is_red(e.region(&black, 1.0, picture)));

        let green = render("colour.mp4", json!({"kind": "color", "color": "#00AA00"}));
        let c = e.region(&green, 1.0, bar);
        assert!(
            c.1 > 120 && c.0 < 60 && c.2 < 60,
            "chosen colour in the bars: {c:?}"
        );

        let image = render("image.mp4", json!({"kind": "image", "assetId": "bg"}));
        assert!(
            is_blue(e.region(&image, 1.0, bar)),
            "the image covers the canvas behind the clip: {:?}",
            e.region(&image, 1.0, bar)
        );
        assert!(
            is_blue(e.region(&image, 1.0, "200:80:80:520")),
            "below the picture too"
        );
        assert!(
            is_red(e.region(&image, 1.0, picture)),
            "the clip itself is still on top"
        );
        assert!(e.decodes_cleanly(&image));

        // the cached preview copy is downscaled, never upscaled, and keeps the picture
        let big = e.make(
            "big.png",
            &[
                "-f",
                "lavfi",
                "-i",
                "color=c=blue:s=2600x1300",
                "-frames:v",
                "1",
            ],
        );
        let small = e.dir.join("preview.jpg");
        e.backend
            .scaled_image(Path::new(&big), 1280, &small)
            .unwrap();
        let info = e.backend.probe(&small).unwrap();
        assert_eq!((info.width, info.height), (Some(1280), Some(640)));
        // (checked through a PNG copy: the frame helper seeks, which a single JPEG does not support)
        let as_png = e.dir.join("preview-check.png");
        assert!(
            command(&e.ffmpeg)
                .args(["-y", "-v", "error", "-i"])
                .arg(&small)
                .arg(&as_png)
                .status()
                .unwrap()
                .success()
        );
        assert!(
            is_blue(e.region(&as_png, 0.0, "200:200:100:100")),
            "the preview copy keeps the picture"
        );
        let tiny = e.dir.join("tiny.jpg");
        e.backend
            .scaled_image(Path::new(&blue_png), 1280, &tiny)
            .unwrap();
        assert_eq!(e.backend.probe(&tiny).unwrap().width, Some(300));
    }

    #[test]
    fn cancel_stops_the_render_and_leaves_no_output() {
        let Some(e) = env("cancel") else { return };
        let green = e.green_png();
        // a still can be any length, so this is a long, slow job
        let p = project(
            vec![asset("g", &green, "image", None)],
            vec![track(
                "v1",
                "video",
                0,
                false,
                false,
                vec![clip("c", "g", "v1", 0.0, 0.0, 600.0, 1.0)],
            )],
        );
        let out = e.dir.join("never.mp4");
        let facts = gather_facts(&p, &e.backend);
        let plan = build_plan(
            &p,
            &ExportOptions {
                width: 1920,
                height: 1080,
                fps: 30.0,
                quality: Quality::High,
                format: ExportFormat::Mp4,
            },
            &facts,
        )
        .unwrap();

        let cancel = AtomicBool::new(false);
        let mut ticks = 0;
        let started = std::time::Instant::now();
        let r = e.backend.render(
            &RenderRequest {
                plan,
                output: out.clone(),
            },
            &mut |_| {
                ticks += 1;
                cancel.store(true, Ordering::Relaxed);
            },
            &cancel,
        );

        assert!(matches!(r, Err(AppError::Cancelled)), "{r:?}");
        assert!(ticks >= 1, "cancel should be triggered by real progress");
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "cancel must be prompt"
        );
        assert!(!out.exists());
        assert!(
            !temp_path(&out, ExportFormat::Mp4).exists(),
            "temp file must be cleaned up"
        );
    }

    #[test]
    fn a_failed_render_keeps_the_existing_output() {
        let Some(e) = env("fail") else { return };
        let bad = e.dir.join("bad.mp4");
        fs::write(&bad, b"this is not a video").unwrap();
        let p = project(
            vec![asset("bad", &bad.to_string_lossy(), "video", Some(5.0))],
            vec![track(
                "v1",
                "video",
                0,
                false,
                false,
                vec![clip("c", "bad", "v1", 0.0, 0.0, 2.0, 1.0)],
            )],
        );
        let out = e.dir.join("keep.mp4");
        fs::write(&out, b"PREVIOUS EXPORT").unwrap();

        let (r, _) = e.export(&p, &opts(Quality::Draft), &out);
        let msg = r.unwrap_err().to_string();
        assert!(msg.contains("FFmpeg failed"), "{msg}");
        assert_eq!(fs::read(&out).unwrap(), b"PREVIOUS EXPORT");
        assert!(!temp_path(&out, ExportFormat::Mp4).exists());
    }

    #[test]
    fn refuses_to_overwrite_a_source_or_export_with_missing_media() {
        let Some(e) = env("safety") else { return };
        let red = e.red();
        let p = project(
            vec![asset("red", &red, "video", Some(4.0))],
            vec![track(
                "v1",
                "video",
                0,
                false,
                false,
                vec![clip("c", "red", "v1", 0.0, 0.0, 2.0, 1.0)],
            )],
        );
        let before = fs::read(&red).unwrap();
        let (r, _) = e.export(&p, &opts(Quality::Draft), Path::new(&red));
        assert!(r.unwrap_err().to_string().contains("overwrite a source"));
        assert_eq!(fs::read(&red).unwrap(), before);

        fs::remove_file(&red).unwrap();
        let (r, _) = e.export(&p, &opts(Quality::Draft), &e.dir.join("o.mp4"));
        assert!(r.unwrap_err().to_string().contains("missing"));
    }

    #[test]
    fn prepare_plan_checks_access_before_anything_is_rendered() {
        let Some(e) = env("prepare") else { return };
        let red = e.red();
        let p = project(
            vec![asset("red", &red, "video", Some(4.0))],
            vec![track(
                "v1",
                "video",
                0,
                false,
                false,
                vec![clip("c", "red", "v1", 0.0, 0.0, 2.0, 1.0)],
            )],
        );
        let ok =
            crate::export::prepare_plan(&p, &opts(Quality::Draft), &e.backend, &|_| true).unwrap();
        assert_eq!(ok.duration, 2.0);
        assert!(ok.clips[0].audio);

        let denied = crate::export::prepare_plan(&p, &opts(Quality::Draft), &e.backend, &|_| false)
            .unwrap_err();
        assert!(
            denied.to_string().contains("not imported or opened"),
            "{denied}"
        );

        let bad = ExportOptions {
            width: 641,
            ..opts(Quality::Draft)
        };
        assert!(
            crate::export::prepare_plan(&p, &bad, &e.backend, &|_| true)
                .unwrap_err()
                .to_string()
                .contains("even")
        );
    }

    /// The whole backend pipeline on real files: import (probe + thumbnail) -> project -> save -> reopen
    /// -> plan -> render -> verify. What comes out must match what went in.
    #[test]
    fn full_flow_import_save_reopen_export() {
        use crate::media::import::import_one;
        use crate::project::persistence::{missing_paths, read_project, write_project_atomic};

        let Some(e) = env("fullflow") else { return };
        let (red, tone) = (e.red(), e.tone());
        let thumbs = e.dir.join("thumbs");

        // import: metadata comes from ffprobe, not from us
        let v = import_one(&e.backend, Path::new(&red), &thumbs).unwrap();
        let a = import_one(&e.backend, Path::new(&tone), &thumbs).unwrap();
        assert!((v.info.duration.unwrap() - 4.0).abs() < 0.1 && v.thumbnail_path.is_some());
        assert!((a.info.duration.unwrap() - 3.0).abs() < 0.1);

        let ty = |m: &crate::media::MediaType| serde_json::to_value(m).unwrap();
        let project = project(
            vec![
                json!({"id": "v", "path": v.path, "type": ty(&v.info.media_type), "duration": v.info.duration,
                       "width": v.info.width, "height": v.info.height, "thumbnailPath": v.thumbnail_path}),
                json!({"id": "a", "path": a.path, "type": ty(&a.info.media_type), "duration": a.info.duration}),
            ],
            vec![
                track(
                    "v1",
                    "video",
                    0,
                    false,
                    false,
                    vec![clip("c1", "v", "v1", 0.0, 1.0, 3.0, 1.0)],
                ),
                track(
                    "a1",
                    "audio",
                    1,
                    false,
                    false,
                    vec![clip("c2", "a", "a1", 1.0, 0.0, 2.0, 0.8)],
                ),
            ],
        );

        // save, then reopen from disk: identical
        let file = e.dir.join("flow.cutvii");
        write_project_atomic(&file, &project).unwrap();
        let reopened = read_project(&file).unwrap();
        assert_eq!(reopened, project);
        assert!(missing_paths(&reopened).is_empty());

        // export the reopened project
        let out = e.dir.join("flow.mp4");
        let (report, _) = e.export(&reopened, &opts(Quality::Standard), &out);
        let report = report.expect("export of a reopened project");
        assert!(
            (report.duration - 3.0).abs() < 0.2,
            "2s of video starting at 0, audio 1..3s: {}",
            report.duration
        );
        assert!(e.decodes_cleanly(&out));
        assert!(
            e.volume(&out, 0.2, 0.6) > -40.0,
            "tone from the video clip's source 1..3s"
        );
        assert!(e.volume(&out, 1.2, 1.6) > -40.0, "the wav joins at 1s");

        // a source that vanished after saving is reported on reopen, and blocks the export before rendering
        fs::remove_file(&tone).unwrap();
        let again = read_project(&file).unwrap();
        assert_eq!(missing_paths(&again), vec![tone.clone()]);
        let (r, _) = e.export(&again, &opts(Quality::Draft), &e.dir.join("blocked.mp4"));
        assert!(r.unwrap_err().to_string().contains("missing"));
        assert!(!e.dir.join("blocked.mp4").exists());
    }

    #[test]
    fn facts_report_missing_files_and_audio_presence() {
        let Some(e) = env("facts") else { return };
        let (red, blue) = (e.red(), e.blue());
        let p = project(
            vec![
                asset("r", &red, "video", Some(4.0)),
                asset("b", &blue, "video", Some(4.0)),
                asset("x", "/definitely/not/here.mp4", "video", Some(4.0)),
            ],
            vec![track("v1", "video", 0, false, false, vec![])],
        );
        let f: HashMap<String, AssetFacts> = gather_facts(&p, &e.backend);
        assert!(f[&red].exists && f[&red].has_audio);
        assert!(f[&blue].exists && !f[&blue].has_audio);
        assert!(!f["/definitely/not/here.mp4"].exists);
    }
}
