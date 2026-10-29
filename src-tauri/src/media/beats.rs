//! Beat detection for Beat Sync, fully local, no model.
//!
//! The used range of a file is decoded once by FFmpeg to 22.05 kHz mono and turned, while it streams, into
//! an onset envelope ("how much new sound starts here", one value per 256 samples): log-compressed spectral
//! flux over the whole band plus the same below ~150 Hz, where kicks and bass live. From the envelope:
//! - the tempo, by autocorrelation weighted towards 120 BPM (with support from twice the period);
//! - the beats, by dynamic programming (Ellis 2007: strong onsets, spaced about one period apart);
//! - a constant grid (BPM + first beat) fitted to those beats and refined on the envelope; the phase is the
//!   grid or the grid half a beat later, whichever lands on more kick / bass onsets (off-beat hats and bass
//!   otherwise pull EDM half a beat off);
//! - `clarity`: the envelope's correlation with itself one beat later (below [`CLEAR_BEAT`]: no clear
//!   beat; measured: speech 0.04, ambient pads 0.01, synthetic music 0.5-0.86), and `steady`: whether the tracked beats follow the constant grid
//!   (a tempo change does not).
//!
//! Measured in the 6ac spike on synthetic tracks: about 0.1 s of analysis per minute of audio. Fast music
//! is often found at half tempo (drum & bass at 87 instead of 174): the UI offers Half / Double.
//! The result is cached as JSON; nothing about the grid is stored in the project except its id.

use std::f32::consts::PI;
use std::fs;
use std::io::Read;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};

use super::tools::command;
use crate::errors::{AppError, AppResult};

/// Bump when the analysis changes, so old cache entries are not reused.
pub const ALGORITHM_VERSION: u32 = 1;
pub const SAMPLE_RATE: u32 = 22_050;
const N: usize = 1024;
const HOP: usize = 256;
/// FFT bins below ~150 Hz (21.5 Hz per bin).
const LOW_BINS: usize = 7;
/// Below this `clarity` the UI says there is no clear beat.
pub const CLEAR_BEAT: f64 = 0.2;
/// Shortest range worth analysing, and the longest one accepted.
pub const MIN_SECONDS: f64 = 3.0;
pub const MAX_SECONDS: f64 = 3.0 * 3600.0;
const MIN_BPM: f32 = 50.0;
const MAX_BPM: f32 = 220.0;

/// The beat grid of a source range. All times are source times (seconds in the media file).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeatGrid {
    pub version: u32,
    /// The analysed range.
    pub start: f64,
    pub end: f64,
    /// Constant grid: beats per minute and the first beat at or after `start`.
    pub bpm: f64,
    pub offset: f64,
    /// How strongly the sound repeats one beat later, 0..1; below [`CLEAR_BEAT`] there is no clear beat.
    pub clarity: f64,
    /// `clarity` is at least [`CLEAR_BEAT`].
    pub clear: bool,
    /// The tracked beats follow the constant grid (false when the tempo changes).
    pub steady: bool,
    /// Every tracked beat, in order. Used instead of the grid when it is not steady.
    pub beats: Vec<f64>,
}

fn fft(re: &mut [f32], im: &mut [f32], twiddle: &[(f32, f32)]) {
    let n = re.len();
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j |= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= n {
        let step = n / len;
        for start in (0..n).step_by(len) {
            for k in 0..len / 2 {
                let (wr, wi) = twiddle[k * step];
                let (a, b) = (start + k, start + k + len / 2);
                let (xr, xi) = (re[b] * wr - im[b] * wi, re[b] * wi + im[b] * wr);
                re[b] = re[a] - xr;
                im[b] = im[a] - xi;
                re[a] += xr;
                im[a] += xi;
            }
        }
        len <<= 1;
    }
}

/// Turns a stream of f32 little-endian mono samples into onset strength, one value per hop.
pub struct OnsetBuilder {
    window: Vec<f32>,
    twiddle: Vec<(f32, f32)>,
    pending: Vec<f32>,
    pos: usize,
    carry: Vec<u8>,
    prev: Vec<f32>,
    re: Vec<f32>,
    im: Vec<f32>,
    full: Vec<f32>,
    low: Vec<f32>,
}

