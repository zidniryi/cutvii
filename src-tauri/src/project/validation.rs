use std::collections::{HashMap, HashSet};

use super::model::*;
use crate::media::MediaType;

const DURATION_EPSILON: f64 = 1e-3;
const MAX_VOLUME: f64 = 2.0;
pub const MIN_SIDE: u32 = 16;
pub const MAX_SIDE: u32 = 8192;
pub const MIN_FPS: f64 = 1.0;
pub const MAX_FPS: f64 = 120.0;

fn is_hex_color(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].chars().all(|c| c.is_ascii_hexdigit())
}

/// Same rules as the Zod schema. Returns every problem found, not just the first.
/// Note: timestamps are only checked for being non-empty (no date parser in the Rust side yet).
pub fn validate(project: &Project) -> Result<(), Vec<String>> {
    let mut errors = Vec::new();
    let mut err = |msg: String| errors.push(msg);

    if project.schema_version != SCHEMA_VERSION {
        err(format!(
            "schemaVersion: unsupported version {}",
            project.schema_version
        ));
    }
    if project.id.is_empty() || project.name.is_empty() {
        err("id and name must not be empty".into());
    }
    if project.created_at.is_empty() || project.modified_at.is_empty() {
        err("createdAt/modifiedAt must not be empty".into());
    }

    let s = &project.settings;
    for (name, side) in [("width", s.width), ("height", s.height)] {
        if !(MIN_SIDE..=MAX_SIDE).contains(&side) {
            err(format!(
                "settings.{name}: must be between {MIN_SIDE} and {MAX_SIDE} px"
            ));
        } else if !side.is_multiple_of(2) {
            err(format!("settings.{name}: must be an even number"));
        }
    }
    if !(MIN_FPS..=MAX_FPS).contains(&s.fps) {
        err(format!(
            "settings.fps: must be between {MIN_FPS} and {MAX_FPS}"
        ));
    }
    match (s.fps_num, s.fps_den) {
        (None, None) => {}
        (Some(n), Some(d)) if n > 0 && d > 0 => {
            if (n as f64 / d as f64 - s.fps).abs() > 1e-6 {
                err(format!(
                    "settings.fps: {} does not match the exact rate {n}/{d}",
                    s.fps
                ));
            }
        }
        _ => err(
            "settings.fpsNum/fpsDen: must both be positive whole numbers, or both absent".into(),
        ),
    }
    if !is_hex_color(&s.background_color) {
        err("settings.backgroundColor: must be a #RRGGBB color".into());
    }

    let mut assets: HashMap<&str, &MediaAsset> = HashMap::new();
    for (i, a) in project.assets.iter().enumerate() {
        if a.id.is_empty() || a.path.is_empty() {
            err(format!("assets.{i}: id and path must not be empty"));
        }
        if a.fps_num.is_some() != a.fps_den.is_some()
            || a.fps_num == Some(0)
            || a.fps_den == Some(0)
        {
            err(format!(
                "assets.{i}.fpsNum/fpsDen: must both be positive whole numbers, or both absent"
            ));
        }
        if let Some(text) = &a.text {
            if a.media_type != MediaType::Image {
                err(format!("assets.{i}.text: only an image asset can be text"));
            }
            if let Err(e) = text.validate() {
                err(format!("assets.{i}.text: {e}"));
            }
        }
        if a.duration.is_some_and(|d| d < 0.0) {
            err(format!("assets.{i}.duration: must not be negative"));
        }
        if assets.insert(a.id.as_str(), a).is_some() {
            err(format!("assets.{i}.id: duplicate asset id \"{}\"", a.id));
        }
    }

    let mut track_ids = HashSet::new();
    let mut clip_ids = HashSet::new();
    for (ti, track) in project.tracks.iter().enumerate() {
        if !track_ids.insert(track.id.as_str()) {
            err(format!(
                "tracks.{ti}.id: duplicate track id \"{}\"",
                track.id
            ));
        }
        for (ci, clip) in track.clips.iter().enumerate() {
            let at = format!("tracks.{ti}.clips.{ci}");
            if !clip_ids.insert(clip.id.as_str()) {
                err(format!("{at}.id: duplicate clip id \"{}\"", clip.id));
            }
            if clip.track_id != track.id {
                err(format!(
                    "{at}.trackId: \"{}\" does not match its track",
                    clip.track_id
                ));
            }
            if clip.source_out <= clip.source_in {
                err(format!(
                    "{at}.sourceOut: sourceOut must be greater than sourceIn"
                ));
            }
            if clip.timeline_start < 0.0 || clip.source_in < 0.0 {
                err(format!(
                    "{at}: timelineStart and sourceIn must not be negative"
                ));
            }
            if !(0.0..=MAX_VOLUME).contains(&clip.volume) {
                err(format!("{at}.volume: must be between 0 and {MAX_VOLUME}"));
            }
            if let Some(bg) = &clip.fit_background {
                if bg
                    .blur
                    .is_some_and(|b| !(0.0..=MAX_BLUR_AMOUNT).contains(&b))
                {
                    err(format!(
                        "{at}.fitBackground.blur: must be between 0 and {MAX_BLUR_AMOUNT}"
                    ));
                }
                match bg.kind {
                    BackgroundKind::Black => {}
                    BackgroundKind::Color => {
                        if !bg.color.as_deref().is_some_and(is_hex_color) {
                            err(format!("{at}.fitBackground.color: must be a #RRGGBB color"));
                        }
                    }
                    BackgroundKind::Image => {
                        match bg.asset_id.as_deref().and_then(|id| assets.get(id)) {
                            Some(a) if a.media_type == MediaType::Image => {}
                            Some(_) => err(format!(
                                "{at}.fitBackground.assetId: the background must be an image"
                            )),
                            None => err(format!("{at}.fitBackground.assetId: unknown image asset")),
                        }
                    }
                }
            }
            if clip
                .speed
                .is_some_and(|v| !(MIN_SPEED..=MAX_SPEED).contains(&v))
            {
                err(format!(
                    "{at}.speed: must be between {MIN_SPEED} and {MAX_SPEED}"
                ));
            }
            if !(0.0..=1.0).contains(&clip.opacity) {
                err(format!("{at}.opacity: must be between 0 and 1"));
            }
            if !(clip.scale > 0.0 && clip.scale.is_finite()) {
                err(format!("{at}.scale: must be positive"));
            }
            if !(clip.x.is_finite() && clip.y.is_finite()) {
                err(format!("{at}: x and y must be finite"));
            }

            let Some(asset) = assets.get(clip.asset_id.as_str()) else {
                err(format!("{at}.assetId: unknown asset \"{}\"", clip.asset_id));
                continue;
            };
            match (track.track_type, asset.media_type) {
                (TrackType::Audio, MediaType::Audio)
                | (TrackType::Video, MediaType::Video | MediaType::Image) => {}
                (TrackType::Audio, other) => err(format!(
                    "{at}.assetId: {other:?} asset cannot be placed on an audio track"
                )),
                (TrackType::Video, MediaType::Audio) => err(format!(
                    "{at}.assetId: audio asset cannot be placed on a video track"
                )),
            }
            if asset
                .duration
                .is_some_and(|d| clip.source_out > d + DURATION_EPSILON)
            {
                err(format!("{at}.sourceOut: exceeds asset duration"));
            }
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Project {
        serde_json::from_str(include_str!("../../../fixtures/project-v5.json"))
            .expect("fixture parses")
    }

    #[test]
    fn fixture_is_valid_and_round_trips() {
        let p = fixture();
        assert!(validate(&p).is_ok());
        let json = serde_json::to_string(&p).unwrap();
        assert_eq!(serde_json::from_str::<Project>(&json).unwrap(), p);
    }

    #[test]
    fn unknown_fields_are_rejected() {
        let mut v: serde_json::Value =
            serde_json::from_str(include_str!("../../../fixtures/project-v5.json")).unwrap();
        v["extra"] = 1.into();
        assert!(serde_json::from_value::<Project>(v).is_err());
    }

    fn first_error(mutate: impl FnOnce(&mut Project)) -> String {
        let mut p = fixture();
        mutate(&mut p);
        validate(&p).expect_err("should be invalid").join("\n")
    }

    #[test]
    fn rejects_bad_clips() {
        assert!(
            first_error(|p| p.tracks[0].clips[0].source_out = 1.0)
                .contains("greater than sourceIn")
        );
        assert!(
            first_error(|p| p.tracks[0].clips[0].asset_id = "nope".into())
                .contains("unknown asset")
        );
        assert!(
            first_error(|p| p.tracks[0].clips[0].track_id = "other".into())
                .contains("does not match")
        );
        assert!(
            first_error(|p| p.tracks[1].clips[0].asset_id = "asset-image".into())
                .contains("audio track")
        );
        assert!(
            first_error(|p| p.tracks[0].clips[0].asset_id = "asset-audio".into())
                .contains("video track")
        );
        assert!(
            first_error(|p| p.tracks[0].clips[0].source_out = 99.0)
                .contains("exceeds asset duration")
        );
        assert!(
            first_error(|p| p.tracks[1].clips[0].id = "clip-1".into())
                .contains("duplicate clip id")
        );
        assert!(first_error(|p| p.tracks[0].clips[0].opacity = 1.5).contains("opacity"));
    }

    #[test]
    fn enforces_canvas_limits_with_clear_messages() {
        assert!(
            first_error(|p| p.settings.width = 15)
                .contains("settings.width: must be between 16 and 8192")
        );
        assert!(
            first_error(|p| p.settings.height = 8194)
                .contains("settings.height: must be between 16 and 8192")
        );
        assert!(
            first_error(|p| p.settings.width = 1921)
                .contains("settings.width: must be an even number")
        );
        assert!(
            first_error(|p| p.settings.fps = 0.5)
                .contains("settings.fps: must be between 1 and 120")
        );
        assert!(
            first_error(|p| p.settings.fps = 121.0)
                .contains("settings.fps: must be between 1 and 120")
        );
        // boundaries are valid
        let mut p = fixture();
        p.settings.width = 16;
        p.settings.height = 8192;
        p.settings.fps = 120.0;
        assert!(validate(&p).is_ok());
    }

    #[test]
    fn checks_the_exact_frame_rate_is_consistent() {
        let mut p = fixture();
        p.settings.fps_num = Some(30000);
        p.settings.fps_den = Some(1001);
        p.settings.fps = 30000.0 / 1001.0;
        assert!(validate(&p).is_ok());
        p.settings.fps = 30.0; // does not match 30000/1001
        assert!(
            validate(&p)
                .unwrap_err()
                .join(";")
                .contains("does not match the exact rate")
        );
        p.settings.fps_den = None;
        assert!(
            validate(&p)
                .unwrap_err()
                .join(";")
                .contains("both be positive")
        );
        assert!(first_error(|p| p.assets[0].fps_num = Some(30)).contains("assets.0.fpsNum/fpsDen"));
    }

    #[test]
    fn speed_must_be_within_range() {
        assert!(
            first_error(|p| p.tracks[0].clips[0].speed = Some(0.05))
                .contains("speed: must be between 0.1 and 10")
        );
        assert!(first_error(|p| p.tracks[0].clips[0].speed = Some(10.5)).contains("speed"));
        let mut p = fixture();
        p.tracks[0].clips[0].speed = Some(0.1);
        p.tracks[1].clips[0].speed = Some(10.0);
        assert!(validate(&p).is_ok());
        assert_eq!(p.tracks[0].clips[0].timeline_duration(), 50.0); // 5 s of source at 0.1x
    }

    #[test]
    fn fit_background_must_be_complete_and_point_at_an_image() {
        let bg = |kind, color: Option<&str>, asset: Option<&str>, blur| FitBackground {
            kind,
            color: color.map(String::from),
            asset_id: asset.map(String::from),
            blur,
        };
        let set =
            |b: FitBackground| first_error(move |p| p.tracks[0].clips[0].fit_background = Some(b));
        assert!(set(bg(BackgroundKind::Color, None, None, None)).contains("fitBackground.color"));
        assert!(set(bg(BackgroundKind::Color, Some("red"), None, None)).contains("#RRGGBB"));
        assert!(set(bg(BackgroundKind::Image, None, None, None)).contains("unknown image asset"));
        assert!(
            set(bg(BackgroundKind::Image, None, Some("asset-video"), None))
                .contains("must be an image")
        );
        assert!(
            set(bg(BackgroundKind::Black, None, None, Some(150.0))).contains("fitBackground.blur")
        );

        let mut p = fixture();
        p.tracks[0].clips[0].fit_background = Some(bg(
            BackgroundKind::Image,
            None,
            Some("asset-image"),
            Some(0.0),
        ));
        p.tracks[0].clips[1].fit_background = Some(bg(
            BackgroundKind::Color,
            Some("#1A2b3C"),
            None,
            Some(100.0),
        ));
        assert!(validate(&p).is_ok());
    }

    #[test]
    fn rejects_bad_settings_and_version() {
        assert!(first_error(|p| p.settings.background_color = "red".into()).contains("#RRGGBB"));
        assert!(first_error(|p| p.schema_version = 99).contains("schemaVersion"));
    }
}
