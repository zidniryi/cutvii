//! Export planning and FFmpeg filter-graph generation. Pure: no processes, no filesystem.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use super::transitions::{From, find as find_transition, leaving, remaining};
use super::{ExportFormat, ExportOptions, Quality};
use crate::errors::{AppError, AppResult};
use crate::media::MediaType;
use crate::media::clean::{duck_filter, filters as clean_filters};
use crate::media::color::{ColorAdjust, Overlay, ensure_graded_lut, filter_path};
use crate::media::cube::load_cube;
use crate::project::{AudioClean, ClipLut};
use crate::project::{
    BackgroundKind, Crop, DEFAULT_BLUR_AMOUNT, FitMode, Motion, Project, TrackType, Transform,
    validate,
};

/// What we need to know about a source file that the project itself does not record.
#[derive(Debug, Clone, Copy)]
pub struct AssetFacts {
    pub exists: bool,
    pub has_audio: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlannedClip {
    pub path: PathBuf,
    /// Id of the track the clip is on.
    pub track: String,
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
    /// Seconds of fade at the start and at the end of the clip's sound (already fitted to its length).
    pub fade_in: f64,
    pub fade_out: f64,
    /// Noise and rumble clean-up of the sound, when any is switched on.
    pub clean: Option<AudioClean>,
    /// Ducking amount 0..1: the clip is turned down while the clips that do not duck make sound. 0 = off.
    pub duck: f64,
    /// How the picture is scaled to the canvas (video and stills).
    pub fit: FitMode,
    /// Colour behind the picture where it does not cover the canvas (`#RRGGBB`).
    pub bg_color: String,
    /// Image behind the picture instead of the colour, scaled to cover the canvas.
    pub bg_image: Option<PathBuf>,
    /// Blur amount 0..=100 for `blur-bg` (30 = a radius of 3 % of the canvas height).
    pub blur_amount: f64,
    /// Shares of the source picture cut away before it is scaled to the canvas (never set for text).
    pub crop: Option<Crop>,
    /// Position, scale, rotation, flip and opacity of the clip's layer; `None` when it is left as it is.
    pub transform: Option<Transform>,
    /// Keyframes of the transform in clip time; a property with keys ignores its value in `transform`.
    pub motion: Option<Motion>,
    /// The transition the clip comes in with: where it starts from, and for how many seconds.
    pub transition: Option<(From, f64)>,
    /// The transition the clip leaves with: where it ends up, and over how many of its last seconds.
    pub transition_out: Option<(From, f64)>,
    /// Seconds the last frame stays on after the clip, under the next clip's transition.
    pub hold: f64,
    /// Colour adjustment of the picture; `None` when nothing is set (and always for text).
    pub color: Option<ColorAdjust>,
    /// The baked table for `color` (a `.cube` file). Filled in just before rendering: planning itself
    /// writes no files. Without it the colour step is left out of the graph.
    pub lut: Option<PathBuf>,
    /// An imported LUT to lay over `color`. Its table is loaded and baked into `lut` by
    /// [`ExportPlan::bake_user_luts`] before rendering.
    pub user_lut: Option<ClipLut>,
    /// A text picture: drawn over the tracks below with its transparency kept, never on a background.
    pub transparent: bool,
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

impl ExportPlan {
    /// Bake the table of every clip that uses an imported LUT: Adjust first, then the LUT (see
    /// `media/color.rs`). `cubes` is the folder of CutVii's own LUT copies. A LUT that is not there stops
    /// the export with a message that names it: the video is never silently exported without it.
    pub fn bake_user_luts(&mut self, cubes: &Path) -> AppResult<()> {
        let out = std::env::temp_dir().join("cutvii-luts");
        for clip in self.clips.iter_mut() {
            let Some(lut) = &clip.user_lut else { continue };
            let cube = load_cube(cubes, &lut.id).map_err(|e| {
                AppError::InvalidInput(format!(
                    "a clip uses the LUT \"{}\", which cannot be used: {e}. Import it again, or remove it from the clip in the Color tab.",
                    lut.name
                ))
            })?;
            let overlay = Overlay {
                id: &lut.id,
                cube: &cube,
                intensity: lut.intensity,
            };
            let adjust = clip.color.unwrap_or_default();
            clip.lut = Some(ensure_graded_lut(&out, &adjust, Some(&overlay))?.cube);
        }
        Ok(())
    }
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

    let mut clips: Vec<PlannedClip> = Vec::new();
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
                && !c.muted.unwrap_or(false)
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
            // a transition in; the clip that ends right here on this track holds its last frame under it
            let coming = c
                .transition_in
                .as_ref()
                .filter(|_| video)
                .and_then(|t| Some((find_transition(&t.kind)?, t.duration.min(duration))));
            if let (Some((kind, seconds)), Some(before)) = (coming, clips.last_mut()) {
                let touches = (before.start + before.duration - c.timeline_start).abs() < 1e-3;
                if kind.hold && before.video && before.track == track.id && touches {
                    before.hold = seconds;
                }
            }
            let transition = coming.map(|(kind, seconds)| (kind.from, seconds));
            // a transition out takes what the transition in leaves of the clip's length
            let room = duration - transition.map_or(0.0, |(_, seconds)| seconds);
            let transition_out = c
                .transition_out
                .as_ref()
                .filter(|_| video)
                .and_then(|t| Some((find_transition(&t.kind)?.from, t.duration.min(room))))
                .filter(|(_, seconds)| *seconds > 1e-3);
            // the sound of a clip fades for as long as its picture comes in or leaves (text has no sound:
            // its own fade is its transparency)
            let (fade_in, fade_out) = if asset.text.is_none() {
                c.fades_with(
                    transition.map_or(0.0, |(_, seconds)| seconds),
                    transition_out.map_or(0.0, |(_, seconds)| seconds),
                )
            } else {
                c.fades()
            };
            // what shows behind a fitted or transparent picture
            let black = || "#000000".to_string();
            let (bg_color, bg_image) = match c.fit_background.as_ref() {
                Some(b) if b.kind == BackgroundKind::Color => {
                    (b.color.clone().unwrap_or_else(black), None)
                }
                Some(b) if b.kind == BackgroundKind::Image && video => {
                    match b
                        .asset_id
                        .as_deref()
                        .and_then(|id| assets.get(id))
                        .map(|a| a.path.clone())
                    {
                        Some(path) if facts.get(&path).is_some_and(|f| f.exists) => {
                            (black(), Some(PathBuf::from(path)))
                        }
                        Some(path) => {
                            errors.push(format!("background image is missing: {path}"));
                            (black(), None)
                        }
                        None => (black(), None),
                    }
                }
                _ => (black(), None),
            };
            clips.push(PlannedClip {
                path: PathBuf::from(&asset.path),
                track: track.id.clone(),
                media_type: asset.media_type,
                source_in: c.source_in,
                source_duration,
                duration,
                speed,
                keep_pitch: c.keep_pitch(),
                reversed,
                start: c.timeline_start,
                volume: c.volume,
                fade_in,
                fade_out,
                clean: c.clean.filter(|k| audio && !k.is_off()),
                duck: c.duck.filter(|_| audio).unwrap_or(0.0).clamp(0.0, 1.0),
                fit: c.fit_mode.unwrap_or_default(),
                bg_color,
                bg_image,
                blur_amount: c
                    .fit_background
                    .as_ref()
                    .and_then(|b| b.blur)
                    .unwrap_or(DEFAULT_BLUR_AMOUNT),
                crop: c.crop.filter(|k| !k.is_none() && asset.text.is_none()),
                transform: Some(c.transform()).filter(|t| {
                    !t.is_identity()
                        || (video
                            && (c.motion().is_some()
                                || transition.is_some()
                                || transition_out.is_some()))
                }),
                motion: c.motion().filter(|_| video),
                transition,
                transition_out,
                hold: 0.0,
                color: c
                    .color
                    .filter(|k| video && !k.is_identity() && asset.text.is_none()),
                lut: None,
                user_lut: c
                    .lut
                    .clone()
                    .filter(|l| video && l.intensity > 0.0 && asset.text.is_none()),
                transparent: asset.text.is_some(),
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

/// Keyframes as an FFmpeg expression of `t` (clip time): straight lines between the keys, the first value
/// before the first key and the last value after the last. The preview does the same (`valueAt`).
pub fn piecewise(keys: &[(f64, f64)], t: &str) -> String {
    let (Some(first), Some(last)) = (keys.first(), keys.last()) else {
        return "0".into();
    };
    let mut e = format!("{:.6}", last.1);
    for pair in keys.windows(2).rev() {
        let ((t0, v0), (t1, v1)) = (pair[0], pair[1]);
        e = format!(
            "if(lt({t},{t1:.6}),({v0:.6})+({dv:.6})*({t}-({t0:.6}))/{dt:.6},{e})",
            dv = v1 - v0,
            dt = (t1 - t0).max(1e-6)
        );
    }
    if keys.len() > 1 {
        e = format!("if(lt({t},{:.6}),{:.6},{e})", first.0, first.1);
    }
    e
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

    // Background images are extra looped inputs after the per-clip ones. Only clips whose picture can leave
    // part of the canvas uncovered need one (fitted video, and every still).
    let mut bg_inputs: Vec<Option<usize>> = vec![None; plan.clips.len()];
    if !plan.format.is_audio() {
        let mut next = plan.clips.len();
        for (i, clip) in plan.clips.iter().enumerate().filter(|(_, c)| c.video) {
            let needs_base = !clip.transparent
                && (clip.media_type == MediaType::Image || clip.fit == FitMode::Fit);
            if let (true, Some(image)) = (needs_base, &clip.bg_image) {
                input_args.extend(
                    ["-loop", "1", "-framerate"]
                        .map(String::from)
                        .into_iter()
                        .chain([
                            fps.clone(),
                            "-t".into(),
                            secs(clip.duration),
                            "-i".into(),
                            image.to_string_lossy().into_owned(),
                        ]),
                );
                bg_inputs[i] = Some(next);
                next += 1;
            }
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
            let still = clip.media_type == MediaType::Image;
            let clip_bg = color(&clip.bg_color);
            // blur radius: amount/1000 of the canvas height (30 -> 3 %), mirrored by the preview's CSS blur
            let sigma = h as f64 * clip.blur_amount / 1000.0;
            let blur = if sigma >= 0.5 {
                format!(",gblur=sigma={sigma:.1}")
            } else {
                String::new()
            };
            // stills carry transparency and are flattened onto the base; video is opaque
            let source = if still {
                format!("[{i}:v]format=rgba")
            } else if (clip.speed - 1.0).abs() > 1e-9 {
                // speed: retime first, then resample to the output rate (frames are dropped or repeated)
                format!("[{i}:v]setpts=(PTS-STARTPTS)/{:.6},fps={fps}", clip.speed)
            } else {
                format!("[{i}:v]fps={fps}")
            };
            // crop first, on the source picture: everything after it sees only the part that is kept
            let source = match clip.crop {
                Some(k) => format!(
                    "{source},crop=iw*{:.6}:ih*{:.6}:iw*{:.6}:ih*{:.6}",
                    1.0 - k.left - k.right,
                    1.0 - k.top - k.bottom,
                    k.left,
                    k.top
                ),
                None => source,
            };
            // colour: the one baked table, on the picture itself (so a blurred copy of it is graded too)
            let source = match &clip.lut {
                Some(lut) => format!("{source},lut3d=file={}", filter_path(lut)),
                None => source,
            };
            let cover = format!("scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}");
            let contain = format!("scale={w}:{h}:force_original_aspect_ratio=decrease");
            // The base under the picture: the chosen image (covering the canvas) or the chosen colour.
            let base = match bg_inputs[i] {
                Some(k) => format!("[{k}:v]{cover},setsar=1[g{i}]"),
                None => format!(
                    "color=c={clip_bg}:s={w}x{h}:r={fps}:d={}[g{i}]",
                    secs(clip.duration)
                ),
            };
            let finish = format!("format=yuv420p,setsar=1,{shift}[c{i}]");

            match (still, clip.fit) {
                // text: the whole picture, centred, with its transparency kept so the tracks below show
                _ if clip.transparent => {
                    // a text that fades does so with its transparency, so what is under it shows through
                    let mut fades = String::new();
                    if clip.fade_in > 1e-6 {
                        fades.push_str(&format!("fade=t=in:st=0:d={:.6}:alpha=1,", clip.fade_in));
                    }
                    if clip.fade_out > 1e-6 {
                        fades.push_str(&format!(
                            "fade=t=out:st={:.6}:d={:.6}:alpha=1,",
                            clip.duration - clip.fade_out,
                            clip.fade_out
                        ));
                    }
                    parts.push(format!(
                        "{source},{contain},pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black@0,{fades}setsar=1,{shift}[c{i}]"
                    ))
                }
                // video, whole picture, plain colour bars: a pad is enough
                (false, FitMode::Fit) if bg_inputs[i].is_none() => parts.push(format!(
                    "{source},{contain},pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color={clip_bg},setsar=1,format=yuv420p,{shift}[c{i}]"
                )),
                // video covering the canvas: nothing shows behind it
                (false, FitMode::Fill) => {
                    parts.push(format!("{source},{cover},setsar=1,format=yuv420p,{shift}[c{i}]"))
                }
                // video over a blurred, covering copy of itself (opaque, so no base is needed)
                (false, FitMode::BlurBg) => {
                    parts.push(format!("{source},split=2[a{i}][b{i}]"));
                    parts.push(format!("[a{i}]{cover}{blur}[bl{i}]"));
                    parts.push(format!("[b{i}]{contain}[s{i}]"));
                    parts.push(format!("[bl{i}][s{i}]overlay=x=(W-w)/2:y=(H-h)/2,{finish}"));
                }
                // a still over its own blurred copy, on the base (which shows through transparency)
                (true, FitMode::BlurBg) => {
                    parts.push(format!("{source},split=2[a{i}][b{i}]"));
                    parts.push(format!("[a{i}]{cover}{blur}[bl{i}]"));
                    parts.push(format!("[b{i}]{contain}[s{i}]"));
                    parts.push(base);
                    parts.push(format!("[g{i}][bl{i}]overlay=x=0:y=0:format=auto:shortest=1[m{i}]"));
                    parts.push(format!("[m{i}][s{i}]overlay=x=(W-w)/2:y=(H-h)/2:format=auto:shortest=1,{finish}"));
                }
                // fitted video over an image, and every other still: the picture sits on the base
                (_, fit) => {
                    let scale = if fit == FitMode::Fill { &cover } else { &contain };
                    parts.push(format!("{source},{scale}[s{i}]"));
                    parts.push(base);
                    parts.push(format!("[g{i}][s{i}]overlay=x=(W-w)/2:y=(H-h)/2:format=auto:shortest=1,{finish}"));
                }
            }
            // Transform: the finished canvas-sized layer is mirrored, scaled, rotated and faded, then laid
            // over the tracks below at its offset. Whatever it leaves uncovered keeps showing them.
            // held under the next clip's transition: the last frame stays on for that long
            let layer = if clip.hold > 0.0 {
                parts.push(format!(
                    "[c{i}]tpad=stop_mode=clone:stop_duration={}[h{i}]",
                    secs(clip.hold)
                ));
                format!("h{i}")
            } else {
                format!("c{i}")
            };
            match clip.transform {
                Some(t) => {
                    // Keyframes and the transition in: each animated property is an expression of clip
                    // time. Layers carry timeline timestamps, so clip time is the filter's time minus the
                    // clip's start. `None` below means the property is fixed.
                    let m = clip.motion.clone().unwrap_or_default();
                    let clip_time = |var: &str| format!("({var}-{})", secs(clip.start));
                    // what the user set: a fixed value, or the keyframes
                    let own = |keys: &[(f64, f64)], fixed: f64, var: &str| {
                        if keys.is_empty() {
                            format!("{fixed:.6}")
                        } else {
                            piecewise(keys, &clip_time(var))
                        }
                    };
                    // the transitions: `left` goes from 1 to 0 while the clip comes in, `gone` from 0 to 1
                    // while it leaves
                    let coming = clip.transition.map(|(f, _)| f).unwrap_or_default();
                    let going = clip.transition_out.map(|(f, _)| f).unwrap_or_default();
                    let left = |var: &str| match clip.transition {
                        Some((_, seconds)) => piecewise(&remaining(seconds), &clip_time(var)),
                        None => "0".into(),
                    };
                    let gone = |var: &str| match clip.transition_out {
                        Some((_, seconds)) => {
                            piecewise(&leaving(clip.duration, seconds), &clip_time(var))
                        }
                        None => "0".into(),
                    };
                    // `offsets` / `factors`: what the transition in and the transition out add or multiply
                    let added =
                        |keys: &[(f64, f64)], fixed: f64, var: &str, offsets: (f64, f64)| {
                            if keys.is_empty() && offsets == (0.0, 0.0) {
                                return None;
                            }
                            let mut e = own(keys, fixed, var);
                            if offsets.0 != 0.0 {
                                e = format!("({e})+({:.6})*({})", offsets.0, left(var));
                            }
                            if offsets.1 != 0.0 {
                                e = format!("({e})+({:.6})*({})", offsets.1, gone(var));
                            }
                            Some(e)
                        };
                    let scaled =
                        |keys: &[(f64, f64)], fixed: f64, var: &str, factors: (f64, f64)| {
                            if keys.is_empty() && factors == (1.0, 1.0) {
                                return None;
                            }
                            let mut e = own(keys, fixed, var);
                            if factors.0 != 1.0 {
                                e = format!("({e})*(1+({:.6})*({}))", factors.0 - 1.0, left(var));
                            }
                            if factors.1 != 1.0 {
                                e = format!("({e})*(1+({:.6})*({}))", factors.1 - 1.0, gone(var));
                            }
                            Some(e)
                        };
                    let x = added(&m.x, t.x, "t", (coming.x, going.x));
                    let y = added(&m.y, t.y, "t", (coming.y, going.y));
                    let rotation = added(
                        &m.rotation,
                        t.rotation,
                        "t",
                        (coming.rotation, going.rotation),
                    );
                    let scale = scaled(&m.scale, t.scale, "t", (coming.scale, going.scale));
                    let opacity =
                        scaled(&m.opacity, t.opacity, "T", (coming.opacity, going.opacity));

                    let mut chain = vec!["format=rgba".to_string()];
                    if t.flip_h {
                        chain.push("hflip".into());
                    }
                    if t.flip_v {
                        chain.push("vflip".into());
                    }
                    if scale.is_none() && t.scale != 1.0 {
                        chain.push(format!("scale=w=iw*{s:.6}:h=ih*{s:.6}", s = t.scale));
                    }
                    let fade = if let Some(e) = &opacity {
                        // The alpha gain takes no expression, so it is set anew for every frame. The
                        // command is sent to THIS clip's filter by its own name: sent to the plain filter
                        // name it only ever reaches the first such filter in the graph (measured: a
                        // second fading clip stayed invisible).
                        let first = m.opacity.first().map_or(t.opacity, |k| k.1) * coming.opacity;
                        Some(format!(
                            "sendcmd=c='0-1000000 [expr] colorchannelmixer@fade{i} aa {}',colorchannelmixer@fade{i}=aa={first:.4}",
                            // its commas would end the command: escaped for the command, inside the quotes
                            e.replace(',', "\\\\,"),
                        ))
                    } else if t.opacity != 1.0 {
                        Some(format!("colorchannelmixer=aa={:.4}", t.opacity))
                    } else {
                        None
                    };
                    // The alpha gain draws wrongly on frames whose size changes (measured: it keeps to
                    // the first frame's area), so with an animated scale it comes before the scaling.
                    let fade_first = scale.is_some();
                    if fade_first {
                        chain.extend(fade.clone());
                    }
                    if let Some(e) = &rotation {
                        // a square that holds the picture at any angle: the size cannot change per frame
                        chain.push(format!(
                            "rotate=a='({e})*PI/180':ow='hypot(iw,ih)':oh=ow:c=black@0"
                        ));
                    } else if t.rotation != 0.0 {
                        let a = t.rotation.to_radians();
                        chain.push(format!(
                            "rotate={a:.6}:ow=rotw({a:.6}):oh=roth({a:.6}):c=black@0"
                        ));
                    }
                    if let Some(e) = &scale {
                        // after the turn: scaling evenly and turning give the same picture in either order
                        chain.push(format!(
                            "scale=eval=frame:w='max(2,iw*({e}))':h='max(2,ih*({e}))'"
                        ));
                    }
                    if !fade_first {
                        chain.extend(fade);
                    }
                    parts.push(format!("[{layer}]{}[t{i}]", chain.join(",")));
                    let offset = |e: &Option<String>, fixed: f64, size: &str| match e {
                        Some(e) => format!("({e})*{size}"),
                        None => format!("{fixed:.3}"),
                    };
                    let q = if x.is_none() && y.is_none() { "" } else { "'" };
                    parts.push(format!(
                        "[v{current}][t{i}]overlay=x={q}(W-w)/2+({dx}){q}:y={q}(H-h)/2+({dy}){q}:eof_action=pass:repeatlast=0[v{n}]",
                        dx = offset(&x, t.x * w as f64, "W"),
                        dy = offset(&y, t.y * h as f64, "H"),
                        n = current + 1
                    ));
                }
                None => parts.push(format!(
                    "[v{current}][{layer}]overlay=eof_action=pass:repeatlast=0[v{n}]",
                    n = current + 1
                )),
            }
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
    // ducking: clips that duck listen to the mix of the clips that do not (the "key"). It only happens
    // when there is at least one of each.
    let heard = |c: &&PlannedClip| c.audio;
    let ducking = plan.clips.iter().filter(heard).any(|c| c.duck > 0.0)
        && plan.clips.iter().filter(heard).any(|c| c.duck <= 0.0);
    let mut keys: Vec<String> = Vec::new();
    let mut ducked: Vec<(usize, f64)> = Vec::new();
    for (i, clip) in plan.clips.iter().enumerate().filter(|(_, c)| c.audio) {
        let ms = (clip.start * 1000.0).round() as u64;
        let n = labels.len();
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
        // fades: straight-line ramps in clip time (after the speed change), like the preview's
        let mut fades = String::new();
        if clip.fade_in > 1e-6 {
            fades.push_str(&format!("afade=t=in:st=0:d={:.6},", clip.fade_in));
        }
        if clip.fade_out > 1e-6 {
            fades.push_str(&format!(
                "afade=t=out:st={:.6}:d={:.6},",
                clip.duration - clip.fade_out,
                clip.fade_out
            ));
        }
        // clean-up works on the sound as recorded, before speed changes its pitch
        let clean = clip.clean.as_ref().map(clean_filters).unwrap_or_default();
        parts.push(format!(
            "[{i}:a]aresample={AUDIO_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,{clean}{tempo}\
             volume={vol:.4},asetpts=PTS-STARTPTS,{fades}adelay={ms}|{ms}{end}",
            vol = clip.volume,
            end = match (ducking, clip.duck > 0.0) {
                (false, _) => format!("[a{n}]"),
                (true, true) => format!("[d{n}]"),
                (true, false) => format!(",asplit[a{n}][k{n}]"),
            }
        ));
        if ducking && clip.duck > 0.0 {
            ducked.push((n, clip.duck));
        } else if ducking {
            keys.push(format!("[k{n}]"));
        }
        labels.push(format!("[a{n}]"));
    }
    if ducking {
        // the key is as long as the whole timeline: the ducking filter stops when either input ends
        parts.push(format!(
            "anullsrc=r={AUDIO_RATE}:cl=stereo,atrim=duration={d},asetpts=N/SR/TB[kb]",
            d = secs(plan.duration)
        ));
        let split = if ducked.len() > 1 {
            format!(",asplit={}", ducked.len())
        } else {
            String::new()
        };
        parts.push(format!(
            "[kb]{}amix=inputs={}:normalize=0:duration=first:dropout_transition=0{split}{}",
            keys.concat(),
            keys.len() + 1,
            ducked
                .iter()
                .map(|(n, _)| format!("[key{n}]"))
                .collect::<String>()
        ));
        for (n, amount) in &ducked {
            parts.push(format!("[d{n}][key{n}]{}[a{n}]", duck_filter(*amount)));
        }
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
            "id": "p", "name": "t", "schemaVersion": 7,
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
               "sourceOut": sout, "volume": 1, "x": 0, "y": 0, "scale": 1, "opacity": 1, "fitMode": "fit", "fitBackground": {"kind": "color", "color": "#102030"}})
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
    fn text_pictures_keep_their_transparency_over_the_tracks_below() {
        let mut p = sample();
        p.assets[1].text = Some(crate::media::text::TextSpec {
            content: "Title".into(),
            font_size: 48.0,
            color: "#FFFFFF".into(),
            bold: false,
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
        });
        // even with an image background chosen, a text picture gets no base under it
        p.assets.push(
            serde_json::from_value(json!({"id": "bg", "path": "/m/bg.png", "type": "image"}))
                .unwrap(),
        );
        p.tracks[1].clips[0].fit_background = Some(crate::project::FitBackground {
            kind: BackgroundKind::Image,
            asset_id: Some("bg".into()),
            ..Default::default()
        });
        let mut facts = sample_facts();
        facts.insert(
            "/m/bg.png".into(),
            AssetFacts {
                exists: true,
                has_audio: false,
            },
        );
        let plan = build_plan(&p, &opts(), &facts).unwrap();
        assert!(plan.clips[1].transparent && !plan.clips[0].transparent);
        let g = build_filter_graph(&plan);
        assert!(
            g.graph.contains(
                "[1:v]format=rgba,scale=640:360:force_original_aspect_ratio=decrease,\
                 pad=640:360:(ow-iw)/2:(oh-ih)/2:color=black@0,setsar=1,setpts=PTS-STARTPTS+3.000000/TB[c1]"
            ),
            "{}",
            g.graph
        );
        assert!(!g.graph.contains("[g1]"), "no background under text");
        // a fading text fades its transparency in and out (clip c2 runs 3..5, so it is 2 s long)
        let mut fading = plan.clone();
        (fading.clips[1].fade_in, fading.clips[1].fade_out) = (0.5, 0.25);
        let faded = build_filter_graph(&fading).graph;
        assert!(
            faded.contains("color=black@0,fade=t=in:st=0:d=0.500000:alpha=1,fade=t=out:st=1.750000:d=0.250000:alpha=1,setsar=1"),
            "{faded}"
        );
        assert!(!g.input_args.join(" ").contains("/m/bg.png"));
        assert!(
            g.graph
                .contains("[v1][c1]overlay=eof_action=pass:repeatlast=0[v2]")
        );
    }

    #[test]
    fn crop_is_applied_to_the_source_before_scaling() {
        let mut p = sample();
        p.tracks[0].clips[0].crop = Some(Crop {
            left: 0.25,
            top: 0.1,
            right: 0.25,
            bottom: 0.0,
        });
        p.tracks[1].clips[0].crop = Some(Crop {
            left: 0.0,
            top: 0.0,
            right: 0.5,
            bottom: 0.5,
        });
        let g = build_filter_graph(&build_plan(&p, &opts(), &sample_facts()).unwrap()).graph;
        assert!(
            g.contains(
                "[0:v]fps=30,crop=iw*0.500000:ih*0.900000:iw*0.250000:ih*0.100000,scale=640:360"
            ),
            "{g}"
        );
        assert!(
            g.contains("[1:v]format=rgba,crop=iw*0.500000:ih*0.500000:iw*0.000000:ih*0.000000,scale=640:360"),
            "{g}"
        );
        // an all-zero crop is no crop
        p.tracks[0].clips[0].crop = Some(Crop::default());
        p.tracks[1].clips[0].crop = None;
        let plan = build_plan(&p, &opts(), &sample_facts()).unwrap();
        assert!(plan.clips.iter().all(|c| c.crop.is_none()));
        assert!(!build_filter_graph(&plan).graph.contains("crop=iw"));
        // out of range, or nothing left of the picture
        for bad in [
            Crop {
                left: -0.1,
                ..Default::default()
            },
            Crop {
                top: 0.95,
                ..Default::default()
            },
            Crop {
                left: 0.5,
                right: 0.5,
                ..Default::default()
            },
            Crop {
                bottom: f64::NAN,
                ..Default::default()
            },
        ] {
            p.tracks[0].clips[0].crop = Some(bad);
            let e = build_plan(&p, &opts(), &sample_facts())
                .unwrap_err()
                .join(";");
            assert!(e.contains("crop"), "{bad:?}: {e}");
        }
    }

    #[test]
    fn transitions_in_and_out_share_the_clip_and_fade_its_sound() {
        use crate::project::ClipTransition;
        let tr = |kind: &str, duration: f64| {
            Some(ClipTransition {
                kind: kind.into(),
                duration,
            })
        };
        // sample: video c1 on t1 at 1..5 (4 s long)
        let mut p = sample();
        let c = &mut p.tracks[0].clips[0];
        (c.transition_in, c.transition_out) = (tr("slide-left", 1.0), tr("dissolve", 0.5));
        let plan = build_plan(&p, &opts(), &sample_facts()).unwrap();
        let clip = &plan.clips[0];
        assert_eq!(clip.transition.unwrap().1, 1.0);
        assert_eq!(clip.transition_out.unwrap().1, 0.5);
        assert_eq!(
            (clip.fade_in, clip.fade_out),
            (1.0, 0.5),
            "the sound fades with the picture"
        );
        let g = build_filter_graph(&plan).graph;
        // leaving: opacity goes down over clip time 3.5..4
        assert!(
            g.contains("if(lt((T-1.000000)\\\\,3.500000)\\\\,0.000000"),
            "{g}"
        );
        assert!(
            g.contains("afade=t=in:st=0:d=1.000000,afade=t=out:st=3.500000:d=0.500000"),
            "{g}"
        );

        // longer than the clip: the way in keeps its length, the way out gets what is left
        let c = &mut p.tracks[0].clips[0];
        (c.transition_in, c.transition_out) = (tr("dissolve", 3.0), tr("dissolve", 3.0));
        let squeezed = build_plan(&p, &opts(), &sample_facts()).unwrap();
        assert_eq!(squeezed.clips[0].transition.unwrap().1, 3.0);
        assert_eq!(squeezed.clips[0].transition_out.unwrap().1, 1.0);
        // an unknown kind is refused when the project is checked
        p.tracks[0].clips[0].transition_out = tr("sparkle", 1.0);
        assert!(
            validate(&p)
                .unwrap_err()
                .join(" ")
                .contains("transitionOut.kind")
        );
    }

    #[test]
    fn keyframes_become_expressions_of_clip_time() {
        use crate::project::{Key, Keyframes};
        assert_eq!(piecewise(&[], "T"), "0");
        assert_eq!(piecewise(&[(1.0, 0.5)], "T"), "0.500000");
        assert_eq!(
            piecewise(&[(0.5, -1.0), (2.5, 1.0)], "T"),
            "if(lt(T,0.500000),-1.000000,if(lt(T,2.500000),(-1.000000)+(2.000000)*(T-(0.500000))/2.000000,1.000000))"
        );

        // sample: video c1 on t1 at 1..5, source 2..6. A key at source 3 s is 1 s into the clip.
        let mut p = sample();
        let c = &mut p.tracks[0].clips[0];
        c.keyframes = Some(Keyframes {
            x: Some(vec![Key { t: 3.0, v: 0.0 }, Key { t: 5.0, v: 0.5 }]),
            ..Default::default()
        });
        let plan = build_plan(&p, &opts(), &sample_facts()).unwrap();
        assert_eq!(
            plan.clips[0].motion.as_ref().unwrap().x,
            vec![(1.0, 0.0), (3.0, 0.5)]
        );
        let g = build_filter_graph(&plan).graph;
        assert!(
            g.contains("overlay=x='(W-w)/2+((if(lt((t-1.000000),1.000000),0.000000,"),
            "{g}"
        );
        assert!(
            g.contains(")*W)':y='(H-h)/2+(0.000)':eof_action=pass"),
            "{g}"
        );

        // twice as fast: half as far into the clip; backwards: counted from the other end
        let c = &mut p.tracks[0].clips[0];
        c.speed = Some(2.0);
        assert_eq!(c.motion().unwrap().x, vec![(0.5, 0.0), (1.5, 0.5)]);
        c.reversed = Some(true);
        assert_eq!(c.motion().unwrap().x, vec![(0.5, 0.5), (1.5, 0.0)]);

        // bad keyframes are refused when the project is checked
        let c = &mut p.tracks[0].clips[0];
        c.keyframes = Some(Keyframes {
            scale: Some(vec![Key { t: 3.0, v: 1.0 }, Key { t: 3.0, v: 2.0 }]),
            opacity: Some(vec![Key { t: 0.0, v: 1.5 }]),
            rotation: Some(vec![]),
            ..Default::default()
        });
        let errors = validate(&p).unwrap_err().join("\n");
        for part in [
            "keyframes.scale: keyframes must be in time order",
            "keyframes.opacity: every value",
            "keyframes.rotation: must have 1 to 64",
        ] {
            assert!(errors.contains(part), "{errors}");
        }
    }

    #[test]
    fn transforms_place_the_finished_layer_over_the_tracks_below() {
        let mut p = sample();
        let plain = build_plan(&p, &opts(), &sample_facts()).unwrap();
        assert!(plain.clips.iter().all(|c| c.transform.is_none()));

        // picture-in-picture: half size, moved right and up, a little see-through
        let c = &mut p.tracks[1].clips[0];
        (c.scale, c.x, c.y, c.opacity) = (0.5, 0.25, -0.1, 0.8);
        let g = build_filter_graph(&build_plan(&p, &opts(), &sample_facts()).unwrap()).graph;
        assert!(
            g.contains(
                "[c1]format=rgba,scale=w=iw*0.500000:h=ih*0.500000,colorchannelmixer=aa=0.8000[t1]"
            ),
            "{g}"
        );
        assert!(
            g.contains("[v1][t1]overlay=x=(W-w)/2+(160.000):y=(H-h)/2+(-36.000):eof_action=pass:repeatlast=0[v2]"),
            "{g}"
        );
        assert!(
            g.contains("[v0][c0]overlay=eof_action=pass:repeatlast=0[v1]"),
            "the other clip is untouched"
        );

        // mirror first, then turn (the preview applies them in the same order)
        let c = &mut p.tracks[1].clips[0];
        (c.scale, c.x, c.y, c.opacity) = (1.0, 0.0, 0.0, 1.0);
        (c.rotation, c.flip_h, c.flip_v) = (Some(90.0), Some(true), Some(true));
        let g = build_filter_graph(&build_plan(&p, &opts(), &sample_facts()).unwrap()).graph;
        assert!(
            g.contains("[c1]format=rgba,hflip,vflip,rotate=1.570796:ow=rotw(1.570796):oh=roth(1.570796):c=black@0[t1]"),
            "{g}"
        );
        assert!(g.contains("overlay=x=(W-w)/2+(0.000):y=(H-h)/2+(0.000)"));

        // out-of-range values never reach FFmpeg
        for (field, value) in [
            ("scale", 9.0),
            ("scale", 0.0),
            ("x", 3.0),
            ("y", -2.5),
            ("opacity", 1.5),
        ] {
            let mut bad = sample();
            let c = &mut bad.tracks[1].clips[0];
            match field {
                "scale" => c.scale = value,
                "x" => c.x = value,
                "y" => c.y = value,
                _ => c.opacity = value,
            }
            let e = build_plan(&bad, &opts(), &sample_facts())
                .unwrap_err()
                .join(";");
            assert!(e.contains(field), "{field}={value}: {e}");
        }
        let mut bad = sample();
        bad.tracks[1].clips[0].rotation = Some(200.0);
        assert!(
            build_plan(&bad, &opts(), &sample_facts())
                .unwrap_err()
                .join(";")
                .contains("rotation")
        );
    }

    #[test]
    fn sound_clean_up_is_filtered_before_speed_and_only_where_there_is_sound() {
        let mut p = sample();
        let on = AudioClean {
            noise: 0.5,
            rumble: true,
        };
        p.tracks[0].clips[0].clean = Some(on);
        p.tracks[0].clips[0].speed = Some(2.0);
        let plan = build_plan(&p, &opts(), &sample_facts()).unwrap();
        assert_eq!(plan.clips[0].clean, Some(on));
        let g = build_filter_graph(&plan).graph;
        assert!(
            g.contains("channel_layouts=stereo,highpass=f=80,highpass=f=80,afftdn=nr=15.0:nf=-37.5,atempo=2.000000,volume="),
            "{g}"
        );
        assert_eq!(g.matches("afftdn").count(), 1, "only the clip that asked");

        // switched off, or a clip that makes no sound: nothing is planned
        p.tracks[0].clips[0].clean = Some(AudioClean {
            noise: 0.0,
            rumble: false,
        });
        assert!(
            build_plan(&p, &opts(), &sample_facts()).unwrap().clips[0]
                .clean
                .is_none()
        );
        p.tracks[0].clips[0].clean = Some(on);
        p.tracks[0].clips[0].muted = Some(true);
        assert!(
            build_plan(&p, &opts(), &sample_facts()).unwrap().clips[0]
                .clean
                .is_none()
        );
    }

    #[test]
    fn a_ducking_clip_listens_to_the_clips_that_do_not_duck() {
        // sample: video c1 on t1 at 1..5, music on t3 at 0.5..4.5
        let mut p = sample();
        let music = p
            .tracks
            .iter_mut()
            .find(|t| t.track_type == TrackType::Audio)
            .unwrap();
        music.clips[0].duck = Some(0.5);
        let plan = build_plan(&p, &opts(), &sample_facts()).unwrap();
        let g = build_filter_graph(&plan).graph;
        assert_eq!(g.matches("sidechaincompress").count(), 1, "{g}");
        assert!(g.contains(",asplit[a1][k1]"), "{g}");
        assert!(
            g.contains(
                "[kb][k1]amix=inputs=2:normalize=0:duration=first:dropout_transition=0[key2]"
            ),
            "{g}"
        );
        assert!(
            g.contains("[d2][key2]sidechaincompress=threshold=0.015:ratio=5.75:attack=20:release=500:makeup=1[a2]"),
            "{g}"
        );

        // every sounding clip ducks: there is nothing to duck under, so nothing happens
        for t in p.tracks.iter_mut() {
            t.clips.iter_mut().for_each(|c| c.duck = Some(0.5));
        }
        let all = build_filter_graph(&build_plan(&p, &opts(), &sample_facts()).unwrap()).graph;
        assert!(!all.contains("sidechaincompress"), "{all}");
    }

    #[test]
    fn clip_mute_fades_and_detached_sound_shape_the_mix() {
        // sample: video c1 on t1 at 1..5 (source 2..6), still on t2, music on t3 at 0.5..4.5
        let mut p = sample();
        p.tracks[0].clips[0].muted = Some(true);
        let plan = build_plan(&p, &opts(), &sample_facts()).unwrap();
        assert!(
            plan.clips[0].video && !plan.clips[0].audio,
            "a muted clip keeps its picture"
        );

        // the video's sound, detached onto the audio track: sound only, from the same file
        p.tracks[2]
            .clips
            .push(serde_json::from_value(clip("c4", "v", "t3", 6.0, 2.0, 6.0)).unwrap());
        let c = &mut p.tracks[2].clips[1];
        (c.fade_in, c.fade_out) = (Some(1.0), Some(0.5));
        let plan = build_plan(&p, &opts(), &sample_facts()).unwrap();
        let detached = plan.clips.last().unwrap();
        assert!(!detached.video && detached.audio);
        assert_eq!((detached.fade_in, detached.fade_out), (1.0, 0.5));
        let g = build_filter_graph(&plan).graph;
        assert!(
            g.contains("asetpts=PTS-STARTPTS,afade=t=in:st=0:d=1.000000,afade=t=out:st=3.500000:d=0.500000,adelay=6000|6000"),
            "{g}"
        );
        assert_eq!(
            g.matches("afade").count(),
            2,
            "the other clips have no fades"
        );

        // fades longer than the clip are fitted: the fade-in first, the fade-out gets the rest
        let c = &mut p.tracks[2].clips[1];
        (c.fade_in, c.fade_out) = (Some(3.0), Some(3.0));
        let plan = build_plan(&p, &opts(), &sample_facts()).unwrap();
        let fitted = plan.clips.last().unwrap();
        assert_eq!((fitted.fade_in, fitted.fade_out), (3.0, 1.0));

        // an image has no sound to put on an audio track; a fade must be a sensible length
        let mut bad = sample();
        bad.tracks[2].clips[0].asset_id = "i".into();
        assert!(
            build_plan(&bad, &opts(), &sample_facts())
                .unwrap_err()
                .join(";")
                .contains("audio track")
        );
        let mut bad = sample();
        bad.tracks[2].clips[0].fade_out = Some(-1.0);
        assert!(
            build_plan(&bad, &opts(), &sample_facts())
                .unwrap_err()
                .join(";")
                .contains("fadeOut")
        );
    }

    #[test]
    fn colour_is_one_baked_table_applied_to_the_picture() {
        let mut p = sample();
        let warm = ColorAdjust {
            temperature: 0.5,
            contrast: 0.2,
            ..Default::default()
        };
        p.tracks[0].clips[0].color = Some(warm);
        p.tracks[1].clips[0].color = Some(ColorAdjust::default()); // nothing set: no colour step
        p.tracks[2].clips[0].color = Some(warm); // sound has no picture
        let mut plan = build_plan(&p, &opts(), &sample_facts()).unwrap();
        assert_eq!(plan.clips[0].color, Some(warm));
        assert!(plan.clips[1].color.is_none() && plan.clips[2].color.is_none());
        assert!(
            plan.clips.iter().all(|c| c.lut.is_none()),
            "planning writes no files"
        );
        assert!(
            !build_filter_graph(&plan).graph.contains("lut3d"),
            "no table yet, no colour step"
        );

        plan.clips[0].lut = Some(PathBuf::from("/cache/luts/abc.cube"));
        let g = build_filter_graph(&plan).graph;
        assert!(
            g.contains("[0:v]fps=30,lut3d=file='/cache/luts/abc.cube',scale=640:360"),
            "{g}"
        );
        assert_eq!(g.matches("lut3d").count(), 1);
        // with a crop: crop first, then colour, then the fit
        plan.clips[0].crop = Some(Crop {
            left: 0.5,
            ..Default::default()
        });
        let g = build_filter_graph(&plan).graph;
        assert!(
            g.contains("ih*0.000000,lut3d=file='/cache/luts/abc.cube',scale="),
            "{g}"
        );

        // an imported LUT is planned for pictures only, and only when it does something
        let lut = |intensity| {
            Some(ClipLut {
                id: "0123456789abcdef01234567".into(),
                name: "Film".into(),
                intensity,
            })
        };
        let mut p = sample();
        p.tracks[0].clips[0].lut = lut(0.8);
        p.tracks[1].clips[0].lut = lut(0.0);
        p.tracks[2].clips[0].lut = lut(1.0); // sound has no picture
        let mut plan = build_plan(&p, &opts(), &sample_facts()).unwrap();
        assert_eq!(plan.clips[0].user_lut, lut(0.8));
        assert!(plan.clips[1].user_lut.is_none() && plan.clips[2].user_lut.is_none());
        assert!(plan.clips.iter().all(|c| c.lut.is_none()));
        // it is not on this computer: the export stops and names it
        let nowhere = std::env::temp_dir().join("cutvii-no-such-luts");
        let message = plan.bake_user_luts(&nowhere).unwrap_err().to_string();
        assert!(message.contains("\"Film\""), "{message}");
        for (field, value) in [
            ("id", json!("../../etc/passwd")),
            ("intensity", json!(1.5)),
            ("name", json!("")),
        ] {
            let mut bad = serde_json::to_value(sample()).unwrap();
            bad["tracks"][0]["clips"][0]["lut"] =
                json!({"id": "0123456789abcdef01234567", "name": "Film", "intensity": 1});
            bad["tracks"][0]["clips"][0]["lut"][field] = value;
            let bad: Project = serde_json::from_value(bad).unwrap();
            assert!(
                build_plan(&bad, &opts(), &sample_facts())
                    .unwrap_err()
                    .join(";")
                    .contains(&format!("lut.{field}")),
                "{field}"
            );
        }

        let mut bad = sample();
        bad.tracks[0].clips[0].color = Some(ColorAdjust {
            exposure: 3.0,
            ..Default::default()
        });
        assert!(
            build_plan(&bad, &opts(), &sample_facts())
                .unwrap_err()
                .join(";")
                .contains("color")
        );
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
        assert!(g.contains("[bl0][s0]overlay=x=(W-w)/2:y=(H-h)/2,format=yuv420p,setsar=1"));

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
    fn fit_background_sets_the_bar_colour_an_image_input_and_the_blur_amount() {
        use crate::project::FitBackground;
        let bg = |kind, color: Option<&str>, asset: Option<&str>, blur| {
            Some(FitBackground {
                kind,
                color: color.map(String::from),
                asset_id: asset.map(String::from),
                blur,
            })
        };
        let graph =
            |p: &Project| build_filter_graph(&build_plan(p, &opts(), &sample_facts()).unwrap());

        // absent = black, whatever the project background is
        let mut p = sample();
        p.tracks[0].clips[0].fit_background = None;
        let plan = build_plan(&p, &opts(), &sample_facts()).unwrap();
        assert_eq!(
            (plan.clips[0].bg_color.as_str(), plan.clips[0].blur_amount),
            ("#000000", 30.0)
        );
        assert!(
            graph(&p)
                .graph
                .contains("pad=640:360:(ow-iw)/2:(oh-ih)/2:color=0x000000")
        );

        p.tracks[0].clips[0].fit_background =
            bg(BackgroundKind::Color, Some("#AA5500"), None, None);
        assert!(
            graph(&p)
                .graph
                .contains("pad=640:360:(ow-iw)/2:(oh-ih)/2:color=0xAA5500")
        );

        // an image background becomes one extra looped input after the three clip inputs, covering the canvas
        p.tracks[0].clips[0].fit_background = bg(BackgroundKind::Image, None, Some("i"), None);
        let g = graph(&p);
        let args = g.input_args.join(" ");
        assert_eq!(args.matches("-i /m/i.png").count(), 2, "{args}"); // the still clip itself + the background
        assert!(
            args.ends_with("-loop 1 -framerate 30 -t 4.000000 -i /m/i.png"),
            "{args}"
        );
        assert!(
            g.graph.contains(
                "[3:v]scale=640:360:force_original_aspect_ratio=increase,crop=640:360,setsar=1[g0]"
            ),
            "{}",
            g.graph
        );
        assert!(
            g.graph
                .contains("[g0][s0]overlay=x=(W-w)/2:y=(H-h)/2:format=auto:shortest=1")
        );
        assert!(
            !g.graph
                .contains("[0:v]fps=30,scale=640:360:force_original_aspect_ratio=decrease,pad=")
        );

        // a filled video needs no background input at all
        p.tracks[0].clips[0].fit_mode = Some(FitMode::Fill);
        assert_eq!(
            graph(&p)
                .input_args
                .join(" ")
                .matches("-i /m/i.png")
                .count(),
            1
        );

        // blur amount: 0 = no blur filter, 100 = 10 % of the canvas height
        p.tracks[0].clips[0].fit_mode = Some(FitMode::BlurBg);
        p.tracks[0].clips[0].fit_background = bg(BackgroundKind::Black, None, None, Some(0.0));
        assert!(!graph(&p).graph.contains("gblur"));
        p.tracks[0].clips[0].fit_background = bg(BackgroundKind::Black, None, None, Some(100.0));
        assert!(graph(&p).graph.contains("gblur=sigma=36.0[bl0]"));

        // a missing background image stops the export with a clear reason
        p.tracks[0].clips[0].fit_mode = Some(FitMode::Fit);
        p.tracks[0].clips[0].fit_background = bg(BackgroundKind::Image, None, Some("i"), None);
        let mut facts = sample_facts();
        facts.insert(
            "/m/i.png".into(),
            AssetFacts {
                exists: false,
                has_audio: false,
            },
        );
        let e = build_plan(&p, &opts(), &facts).unwrap_err().join("; ");
        assert!(e.contains("background image is missing: /m/i.png"), "{e}");
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
