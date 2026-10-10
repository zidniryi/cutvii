//! Export planning and FFmpeg filter-graph generation. Pure: no processes, no filesystem.

use std::collections::HashMap;
use std::path::PathBuf;

use super::{ExportFormat, ExportOptions, Quality};
use crate::media::MediaType;
use crate::project::{FitMode, Project, TrackType, validate};

/// What we need to know about a source file that the project itself does not record.
#[derive(Debug, Clone, Copy)]
pub struct AssetFacts {
    pub exists: bool,
    pub has_audio: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlannedClip {
    pub path: PathBuf,
    pub media_type: MediaType,
    pub source_in: f64,
    /// Seconds of source media used (sourceOut - sourceIn).
    pub source_duration: f64,
    /// Seconds on the timeline (source_duration / speed).
    pub duration: f64,
    /// Playback speed; 1 for stills.
    pub speed: f64,
    /// Keep the pitch when the speed changes (time-stretch) instead of letting it rise and fall.
    pub keep_pitch: bool,
    /// The used range plays backwards. Resolved before rendering by swapping in a reversed copy.
    pub reversed: bool,
    pub start: f64,
    pub volume: f64,
    /// How the picture is scaled to the canvas (video and stills).
    pub fit: FitMode,
    /// Contributes picture (on a visible video track, not an audio asset).
    pub video: bool,
    /// Contributes sound (track not muted, asset has audio).
    pub audio: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExportPlan {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub quality: Quality,
    pub format: ExportFormat,
    pub duration: f64,
    /// `#RRGGBB`
    pub background: String,
    /// Back-to-front: later clips are drawn over earlier ones.
    pub clips: Vec<PlannedClip>,
    /// Things the user should know about this export (for example sound muted at high speed).
    pub warnings: Vec<String>,
}

/// Above this speed a clip's sound is dropped: it is no longer intelligible and the time-stretch artefacts dominate.
pub const MAX_AUDIBLE_SPEED: f64 = 4.0;

/// `atempo` factors that multiply to `speed`, each within the filter's best-quality range (0.5 to 2).
pub fn atempo_chain(speed: f64) -> Vec<f64> {
    let mut left = speed;
    let mut chain = Vec::new();
    while left > 2.0 + 1e-9 {
        chain.push(2.0);
        left /= 2.0;
    }
    while left < 0.5 - 1e-9 {
        chain.push(0.5);
        left /= 0.5;
    }
    if (left - 1.0).abs() > 1e-9 {
        chain.push(left);
    }
    chain
}

pub const AUDIO_RATE: u32 = 48_000;

pub fn build_plan(
    project: &Project,
    opts: &ExportOptions,
    facts: &HashMap<String, AssetFacts>,
) -> Result<ExportPlan, Vec<String>> {
    let mut errors = Vec::new();
    if let Err(e) = opts.validate() {
        errors.push(e);
    }
    if let Err(mut e) = validate(project) {
        errors.append(&mut e);
    }
    if !errors.is_empty() {
        return Err(errors);
    }

    let assets: HashMap<&str, _> = project.assets.iter().map(|a| (a.id.as_str(), a)).collect();
    let mut tracks: Vec<_> = project.tracks.iter().collect();
    tracks.sort_by_key(|t| t.order);

    let mut clips = Vec::new();
    let mut warnings = Vec::new();
    let mut end = 0.0_f64;
    for track in tracks {
        let mut ordered: Vec<_> = track.clips.iter().collect();
        ordered.sort_by(|a, b| a.timeline_start.total_cmp(&b.timeline_start));
        for c in ordered {
            let asset = assets[c.asset_id.as_str()]; // validated above
            let source_duration = c.source_out - c.source_in;
            // stills have no speed: their length is simply how long they are shown
            let is_still = asset.media_type == MediaType::Image;
            let speed = if is_still { 1.0 } else { c.speed() };
            let duration = if is_still {
                source_duration
            } else {
                c.timeline_duration()
            };
            end = end.max(c.timeline_start + duration);

            let fact = facts.get(&asset.path).copied();
            let video = track.track_type == TrackType::Video
                && !track.hidden
                && asset.media_type != MediaType::Audio;
            let audio = !track.muted
                && match asset.media_type {
                    MediaType::Audio => true,
                    MediaType::Video => fact.is_some_and(|f| f.has_audio),
                    MediaType::Image => false,
                };
            let audio = if audio && speed > MAX_AUDIBLE_SPEED + 1e-9 {
                let name = std::path::Path::new(&asset.path)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                warnings.push(format!("“{name}” is exported without sound: audio is muted above {MAX_AUDIBLE_SPEED}× speed"));
                false
            } else {
                audio
            };
            if !video && !audio {
                continue;
            }
            let reversed = !is_still && c.reversed.unwrap_or(false);
            if reversed && source_duration > crate::media::reverse::LONG_REVERSE_SECONDS {
                warnings.push(format!(
                    "Reversing {source_duration:.0} s of “{}” is slow and needs temporary disk space",
                    std::path::Path::new(&asset.path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
                ));
            }
            if !fact.is_some_and(|f| f.exists) {
                errors.push(format!("media file is missing: {}", asset.path));
                continue;
            }
            clips.push(PlannedClip {
                path: PathBuf::from(&asset.path),
                media_type: asset.media_type,
                source_in: c.source_in,
                source_duration,
                duration,
                speed,
                keep_pitch: c.keep_pitch(),
                reversed,
                start: c.timeline_start,
                volume: c.volume,
                fit: c.fit_mode.unwrap_or_default(),
                video,
                audio,
            });
        }
    }

    if opts.format.is_audio() {
        // audio-only export: keep just the sources that make sound
        clips.retain(|c| c.audio);
        clips.iter_mut().for_each(|c| c.video = false);
        if end > 0.0 && clips.is_empty() && errors.is_empty() {
            errors.push(
                "there is no sound to export: no audio on the timeline, or every source is muted"
                    .into(),
            );
        }
    }

    if end <= 0.0 {
        errors.push("nothing to export: the timeline is empty".into());
    } else if clips.is_empty() && errors.is_empty() {
        errors.push("nothing to export: every track is hidden or muted".into());
    }
    errors.dedup();
    if !errors.is_empty() {
        return Err(errors);
    }

    Ok(ExportPlan {
        width: opts.width,
        height: opts.height,
        fps: opts.fps,
        quality: opts.quality,
        format: opts.format,
        duration: end,
        background: project.settings.background_color.clone(),
        clips,
        warnings,
    })
}

#[derive(Debug, Clone, PartialEq)]
pub struct FilterGraph {
    /// `-i ...` argument groups, one input per planned clip (input index == clip index).
    pub input_args: Vec<String>,
    pub graph: String,
    /// None for audio-only exports.
    pub video_label: Option<&'static str>,
    pub audio_label: &'static str,
}

/// FFmpeg rate expression for a frame rate. NTSC-style rates become exact fractions so a 29.97 project
/// is rendered at 30000/1001, not at a rounded decimal.
pub fn rate_expr(fps: f64) -> String {
    if (fps - fps.round()).abs() < 1e-9 {
        return format!("{}", fps.round() as u64);
    }
    for (n, d) in [
        (24000u32, 1001u32),
        (30000, 1001),
        (60000, 1001),
        (120000, 1001),
    ] {
        if (fps - n as f64 / d as f64).abs() < 1e-4 {
            return format!("{n}/{d}");
        }
    }
    format!("{fps}")
}

fn secs(v: f64) -> String {
    format!("{v:.6}")
}

fn color(hex: &str) -> String {
    format!("0x{}", hex.trim_start_matches('#'))
}

pub fn build_filter_graph(plan: &ExportPlan) -> FilterGraph {
    let (w, h) = (plan.width, plan.height);
    let fps = rate_expr(plan.fps);
    let bg = color(&plan.background);
    let mut input_args: Vec<String> = Vec::new();
    let mut parts: Vec<String> = Vec::new();

    for clip in &plan.clips {
        let p = clip.path.to_string_lossy().into_owned();
        match clip.media_type {
            // stills loop for the clip length
            MediaType::Image => input_args.extend(
                ["-loop", "1", "-framerate"]
                    .map(String::from)
                    .into_iter()
                    .chain([
                        fps.clone(),
                        "-t".into(),
                        secs(clip.duration),
                        "-i".into(),
                        p,
                    ]),
            ),
            // seek in the demuxer (fast, still frame-accurate) and read only what is used
            _ => input_args.extend([
                "-ss".to_string(),
                secs(clip.source_in),
                "-t".into(),
                secs(clip.source_duration),
                "-i".into(),
                p,
            ]),
        }
    }

    if !plan.format.is_audio() {
        // ---- video: opaque background, then each visible clip over it in track order
        parts.push(format!(
            "color=c={bg}:s={w}x{h}:r={fps}:d={d},format=yuv420p[v0]",
            d = secs(plan.duration)
        ));
        let mut current = 0usize;
        for (i, clip) in plan.clips.iter().enumerate().filter(|(_, c)| c.video) {
            let shift = format!("setpts=PTS-STARTPTS+{}/TB", secs(clip.start));
            if clip.media_type == MediaType::Image {
                // Every still is flattened onto an opaque background canvas so transparency matches the preview.
                let dur = secs(clip.duration);
                match clip.fit {
                    FitMode::Fit => parts.push(format!(
                        "[{i}:v]format=rgba,scale={w}:{h}:force_original_aspect_ratio=decrease[s{i}]"
                    )),
                    FitMode::Fill => parts.push(format!(
                        "[{i}:v]format=rgba,scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}[s{i}]"
                    )),
                    FitMode::BlurBg => {
                        // sigma is 3% of the canvas height, mirrored by the preview's CSS blur
                        let sigma = (h as f64 * 0.03).max(2.0);
                        parts.push(format!("[{i}:v]format=rgba,split=2[a{i}][b{i}]"));
                        parts.push(format!(
                            "[a{i}]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},gblur=sigma={sigma:.1}[bl{i}]"
                        ));
                        parts.push(format!("[b{i}]scale={w}:{h}:force_original_aspect_ratio=decrease[s{i}]"));
                    }
                }
                parts.push(format!("color=c={bg}:s={w}x{h}:r={fps}:d={dur}[g{i}]"));
                let base = if clip.fit == FitMode::BlurBg {
                    parts.push(format!(
                        "[g{i}][bl{i}]overlay=x=0:y=0:format=auto:shortest=1[m{i}]"
                    ));
                    format!("m{i}")
                } else {
                    format!("g{i}")
                };
                parts.push(format!(
                    "[{base}][s{i}]overlay=x=(W-w)/2:y=(H-h)/2:format=auto:shortest=1,format=yuv420p,setsar=1,{shift}[c{i}]"
                ));
            } else {
                // speed: retime first, then resample to the output rate (frames are dropped or repeated)
                let retime = if (clip.speed - 1.0).abs() > 1e-9 {
                    format!("setpts=(PTS-STARTPTS)/{:.6},", clip.speed)
                } else {
                    String::new()
                };
                match clip.fit {
                    // whole picture, bars in the background colour
                    FitMode::Fit => parts.push(format!(
                        "[{i}:v]{retime}fps={fps},scale={w}:{h}:force_original_aspect_ratio=decrease,\
                         pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color={bg},setsar=1,format=yuv420p,{shift}[c{i}]"
                    )),
                    // cover the canvas, crop the overflow equally on both sides
                    FitMode::Fill => parts.push(format!(
                        "[{i}:v]{retime}fps={fps},scale={w}:{h}:force_original_aspect_ratio=increase,\
                         crop={w}:{h},setsar=1,format=yuv420p,{shift}[c{i}]"
                    )),
                    // whole picture over a blurred, covering copy of itself
                    FitMode::BlurBg => {
                        let sigma = (h as f64 * 0.03).max(2.0);
                        parts.push(format!("[{i}:v]{retime}fps={fps},split=2[a{i}][b{i}]"));
                        parts.push(format!(
                            "[a{i}]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},gblur=sigma={sigma:.1}[bl{i}]"
                        ));
                        parts.push(format!("[b{i}]scale={w}:{h}:force_original_aspect_ratio=decrease[s{i}]"));
                        parts.push(format!(
                            "[bl{i}][s{i}]overlay=x=(W-w)/2:y=(H-h)/2,setsar=1,format=yuv420p,{shift}[c{i}]"
                        ));
                    }
                }
            }
            parts.push(format!(
                "[v{current}][c{i}]overlay=eof_action=pass:repeatlast=0[v{n}]",
                n = current + 1
            ));
            current += 1;
        }
        parts.push(format!("[v{current}]null[vout]"));
    }

    // ---- audio: silent base of the full length, each clip delayed to its start, then mixed
    parts.push(format!(
        "anullsrc=r={AUDIO_RATE}:cl=stereo,atrim=duration={d},asetpts=N/SR/TB[a0]",
        d = secs(plan.duration)
    ));
    let mut labels = vec!["[a0]".to_string()];
    for (i, clip) in plan.clips.iter().enumerate().filter(|(_, c)| c.audio) {
        let ms = (clip.start * 1000.0).round() as u64;
        // speed: time-stretch with atempo (pitch kept), or resample so pitch follows the speed
        let tempo = if (clip.speed - 1.0).abs() <= 1e-9 {
            String::new()
        } else if clip.keep_pitch {
            atempo_chain(clip.speed)
                .iter()
                .map(|f| format!("atempo={f:.6},"))
                .collect()
        } else {
            format!(
                "asetrate={:.0},aresample={AUDIO_RATE},",
                AUDIO_RATE as f64 * clip.speed
            )
        };
        parts.push(format!(
            "[{i}:a]aresample={AUDIO_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,{tempo}\
             volume={vol:.4},asetpts=PTS-STARTPTS,adelay={ms}|{ms}[a{n}]",
            vol = clip.volume,
            n = labels.len()
        ));
        labels.push(format!("[a{}]", labels.len()));
    }
    if labels.len() == 1 {
        parts.push("[a0]anull[aout]".into());
    } else {
        parts.push(format!(
            "{}amix=inputs={}:normalize=0:duration=first:dropout_transition=0[aout]",
            labels.concat(),
            labels.len()
        ));
    }

    FilterGraph {
        input_args,
        graph: parts.join(";"),
        video_label: (!plan.format.is_audio()).then_some("[vout]"),
        audio_label: "[aout]",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    pub fn project(assets: serde_json::Value, tracks: serde_json::Value) -> Project {
        serde_json::from_value(json!({
            "id": "p", "name": "t", "schemaVersion": 3,
            "createdAt": "2026-01-01T00:00:00.000Z", "modifiedAt": "2026-01-01T00:00:00.000Z",
            "settings": {"width": 1280, "height": 720, "fps": 30, "backgroundColor": "#102030"},
            "assets": assets, "tracks": tracks
        }))
        .unwrap()
    }

    fn clip(
        id: &str,
        asset: &str,
        track: &str,
        start: f64,
        sin: f64,
        sout: f64,
    ) -> serde_json::Value {
        json!({"id": id, "assetId": asset, "trackId": track, "timelineStart": start, "sourceIn": sin,
               "sourceOut": sout, "volume": 1, "x": 0, "y": 0, "scale": 1, "opacity": 1, "fitMode": "fit"})
    }
    fn track(
        id: &str,
        ty: &str,
        order: u32,
        muted: bool,
        hidden: bool,
        clips: Vec<serde_json::Value>,
    ) -> serde_json::Value {
        json!({"id": id, "name": id, "type": ty, "order": order, "muted": muted, "hidden": hidden, "clips": clips})
    }
    pub fn opts() -> ExportOptions {
        ExportOptions {
            width: 640,
            height: 360,
            fps: 30.0,
            quality: Quality::Draft,
            format: ExportFormat::Mp4,
        }
    }
    fn facts(entries: &[(&str, bool, bool)]) -> HashMap<String, AssetFacts> {
        entries
            .iter()
            .map(|(p, e, a)| {
                (
                    p.to_string(),
                    AssetFacts {
                        exists: *e,
                        has_audio: *a,
                    },
                )
            })
            .collect()
    }

    fn sample() -> Project {
        project(
            json!([
                {"id": "v", "path": "/m/v.mp4", "type": "video", "duration": 10},
                {"id": "i", "path": "/m/i.png", "type": "image"},
                {"id": "a", "path": "/m/a.mp3", "type": "audio", "duration": 20}
            ]),
            json!([
                track(
                    "t1",
                    "video",
                    0,
                    false,
                    false,
                    vec![clip("c1", "v", "t1", 1.0, 2.0, 6.0)]
                ),
                track(
                    "t2",
                    "video",
                    1,
                    false,
                    false,
                    vec![clip("c2", "i", "t2", 3.0, 0.0, 2.0)]
                ),
                track(
                    "t3",
                    "audio",
                    2,
                    false,
                    false,
                    vec![clip("c3", "a", "t3", 0.5, 0.0, 4.0)]
                ),
            ]),
        )
    }
    fn sample_facts() -> HashMap<String, AssetFacts> {
        facts(&[
            ("/m/v.mp4", true, true),
            ("/m/i.png", true, false),
            ("/m/a.mp3", true, true),
        ])
    }

    #[test]
    fn plans_clips_back_to_front_with_duration_from_the_last_clip() {
        let plan = build_plan(&sample(), &opts(), &sample_facts()).unwrap();
        assert_eq!(plan.duration, 5.0); // video clip 1..5, image 3..5, audio 0.5..4.5
        let order: Vec<_> = plan.clips.iter().map(|c| c.media_type).collect();
        assert_eq!(
            order,
            vec![MediaType::Video, MediaType::Image, MediaType::Audio]
        );
        assert!(plan.clips[0].video && plan.clips[0].audio);
        assert!(plan.clips[1].video && !plan.clips[1].audio);
        assert!(!plan.clips[2].video && plan.clips[2].audio);
        assert_eq!(plan.background, "#102030");
    }

    #[test]
    fn muted_and_hidden_tracks_drop_sound_and_picture() {
        let mut p = sample();
        p.tracks[0].muted = true;
        p.tracks[1].hidden = true;
        let plan = build_plan(&p, &opts(), &sample_facts()).unwrap();
        assert!(plan.clips[0].video && !plan.clips[0].audio); // muted video still shows
        assert_eq!(plan.clips.len(), 2); // hidden image has neither picture nor sound -> dropped
        assert_eq!(plan.duration, 5.0); // ...but still counts toward the timeline length
    }

    #[test]
    fn video_without_an_audio_stream_has_no_audio_input() {
        let plan = build_plan(
            &sample(),
            &opts(),
            &facts(&[
                ("/m/v.mp4", true, false),
                ("/m/i.png", true, false),
                ("/m/a.mp3", true, true),
            ]),
        )
        .unwrap();
        assert!(plan.clips[0].video && !plan.clips[0].audio);
    }

    #[test]
    fn reports_missing_files_bad_options_and_empty_timelines() {
        let e = build_plan(
            &sample(),
            &opts(),
            &facts(&[
                ("/m/v.mp4", false, true),
                ("/m/i.png", true, false),
                ("/m/a.mp3", true, true),
            ]),
        )
        .unwrap_err();
        assert_eq!(e, vec!["media file is missing: /m/v.mp4".to_string()]);

        let odd = ExportOptions {
            width: 641,
            ..opts()
        };
        assert!(build_plan(&sample(), &odd, &sample_facts()).unwrap_err()[0].contains("even"));

        let mut empty = sample();
        empty.tracks.iter_mut().for_each(|t| t.clips.clear());
        assert!(build_plan(&empty, &opts(), &sample_facts()).unwrap_err()[0].contains("empty"));

        let mut silent = sample();
        silent.tracks.iter_mut().for_each(|t| t.muted = true);
        silent.tracks[0].hidden = true;
        silent.tracks[1].hidden = true;
        assert!(
            build_plan(&silent, &opts(), &sample_facts()).unwrap_err()[0]
                .contains("hidden or muted")
        );
    }

    #[test]
    fn filter_graph_places_inputs_overlays_and_mixes() {
        let plan = build_plan(&sample(), &opts(), &sample_facts()).unwrap();
        let g = build_filter_graph(&plan);
        let args = g.input_args.join(" ");

        // video: demuxer seek to sourceIn, limited to the used length
        assert!(
            args.contains("-ss 2.000000 -t 4.000000 -i /m/v.mp4"),
            "{args}"
        );
        // image: looped still of the clip length
        assert!(
            args.contains("-loop 1 -framerate 30 -t 2.000000 -i /m/i.png"),
            "{args}"
        );
        // audio: one input per clip, in plan order
        assert!(args.contains("-ss 0.000000 -t 4.000000 -i /m/a.mp3"));

        let s = &g.graph;
        assert!(
            s.starts_with("color=c=0x102030:s=640x360:r=30:d=5.000000,format=yuv420p[v0]"),
            "{s}"
        );
        assert!(s.contains("[0:v]fps=30,scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2:color=0x102030"));
        assert!(s.contains("setpts=PTS-STARTPTS+1.000000/TB[c0]"));
        assert!(s.contains("[v0][c0]overlay=eof_action=pass:repeatlast=0[v1]"));
        assert!(s.contains("[1:v]format=rgba,scale=640:360"));
        assert!(s.contains("setpts=PTS-STARTPTS+3.000000/TB[c1]"));
        assert!(s.contains("[v1][c1]overlay=eof_action=pass:repeatlast=0[v2];[v2]null[vout]"));
        // audio delayed to start (ms) and mixed with a silent base without level normalisation
        assert!(s.contains("[0:a]aresample=48000"));
        assert!(s.contains("adelay=1000|1000[a1]"));
        assert!(s.contains("[2:a]aresample=48000"));
        assert!(s.contains("adelay=500|500[a2]"));
        assert!(s.contains(
            "[a0][a1][a2]amix=inputs=3:normalize=0:duration=first:dropout_transition=0[aout]"
        ));
    }

    #[test]
    fn ntsc_rates_are_written_as_exact_fractions() {
        assert_eq!(rate_expr(30.0), "30");
        assert_eq!(rate_expr(30000.0 / 1001.0), "30000/1001");
        assert_eq!(rate_expr(29.97002997002997), "30000/1001");
        assert_eq!(rate_expr(24000.0 / 1001.0), "24000/1001");
        assert_eq!(rate_expr(60000.0 / 1001.0), "60000/1001");
        assert_eq!(rate_expr(12.5), "12.5");

        let mut plan = build_plan(&sample(), &opts(), &sample_facts()).unwrap();
        plan.fps = 30000.0 / 1001.0;
        let g = build_filter_graph(&plan).graph;
        assert!(
            g.contains("r=30000/1001") && g.contains("fps=30000/1001"),
            "{g}"
        );
    }

    #[test]
    fn fit_modes_change_only_how_a_still_is_scaled() {
        let mut p = sample();
        let fit = build_filter_graph(&build_plan(&p, &opts(), &sample_facts()).unwrap()).graph;
        assert!(
            fit.contains("[1:v]format=rgba,scale=640:360:force_original_aspect_ratio=decrease[s1]")
        );
        assert!(!fit.contains("gblur"));

        p.tracks[1].clips[0].fit_mode = Some(FitMode::Fill);
        let fill = build_filter_graph(&build_plan(&p, &opts(), &sample_facts()).unwrap()).graph;
        assert!(fill.contains("[1:v]format=rgba,scale=640:360:force_original_aspect_ratio=increase,crop=640:360[s1]"), "{fill}");

        p.tracks[1].clips[0].fit_mode = Some(FitMode::BlurBg);
        let blur = build_filter_graph(&build_plan(&p, &opts(), &sample_facts()).unwrap()).graph;
        assert!(blur.contains("[1:v]format=rgba,split=2[a1][b1]"));
        assert!(
            blur.contains("crop=640:360,gblur=sigma=10.8[bl1]"),
            "{blur}"
        ); // 3% of 360
        assert!(blur.contains("[g1][bl1]overlay=x=0:y=0:format=auto:shortest=1[m1]"));
        assert!(blur.contains("[m1][s1]overlay=x=(W-w)/2:y=(H-h)/2"));

        // video follows the same three modes
        p.tracks[0].clips[0].fit_mode = Some(FitMode::Fill);
        let g = build_filter_graph(&build_plan(&p, &opts(), &sample_facts()).unwrap()).graph;
        assert!(g.contains("[0:v]fps=30,scale=640:360:force_original_aspect_ratio=increase,crop=640:360,setsar=1"), "{g}");
        assert!(!g.contains("[0:v]fps=30,scale=640:360:force_original_aspect_ratio=decrease,pad="));

        p.tracks[0].clips[0].fit_mode = Some(FitMode::BlurBg);
        let g = build_filter_graph(&build_plan(&p, &opts(), &sample_facts()).unwrap()).graph;
        assert!(
            g.contains("[0:v]fps=30,split=2[a0][b0]") && g.contains("gblur=sigma=10.8[bl0]"),
            "{g}"
        );
        assert!(g.contains("[bl0][s0]overlay=x=(W-w)/2:y=(H-h)/2,setsar=1"));

        // a clip without the field uses the default: fill
        p.tracks[0].clips[0].fit_mode = None;
        let plan = build_plan(&p, &opts(), &sample_facts()).unwrap();
        assert_eq!(plan.clips[0].fit, FitMode::Fill);
    }

    #[test]
    fn atempo_is_chained_to_stay_within_its_good_range() {
        assert_eq!(atempo_chain(1.0), Vec::<f64>::new());
        assert_eq!(atempo_chain(2.0), vec![2.0]);
        assert_eq!(atempo_chain(4.0), vec![2.0, 2.0]);
        assert_eq!(atempo_chain(0.25), vec![0.5, 0.5]);
        assert_eq!(atempo_chain(0.5), vec![0.5]);
        for speed in [0.1, 0.25, 0.3, 0.75, 1.5, 3.0, 4.0] {
            let chain = atempo_chain(speed);
            assert!(
                chain.iter().all(|f| (0.5..=2.0).contains(f)),
                "{speed}: {chain:?}"
            );
            assert!(
                (chain.iter().product::<f64>() - speed).abs() < 1e-9,
                "{speed}: {chain:?}"
            );
        }
    }

    #[test]
    fn speed_changes_the_timeline_length_and_the_filters_but_reads_the_same_source() {
        let mut p = sample(); // video clip: source 2..6 (4 s) at timeline 1
        p.tracks[0].clips[0].speed = Some(2.0);
        let plan = build_plan(&p, &opts(), &sample_facts()).unwrap();
        let v = &plan.clips[0];
        assert_eq!((v.source_duration, v.duration, v.speed), (4.0, 2.0, 2.0));
        assert_eq!(plan.duration, 5.0); // still ends with the image (3..5) and the audio (0.5..4.5)

        let g = build_filter_graph(&plan);
        assert!(
            g.input_args
                .join(" ")
                .contains("-ss 2.000000 -t 4.000000 -i /m/v.mp4")
        );
        assert!(
            g.graph
                .contains("[0:v]setpts=(PTS-STARTPTS)/2.000000,fps=30,scale="),
            "{}",
            g.graph
        );
        assert!(g.graph.contains("[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atempo=2.000000,volume="));

        // slow motion needs a chain; without keep-pitch the sample rate is changed instead
        p.tracks[0].clips[0].speed = Some(0.25);
        let slow = build_filter_graph(&build_plan(&p, &opts(), &sample_facts()).unwrap()).graph;
        assert!(
            slow.contains("atempo=0.500000,atempo=0.500000,volume="),
            "{slow}"
        );
        p.tracks[0].clips[0].keep_pitch = Some(false);
        let pitched = build_filter_graph(&build_plan(&p, &opts(), &sample_facts()).unwrap()).graph;
        assert!(
            pitched.contains("asetrate=12000,aresample=48000,volume=")
                && !pitched.contains("atempo"),
            "{pitched}"
        );

        // normal speed leaves the graph exactly as before
        p.tracks[0].clips[0].speed = Some(1.0);
        let normal = build_filter_graph(&build_plan(&p, &opts(), &sample_facts()).unwrap()).graph;
        assert!(
            normal.contains("[0:v]fps=30,scale=")
                && !normal.contains("atempo")
                && !normal.contains("asetrate")
        );
    }

    #[test]
    fn sound_is_muted_above_four_times_speed_with_a_warning_and_stills_ignore_speed() {
        let mut p = sample();
        p.tracks[0].clips[0].speed = Some(8.0);
        p.tracks[1].clips[0].speed = Some(2.0); // an image: speed means nothing
        let plan = build_plan(&p, &opts(), &sample_facts()).unwrap();
        assert!(plan.clips[0].video && !plan.clips[0].audio);
        assert_eq!(plan.clips[1].duration, 2.0);
        assert_eq!(plan.warnings.len(), 1);
        assert!(
            plan.warnings[0].contains("v.mp4") && plan.warnings[0].contains("muted above 4"),
            "{:?}",
            plan.warnings
        );

        p.tracks[0].clips[0].speed = Some(4.0); // exactly 4x still has sound
        let ok = build_plan(&p, &opts(), &sample_facts()).unwrap();
        assert!(ok.clips[0].audio && ok.warnings.is_empty());
    }

    #[test]
    fn graph_without_any_audio_still_produces_a_silent_track() {
        let p = project(
            json!([{"id": "i", "path": "/m/i.png", "type": "image"}]),
            json!([track(
                "t",
                "video",
                0,
                false,
                false,
                vec![clip("c", "i", "t", 0.0, 0.0, 3.0)]
            )]),
        );
        let plan = build_plan(&p, &opts(), &facts(&[("/m/i.png", true, false)])).unwrap();
        let g = build_filter_graph(&plan);
        assert!(g.graph.ends_with("[a0]anull[aout]"), "{}", g.graph);
    }
}
