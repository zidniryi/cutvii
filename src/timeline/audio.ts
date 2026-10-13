/** Per-clip sound: mute, fades, and detaching a video's sound into its own clip. */
import {
  MAX_FADE,
  type AudioClean,
  type MediaAsset,
  type Project,
  type TimelineClip,
  type TimelineTrack,
} from "@/project/model";
import { clipDuration, clipEnd, EPS, findClip } from "./clips";
import { addTrack, type EditResult } from "./edit";

export { MAX_FADE };

/** A clip that is only heard: an audio file, or a video's detached sound on an audio track. */
export const isSoundOnly = (track: Pick<TimelineTrack, "type">, asset: Pick<MediaAsset, "type">) =>
  track.type === "audio" || asset.type === "audio";

type Fading = Pick<TimelineClip, "fadeIn" | "fadeOut" | "sourceIn" | "sourceOut" | "speed" | "timelineStart">;

/**
 * The fades as they are applied (seconds on the timeline): the fade-in is at most the clip's length, the
 * fade-out takes what is left. The export uses the same rule (`TimelineClip::fades` in Rust).
 */
export function fadesOf(clip: Fading): { fadeIn: number; fadeOut: number } {
  const length = clipDuration(clip as TimelineClip);
  const fadeIn = Math.min(Math.max(0, clip.fadeIn ?? 0), length);
  const fadeOut = Math.min(Math.max(0, clip.fadeOut ?? 0), length - fadeIn);
  return { fadeIn, fadeOut };
}

/** How loud the clip is at timeline time `t` because of its fades: 0 (silent) to 1. Straight-line ramps. */
export function fadeGain(clip: Fading, t: number): number {
  const { fadeIn, fadeOut } = fadesOf(clip);
  const into = t - clip.timelineStart;
  const left = clipDuration(clip as TimelineClip) - into;
  let gain = 1;
  if (fadeIn > 0) gain = Math.min(gain, into / fadeIn);
  if (fadeOut > 0) gain = Math.min(gain, left / fadeOut);
  return Math.min(1, Math.max(0, gain));
}

const fail = (code: "unknown-clip" | "out-of-range" | "incompatible-track", message: string): EditResult => ({
  ok: false,
  error: { code, message },
});

const replaceClip = (
  project: Project,
  clipId: string,
  change: (c: TimelineClip) => TimelineClip,
): Project => ({
  ...project,
  tracks: project.tracks.map((t) =>
    t.clips.some((c) => c.id === clipId)
      ? { ...t, clips: t.clips.map((c) => (c.id === clipId ? change(c) : c)) }
      : t,
  ),
});

export interface ClipSound {
  muted: boolean;
  /** Seconds. */
  fadeIn: number;
  fadeOut: number;
}

/** Mute a clip or set its fades. Defaults (not muted, no fade) are not stored. Not for stills or text. */
export function setClipSound(project: Project, clipId: string, patch: Partial<ClipSound>): EditResult {
  const found = findClip(project, clipId);
  if (!found) return fail("unknown-clip", `Unknown clip ${clipId}`);
  const asset = project.assets.find((a) => a.id === found.clip.assetId);
  if (!asset || asset.type === "image") return fail("incompatible-track", "This clip has no sound");
  const current: ClipSound = {
    muted: found.clip.muted ?? false,
    fadeIn: found.clip.fadeIn ?? 0,
    fadeOut: found.clip.fadeOut ?? 0,
  };
  const next = { ...current, ...patch };
  const badFade = (v: number) => !Number.isFinite(v) || v < 0 || v > MAX_FADE;
  if (badFade(next.fadeIn) || badFade(next.fadeOut)) {
    return fail("out-of-range", `A fade can be 0 to ${MAX_FADE} seconds`);
  }
  if (next.muted === current.muted && next.fadeIn === current.fadeIn && next.fadeOut === current.fadeOut) {
    return { ok: true, project };
  }
  return {
    ok: true,
    project: replaceClip(project, clipId, (c) => {
      const out = { ...c };
      if (next.muted) out.muted = true;
      else delete out.muted;
      if (next.fadeIn > 0) out.fadeIn = next.fadeIn;
      else delete out.fadeIn;
      if (next.fadeOut > 0) out.fadeOut = next.fadeOut;
      else delete out.fadeOut;
      return out;
    }),
  };
}

export const NO_CLEAN: AudioClean = { noise: 0, rumble: false };
export const cleanOf = (clip: Pick<TimelineClip, "clean">): AudioClean => clip.clean ?? NO_CLEAN;