impl Default for OnsetBuilder {
    fn default() -> Self {
        Self {
            window: (0..N)
                .map(|i| 0.5 - 0.5 * (2.0 * PI * i as f32 / N as f32).cos())
                .collect(),
            twiddle: (0..N / 2)
                .map(|k| {
                    let a = -2.0 * PI * k as f32 / N as f32;
                    (a.cos(), a.sin())
                })
                .collect(),
            pending: Vec::new(),
            pos: 0,
            carry: Vec::new(),
            prev: vec![0.0; N / 2],
            re: vec![0.0; N],
            im: vec![0.0; N],
            full: Vec::new(),
            low: Vec::new(),
        }
    }
}

impl OnsetBuilder {
    pub fn push_samples(&mut self, samples: &[f32]) {
        self.pending.extend_from_slice(samples);
        while self.pending.len() - self.pos >= N {
            self.frame();
            self.pos += HOP;
        }
        if self.pos > 1 << 16 {
            self.pending.drain(..self.pos);
            self.pos = 0;
        }
    }

    pub fn push_bytes(&mut self, bytes: &[u8]) {
        let mut data = std::mem::take(&mut self.carry);
        data.extend_from_slice(bytes);
        let whole = data.len() / 4 * 4;
        let samples: Vec<f32> = data[..whole]
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .map(|v| if v.is_finite() { v } else { 0.0 })
            .collect();
        self.carry = data[whole..].to_vec();
        self.push_samples(&samples);
    }

    fn frame(&mut self) {
        let frame = &self.pending[self.pos..self.pos + N];
        for ((re, sample), w) in self.re.iter_mut().zip(frame).zip(&self.window) {
            *re = sample * w;
        }
        self.im.fill(0.0);
        fft(&mut self.re, &mut self.im, &self.twiddle);
        let (mut all, mut low) = (0.0, 0.0);
        for k in 1..N / 2 {
            let m = (1.0 + 100.0 * (self.re[k] * self.re[k] + self.im[k] * self.im[k]).sqrt()).ln();
            let rise = (m - self.prev[k]).max(0.0);
            all += rise;
            if k <= LOW_BINS {
                low += rise;
            }
            self.prev[k] = m;
        }
        self.full.push(all);
        self.low.push(low);
    }

    /// The onset envelope (whole band + low band, each normalised) and the low band on its own.
    pub fn finish(self) -> (Vec<f32>, Vec<f32>) {
        let (full, low) = (normalise(&self.full), normalise(&self.low));
        (full.iter().zip(&low).map(|(a, b)| a + b).collect(), low)
    }
}

/// Removes the local mean (0.4 s), keeps rises only, scales to unit RMS.
fn normalise(flux: &[f32]) -> Vec<f32> {
    if flux.is_empty() {
        return Vec::new();
    }
    let half = (0.2 * SAMPLE_RATE as f32 / HOP as f32) as usize;
    let mut prefix = vec![0.0f64; flux.len() + 1];
    for (i, v) in flux.iter().enumerate() {
        prefix[i + 1] = prefix[i] + *v as f64;
    }
    let out: Vec<f32> = (0..flux.len())
        .map(|i| {
            let (a, b) = (i.saturating_sub(half), (i + half).min(flux.len() - 1));
            let mean = (prefix[b + 1] - prefix[a]) / (b - a + 1) as f64;
            (flux[i] - mean as f32).max(0.0)
        })
        .collect();
    let rms = (out.iter().map(|v| v * v).sum::<f32>() / out.len() as f32).sqrt();
    if rms < 1e-9 {
        return out;
    }
    out.iter().map(|v| v / rms).collect()
}

fn frames_per_second() -> f32 {
    SAMPLE_RATE as f32 / HOP as f32
}

