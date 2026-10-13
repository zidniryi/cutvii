/**
 * Editing a clip's keyframes. What keyframes mean (interpolation, source time) is in `./transform.ts`;
 * the export applies the same keys (`src-tauri/src/export/plan.rs`).
 */
import { MAX_KEYS, TRANSFORM_LIMITS, type Project, type TimelineClip } from "@/project/model";
import { findClip } from "./clips";
import type { EditResult } from "./edit";
import { KEY_PROPS, NO_TRANSFORM, setClipTransform, type Key, type KeyProp } from "./transform";

/** Two times closer than this are the same keyframe (a little under one frame at 30 fps). */
export const KEY_SNAP = 0.03;

const RANGE: Record<KeyProp, [number, number]> = {
  x: [-TRANSFORM_LIMITS.offset, TRANSFORM_LIMITS.offset],
  y: [-TRANSFORM_LIMITS.offset, TRANSFORM_LIMITS.offset],
  scale: [TRANSFORM_LIMITS.minScale, TRANSFORM_LIMITS.maxScale],
  rotation: [-TRANSFORM_LIMITS.rotation, TRANSFORM_LIMITS.rotation],
  opacity: [0, 1],
};

const fail = (code: "unknown-clip" | "out-of-range" | "incompatible-track", message: string): EditResult => ({
  ok: false,
  error: { code, message },
});

export const keysOf = (clip: Pick<TimelineClip, "keyframes">, prop: KeyProp): readonly Key[] =>
  clip.keyframes?.[prop] ?? [];

/** The keyframe of `prop` at source time `t`, if there is one there. */
export const keyAt = (clip: Pick<TimelineClip, "keyframes">, prop: KeyProp, t: number): Key | undefined =>
  keysOf(clip, prop).find((k) => Math.abs(k.t - t) < KEY_SNAP);

function withKeys(project: Project, clipId: string, prop: KeyProp, keys: Key[]): Project {
  return {
    ...project,
    tracks: project.tracks.map((track) =>
      track.clips.some((c) => c.id === clipId)
        ? {
            ...track,
            clips: track.clips.map((c) => {
              if (c.id !== clipId) return c;
              const all = { ...c.keyframes };
              if (keys.length > 0) all[prop] = keys;
              else delete all[prop];
              const out = { ...c };
              if (Object.keys(all).length > 0) out.keyframes = all;
              else delete out.keyframes;
              return out;
            }),
          }
        : track,
    ),
  };
}

/** Add a keyframe of `prop` at source time `t`, or change the value of the one already there. */
export function setKey(project: Project, clipId: string, prop: KeyProp, t: number, v: number): EditResult {
  const found = findClip(project, clipId);
  if (!found) return fail("unknown-clip", `Unknown clip ${clipId}`);
  const asset = project.assets.find((a) => a.id === found.clip.assetId);
  if (!asset || asset.type === "audio") return fail("incompatible-track", "Sound has no picture to animate");
  const [min, max] = RANGE[prop];
  if (!Number.isFinite(t) || t < 0 || !Number.isFinite(v) || v < min || v > max) {
    return fail("out-of-range", "That is outside what a clip can be moved or scaled to");
  }
  const keys = keysOf(found.clip, prop);
  const there = keyAt(found.clip, prop, t);
  if (there?.v === v) return { ok: true, project };
  if (!there && keys.length >= MAX_KEYS) {
    return fail("out-of-range", `A property can have ${MAX_KEYS} keyframes at most`);
  }
  const next = there
    ? keys.map((k) => (k === there ? { t: k.t, v } : k))
    : [...keys, { t, v }].sort((a, b) => a.t - b.t);
  return { ok: true, project: withKeys(project, clipId, prop, next) };
}

/**
 * Remove the keyframe of `prop` at source time `t`. When it was the last one, the property stops being
 * animated and keeps the value it had there.
 */
export function removeKey(project: Project, clipId: string, prop: KeyProp, t: number): EditResult {
  const found = findClip(project, clipId);
  if (!found) return fail("unknown-clip", `Unknown clip ${clipId}`);
  const there = keyAt(found.clip, prop, t);
  if (!there) return { ok: true, project };
  const left = keysOf(found.clip, prop).filter((k) => k !== there);
  const next = withKeys(project, clipId, prop, left);
  if (left.length > 0) return { ok: true, project: next };
  return {
    ok: true,
    project: {
      ...next,
      tracks: next.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((c) => (c.id === clipId ? { ...c, [prop]: there.v } : c)),
      })),
    },
  };
}

/**
 * Put one property back to where it starts: its keyframes go, and the clip gets the plain value (full size,
 * centred, not turned, opaque).
 */
export function resetProp(project: Project, clipId: string, prop: KeyProp): EditResult {
  const found = findClip(project, clipId);
  if (!found) return fail("unknown-clip", `Unknown clip ${clipId}`);
  const cleared = keysOf(found.clip, prop).length > 0 ? withKeys(project, clipId, prop, []) : project;
  return setClipTransform(cleared, clipId, { [prop]: NO_TRANSFORM[prop] });
}

export interface KeyMark {
  /** Seconds from the clip's start on the timeline. */
  at: number;
  /** The properties that have a keyframe there. */
  props: KeyProp[];
}

/**
 * Where a clip's keyframes sit along it on the timeline. Keys are source times, so a mark follows trim,
 * speed and reverse (the inverse of `keyTime`); keys in the part that was trimmed away have no mark.
 * Properties with a key at the same moment share one mark.
 */
export function keyMarks(
  clip: Pick<TimelineClip, "keyframes" | "sourceIn" | "sourceOut" | "speed" | "reversed">,
): KeyMark[] {
  if (!clip.keyframes) return [];
  const speed = clip.speed ?? 1;
  const marks: (KeyMark & { t: number })[] = [];
  for (const prop of KEY_PROPS) {
    for (const key of keysOf(clip, prop)) {
      if (key.t < clip.sourceIn - KEY_SNAP || key.t > clip.sourceOut + KEY_SNAP) continue;
      const there = marks.find((m) => Math.abs(m.t - key.t) < KEY_SNAP);
      if (there) there.props.push(prop);
      else {
        const t = Math.min(clip.sourceOut, Math.max(clip.sourceIn, key.t));
        marks.push({
          t: key.t,
          at: (clip.reversed ? clip.sourceOut - t : t - clip.sourceIn) / speed,
          props: [prop],
        });
      }
    }
  }
  return marks.sort((a, b) => a.at - b.at).map(({ at, props }) => ({ at, props }));
}
