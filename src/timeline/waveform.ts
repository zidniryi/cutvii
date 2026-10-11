/** Pure waveform math: reading the peak file written by Rust and turning it into bars for a clip. */
import type { TimelineClip } from "@/project/model";

export interface WaveLevel {
  /** Peaks per second of source audio. */
  rate: number;
  /** One byte per peak: 0 = silence, 255 = full scale. */
  peaks: Uint8Array;
}

export interface Waveform {
  /** Finest level first. */
  levels: WaveLevel[];
}

const MAGIC = "CVWF";
const VERSION = 1;
/** The canvas only covers the part of a clip near the viewport, in steps of this many pixels. */
export const WAVE_TILE_PX = 512;

/** Parse the file layout documented in `src-tauri/src/media/waveform.rs`. Throws on anything else. */
export function parseWaveform(buffer: ArrayBuffer): Waveform {
  const view = new DataView(buffer);
  const magic = buffer.byteLength >= 12 ? String.fromCharCode(...new Uint8Array(buffer, 0, 4)) : "";
  if (magic !== MAGIC || view.getUint32(4, true) !== VERSION) throw new Error("not a waveform file");
  const count = view.getUint32(8, true);
  let offset = 12 + count * 8;
  if (count < 1 || offset > buffer.byteLength) throw new Error("waveform file is truncated");
  const levels: WaveLevel[] = [];
  for (let i = 0; i < count; i++) {
    const rate = view.getFloat32(12 + i * 8, true);
    const length = view.getUint32(16 + i * 8, true);
    if (!(rate > 0) || offset + length > buffer.byteLength) throw new Error("waveform file is truncated");
    levels.push({ rate, peaks: new Uint8Array(buffer, offset, length) });
    offset += length;
  }
  return { levels };
}

/**
 * The coarsest level that still has two peaks per drawn column (the finest when none has), so a coarse peak
 * never smears further than half a column.
 */
export function pickLevel(wave: Waveform, sourceSecondsPerColumn: number): WaveLevel {
  for (let i = wave.levels.length - 1; i > 0; i--) {
    if (wave.levels[i].rate * sourceSecondsPerColumn >= 2) return wave.levels[i];
  }
  return wave.levels[0];
}

type WaveClip = Pick<TimelineClip, "sourceIn" | "sourceOut" | "speed" | "reversed" | "volume">;

/**
 * Bar heights (0..1) for the pixel columns `[fromPx, toPx)` of a clip, measured from the clip's left edge.
 * Follows what the clip plays: its trimmed range, speed, direction and volume.
 */
export function waveColumns(
  wave: Waveform,
  clip: WaveClip,
  pps: number,
  fromPx: number,
  toPx: number,
): Float32Array {
  const speed = clip.speed ?? 1;
  const perColumn = speed / pps;
  const level = pickLevel(wave, perColumn);
  const out = new Float32Array(Math.max(0, toPx - fromPx));
  for (let i = 0; i < out.length; i++) {
    const offset = (fromPx + i) * perColumn;
    const start = clip.reversed ? clip.sourceOut - offset - perColumn : clip.sourceIn + offset;
    const a = Math.max(clip.sourceIn, start);
    const b = Math.min(clip.sourceOut, start + perColumn);
    if (b <= a) continue;
    const first = Math.floor(a * level.rate);
    const last = Math.min(level.peaks.length, Math.max(first + 1, Math.ceil(b * level.rate)));
    let peak = 0;
    for (let p = first; p < last; p++) if (level.peaks[p] > peak) peak = level.peaks[p];
    out[i] = Math.min(1, (peak / 255) * clip.volume);
  }
  return out;
}

/**
 * The slice of a clip (px from its left edge) worth drawing for a viewport, snapped to tiles so it only
 * changes now and then while scrolling. Null when the clip is out of view.
 */
export function waveWindow(
  clipLeft: number,
  clipWidth: number,
  viewLeft: number,
  viewRight: number,
): { from: number; to: number } | null {
  const from = Math.max(0, Math.floor((viewLeft - clipLeft) / WAVE_TILE_PX) * WAVE_TILE_PX);
  const to = Math.min(Math.ceil(clipWidth), Math.ceil((viewRight - clipLeft) / WAVE_TILE_PX) * WAVE_TILE_PX);
  return to > from ? { from, to } : null;
}
