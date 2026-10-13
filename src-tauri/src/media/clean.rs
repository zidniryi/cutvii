//! Audio clean-up of a clip's sound: less steady background noise (hiss, fan, air conditioning) and no
//! low rumble (wind, handling, mains hum). FFmpeg filters only: no model, nothing downloaded.
//!
//! The export applies [`filters`] to the clip's sound before speed, volume and fades. The preview plays the
//! original sound, so the Audio tab can render a short sample through the very same filters to listen to.

use std::fs;
use std::path::Path;
use std::process::Stdio;

use super::tools::command;
use crate::errors::{AppError, AppResult};
use crate::project::AudioClean;

/// Everything below this is removed by "Remove rumble" (two 2-pole filters: about -18 dB at 50 Hz).
pub const RUMBLE_HZ: u32 = 80;
/// Seconds of sound in a sample to listen to.
pub const SAMPLE_SECONDS: f64 = 6.0;

/// The filters for a clip, each followed by a comma (empty when there is nothing to do).
///
/// Noise: `afftdn` lowers what is under the noise floor `nf` by `nr` dB. One strength sets both: from 6 dB
/// under -50 dB (gentle) to 24 dB under -25 dB (strong, speech starts to sound thin). Measured on speech
/// with -42 dB hiss: strength 0.8 lowered the hiss by about 20 dB and the speech by under 0.1 dB.
pub fn filters(clean: &AudioClean) -> String {
    let mut out = String::new();
    if clean.rumble {
        out.push_str(&format!("highpass=f={RUMBLE_HZ},highpass=f={RUMBLE_HZ},"));
    }
    let s = clean.noise.clamp(0.0, 1.0);
    if s > 0.0 {
        out.push_str(&format!(
            "afftdn=nr={:.1}:nf={:.1},",
            6.0 + 18.0 * s,
            -50.0 + 25.0 * s
        ));
    }
    out
}

/// Ducking: a clip is turned down while the other clips make sound (music under a voice). `amount` is 0..1.
/// The filter takes the clip and, as its second input, the mix of the other clips. That second input must
/// last as long as the clip: the filter stops when either input ends.
///
/// Measured with speech at about -20 dB as the other sound: amount 0.25 lowers the clip by about 9 dB,
/// 0.5 by about 13 dB, 1 by about 16 dB; it comes back over half a second.
pub fn duck_filter(amount: f64) -> String {
    format!(
        "sidechaincompress=threshold=0.015:ratio={:.2}:attack=20:release=500:makeup=1",
        1.5 + 8.5 * amount.clamp(0.0, 1.0)
    )
}

