/**
 * Clip transform: where and how a clip's layer sits on the canvas. The layer is the whole canvas-sized
 * picture the clip produces (fit mode, background and crop already applied); the export places the same
 * layer the same way (`src-tauri/src/export/plan.rs`).
 */
import { TRANSFORM_LIMITS, type Project, type TimelineClip } from "@/project/model";
import { findClip } from "./clips";
import { remainingAt, transitionOf, transitionOutOf } from "./transitions";
import type { EditResult } from "./edit";

export { TRANSFORM_LIMITS };

export interface Transform {
  /** Offset as a share of the canvas: 0.1 = a tenth of its width to the right / of its height down. */
  x: number;
  y: number;
  /** 1 is the fitted size. */
  scale: number;
  /** Degrees, clockwise. */
  rotation: number;
  flipH: boolean;
  flipV: boolean;
  /** 0 (invisible) to 1. */
  opacity: number;
}

export const NO_TRANSFORM: Transform = {
  x: 0,
  y: 0,
  scale: 1,
  rotation: 0,
  flipH: false,
  flipV: false,
  opacity: 1,
};

type Transformable = Pick<
  TimelineClip,
  | "x"
  | "y"
  | "scale"
  | "opacity"
  | "rotation"
  | "flipH"
  | "flipV"
  | "keyframes"
  | "transitionIn"
  | "transitionOut"
>;

export interface Key {
  /** Source time: seconds in the media, like `sourceIn`. */
  t: number;
  v: number;
}

/** The properties that can have keyframes. */
export const KEY_PROPS = ["x", "y", "scale", "rotation", "opacity"] as const;
export type KeyProp = (typeof KEY_PROPS)[number];

/**
 * The value keys give at time `t`: straight lines between keys, the first value before the first key and
 * the last value after the last. The export builds the same from the same keys (`piecewise` in Rust).
 */
export function valueAt(keys: readonly Key[], t: number): number {
  if (t <= keys[0].t) return keys[0].v;
  for (let i = 1; i < keys.length; i += 1) {
    const [a, b] = [keys[i - 1], keys[i]];
    if (t < b.t) return a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
  }
  return keys[keys.length - 1].v;
}

type Timed = Transformable &
  Pick<TimelineClip, "timelineStart" | "sourceIn" | "sourceOut" | "speed" | "reversed">;

/** Source time shown at timeline `time`, kept inside the clip (the rule of `sourceTimeAt`). */
export function keyTime(clip: Timed, time: number): number {
  const used = (time - clip.timelineStart) * (clip.speed ?? 1);
  const t = clip.reversed ? clip.sourceOut - used : clip.sourceIn + used;
  return Math.min(clip.sourceOut, Math.max(clip.sourceIn, t));
}

/**
 * The transform at timeline `time`: every property that has keyframes follows them, and while the clip's
 * transition runs it is still on its way in from where the transition starts.
 */
export function transformAt(clip: Timed, time: number): Transform {
  const t = transformOf(clip);
  if (clip.keyframes) {
    const at = keyTime(clip, time);
    for (const prop of KEY_PROPS) {
      const keys = clip.keyframes[prop];
      if (keys && keys.length > 0) t[prop] = valueAt(keys, at);
    }
  }
  const coming = transitionOf(clip);
  if (coming) {
    const left = remainingAt((time - clip.timelineStart) / coming.seconds);
    if (left > 0) {
      t.x += coming.from.x * left;
      t.y += coming.from.y * left;
      t.rotation += coming.from.rotation * left;
      t.scale *= 1 + (coming.from.scale - 1) * left;
      t.opacity *= 1 + (coming.from.opacity - 1) * left;
    }
  }
  const going = transitionOutOf(clip);
  if (going) {
    // the same ease the other way: nothing of `from` until the last seconds, all of it at the end
    const length = (clip.sourceOut - clip.sourceIn) / (clip.speed ?? 1);
    const gone = 1 - remainingAt((time - clip.timelineStart - (length - going.seconds)) / going.seconds);
    if (gone > 0) {
      t.x += going.from.x * gone;
      t.y += going.from.y * gone;
      t.rotation += going.from.rotation * gone;
      t.scale *= 1 + (going.from.scale - 1) * gone;
      t.opacity *= 1 + (going.from.opacity - 1) * gone;
    }
  }
  return t;
}