/** Set a clip's noise / rumble clean-up. "Nothing switched on" is not stored. Not for stills or text. */
export function setClipClean(project: Project, clipId: string, patch: Partial<AudioClean>): EditResult {
  const found = findClip(project, clipId);
  if (!found) return fail("unknown-clip", `Unknown clip ${clipId}`);
  const asset = project.assets.find((a) => a.id === found.clip.assetId);
  if (!asset || asset.type === "image") return fail("incompatible-track", "This clip has no sound");
  const current = cleanOf(found.clip);
  const next = { ...current, ...patch };
  if (!Number.isFinite(next.noise) || next.noise < 0 || next.noise > 1) {
    return fail("out-of-range", "Noise reduction can be 0 to 100 %");
  }
  if (next.noise === current.noise && next.rumble === current.rumble) return { ok: true, project };
  return {
    ok: true,
    project: replaceClip(project, clipId, (c) => {
      const out = { ...c };
      if (next.noise > 0 || next.rumble) out.clean = next;
      else delete out.clean;
      return out;
    }),
  };
}

/**
 * Ducking: turn this clip down while other clips make sound (music under a voice). 0 switches it off and
 * is not stored. Not for stills or text.
 */
export function setClipDuck(project: Project, clipId: string, amount: number): EditResult {
  const found = findClip(project, clipId);
  if (!found) return fail("unknown-clip", `Unknown clip ${clipId}`);
  const asset = project.assets.find((a) => a.id === found.clip.assetId);
  if (!asset || asset.type === "image") return fail("incompatible-track", "This clip has no sound");
  if (!Number.isFinite(amount) || amount < 0 || amount > 1) {
    return fail("out-of-range", "Ducking can be 0 to 100 %");
  }
  if ((found.clip.duck ?? 0) === amount) return { ok: true, project };
  return {
    ok: true,
    project: replaceClip(project, clipId, (c) => {
      const out = { ...c };
      if (amount > 0) out.duck = amount;
      else delete out.duck;
      return out;
    }),
  };
}

/**
 * Split a video clip's sound into its own clip on an audio track, at the same time and with the same
 * trim, speed, volume and fades. The video clip is muted, so the sound is heard once. One undo step.
 */
export function detachAudio(
  project: Project,
  clipId: string,
  ids: { clipId: string; trackId: string },
): EditResult {
  const found = findClip(project, clipId);
  if (!found) return fail("unknown-clip", `Unknown clip ${clipId}`);
  const { clip, track } = found;
  const asset = project.assets.find((a) => a.id === clip.assetId);
  if (!asset || asset.type !== "video" || track.type !== "video") {
    return fail("incompatible-track", "Only a video clip has sound to detach");
  }
  if (clip.muted) return fail("incompatible-track", "This clip's sound is already off");

  const end = clipEnd(clip);
  const free = [...project.tracks]
    .sort((a, b) => a.order - b.order)
    .find(
      (t) =>
        t.type === "audio" &&
        !t.clips.some((c) => c.timelineStart < end - EPS && clip.timelineStart < clipEnd(c) - EPS),
    );
  let next = project;
  if (!free) {
    const added = addTrack(next, "audio", ids.trackId);
    if (!added.ok) return added;
    next = added.project;
  }
  const target = free?.id ?? ids.trackId;
  // the sound keeps what shapes sound; everything about the picture stays with the video clip
  const sound: TimelineClip = {
    id: ids.clipId,
    assetId: clip.assetId,
    trackId: target,
    timelineStart: clip.timelineStart,
    sourceIn: clip.sourceIn,
    sourceOut: clip.sourceOut,
    volume: clip.volume,
    x: 0,
    y: 0,
    scale: 1,
    opacity: 1,
    ...(clip.speed !== undefined ? { speed: clip.speed } : {}),
    ...(clip.keepPitch !== undefined ? { keepPitch: clip.keepPitch } : {}),
    ...(clip.reversed !== undefined ? { reversed: clip.reversed } : {}),
    ...(clip.fadeIn !== undefined ? { fadeIn: clip.fadeIn } : {}),
    ...(clip.fadeOut !== undefined ? { fadeOut: clip.fadeOut } : {}),
    ...(clip.clean !== undefined ? { clean: clip.clean } : {}),
    ...(clip.duck !== undefined ? { duck: clip.duck } : {}),
  };
  next = replaceClip(next, clip.id, (c) => ({ ...c, muted: true }));
  return {
    ok: true,
    project: {
      ...next,
      tracks: next.tracks.map((t) =>
        t.id === target
          ? { ...t, clips: [...t.clips, sound].sort((a, b) => a.timelineStart - b.timelineStart) }
          : t,
      ),
    },
  };
}