/// Seconds from the start of the range to the centre of envelope frame `i`.
fn frame_time(i: f32) -> f64 {
    ((i * HOP as f32 + N as f32 / 2.0) / SAMPLE_RATE as f32) as f64
}

/// Strongest envelope value within two frames of `t` (seconds from the range start).
fn strength_at(env: &[f32], t: f64) -> f32 {
    let i = ((t * SAMPLE_RATE as f64 - N as f64 / 2.0) / HOP as f64).round();
    if i < 0.0 || i as usize >= env.len() {
        return 0.0;
    }
    let i = i as usize;
    env[i.saturating_sub(2)..(i + 3).min(env.len())]
        .iter()
        .copied()
        .fold(0.0, f32::max)
}

/// Envelope value at `t` (seconds from the range start), linearly between frames.
fn interpolated(env: &[f32], t: f64) -> f32 {
    let x = (t * SAMPLE_RATE as f64 - N as f64 / 2.0) / HOP as f64;
    if x < 0.0 || x + 1.0 >= env.len() as f64 {
        return 0.0;
    }
    let (i, f) = (x.floor() as usize, (x - x.floor()) as f32);
    env[i] * (1.0 - f) + env[i + 1] * f
}

fn autocorrelation(env: &[f32], lag: usize) -> f32 {
    if lag >= env.len() {
        return 0.0;
    }
    env.iter().zip(&env[lag..]).map(|(a, b)| a * b).sum::<f32>() / (env.len() - lag) as f32
}

/// Tempo in BPM: the autocorrelation peak, weighted towards 120 BPM, refined between lags.
fn tempo(env: &[f32]) -> f32 {
    let fps = frames_per_second();
    let (lo, hi) = (
        (fps * 60.0 / MAX_BPM) as usize,
        (fps * 60.0 / MIN_BPM) as usize,
    );
    let mut best = (f32::MIN, lo);
    for lag in lo..=hi {
        let bpm = 60.0 * fps / lag as f32;
        let prior = (-0.5 * (bpm / 120.0).log2().powi(2)).exp();
        let score = (autocorrelation(env, lag) + 0.5 * autocorrelation(env, 2 * lag)) * prior;
        if score > best.0 {
            best = (score, lag);
        }
    }
    let lag = best.1;
    let (a, b, c) = (
        autocorrelation(env, lag - 1),
        autocorrelation(env, lag),
        autocorrelation(env, lag + 1),
    );
    let shift = 0.5 * (a - c) / (a - 2.0 * b + c);
    let shift = if shift.is_finite() {
        shift.clamp(-0.5, 0.5)
    } else {
        0.0
    };
    60.0 * fps / (lag as f32 + shift)
}

/// Beat frames by dynamic programming: onset strength minus a penalty for spacing other than one period.
fn track(env: &[f32], bpm: f32) -> Vec<usize> {
    if env.is_empty() {
        return Vec::new();
    }
    let period = 60.0 * frames_per_second() / bpm;
    let (near, far) = (
        (period / 2.0).round() as usize,
        (2.0 * period).round() as usize,
    );
    let penalty: Vec<f32> = (0..=far)
        .map(|gap| -100.0 * (gap.max(1) as f32 / period).ln().powi(2))
        .collect();
    let mut score = env.to_vec();
    let mut back = vec![usize::MAX; env.len()];
    for t in near..env.len() {
        let mut best = (f32::MIN, usize::MAX);
        for tau in t.saturating_sub(far)..=t - near {
            let s = score[tau] + penalty[t - tau];
            if s > best.0 {
                best = (s, tau);
            }
        }
        if best.1 != usize::MAX {
            score[t] = env[t] + best.0;
            back[t] = best.1;
        }
    }
    let tail = env.len().saturating_sub(period.ceil() as usize);
    let mut t = (tail..env.len())
        .max_by(|&a, &b| score[a].total_cmp(&score[b]))
        .unwrap_or(0);
    let mut beats = vec![t];
    while back[t] != usize::MAX {
        t = back[t];
        beats.push(t);
    }
    beats.reverse();
    beats
}