export const transformOf = (clip: Transformable): Transform => ({
  x: clip.x,
  y: clip.y,
  scale: clip.scale,
  rotation: clip.rotation ?? 0,
  flipH: clip.flipH ?? false,
  flipV: clip.flipV ?? false,
  opacity: clip.opacity,
});

const same = (a: Transform, b: Transform) =>
  (Object.keys(NO_TRANSFORM) as (keyof Transform)[]).every((k) => a[k] === b[k]);

/** A transformed layer no longer covers the canvas, so whatever is on the tracks below shows too. */
export const isTransformed = (clip: Transformable) =>
  clip.keyframes !== undefined ||
  clip.transitionIn !== undefined ||
  clip.transitionOut !== undefined ||
  !same(transformOf(clip), NO_TRANSFORM);

const tidy = (v: number) => Number(v.toFixed(4));

/** CSS for a canvas-sized layer: mirror and scale first, then turn, then move (the export's order). */
export function transformStyle(
  clip: Transformable | Timed,
  /** Timeline time, for a clip with keyframes. */
  time?: number,
): { transform?: string; opacity?: number } {
  const t = time !== undefined && "timelineStart" in clip ? transformAt(clip, time) : transformOf(clip);
  const parts: string[] = [];
  if (t.x !== 0 || t.y !== 0) parts.push(`translate(${tidy(t.x * 100)}%, ${tidy(t.y * 100)}%)`);
  if (t.rotation !== 0) parts.push(`rotate(${tidy(t.rotation)}deg)`);
  if (t.scale !== 1 || t.flipH || t.flipV) {
    parts.push(`scale(${tidy(t.scale * (t.flipH ? -1 : 1))}, ${tidy(t.scale * (t.flipV ? -1 : 1))})`);
  }
  return {
    transform: parts.length > 0 ? parts.join(" ") : undefined,
    opacity: t.opacity !== 1 ? t.opacity : undefined,
  };
}

function valid(t: Transform): boolean {
  const { offset, minScale, maxScale, rotation } = TRANSFORM_LIMITS;
  return (
    Math.abs(t.x) <= offset &&
    Math.abs(t.y) <= offset &&
    t.scale >= minScale &&
    t.scale <= maxScale &&
    Math.abs(t.rotation) <= rotation &&
    t.opacity >= 0 &&
    t.opacity <= 1
  );
}

/** Change some transform properties of a clip, or put them all back with `null`. Not for sound. */
export function setClipTransform(
  project: Project,
  clipId: string,
  patch: Partial<Transform> | null,
): EditResult {
  const found = findClip(project, clipId);
  if (!found) return { ok: false, error: { code: "unknown-clip", message: `Unknown clip ${clipId}` } };
  const asset = project.assets.find((a) => a.id === found.clip.assetId);
  if (!asset || asset.type === "audio") {
    return { ok: false, error: { code: "incompatible-track", message: "Sound has no picture to transform" } };
  }
  const current = transformOf(found.clip);
  const next = patch ? { ...current, ...patch } : NO_TRANSFORM;
  if (!valid(next)) {
    return {
      ok: false,
      error: { code: "out-of-range", message: "That is outside what a clip can be moved or scaled to" },
    };
  }
  if (same(current, next) && (patch || !found.clip.keyframes)) return { ok: true, project };

  const apply = (c: TimelineClip): TimelineClip => {
    const out: TimelineClip = { ...c, x: next.x, y: next.y, scale: next.scale, opacity: next.opacity };
    // a reset takes the keyframes away too
    if (!patch) delete out.keyframes;
    // the optional ones are only stored when they are not the default
    if (next.rotation !== 0) out.rotation = next.rotation;
    else delete out.rotation;
    if (next.flipH) out.flipH = true;
    else delete out.flipH;
    if (next.flipV) out.flipV = true;
    else delete out.flipV;
    return out;
  };
  return {
    ok: true,
    project: {
      ...project,
      tracks: project.tracks.map((t) =>
        t.id === found.track.id ? { ...t, clips: t.clips.map((c) => (c.id === clipId ? apply(c) : c)) } : t,
      ),
    },
  };
}
