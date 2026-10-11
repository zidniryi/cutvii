//! Pure helpers for interpreting files and ffprobe output (no process spawning, easy to test).

use std::path::Path;

use serde::Deserialize;

use super::{MediaInfo, MediaType};
use crate::errors::{AppError, AppResult};

const VIDEO_EXT: &[&str] = &["mp4", "mov", "m4v", "mkv", "webm", "avi"];
const AUDIO_EXT: &[&str] = &["mp3", "wav", "flac", "m4a", "aac", "ogg", "opus"];
const IMAGE_EXT: &[&str] = &["png", "jpg", "jpeg", "webp", "bmp"];

pub fn image_extensions() -> impl Iterator<Item = &'static str> {
    IMAGE_EXT.iter().copied()
}

pub fn supported_extensions() -> impl Iterator<Item = &'static str> {
    VIDEO_EXT.iter().chain(AUDIO_EXT).chain(IMAGE_EXT).copied()
}

/// Decide the media type from the extension (allowlist). ffprobe then verifies the content.
pub fn classify_extension(path: &Path) -> Option<MediaType> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    let ext = ext.as_str();
    if VIDEO_EXT.contains(&ext) {
        Some(MediaType::Video)
    } else if AUDIO_EXT.contains(&ext) {
        Some(MediaType::Audio)
    } else if IMAGE_EXT.contains(&ext) {
        Some(MediaType::Image)
    } else {
        None
    }
}

#[derive(Deserialize)]
struct ProbeOutput {
    #[serde(default)]
    streams: Vec<Stream>,
    format: Option<Format>,
}

#[derive(Deserialize)]
struct Stream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    channels: Option<u32>,
    sample_rate: Option<String>,
    color_transfer: Option<String>,
    color_primaries: Option<String>,
    color_space: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    duration: Option<String>,
    avg_frame_rate: Option<String>,
    r_frame_rate: Option<String>,
    #[serde(default)]
    side_data_list: Vec<SideData>,
    tags: Option<StreamTags>,
}

#[derive(Deserialize)]
struct SideData {
    /// Display Matrix rotation in degrees (counter-clockwise, e.g. -90 for a phone held upright).
    rotation: Option<f64>,
}

#[derive(Deserialize)]
struct StreamTags {
    /// Older containers store rotation as a tag.
    rotate: Option<String>,
}

fn gcd(a: u32, b: u32) -> u32 {
    if b == 0 { a } else { gcd(b, a % b) }
}

/// "30000/1001" -> (30000, 1001), reduced. "0/0" and garbage are rejected.
fn parse_rate(s: &str) -> Option<(u32, u32)> {
    let (n, d) = s.split_once('/')?;
    let (n, d) = (n.trim().parse::<u32>().ok()?, d.trim().parse::<u32>().ok()?);
    if n == 0 || d == 0 {
        return None;
    }
    let g = gcd(n, d);
    Some((n / g, d / g))
}

/// The average rate is what players show; fall back to the stream's base rate when it is unknown.
fn stream_rate(v: &Stream) -> Option<(u32, u32)> {
    v.avg_frame_rate
        .as_deref()
        .and_then(parse_rate)
        .or_else(|| v.r_frame_rate.as_deref().and_then(parse_rate))
}

/// Clockwise-agnostic quarter turns: true when the picture is displayed rotated by 90 or 270 degrees.
fn is_quarter_turn(v: &Stream) -> bool {
    let degrees = v
        .side_data_list
        .iter()
        .find_map(|d| d.rotation)
        .or_else(|| {
            v.tags
                .as_ref()
                .and_then(|t| t.rotate.as_deref())
                .and_then(|r| r.trim().parse::<f64>().ok())
        })
        .unwrap_or(0.0);
    let norm = ((degrees.round() as i64 % 360) + 360) % 360;
    norm == 90 || norm == 270
}

#[derive(Deserialize)]
struct Format {
    duration: Option<String>,
    bit_rate: Option<String>,
    format_long_name: Option<String>,
}