/// Constant grid (period, first beat; seconds from the range start) fitted to the beats by least squares,
/// then refined to land on the most onset strength.
fn fit_grid(env: &[f32], beats: &[f64], bpm: f32) -> (f64, f64) {
    let duration = env.len() as f64 / frames_per_second() as f64;
    let (mut period, mut first) = (60.0 / bpm as f64, beats.first().copied().unwrap_or(0.0));
    if beats.len() >= 2 {
        let n = beats.len() as f64;
        let (sx, sy) = ((n - 1.0) * n / 2.0, beats.iter().sum::<f64>());
        let sxx = (0..beats.len()).map(|i| (i * i) as f64).sum::<f64>();
        let sxy = beats
            .iter()
            .enumerate()
            .map(|(i, b)| i as f64 * b)
            .sum::<f64>();
        let fitted = (n * sxy - sx * sy) / (n * sxx - sx * sx);
        if fitted.is_finite() && fitted > 0.0 {
            period = fitted;
            first = (sy - period * sx) / n;
        }
    }
    let on_grid = |p: f64, o: f64| {
        let mut sum = 0.0;
        let mut t = o.rem_euclid(p);
        while t < duration {
            sum += interpolated(env, t);
            t += p;
        }
        sum
    };
    // nearest candidates first, so a tie keeps the least-squares fit
    let mut steps: Vec<(i32, i32)> = (-40..=40)
        .flat_map(|p| (-20..=20).map(move |o| (p, o)))
        .collect();
    steps.sort_by_key(|(p, o)| p.abs() * 2 + o.abs());
    let mut best = (f32::MIN, period, first);
    for (pi, oi) in steps {
        let p = period * (1.0 + pi as f64 * 0.0002);
        let o = first + oi as f64 * 0.002;
        let s = on_grid(p, o);
        if s > best.0 {
            best = (s, p, o);
        }
    }
    (best.1, best.2.rem_euclid(best.1))
}

/// How strongly the envelope repeats one beat later: its correlation with itself at the beat period
/// (best of the nearest lags). About 0 for noise, near 1 for a click track. Not biased by the fitted phase.
fn pulse_clarity(env: &[f32], period: f64) -> f64 {
    let lag = (period * frames_per_second() as f64).round() as usize;
    if env.len() < 2 * lag + 2 || lag < 2 {
        return 0.0;
    }
    let n = env.len() as f64;
    let mean = env.iter().map(|v| *v as f64).sum::<f64>() / n;
    let var = env.iter().map(|v| (*v as f64 - mean).powi(2)).sum::<f64>() / n;
    if var < 1e-12 {
        return 0.0;
    }
    (lag - 1..=lag + 1)
        .map(|l| (autocorrelation(env, l) as f64 - mean * mean) / var)
        .fold(f64::MIN, f64::max)
        .max(0.0)
}

/// Analyse one range's envelope. `start` is the source time of the first sample.
pub fn analyse(env: &[f32], low: &[f32], start: f64, end: f64) -> BeatGrid {
    let fps = frames_per_second();
    let bpm = tempo(env);
    let beats: Vec<f64> = track(env, bpm)
        .into_iter()
        .map(|f| frame_time(f as f32))
        .collect();
    let (period, mut first) = fit_grid(env, &beats, bpm);
    let duration = env.len() as f64 / fps as f64;
    let along = |env: &[f32], o: f64| {
        let mut sum = 0.0;
        let mut t = o;
        while t < duration {
            sum += strength_at(env, t);
            t += period;
        }
        sum
    };
    let tracked_on = first;
    let shifted = (first + period / 2.0).rem_euclid(period);
    let half_beat_later = along(low, shifted) > 1.2 * along(low, first);
    if half_beat_later {
        first = shifted;
    }
    let clarity = pulse_clarity(env, 60.0 / bpm as f64);
    // a tracked beat is on the grid when it is within 50 ms of a grid line
    let near = beats
        .iter()
        .filter(|b| {
            let d = (*b - tracked_on).rem_euclid(period);
            d.min(period - d) <= 0.05
        })
        .count();
    let steady = beats.is_empty() || near as f64 >= 0.8 * beats.len() as f64;
    BeatGrid {
        version: ALGORITHM_VERSION,
        start,
        end,
        bpm: 60.0 / period,
        offset: start + first,
        clarity,
        clear: clarity >= CLEAR_BEAT,
        steady,
        beats: beats
            .iter()
            .map(|b| start + b + if half_beat_later { period / 2.0 } else { 0.0 })
            .filter(|b| *b < end)
            .collect(),
    }
}

