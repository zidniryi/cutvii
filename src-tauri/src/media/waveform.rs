//! Waveform peaks for the timeline.
//!
//! The audio is decoded once to low-rate mono PCM and reduced to one peak per short bucket while it
//! streams, so memory use is one byte per bucket whatever the file length. Coarser levels are derived from
//! the finest one, so the timeline can draw any zoom without scanning every peak. The result is a small
//! binary file the webview loads through the asset protocol (never over IPC).
//!
//! File layout (little-endian): `CVWF`, version u32, level count u32, then per level `peaks per second
//! f32` + `peak count u32`, then every level's peaks (one u8 each, 0 = silence, 255 = full scale),
//! finest level first.

use std::fs;
use std::io::Read;
use std::path::Path;
use std::process::Stdio;

use super::tools::command;
use crate::errors::{AppError, AppResult};

pub const MAGIC: &[u8; 4] = b"CVWF";
pub const FORMAT_VERSION: u32 = 1;
/// Rate the audio is decoded at. Peaks only need the envelope, not the full band.
pub const SAMPLE_RATE: u32 = 8000;
/// Finest level: enough for one peak per ~2 px at the maximum timeline zoom.
pub const BASE_PEAKS_PER_SECOND: u32 = 200;
/// Each level has this many times fewer peaks than the one before.
pub const LEVEL_FACTOR: usize = 4;
pub const LEVEL_COUNT: usize = 4;

/// Turns a stream of signed 16-bit little-endian mono samples into one peak per bucket.
pub struct PeakBuilder {
    per_bucket: usize,
    filled: usize,
    max: u16,
    /// First byte of a sample split across two reads.
    carry: Option<u8>,
    peaks: Vec<u8>,
}

impl PeakBuilder {
    pub fn new(sample_rate: u32, peaks_per_second: u32) -> Self {
        Self {
            per_bucket: (sample_rate / peaks_per_second.max(1)).max(1) as usize,
            filled: 0,
            max: 0,
            carry: None,
            peaks: Vec::new(),
        }
    }

    fn push_sample(&mut self, sample: i16) {
        self.max = self.max.max(sample.unsigned_abs());
        self.filled += 1;
        if self.filled == self.per_bucket {
            self.flush();
        }
    }

    fn flush(&mut self) {
        self.peaks
            .push(((self.max as u32 * 255 + 16_384) / 32_768).min(255) as u8);
        self.filled = 0;
        self.max = 0;
    }

    pub fn push_bytes(&mut self, mut bytes: &[u8]) {
        if let (Some(low), Some(&high)) = (self.carry, bytes.first()) {
            self.carry = None;
            self.push_sample(i16::from_le_bytes([low, high]));
            bytes = &bytes[1..];
        }
        let mut pairs = bytes.chunks_exact(2);
        for pair in &mut pairs {
            self.push_sample(i16::from_le_bytes([pair[0], pair[1]]));
        }
        if let Some(&last) = pairs.remainder().first() {
            self.carry = Some(last);
        }
    }

    /// The peaks, including a last partly filled bucket.
    pub fn finish(mut self) -> Vec<u8> {
        if self.filled > 0 {
            self.flush();
        }
        self.peaks
    }
}

/// The next coarser level: the maximum of every `LEVEL_FACTOR` peaks.
pub fn coarser(peaks: &[u8]) -> Vec<u8> {
    peaks
        .chunks(LEVEL_FACTOR)
        .map(|c| c.iter().copied().max().unwrap_or(0))
        .collect()
}

/// The waveform file for `base` peaks at `BASE_PEAKS_PER_SECOND`, with all levels.
pub fn encode(base: Vec<u8>) -> Vec<u8> {
    let mut levels = vec![base];
    while levels.len() < LEVEL_COUNT {
        levels.push(coarser(levels.last().expect("at least the base level")));
    }
    let mut out = Vec::new();
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
    out.extend_from_slice(&(levels.len() as u32).to_le_bytes());
    let mut rate = BASE_PEAKS_PER_SECOND as f32;
    for level in &levels {
        out.extend_from_slice(&rate.to_le_bytes());
        out.extend_from_slice(&(level.len() as u32).to_le_bytes());
        rate /= LEVEL_FACTOR as f32;
    }
    for level in &levels {
        out.extend_from_slice(level);
    }
    out
}

/// Decode the first audio stream of `src` and return its finest-level peaks. The file is only read.
pub fn read_peaks(ffmpeg: &Path, src: &Path) -> AppResult<Vec<u8>> {
    let mut child = command(ffmpeg)
        .args(["-v", "error", "-nostdin", "-i"])
        .arg(src)
        .args(["-map", "0:a:0", "-vn", "-ac", "1", "-ar"])
        .arg(SAMPLE_RATE.to_string())
        .args(["-f", "s16le", "-"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let mut builder = PeakBuilder::new(SAMPLE_RATE, BASE_PEAKS_PER_SECOND);
    let read = (|| -> AppResult<()> {
        let mut stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::InvalidInput("no output from ffmpeg".into()))?;
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = stdout.read(&mut buf)?;
            if n == 0 {
                return Ok(());
            }
            builder.push_bytes(&buf[..n]);
        }
    })();
    if read.is_err() {
        child.kill().ok();
    }
    let status = child.wait()?;
    read?;
    if !status.success() {
        return Err(AppError::InvalidInput(
            "could not read the audio for the waveform".into(),
        ));
    }
    Ok(builder.finish())
}