fn parse_seconds(s: &Option<String>) -> Option<f64> {
    s.as_deref()?
        .parse::<f64>()
        .ok()
        .filter(|d| d.is_finite() && *d >= 0.0)
}

/// Turn `ffprobe -print_format json -show_format -show_streams` output into [`MediaInfo`],
/// checking that the file actually contains the stream kind its extension promised.
pub fn parse_probe_json(json: &str, media_type: MediaType) -> AppResult<MediaInfo> {
    let out: ProbeOutput = serde_json::from_str(json)
        .map_err(|e| AppError::InvalidInput(format!("unreadable ffprobe output: {e}")))?;

    let video = out
        .streams
        .iter()
        .find(|s| s.codec_type.as_deref() == Some("video"));
    let has_audio = out
        .streams
        .iter()
        .any(|s| s.codec_type.as_deref() == Some("audio"));

    match media_type {
        MediaType::Video | MediaType::Image if video.is_none() => {
            return Err(AppError::InvalidInput("file has no video stream".into()));
        }
        MediaType::Audio if !has_audio => {
            return Err(AppError::InvalidInput("file has no audio stream".into()));
        }
        _ => {}
    }

    let duration = match media_type {
        MediaType::Image => None,
        _ => out
            .format
            .as_ref()
            .and_then(|f| parse_seconds(&f.duration))
            .or_else(|| out.streams.iter().find_map(|s| parse_seconds(&s.duration))),
    };
    // Dimensions are the *displayed* ones: a 1920x1080 clip rotated by 90 degrees is 1080x1920.
    let (width, height) = match (media_type, video) {
        (MediaType::Audio, _) | (_, None) => (None, None),
        (_, Some(v)) => {
            let (w, h) = (v.width.filter(|w| *w > 0), v.height.filter(|h| *h > 0));
            if is_quarter_turn(v) { (h, w) } else { (w, h) }
        }
    };
    let rate = match (media_type, video) {
        (MediaType::Video, Some(v)) => stream_rate(v),
        _ => None,
    };

    Ok(MediaInfo {
        media_type,
        duration,
        width,
        height,
        fps_num: rate.map(|r| r.0),
        fps_den: rate.map(|r| r.1),
    })
}

#[derive(Deserialize)]
struct FramesOutput {
    #[serde(default)]
    frames: Vec<Frame>,
}

#[derive(Deserialize)]
struct Frame {
    #[serde(default)]
    side_data_list: Vec<SideData>,
}

/// Rotation (degrees) found in the first frame's side data, e.g. an image's EXIF orientation, which FFprobe
/// reports as a display matrix on the *frame* and not on the stream.
pub fn parse_frame_rotation(json: &str) -> Option<f64> {
    let out: FramesOutput = serde_json::from_str(json).ok()?;
    out.frames
        .first()?
        .side_data_list
        .iter()
        .find_map(|d| d.rotation)
}

