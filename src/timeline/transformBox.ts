/**
 * Moving, sizing and turning a clip with the pointer in the preview. The maths of the box drawn around the
 * clip and of each gesture; the result is the same Transform the inspector sets, so the export follows.
 *
 * Coordinates: canvas pixels (`canvas.width x canvas.height`), y down. A clip's layer is the whole canvas,
 * turned and scaled about the canvas centre and then moved (CSS / export order: scale, rotate, translate).
 */
import { TRANSFORM_LIMITS, type MediaAsset, type Project, type TimelineClip } from "@/project/model";
import { findClip } from "./clips";
import type { EditResult } from "./edit";
import { croppedSize, cropOf, fitLayout, type Rect } from "./fit";
import { keysOf, setKey } from "./keyframes";
import { keyTime, setClipTransform, transformOf, valueAt, type KeyProp, type Transform } from "./transform";

export interface Pt {
  x: number;
  y: number;
}
interface Size {
  width: number;
  height: number;
}

/** Pulled onto the canvas centre lines when the clip's centre is this close (share of the canvas). */
export const SNAP_SHARE = 0.012;
/** Shift turns in steps of this many degrees. */
export const ROTATE_STEP = 15;

/**
 * The part of the canvas-sized layer that shows the clip, in shares of the canvas. A see-through picture
 * shows only its own fitted picture; every other clip covers the whole canvas (picture plus its background).
 */
export function layerBox(clip: TimelineClip, asset: MediaAsset, canvas: Size): Rect {
  if (asset.type === "image" && asset.alpha) {
    const kept = croppedSize(asset.width ?? 0, asset.height ?? 0, cropOf(clip));
    return fitLayout(kept.width, kept.height, canvas.width, canvas.height, "fit").picture;
  }
  return { x: 0, y: 0, width: 1, height: 1 };
}

/** Where a canvas point ends up under transform `t`. */
function place(p: Pt, t: Transform, canvas: Size): Pt {
  const c = { x: canvas.width / 2, y: canvas.height / 2 };
  const sx = t.scale * (t.flipH ? -1 : 1);
  const sy = t.scale * (t.flipV ? -1 : 1);
  const [dx, dy] = [(p.x - c.x) * sx, (p.y - c.y) * sy];
  const a = (t.rotation * Math.PI) / 180;
  return {
    x: c.x + t.x * canvas.width + dx * Math.cos(a) - dy * Math.sin(a),
    y: c.y + t.y * canvas.height + dx * Math.sin(a) + dy * Math.cos(a),
  };
}

/** The four corners of the box (top-left, top-right, bottom-right, bottom-left before turning). */
export function boxCorners(box: Rect, t: Transform, canvas: Size): Pt[] {
  const { width: w, height: h } = canvas;
  return [
    { x: box.x * w, y: box.y * h },
    { x: (box.x + box.width) * w, y: box.y * h },
    { x: (box.x + box.width) * w, y: (box.y + box.height) * h },
    { x: box.x * w, y: (box.y + box.height) * h },
  ].map((p) => place(p, t, canvas));
}

export const centreOf = (corners: Pt[]): Pt => ({
  x: corners.reduce((s, p) => s + p.x, 0) / corners.length,
  y: corners.reduce((s, p) => s + p.y, 0) / corners.length,
});

/** The point is inside the (convex) box. */
export function inside(corners: Pt[], p: Pt): boolean {
  let sign = 0;
  for (let i = 0; i < corners.length; i += 1) {
    const [a, b] = [corners[i], corners[(i + 1) % corners.length]];
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (cross === 0) continue;
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign) return false;
  }
  return true;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Moved by `dx`, `dy` canvas pixels from `t`. Unless `free`, the clip's centre is pulled onto the canvas
 * centre lines when it comes close; the lines it sits on are returned (shares) for drawing guides.
 */
export function moved(
  t: Transform,
  box: Rect,
  canvas: Size,
  dx: number,
  dy: number,
  free = false,
): { x: number; y: number; vertical: number[]; horizontal: number[] } {
  const limit = TRANSFORM_LIMITS.offset;
  let x = clamp(t.x + dx / canvas.width, -limit, limit);
  let y = clamp(t.y + dy / canvas.height, -limit, limit);
  const vertical: number[] = [];
  const horizontal: number[] = [];
  if (!free) {
    const c = centreOf(boxCorners(box, { ...t, x, y }, canvas));
    const [cx, cy] = [c.x / canvas.width, c.y / canvas.height];
    if (Math.abs(cx - 0.5) < SNAP_SHARE) {
      x += 0.5 - cx;
      vertical.push(0.5);
    }
    if (Math.abs(cy - 0.5) < SNAP_SHARE) {
      y += 0.5 - cy;
      horizontal.push(0.5);
    }
  }
  // no float dust from the snapping sum (a snapped value is exactly 0, not 3e-17)
  const clean = (v: number) => Math.round(v * 1e6) / 1e6;
  return { x: clean(x), y: clean(y), vertical, horizontal };
}