/// Decode `[start, end)` of `src`'s first audio stream and analyse it. `progress` gets 0..1; when `cancel`
/// is set FFmpeg is stopped and nothing is returned. Nothing is written.
pub fn detect(
    ffmpeg: &Path,
    src: &Path,
    start: f64,
    end: f64,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(f64),
) -> AppResult<BeatGrid> {
    check_range(start, end)?;
    let mut child = command(ffmpeg)
        .args(["-v", "error", "-nostdin", "-ss"])
        .arg(format!("{start:.6}"))
        .arg("-t")
        .arg(format!("{:.6}", end - start))
        .arg("-i")
        .arg(src)
        .args(["-map", "0:a:0", "-vn", "-ac", "1", "-ar"])
        .arg(SAMPLE_RATE.to_string())
        .args(["-f", "f32le", "-"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let mut builder = OnsetBuilder::default();
    let total_bytes = (end - start) * SAMPLE_RATE as f64 * 4.0;
    let read = (|| -> AppResult<()> {
        let mut stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::InvalidInput("no output from ffmpeg".into()))?;
        let mut buf = vec![0u8; 64 * 1024];
        let mut received = 0usize;
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err(AppError::Cancelled);
            }
            let n = stdout.read(&mut buf)?;
            if n == 0 {
                return Ok(());
            }
            received += n;
            builder.push_bytes(&buf[..n]);
            progress((received as f64 / total_bytes).min(1.0) * 0.9);
        }
    })();
    if read.is_err() {
        child.kill().ok();
    }
    let status = child.wait()?;
    read?;
    if !status.success() {
        return Err(AppError::InvalidInput(
            "could not read the sound of this clip".into(),
        ));
    }
    let (env, low) = builder.finish();
    if (env.len() as f64 / frames_per_second() as f64) < MIN_SECONDS - 0.5 {
        return Err(AppError::InvalidInput(format!(
            "beats need at least {MIN_SECONDS:.0} seconds of sound"
        )));
    }
    let grid = analyse(&env, &low, start, end);
    progress(1.0);
    Ok(grid)
}

pub fn check_range(start: f64, end: f64) -> AppResult<()> {
    if !(start.is_finite() && end.is_finite() && start >= 0.0 && end > start) {
        return Err(AppError::InvalidInput("invalid range".into()));
    }
    if end - start < MIN_SECONDS {
        return Err(AppError::InvalidInput(format!(
            "beats need at least {MIN_SECONDS:.0} seconds of sound"
        )));
    }
    if end - start > MAX_SECONDS {
        return Err(AppError::InvalidInput(
            "beats can be found in at most 3 hours at a time".into(),
        ));
    }
    Ok(())
}

