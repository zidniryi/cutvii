/**
 * Beat effects, the preview's half. This is the TypeScript twin of `src-tauri/src/export/beatfx.rs`: the same
 * beats, the same envelope and the same whole-number rounding, from the same table (`presets/beat-effects.json`).
 * `beatFxMath.test.tsx` holds both to the same numbers. The preview draws what `look` returns; the export
 * writes the same numbers into FFmpeg.
 */
import type { BeatEffect, BeatFx, MediaAsset, TimelineClip } from "@/project/model";
import { BEAT_TABLE } from "./beatFx";
import { adjustedBeats, type BeatGrid } from "./beats";
import { clipSpeed } from "./clips";
import { cropOf } from "./fit";

export interface Pulses {
  kind: BeatEffect["kind"];
  intensity: number;
  easing: NonNullable<BeatEffect["easing"]>;
  triggers: number[];
}

const DURATION = {
  zoom: BEAT_TABLE.zoom.duration,
  shake: BEAT_TABLE.shake.duration,
  flash: BEAT_TABLE.flash.duration,
  glitch: BEAT_TABLE.glitch.duration,
} as const;

/** The clip's beats in clip time (seconds from its start): the source range it uses, speed applied. */
export function clipBeats(
  grid: BeatGrid,
  fx: BeatFx | undefined,
  clip: Pick<TimelineClip, "sourceIn" | "sourceOut" | "speed">,
): number[] {
  const speed = clipSpeed(clip);
  return adjustedBeats(grid, fx)
    .filter((s) => s >= clip.sourceIn - 1e-9 && s < clip.sourceOut - 1e-9)
    .map((s) => (s - clip.sourceIn) / speed);
}

/** Each effect with the times it fires. Intensity 0 is left out; Reduce flashing caps and thins flashes. */
export function pulses(effects: BeatEffect[], beats: number[], reduceFlashing: boolean): Pulses[] {
  return effects
    .filter((e) => e.intensity > 0)
    .map((e) => {
      let triggers = beats.filter((_, i) => i % e.everyNthBeat === 0).map((b) => b + e.offsetMs / 1000);
      let intensity = e.intensity;
      if (reduceFlashing && e.kind === "flash") {
        const limits = BEAT_TABLE.reduceFlashing;
        intensity = Math.min(intensity, limits.maxFlashIntensity);
        const kept: number[] = [];
        for (const t of triggers) {
          if (kept.length === 0 || t - kept[kept.length - 1] >= limits.minGapSeconds - 1e-9) kept.push(t);
        }
        triggers = kept;
      }
      return { kind: e.kind, intensity, easing: e.easing ?? "out", triggers };
    });
}

/** What the effects do at one moment, as shares of the picture. */
export interface Frame {
  zoom: number;
  dx: number;
  dy: number;
  flash: number;
  glitch: number;
}

const REST: Frame = { zoom: 1, dx: 0, dy: 0, flash: 0, glitch: 0 };

function strength(easing: Pulses["easing"], x: number): number {
  if (!(x >= 0 && x < 1)) return 0;
  if (easing === "out") return (1 - x) * (1 - x);
  if (easing === "linear") return 1 - x;
  return Math.sin(Math.PI * x);
}

/** Index of the last trigger at or before `t` (plus 1e-9), or -1. */
function latest(triggers: number[], t: number): number {
  let lo = 0;
  let hi = triggers.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (triggers[mid] <= t + 1e-9) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

export function frameAt(list: Pulses[], t: number): Frame {
  const f = { ...REST };
  const k = BEAT_TABLE;
  for (const p of list) {
    const i = latest(p.triggers, t);
    if (i < 0) continue;
    const u = Math.max(0, t - p.triggers[i]);
    const e = p.intensity * strength(p.easing, u / DURATION[p.kind]);
    if (p.kind === "zoom") f.zoom += k.zoom.amount * e;
    else if (p.kind === "shake") {
      f.zoom += 2 * k.shake.amount * e;
      f.dx += k.shake.amount * e * Math.sin(2 * Math.PI * k.shake.hz * u);
      f.dy += k.shake.amountY * e * Math.cos(2 * Math.PI * k.shake.hz * u);
    } else if (p.kind === "flash") f.flash = Math.min(1, f.flash + k.flash.amount * e);
    else f.glitch += k.glitch.amount * e;
  }
  return f;
}

const even = (v: number) => Math.max(1, Math.round(v / 2)) * 2;

/** The whole numbers FFmpeg gets (see `Params` in beatfx.rs), for a picture of `w` x `h` pixels. */
export interface Params {
  scaledW: number;
  scaledH: number;
  x: number;
  y: number;
  /** Thousandths of a mix towards white. */
  flash: number;
  /** Pixels red moves right and blue left. */
  split: number;
}

export function params(f: Frame, w: number, h: number): Params {
  const scaledW = Math.max(even(w * f.zoom), w);
  const scaledH = Math.max(even(h * f.zoom), h);
  const place = (slack: number, d: number, size: number) =>
    Math.min(slack, Math.max(0, Math.round(slack / 2 - d * size)));
  return {
    scaledW,
    scaledH,
    x: place(scaledW - w, f.dx, w),
    y: place(scaledH - h, f.dy, h),
    flash: Math.round(Math.min(1, Math.max(0, f.flash)) * 1000),
    split: Math.max(0, Math.round(f.glitch * w)),
  };
}

/** Size of the picture the effects work on: the source after the crop, made even (as the export does). */
export function effectSize(asset: Pick<MediaAsset, "width" | "height">, clip: Pick<TimelineClip, "crop">) {
  if (!asset.width || !asset.height) return null;
  const c = cropOf(clip);
  return {
    w: even(asset.width * (1 - c.left - c.right)),
    h: even(asset.height * (1 - c.top - c.bottom)),
  };
}

/** Everything the preview needs to draw one clip's effects at any time. */
export interface Setup {
  pulses: Pulses[];
  w: number;
  h: number;
}

export function setupFor(
  clip: TimelineClip,
  asset: Pick<MediaAsset, "type" | "width" | "height" | "text">,
  grid: BeatGrid | undefined,
  reduceFlashing: boolean,
): Setup | null {
  const fx = clip.beatFx;
  if (!fx || !grid || asset.type !== "video" || asset.text || clip.reversed) return null;
  const size = effectSize(asset, clip);
  if (!size) return null;
  const list = pulses(fx.effects, clipBeats(grid, fx, clip), reduceFlashing);
  return list.some((p) => p.triggers.length > 0) ? { pulses: list, ...size } : null;
}

/** What CSS draws for one moment: a transform on the picture, a white mix and a channel split. */
export interface Look {
  transform: string | undefined;
  flash: number;
  /** Share of the picture's width red and blue move apart. */
  split: number;
}

export const NO_LOOK: Look = { transform: undefined, flash: 0, split: 0 };

export function look(setup: Setup, clipTime: number): Look {
  const p = params(frameAt(setup.pulses, clipTime), setup.w, setup.h);
  const moved = p.scaledW !== setup.w || p.scaledH !== setup.h || p.x !== 0 || p.y !== 0;
  return {
    transform: moved
      ? `translate(${(-p.x / setup.w) * 100}%, ${(-p.y / setup.h) * 100}%) scale(${p.scaledW / setup.w}, ${p.scaledH / setup.h})`
      : undefined,
    flash: p.flash / 1000,
    split: p.split / setup.w,
  };
}