/// Write the waveform file for `base` to `out` through a temp file, so a failed run never leaves a
/// corrupt cache entry.
pub fn write_waveform(base: Vec<u8>, out: &Path) -> AppResult<()> {
    if let Some(parent) = out.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = out.with_extension(format!("part-{}", std::process::id()));
    if let Err(e) = fs::write(&tmp, encode(base)) {
        fs::remove_file(&tmp).ok();
        return Err(e.into());
    }
    fs::rename(&tmp, out)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::MediaBackend;
    use crate::media::ffmpeg::FfmpegBackend;
    use crate::media::tools::{FFMPEG_ENV, locate_tool};

    fn bytes(samples: &[i16]) -> Vec<u8> {
        samples.iter().flat_map(|s| s.to_le_bytes()).collect()
    }

    #[test]
    fn peaks_are_the_loudest_sample_of_each_bucket() {
        // 4 samples per bucket
        let mut b = PeakBuilder::new(8, 2);
        b.push_bytes(&bytes(&[
            0,
            100,
            -16384,
            50,
            i16::MAX,
            0,
            0,
            0,
            i16::MIN,
            1,
        ]));
        assert_eq!(b.finish(), vec![128, 255, 255], "partial last bucket kept");
        assert!(PeakBuilder::new(8000, 200).finish().is_empty());
    }

    #[test]
    fn samples_split_across_reads_are_joined() {
        let data = bytes(&[1000, -20000, 300, 4, 5, -32768, 7, 8, 9]);
        let mut whole = PeakBuilder::new(4, 2);
        whole.push_bytes(&data);
        for cut in 1..data.len() {
            let mut split = PeakBuilder::new(4, 2);
            split.push_bytes(&data[..cut]);
            split.push_bytes(&data[cut..]);
            let mut again = PeakBuilder::new(4, 2);
            again.push_bytes(&data);
            assert_eq!(split.finish(), again.finish(), "cut at byte {cut}");
        }
        assert_eq!(whole.finish(), vec![156, 2, 255, 0, 0]);
    }

    #[test]
    fn file_holds_every_level_with_its_rate_and_count() {
        let base: Vec<u8> = (0..37u8).collect();
        let file = encode(base.clone());
        assert_eq!(&file[..4], MAGIC);
        let u32_at = |i: usize| u32::from_le_bytes(file[i..i + 4].try_into().unwrap());
        let f32_at = |i: usize| f32::from_le_bytes(file[i..i + 4].try_into().unwrap());
        assert_eq!((u32_at(4), u32_at(8)), (FORMAT_VERSION, LEVEL_COUNT as u32));
        let counts: Vec<u32> = (0..LEVEL_COUNT).map(|l| u32_at(16 + l * 8)).collect();
        assert_eq!(counts, vec![37, 10, 3, 1]);
        assert_eq!(
            (f32_at(12), f32_at(20), f32_at(36)),
            (200.0, 50.0, 3.125),
            "rates"
        );
        let data = 12 + LEVEL_COUNT * 8;
        assert_eq!(file.len(), data + 37 + 10 + 3 + 1);
        assert_eq!(&file[data..data + 37], &base[..]);
        // coarser levels keep the maximum
        assert_eq!(
            &file[data + 37..data + 47],
            &[3, 7, 11, 15, 19, 23, 27, 31, 35, 36]
        );
        assert_eq!(file[file.len() - 1], 36);
    }

    /// Runs against a real FFmpeg; skipped (loudly) when none is installed.
    #[test]
    fn real_audio_gives_peaks_matching_its_length_and_loudness() {
        let Ok(backend) = FfmpegBackend::locate() else {
            eprintln!("SKIPPED: ffmpeg/ffprobe not found");
            return;
        };
        let ffmpeg = locate_tool("ffmpeg", FFMPEG_ENV).unwrap();
        let dir = std::env::temp_dir().join(format!("cutvii-waveform-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();

        // 1 s of silence followed by 2 s of a half-scale tone
        let audio = dir.join("a.wav");
        let status = command(&ffmpeg)
            .args(["-y", "-v", "error", "-f", "lavfi", "-i"])
            .arg("aevalsrc='if(lt(t,1),0,0.5*sin(2*PI*440*t))':d=3:s=44100")
            .arg(&audio)
            .status()
            .unwrap();
        assert!(status.success());

        let peaks = backend.audio_peaks(&audio).unwrap();
        let expected = 3 * BASE_PEAKS_PER_SECOND as usize;
        assert!(
            peaks.len().abs_diff(expected) <= 2,
            "{} peaks for 3 s",
            peaks.len()
        );
        assert!(peaks[..190].iter().all(|&p| p <= 2), "silent first second");
        assert!(
            peaks[220..580].iter().all(|&p| (110..=145).contains(&p)),
            "half-scale tone: {:?}",
            &peaks[220..230]
        );

        let out = dir.join("cache").join("a.wf");
        write_waveform(peaks, &out).unwrap();
        assert_eq!(&fs::read(&out).unwrap()[..4], MAGIC);
        assert_eq!(
            fs::read_dir(out.parent().unwrap()).unwrap().count(),
            1,
            "no temp file left"
        );

        // a file without audio is an error, not an empty waveform
        let image = dir.join("i.png");
        let status = command(&ffmpeg)
            .args(["-y", "-v", "error", "-f", "lavfi", "-i"])
            .arg("testsrc=size=64x64:rate=1")
            .args(["-frames:v", "1"])
            .arg(&image)
            .status()
            .unwrap();
        assert!(status.success());
        assert!(backend.audio_peaks(&image).is_err());

        fs::remove_dir_all(&dir).ok();
    }
}