/// Write [`SAMPLE_SECONDS`] of the first audio stream of `src` from `start` to `out` (WAV), cleaned.
/// `out` appears only when the whole file is done.
pub fn write_sample(
    ffmpeg: &Path,
    src: &Path,
    start: f64,
    clean: &AudioClean,
    out: &Path,
) -> AppResult<()> {
    if !(start.is_finite() && start >= 0.0 && clean.is_valid()) {
        return Err(AppError::InvalidInput("invalid sample request".into()));
    }
    if let Some(dir) = out.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = out.with_extension(format!("part-{}.wav", std::process::id()));
    let chain = format!(
        "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,{}anull",
        filters(clean)
    );
    let status = command(ffmpeg)
        .args(["-v", "error", "-nostdin", "-y", "-ss"])
        .arg(format!("{start:.6}"))
        .arg("-t")
        .arg(format!("{SAMPLE_SECONDS:.6}"))
        .arg("-i")
        .arg(src)
        .args(["-map", "0:a:0", "-vn", "-af"])
        .arg(chain)
        .args(["-c:a", "pcm_s16le", "-f", "wav"])
        .arg(&tmp)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let done = matches!(&status, Ok(s) if s.success())
        && fs::metadata(&tmp).map(|m| m.len() > 1000).unwrap_or(false);
    if !done {
        fs::remove_file(&tmp).ok();
        return Err(AppError::InvalidInput(
            "a sample could not be made from this clip's sound".into(),
        ));
    }
    fs::rename(&tmp, out)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::tools::{FFMPEG_ENV, locate_tool};

    const fn clean(noise: f64, rumble: bool) -> AudioClean {
        AudioClean { noise, rumble }
    }

    #[test]
    fn filters_follow_the_settings() {
        assert_eq!(filters(&clean(0.0, false)), "");
        assert_eq!(filters(&clean(0.0, true)), "highpass=f=80,highpass=f=80,");
        assert_eq!(filters(&clean(1.0, false)), "afftdn=nr=24.0:nf=-25.0,");
        assert_eq!(
            filters(&clean(0.5, true)),
            "highpass=f=80,highpass=f=80,afftdn=nr=15.0:nf=-37.5,"
        );
        assert!(!clean(1.5, false).is_valid() && !clean(f64::NAN, false).is_valid());
        assert!(clean(0.0, false).is_off() && !clean(0.0, true).is_off());
    }

    /// RMS level in dB of `[from, from + 1.5)` seconds of a file.
    fn level(ffmpeg: &Path, file: &Path, from: f64) -> f64 {
        let out = command(ffmpeg)
            .args(["-v", "info", "-nostdin", "-i"])
            .arg(file)
            .arg("-af")
            .arg(format!(
                "atrim={from}:{},astats=measure_overall=RMS_level:measure_perchannel=none",
                from + 1.5
            ))
            .args(["-f", "null", "-"])
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&out.stderr);
        let line = text.lines().find(|l| l.contains("RMS level dB")).unwrap();
        line.rsplit(':').next().unwrap().trim().parse().unwrap()
    }

    #[test]
    fn a_cleaned_sample_has_less_hiss_and_hum_but_keeps_the_tone() {
        let Ok(ffmpeg) = locate_tool("ffmpeg", FFMPEG_ENV) else {
            eprintln!("skipped: FFmpeg not found");
            return;
        };
        let dir = std::env::temp_dir().join(format!("cutvii-clean-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        // 0-2 s: a loud 440 Hz tone; all 6 s: hiss and a 50 Hz hum
        let src = dir.join("noisy.wav");
        let made = command(&ffmpeg)
            .args(["-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i"])
            .arg("sine=f=440:d=2,volume=4,apad=whole_dur=6")
            .args(["-f", "lavfi", "-i", "anoisesrc=c=white:a=0.02:d=6"])
            .args(["-f", "lavfi", "-i", "sine=f=50:d=6,volume=0.2"])
            .args(["-filter_complex", "amix=inputs=3:normalize=0,atrim=0:6"])
            .args(["-ac", "2"])
            .arg(&src)
            .status()
            .unwrap();
        assert!(made.success());

        let out = dir.join("sample.wav");
        write_sample(&ffmpeg, &src, 0.0, &clean(0.8, true), &out).unwrap();
        let (noise_before, noise_after) = (level(&ffmpeg, &src, 3.5), level(&ffmpeg, &out, 3.5));
        let (tone_before, tone_after) = (level(&ffmpeg, &src, 0.3), level(&ffmpeg, &out, 0.3));
        assert!(
            noise_after < noise_before - 10.0,
            "noise {noise_before} -> {noise_after}"
        );
        assert!(
            (tone_after - tone_before).abs() < 1.5,
            "tone {tone_before} -> {tone_after}"
        );

        // nothing switched on: the sound is passed through
        let plain = dir.join("plain.wav");
        write_sample(&ffmpeg, &src, 0.0, &clean(0.0, false), &plain).unwrap();
        assert!((level(&ffmpeg, &plain, 3.5) - noise_before).abs() < 0.5);
        assert!(write_sample(&ffmpeg, &src, -1.0, &clean(0.5, false), &out).is_err());
        assert!(write_sample(&ffmpeg, &src, 0.0, &clean(2.0, false), &out).is_err());
        fs::remove_dir_all(&dir).ok();
    }
}