/// Write a grid to the cache through a temp file, so a failed run never leaves a broken entry.
pub fn write_grid(grid: &BeatGrid, out: &Path) -> AppResult<()> {
    if let Some(parent) = out.parent() {
        fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_vec(grid)
        .map_err(|e| AppError::InvalidInput(format!("could not store the beats: {e}")))?;
    let tmp = out.with_extension(format!("part-{}", std::process::id()));
    if let Err(e) = fs::write(&tmp, json) {
        fs::remove_file(&tmp).ok();
        return Err(e.into());
    }
    fs::rename(&tmp, out)?;
    Ok(())
}

/// A cached grid, or `None` when there is none or it was made by another version of the analysis.
pub fn read_grid(path: &Path) -> Option<BeatGrid> {
    let grid: BeatGrid = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    (grid.version == ALGORITHM_VERSION).then_some(grid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::tools::{FFMPEG_ENV, locate_tool};

    /// A click (short decaying 60 Hz + 2 kHz burst) on every beat of a constant tempo.
    fn click_track(bpm: f64, first: f64, seconds: f64) -> Vec<f32> {
        let sr = SAMPLE_RATE as f64;
        let mut out = vec![0f32; (seconds * sr) as usize];
        let mut beat = first;
        while beat < seconds {
            let i0 = (beat * sr) as usize;
            for k in 0..(0.08 * sr) as usize {
                let t = k as f64 / sr;
                if let Some(s) = out.get_mut(i0 + k) {
                    *s += ((2.0 * std::f64::consts::PI * 60.0 * t).sin() * 0.8
                        + (2.0 * std::f64::consts::PI * 2000.0 * t).sin() * 0.2)
                        as f32
                        * (-t * 40.0).exp() as f32;
                }
            }
            beat += 60.0 / bpm;
        }
        out
    }

    fn grid_of(samples: &[f32], start: f64) -> BeatGrid {
        let mut b = OnsetBuilder::default();
        b.push_samples(samples);
        let (env, low) = b.finish();
        analyse(
            &env,
            &low,
            start,
            start + samples.len() as f64 / SAMPLE_RATE as f64,
        )
    }

    #[test]
    fn a_click_track_gives_its_tempo_and_first_beat() {
        for (bpm, first) in [(128.0, 0.25), (96.0, 0.6), (140.0, 0.1)] {
            let g = grid_of(&click_track(bpm, first, 30.0), 10.0);
            assert!((g.bpm - bpm).abs() < 0.5, "{bpm}: found {}", g.bpm);
            assert!(
                (g.offset - (10.0 + first)).abs() < 0.03,
                "{bpm}: first beat {} instead of {}",
                g.offset,
                10.0 + first
            );
            assert!(g.steady && g.clarity > CLEAR_BEAT, "{g:?}");
            assert!(g.beats.len() as f64 >= 30.0 * bpm / 60.0 - 3.0);
        }
    }

    #[test]
    fn noise_has_no_clear_beat_and_silence_does_not_fail() {
        let mut seed = 12345u32;
        let noise: Vec<f32> = (0..SAMPLE_RATE as usize * 20)
            .map(|_| {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                (seed >> 8) as f32 / (1u32 << 24) as f32 - 0.5
            })
            .collect();
        assert!(grid_of(&noise, 0.0).clarity < CLEAR_BEAT);
        let silent = grid_of(&vec![0.0; SAMPLE_RATE as usize * 5], 0.0);
        assert!(silent.bpm.is_finite() && silent.clarity < CLEAR_BEAT);
    }

    #[test]
    fn samples_split_across_reads_are_joined() {
        let samples = click_track(120.0, 0.1, 4.0);
        let bytes: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
        let mut whole = OnsetBuilder::default();
        whole.push_bytes(&bytes);
        let mut split = OnsetBuilder::default();
        for chunk in bytes.chunks(4093) {
            split.push_bytes(chunk);
        }
        assert_eq!(whole.finish(), split.finish());
    }

    #[test]
    fn ranges_are_checked() {
        assert!(check_range(0.0, 10.0).is_ok());
        for (a, b) in [
            (5.0, 4.0),
            (-1.0, 10.0),
            (0.0, 2.0),
            (0.0, f64::NAN),
            (0.0, 4.0 * 3600.0),
        ] {
            assert!(check_range(a, b).is_err(), "{a}..{b}");
        }
    }

    /// Prints the grid of each file in `CUTVII_BEAT_FILES` (`:`-separated); for tuning by hand.
    #[test]
    #[ignore]
    fn print_grids_of_files() {
        let ffmpeg = locate_tool("ffmpeg", FFMPEG_ENV).unwrap();
        for f in std::env::var("CUTVII_BEAT_FILES")
            .unwrap_or_default()
            .split(':')
            .filter(|f| !f.is_empty())
        {
            let mut d = 0.0;
            let probe = std::process::Command::new("ffprobe")
                .args([
                    "-v",
                    "error",
                    "-show_entries",
                    "format=duration",
                    "-of",
                    "csv=p=0",
                    f,
                ])
                .output()
                .unwrap();
            let len: f64 = String::from_utf8_lossy(&probe.stdout)
                .trim()
                .parse()
                .unwrap();
            let g = detect(
                &ffmpeg,
                Path::new(f),
                0.0,
                len,
                &AtomicBool::new(false),
                &mut |p| d = p,
            )
            .unwrap();
            println!(
                "{f}: bpm {:.2} offset {:.3} clarity {:.3} steady {}",
                g.bpm, g.offset, g.clarity, g.steady
            );
        }
    }

    /// Runs against a real FFmpeg; skipped (loudly) when none is installed.
    #[test]
    fn a_file_is_analysed_cached_and_a_cancel_leaves_nothing() {
        let Ok(ffmpeg) = locate_tool("ffmpeg", FFMPEG_ENV) else {
            eprintln!("SKIPPED: ffmpeg not found");
            return;
        };
        let dir = std::env::temp_dir().join(format!("cutvii-beats-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("clicks.wav");
        let samples = click_track(120.0, 0.2, 20.0);
        let raw = dir.join("clicks.f32");
        fs::write(
            &raw,
            samples
                .iter()
                .flat_map(|s| s.to_le_bytes())
                .collect::<Vec<u8>>(),
        )
        .unwrap();
        let ok = command(&ffmpeg)
            .args([
                "-y", "-v", "error", "-f", "f32le", "-ar", "22050", "-ac", "1", "-i",
            ])
            .arg(&raw)
            .args(["-ar", "44100", "-ac", "2"])
            .arg(&wav)
            .status()
            .unwrap();
        assert!(ok.success());

        // only the used range 5..15 s is read; its first beat is 5.2 s
        let mut last = 0.0;
        let grid = detect(
            &ffmpeg,
            &wav,
            5.0,
            15.0,
            &AtomicBool::new(false),
            &mut |p| last = p,
        )
        .unwrap();
        assert_eq!(last, 1.0);
        assert!((grid.bpm - 120.0).abs() < 0.5, "{grid:?}");
        assert!((grid.offset - 5.2).abs() < 0.03, "{grid:?}");
        assert!(grid.beats.iter().all(|b| (5.0..=15.0).contains(b)));

        let cache = dir.join("cache").join("k.json");
        write_grid(&grid, &cache).unwrap();
        let back = read_grid(&cache).unwrap();
        assert!((back.bpm - grid.bpm).abs() < 1e-9 && (back.offset - grid.offset).abs() < 1e-9);
        assert_eq!(back.beats.len(), grid.beats.len());
        assert_eq!(
            fs::read_dir(cache.parent().unwrap()).unwrap().count(),
            1,
            "no temp file left"
        );

        // cancelled on the first progress: an error, and nothing new on disk
        let cancel = AtomicBool::new(false);
        let before = fs::read_dir(&dir).unwrap().count();
        let err = detect(&ffmpeg, &wav, 0.0, 20.0, &cancel, &mut |_| {
            cancel.store(true, Ordering::Relaxed)
        });
        assert!(matches!(err, Err(AppError::Cancelled)));
        assert_eq!(fs::read_dir(&dir).unwrap().count(), before);

        // a file with no sound is an error
        let image = dir.join("i.png");
        command(&ffmpeg)
            .args([
                "-y",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=64x64:rate=1",
                "-frames:v",
                "1",
            ])
            .arg(&image)
            .status()
            .unwrap();
        assert!(
            detect(
                &ffmpeg,
                &image,
                0.0,
                5.0,
                &AtomicBool::new(false),
                &mut |_| {}
            )
            .is_err()
        );

        fs::remove_dir_all(&dir).ok();
    }
}