/** Scale after dragging a corner from `from` to `to` (canvas px), about the box centre `centre`. */
export function scaledFrom(scale: number, centre: Pt, from: Pt, to: Pt): number {
  const start = Math.hypot(from.x - centre.x, from.y - centre.y);
  const now = Math.hypot(to.x - centre.x, to.y - centre.y);
  if (start < 1) return scale;
  return clamp(scale * (now / start), TRANSFORM_LIMITS.minScale, TRANSFORM_LIMITS.maxScale);
}

/** Keep an angle in -180..180 degrees. */
export function normalAngle(deg: number): number {
  const a = ((((deg + 180) % 360) + 360) % 360) - 180;
  return a === -180 ? 180 : a;
}

/** Rotation after dragging the turn handle from `from` to `to` about `centre`; `step` snaps (Shift). */
export function rotatedFrom(rotation: number, centre: Pt, from: Pt, to: Pt, step = 0): number {
  const angle = (p: Pt) => (Math.atan2(p.y - centre.y, p.x - centre.x) * 180) / Math.PI;
  let r = normalAngle(rotation + angle(to) - angle(from));
  if (step > 0) r = normalAngle(Math.round(r / step) * step);
  return Math.round(r * 10) / 10;
}

/** The clip's own transform at timeline `time`: keyframes followed, transitions left out. */
export function ownTransformAt(clip: TimelineClip, time: number): Transform {
  const t = transformOf(clip);
  const at = keyTime(clip, time);
  for (const prop of ["x", "y", "scale", "rotation", "opacity"] as const) {
    const keys = keysOf(clip, prop);
    if (keys.length > 0) t[prop] = valueAt(keys, at);
  }
  return t;
}

/**
 * Set several transform values at once at timeline `time`: a value with keyframes gets a keyframe at the
 * playhead (as the inspector does), the others change for the whole clip. One edit, so one undo step.
 */
export function setTransformAt(
  project: Project,
  clipId: string,
  patch: Partial<Pick<Transform, KeyProp>>,
  time: number,
): EditResult {
  const found = findClip(project, clipId);
  if (!found) return { ok: false, error: { code: "unknown-clip", message: `Unknown clip ${clipId}` } };
  const at = keyTime(found.clip, time);
  const plain: Partial<Transform> = {};
  let next = project;
  for (const [prop, value] of Object.entries(patch) as [KeyProp, number][]) {
    if (keysOf(found.clip, prop).length > 0) {
      const r = setKey(next, clipId, prop, at, value);
      if (!r.ok) return r;
      next = r.project;
    } else {
      plain[prop] = value;
    }
  }
  return Object.keys(plain).length > 0 ? setClipTransform(next, clipId, plain) : { ok: true, project: next };
}

/**
 * `next` (a changed scale or rotation) with x and y adjusted so the box keeps its place on screen:
 * scaling and turning are about the canvas centre, but a person expects them about the clip's own centre.
 */
export function keepCentre(t: Transform, next: Transform, box: Rect, canvas: Size): Transform {
  const before = centreOf(boxCorners(box, t, canvas));
  const after = centreOf(boxCorners(box, next, canvas));
  return {
    ...next,
    x: clamp(next.x + (before.x - after.x) / canvas.width, -TRANSFORM_LIMITS.offset, TRANSFORM_LIMITS.offset),
    y: clamp(
      next.y + (before.y - after.y) / canvas.height,
      -TRANSFORM_LIMITS.offset,
      TRANSFORM_LIMITS.offset,
    ),
  };
}

/** A clip with a gesture in progress laid over it, for drawing the preview (keys of changed values dropped). */
export function withDraft(clip: TimelineClip, patch: Partial<Pick<Transform, KeyProp>>): TimelineClip {
  const out: TimelineClip = { ...clip, ...patch };
  if (clip.keyframes) {
    const keys = { ...clip.keyframes };
    for (const prop of Object.keys(patch) as KeyProp[]) delete keys[prop];
    if (Object.keys(keys).length > 0) out.keyframes = keys;
    else delete out.keyframes;
  }
  return out;
}
