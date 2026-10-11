/**
 * Clip transform: where and how a clip's layer sits on the canvas. The layer is the whole canvas-sized
 * picture the clip produces (fit mode, background and crop already applied); the export places the same
 * layer the same way (`src-tauri/src/export/plan.rs`).
 */
import { TRANSFORM_LIMITS, type Project, type TimelineClip } from "@/project/model";
import { findClip } from "./clips";
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

type Transformable = Pick<TimelineClip, "x" | "y" | "scale" | "opacity" | "rotation" | "flipH" | "flipV">;

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
export const isTransformed = (clip: Transformable) => !same(transformOf(clip), NO_TRANSFORM);

const tidy = (v: number) => Number(v.toFixed(4));

/** CSS for a canvas-sized layer: mirror and scale first, then turn, then move (the export's order). */
export function transformStyle(clip: Transformable): { transform?: string; opacity?: number } {
  const t = transformOf(clip);
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
  if (same(current, next)) return { ok: true, project };

  const apply = (c: TimelineClip): TimelineClip => {
    const out: TimelineClip = { ...c, x: next.x, y: next.y, scale: next.scale, opacity: next.opacity };
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