/// Swap width and height when a rotation of 90 or 270 degrees is displayed.
pub fn apply_rotation(info: &mut MediaInfo, degrees: f64) {
    let norm = ((degrees.round() as i64 % 360) + 360) % 360;
    if (norm == 90 || norm == 270) && info.width.is_some() && info.height.is_some() {
        std::mem::swap(&mut info.width, &mut info.height);
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct StreamSummary {
    pub has_video: bool,
    pub has_audio: bool,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub duration: Option<f64>,
    /// Frame rate of the first video stream, when known.
    pub fps: Option<f64>,
}

/// Facts about a media file shown in the inspector's Info tab. Nothing here is stored in the project.
#[derive(Debug, Clone, PartialEq, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaDetails {
    /// For example "h264"; absent when the file has no picture.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_codec: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_codec: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_channels: Option<u32>,
    /// Hz.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_rate: Option<u32>,
    /// Bits per second for the whole file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bit_rate: Option<u64>,
    /// The container as FFprobe names it, for example "QuickTime / MOV".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub container: Option<String>,
    /// The picture is HDR or wide-gamut (PQ / HLG transfer, or BT.2020 colours). CutVii's colour tools
    /// assume standard dynamic range (Rec.709), so such footage gets a warning.
    pub hdr: bool,
    /// Size of the file on disk, filled in by the caller.
    pub size_bytes: u64,
}

/// PQ (HDR10, Dolby Vision) or HLG transfer, or BT.2020 primaries / matrix.
fn is_hdr(video: &Stream) -> bool {
    let has = |field: &Option<String>, names: &[&str]| {
        field.as_deref().is_some_and(|v| names.contains(&v))
    };
    has(&video.color_transfer, &["smpte2084", "arib-std-b67"])
        || has(&video.color_primaries, &["bt2020"])
        || has(&video.color_space, &["bt2020nc", "bt2020c"])
}

/// Codec and container facts from ffprobe output (`-show_format -show_streams`).
pub fn parse_details(json: &str) -> AppResult<MediaDetails> {
    let out: ProbeOutput = serde_json::from_str(json)
        .map_err(|e| AppError::InvalidInput(format!("unreadable ffprobe output: {e}")))?;
    let first = |kind: &str| {
        out.streams
            .iter()
            .find(|s| s.codec_type.as_deref() == Some(kind))
    };
    let audio = first("audio");
    Ok(MediaDetails {
        video_codec: first("video").and_then(|s| s.codec_name.clone()),
        audio_codec: audio.and_then(|s| s.codec_name.clone()),
        audio_channels: audio.and_then(|s| s.channels),
        sample_rate: audio
            .and_then(|s| s.sample_rate.as_deref())
            .and_then(|r| r.parse().ok()),
        bit_rate: out
            .format
            .as_ref()
            .and_then(|f| f.bit_rate.as_deref())
            .and_then(|r| r.parse().ok()),
        container: out.format.as_ref().and_then(|f| f.format_long_name.clone()),
        hdr: first("video").is_some_and(is_hdr),
        size_bytes: 0,
    })
}

/// Type-agnostic view of ffprobe output (used to detect audio streams and to verify exports).
pub fn parse_stream_summary(json: &str) -> AppResult<StreamSummary> {
    let out: ProbeOutput = serde_json::from_str(json)
        .map_err(|e| AppError::InvalidInput(format!("unreadable ffprobe output: {e}")))?;
    let video = out
        .streams
        .iter()
        .find(|s| s.codec_type.as_deref() == Some("video"));
    Ok(StreamSummary {
        has_video: video.is_some(),
        has_audio: out
            .streams
            .iter()
            .any(|s| s.codec_type.as_deref() == Some("audio")),
        width: video.and_then(|v| v.width),
        height: video.and_then(|v| v.height),
        duration: out.format.as_ref().and_then(|f| parse_seconds(&f.duration)),
        fps: video
            .and_then(stream_rate)
            .map(|(n, d)| n as f64 / d as f64),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const VIDEO_JSON: &str = r#"{"streams":[{"codec_type":"video","width":1920,"height":1080,"duration":"12.500000"},{"codec_type":"audio","duration":"12.48"}],"format":{"duration":"12.500000"}}"#;
    const AUDIO_JSON: &str = r#"{"streams":[{"codec_type":"audio","duration":"60.0"}],"format":{"duration":"60.026000"}}"#;
    const IMAGE_JSON: &str = r#"{"streams":[{"codec_type":"video","width":512,"height":256}],"format":{"duration":"0.040000"}}"#;

    #[test]
    fn details_name_the_codecs_container_and_bit_rate() {
        let json = r#"{"streams":[
            {"codec_type":"video","codec_name":"h264","width":1920,"height":1080},
            {"codec_type":"audio","codec_name":"aac","channels":2,"sample_rate":"48000"}],
            "format":{"duration":"12.5","bit_rate":"8123456","format_long_name":"QuickTime / MOV"}}"#;
        assert_eq!(
            parse_details(json).unwrap(),
            MediaDetails {
                video_codec: Some("h264".into()),
                audio_codec: Some("aac".into()),
                audio_channels: Some(2),
                sample_rate: Some(48000),
                bit_rate: Some(8_123_456),
                container: Some("QuickTime / MOV".into()),
                hdr: false,
                size_bytes: 0,
            }
        );
        // sound only, and a file that says little about itself
        let audio = parse_details(AUDIO_JSON).unwrap();
        assert_eq!(
            (audio.video_codec, audio.audio_codec, audio.bit_rate),
            (None, None, None)
        );
        assert!(parse_details("nope").is_err());
        // absent facts are left out of what the UI receives
        let sent = serde_json::to_value(parse_details(IMAGE_JSON).unwrap()).unwrap();
        assert_eq!(sent, serde_json::json!({"sizeBytes": 0, "hdr": false}));
        // HDR and wide-gamut footage is recognised by its tags
        for tags in [
            r#""color_transfer":"smpte2084""#,
            r#""color_transfer":"arib-std-b67","pix_fmt":"yuv420p10le""#,
            r#""color_primaries":"bt2020""#,
            r#""color_space":"bt2020nc""#,
        ] {
            let json =
                format!(r#"{{"streams":[{{"codec_type":"video","codec_name":"hevc",{tags}}}]}}"#);
            assert!(parse_details(&json).unwrap().hdr, "{tags}");
        }
        let sdr = r#"{"streams":[{"codec_type":"video","color_transfer":"bt709","color_primaries":"bt709","color_space":"bt709","pix_fmt":"yuv420p"}]}"#;
        assert!(!parse_details(sdr).unwrap().hdr);
    }

    #[test]
    fn classifies_by_extension_case_insensitively() {
        assert_eq!(
            classify_extension(Path::new("a.MP4")),
            Some(MediaType::Video)
        );
        assert_eq!(
            classify_extension(Path::new("a.flac")),
            Some(MediaType::Audio)
        );
        assert_eq!(
            classify_extension(Path::new("a.JPG")),
            Some(MediaType::Image)
        );
        assert_eq!(classify_extension(Path::new("a.exe")), None);
        assert_eq!(classify_extension(Path::new("noext")), None);
    }

    #[test]
    fn parses_video_audio_and_image() {
        let v = parse_probe_json(VIDEO_JSON, MediaType::Video).unwrap();
        assert_eq!(
            (v.duration, v.width, v.height),
            (Some(12.5), Some(1920), Some(1080))
        );

        let a = parse_probe_json(AUDIO_JSON, MediaType::Audio).unwrap();
        assert_eq!((a.duration, a.width), (Some(60.026), None));

        let i = parse_probe_json(IMAGE_JSON, MediaType::Image).unwrap();
        assert_eq!(
            (i.duration, i.width, i.height),
            (None, Some(512), Some(256))
        );
    }

    fn video_json(extra_stream_fields: &str) -> String {
        format!(
            r#"{{"streams":[{{"codec_type":"video","width":1920,"height":1080,"avg_frame_rate":"30000/1001","r_frame_rate":"30000/1001"{extra_stream_fields}}}],"format":{{"duration":"5.0"}}}}"#
        )
    }

    #[test]
    fn keeps_the_frame_rate_as_an_exact_reduced_fraction() {
        let info = parse_probe_json(&video_json(""), MediaType::Video).unwrap();
        assert_eq!((info.fps_num, info.fps_den), (Some(30000), Some(1001)));

        // reduced, not just copied
        let j = video_json("").replace("30000/1001", "60000/2002");
        let info = parse_probe_json(&j, MediaType::Video).unwrap();
        assert_eq!((info.fps_num, info.fps_den), (Some(30000), Some(1001)));

        // unknown average rate falls back to the base rate; nothing usable -> none
        let j = video_json("")
            .replacen(
                "\"avg_frame_rate\":\"30000/1001\"",
                "\"avg_frame_rate\":\"0/0\"",
                1,
            )
            .replace("30000/1001", "24000/1001");
        let info = parse_probe_json(&j, MediaType::Video).unwrap();
        assert_eq!((info.fps_num, info.fps_den), (Some(24000), Some(1001)));
        let none = r#"{"streams":[{"codec_type":"video","width":10,"height":10,"avg_frame_rate":"0/0","r_frame_rate":"0/0"}],"format":{}}"#;
        assert_eq!(
            parse_probe_json(none, MediaType::Video).unwrap().fps_num,
            None
        );
    }

    #[test]
    fn images_and_audio_have_no_frame_rate() {
        let img = r#"{"streams":[{"codec_type":"video","width":512,"height":256,"avg_frame_rate":"25/1","r_frame_rate":"25/1"}],"format":{}}"#;
        assert_eq!(
            parse_probe_json(img, MediaType::Image).unwrap().fps_num,
            None
        );
    }

    #[test]
    fn applies_rotation_metadata_from_side_data_and_legacy_tags() {
        // phone video: stored landscape, displayed portrait
        for rotation in ["-90", "90", "270", "-270"] {
            let j = video_json(&format!(
                r#","side_data_list":[{{"side_data_type":"Display Matrix","rotation":{rotation}}}]"#
            ));
            let info = parse_probe_json(&j, MediaType::Video).unwrap();
            assert_eq!(
                (info.width, info.height),
                (Some(1080), Some(1920)),
                "rotation {rotation}"
            );
        }
        let tag = video_json(r#","tags":{"rotate":"90"}"#);
        let info = parse_probe_json(&tag, MediaType::Video).unwrap();
        assert_eq!((info.width, info.height), (Some(1080), Some(1920)));

        // 0 and 180 degrees keep the stored orientation
        for rotation in ["0", "180", "-180"] {
            let j = video_json(&format!(r#","side_data_list":[{{"rotation":{rotation}}}]"#));
            let info = parse_probe_json(&j, MediaType::Video).unwrap();
            assert_eq!(
                (info.width, info.height),
                (Some(1920), Some(1080)),
                "rotation {rotation}"
            );
        }
    }

    #[test]
    fn exif_orientation_of_a_still_comes_from_frame_side_data() {
        let frames = r#"{"frames":[{"width":200,"height":100,"side_data_list":[{"side_data_type":"3x3 displaymatrix","rotation":-90},{"side_data_type":"EXIF metadata","size":14}]}]}"#;
        assert_eq!(parse_frame_rotation(frames), Some(-90.0));
        assert_eq!(
            parse_frame_rotation(r#"{"frames":[{"width":200,"height":100}]}"#),
            None
        );
        assert_eq!(parse_frame_rotation("{}"), None);
        assert_eq!(parse_frame_rotation("junk"), None);

        let stream = r#"{"streams":[{"codec_type":"video","width":200,"height":100}],"format":{}}"#;
        let mut info = parse_probe_json(stream, MediaType::Image).unwrap();
        apply_rotation(&mut info, -90.0);
        assert_eq!((info.width, info.height), (Some(100), Some(200)));
        apply_rotation(&mut info, 180.0); // half turns keep the orientation
        assert_eq!((info.width, info.height), (Some(100), Some(200)));
    }

    #[test]
    fn odd_dimensions_are_reported_as_they_are() {
        let j = r#"{"streams":[{"codec_type":"video","width":1081,"height":607,"avg_frame_rate":"25/1"}],"format":{}}"#;
        let info = parse_probe_json(j, MediaType::Video).unwrap();
        assert_eq!((info.width, info.height), (Some(1081), Some(607))); // evening is a canvas decision, not a probe one
    }

    #[test]
    fn summarizes_streams_without_a_media_type() {
        let s = parse_stream_summary(VIDEO_JSON).unwrap();
        assert!(s.has_video && s.has_audio);
        assert_eq!(
            (s.width, s.height, s.duration),
            (Some(1920), Some(1080), Some(12.5))
        );
        let a = parse_stream_summary(AUDIO_JSON).unwrap();
        assert!(!a.has_video && a.has_audio);
    }

    #[test]
    fn rejects_files_missing_the_promised_stream() {
        assert!(parse_probe_json(AUDIO_JSON, MediaType::Video).is_err());
        assert!(parse_probe_json(IMAGE_JSON, MediaType::Audio).is_err());
        assert!(parse_probe_json("not json", MediaType::Video).is_err());
    }
}
