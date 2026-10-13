/**
 * Transitions: how a clip comes in over what was there before it. A transition belongs to the incoming
 * clip: for its length the clip starts out moved, scaled, turned or see-through (`from`) and eases to where
 * it belongs. A clip that ends on the same track exactly where the incoming one starts holds its last frame
 * underneath for that time. The export does the same from the same file (`src-tauri/src/export/transitions.rs`).
 */
import { z } from "zod";
import raw from "../../presets/transitions.json";
import { TRANSITION_LIMITS, type ClipTransition, type Project, type TimelineClip } from "@/project/model";
import { clipDuration, clipEnd, findClip } from "./clips";
import type { EditResult } from "./edit";

const KindSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    /** The name when a clip leaves this way (it then ends where `from` is). */
    outName: z.string().min(1),
    /** Coming in: does the clip before it hold its last frame underneath? "Fade from black" does not. */
    hold: z.boolean().default(true),
    /** Where the clip starts: `x` / `y` / `rotation` are added, `scale` and `opacity` multiply. */
    from: z
      .object({
        x: z.number().default(0),
        y: z.number().default(0),
        scale: z.number().default(1),
        rotation: z.number().default(0),
        opacity: z.number().default(1),
      })
      .strict(),
  })
  .strict();

export type TransitionKind = z.infer<typeof KindSchema>;
export const TRANSITIONS: readonly TransitionKind[] = z.array(KindSchema).parse(raw);
export { TRANSITION_LIMITS };
export const DEFAULT_TRANSITION_SECONDS = 0.5;

/** How much of `from` is left at each share of the length: an ease in and out, drawn as straight lines. */
export const EASE: readonly (readonly [number, number])[] = [
  [0, 1],
  [0.25, 0.84375],
  [0.5, 0.5],
  [0.75, 0.15625],
  [1, 0],
];

/** Share of `from` left when `u` (0..1) of the transition has passed. */
export function remainingAt(u: number): number {
  if (u <= 0) return 1;
  for (let i = 1; i < EASE.length; i += 1) {
    const [u0, f0] = EASE[i - 1];
    const [u1, f1] = EASE[i];
    if (u < u1) return f0 + ((f1 - f0) * (u - u0)) / (u1 - u0);
  }
  return 0;
}

type Incoming = Pick<TimelineClip, "transitionIn" | "transitionOut" | "sourceIn" | "sourceOut" | "speed">;
export interface AppliedTransition {
  from: TransitionKind["from"];
  seconds: number;
  hold: boolean;
}

/** The clip's transition in as it is applied: its kind and its length, at most the clip's own length. */
export function transitionOf(clip: Incoming): AppliedTransition | null {
  if (!clip.transitionIn) return null;
  const kind = TRANSITIONS.find((k) => k.id === clip.transitionIn!.kind);
  if (!kind) return null;
  return {
    from: kind.from,
    hold: kind.hold,
    seconds: Math.min(clip.transitionIn.duration, clipDuration(clip as TimelineClip)),
  };
}

/** The clip's transition out as it is applied: it gets what the transition in leaves of the clip's length. */
export function transitionOutOf(clip: Incoming): AppliedTransition | null {
  if (!clip.transitionOut) return null;
  const kind = TRANSITIONS.find((k) => k.id === clip.transitionOut!.kind);
  if (!kind) return null;
  const room = clipDuration(clip as TimelineClip) - (transitionOf(clip)?.seconds ?? 0);
  const seconds = Math.min(clip.transitionOut.duration, room);
  return seconds > 1e-3 ? { from: kind.from, hold: kind.hold, seconds } : null;
}

/**
 * Seconds `clip` holds its last frame after it ends: the length of the transition of the clip that starts
 * on the same track exactly where this one ends. 0 when there is none.
 */
export function holdAfter(clip: TimelineClip, siblings: readonly TimelineClip[]): number {
  const end = clipEnd(clip);
  const next = siblings.find((c) => c !== clip && c.transitionIn && Math.abs(c.timelineStart - end) < 1e-3);
  const coming = next ? transitionOf(next) : null;
  return coming?.hold ? coming.seconds : 0;
}

/** Give a clip a transition in (or out), change it, or take it away (`null`). Not for sound. */
export function setClipTransition(
  project: Project,
  clipId: string,
  transition: ClipTransition | null,
  which: "in" | "out" = "in",
): EditResult {
  const field = which === "in" ? "transitionIn" : "transitionOut";
  const found = findClip(project, clipId);
  if (!found) return { ok: false, error: { code: "unknown-clip", message: `Unknown clip ${clipId}` } };
  const asset = project.assets.find((a) => a.id === found.clip.assetId);
  if (!asset || asset.type === "audio" || found.track.type !== "video") {
    return { ok: false, error: { code: "incompatible-track", message: "Sound has no picture to bring in" } };
  }
  if (transition) {
    const { min, max } = TRANSITION_LIMITS;
    const known = TRANSITIONS.some((k) => k.id === transition.kind);
    if (!known || !(transition.duration >= min && transition.duration <= max)) {
      return {
        ok: false,
        error: { code: "out-of-range", message: `A transition lasts ${min} to ${max} seconds` },
      };
    }
  }
  const now = found.clip[field];
  if ((now?.kind ?? null) === (transition?.kind ?? null) && now?.duration === transition?.duration) {
    return { ok: true, project };
  }
  return {
    ok: true,
    project: {
      ...project,
      tracks: project.tracks.map((t) =>
        t.id === found.track.id
          ? {
              ...t,
              clips: t.clips.map((c) => {
                if (c.id !== clipId) return c;
                const out = { ...c };
                if (transition) out[field] = { kind: transition.kind, duration: transition.duration };
                else delete out[field];
                return out;
              }),
            }
          : t,
      ),
    },
  };
}
