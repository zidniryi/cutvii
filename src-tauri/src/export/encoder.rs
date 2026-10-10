use super::Quality;

/// H.264 encoders we can drive, in order of preference: software first.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Encoder {
    Libx264,
    OpenH264,
    VideoToolbox,
}

/// Pick an encoder from `ffmpeg -encoders` output. LGPL builds have no libx264, so we fall back
/// to what is there instead of failing blindly.
pub fn choose_encoder(listing: &str) -> Option<Encoder> {
    let has = |name: &str| {
        listing
            .lines()
            .any(|l| l.split_whitespace().nth(1) == Some(name))
    };
    if has("libx264") {
        Some(Encoder::Libx264)
    } else if has("libopenh264") {
        Some(Encoder::OpenH264)
    } else if has("h264_videotoolbox") {
        Some(Encoder::VideoToolbox)
    } else {
        None
    }
}

impl Encoder {
    pub fn name(self) -> &'static str {
        match self {
            Encoder::Libx264 => "libx264",
            Encoder::OpenH264 => "libopenh264",
            Encoder::VideoToolbox => "h264_videotoolbox",
        }
    }

    /// Video codec arguments for the requested quality.
    pub fn video_args(self, quality: Quality, width: u32, height: u32, fps: f64) -> Vec<String> {
        let s = |v: &str| v.to_string();
        match self {
            Encoder::Libx264 => {
                let (preset, crf) = match quality {
                    Quality::Draft => ("veryfast", "28"),
                    Quality::Standard => ("medium", "23"),
                    Quality::High => ("slow", "18"),
                };
                vec![
                    s("-c:v"),
                    s("libx264"),
                    s("-preset"),
                    s(preset),
                    s("-crf"),
                    s(crf),
                    s("-pix_fmt"),
                    s("yuv420p"),
                ]
            }
            Encoder::OpenH264 | Encoder::VideoToolbox => {
                // no CRF: derive a bitrate from bits-per-pixel
                let bpp = match quality {
                    Quality::Draft => 0.05,
                    Quality::Standard => 0.09,
                    Quality::High => 0.15,
                };
                let kbps = ((width as f64 * height as f64 * fps * bpp) / 1000.0)
                    .round()
                    .max(200.0) as u64;
                vec![
                    s("-c:v"),
                    s(self.name()),
                    s("-b:v"),
                    format!("{kbps}k"),
                    s("-pix_fmt"),
                    s("yuv420p"),
                ]
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LISTING: &str = " V....D libx264              libx264 H.264 / AVC\n V....D libopenh264          OpenH264\n V....D h264_videotoolbox    VideoToolbox\n A....D aac                  AAC\n";

    #[test]
    fn prefers_software_then_falls_back() {
        assert_eq!(choose_encoder(LISTING), Some(Encoder::Libx264));
        assert_eq!(
            choose_encoder(&LISTING.replace("libx264 ", "libxxxx ")),
            Some(Encoder::OpenH264)
        );
        assert_eq!(
            choose_encoder(" V....D h264_videotoolbox    VideoToolbox\n"),
            Some(Encoder::VideoToolbox)
        );
        assert_eq!(choose_encoder(" A....D aac AAC\n"), None);
        // a description that merely mentions libx264 must not count
        assert_eq!(
            choose_encoder(" V....D h264_nvenc   uses libx264 settings\n"),
            None
        );
    }

    #[test]
    fn quality_maps_to_crf_or_bitrate() {
        let a = Encoder::Libx264
            .video_args(Quality::High, 1920, 1080, 30.0)
            .join(" ");
        assert!(a.contains("-preset slow") && a.contains("-crf 18") && a.contains("yuv420p"));
        let d = Encoder::Libx264
            .video_args(Quality::Draft, 1920, 1080, 30.0)
            .join(" ");
        assert!(d.contains("-crf 28"));
        let b = Encoder::VideoToolbox
            .video_args(Quality::Standard, 1920, 1080, 30.0)
            .join(" ");
        assert!(b.contains("-b:v 5599k"), "{b}"); // 1920*1080*30*0.09 / 1000 = 5598.72
    }
}
