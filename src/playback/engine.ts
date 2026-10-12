/**
 * Pure preview logic: which clips are on screen at time t, and what each media element should do.
 * Kept free of React/DOM so it can be unit-tested; the Preview component only applies the plans.
 */
import type { MediaAsset, Project, TimelineClip, TimelineTrack } from "@/project/model";
import { clipEnd, clipSpeed, EPS } from "@/timeline/clips";
import { isSoundOnly } from "@/timeline/audio";
import { isTransformed } from "@/timeline/transform";

/** Clips starting within this many seconds are mounted (paused) so they are ready when reached. */
export const PRELOAD_SECONDS = 1;
/** While playing, a follower further than this from the clock is re-seeked (a jump you can hear or see). */
export const DRIFT_SECONDS = 0.75;
/** Smaller differences are closed smoothly by playing slightly faster or slower. */
export const RATE_DEADBAND = 0.04;
export const MAX_RATE_NUDGE = 0.08;
/** A follower is only corrected once it is this far (seconds) from where it should be... */
export const NUDGE_START = 0.08;
/** ...and then by this fixed share of its speed, until it is back within half the deadband. */
export const NUDGE_STEP = 0.05;
/** While paused/scrubbing, seek when further than this (about half a frame at 24fps). */
export const SEEK_EPSILON = 0.02;

export interface Layer {
  clip: TimelineClip;
  track: TimelineTrack;
  asset: MediaAsset;
  role: "active" | "upcoming";
  /**
   * Visible picture layers, from the top track down: every text picture (they are transparent) and the first
   * video or image under them. Whatever lies below that one is covered.
   */
  visible: boolean;
}

export function layersAt(project: Project, t: number, horizon = PRELOAD_SECONDS): Layer[] {
  const assets = new Map(project.assets.map((a) => [a.id, a]));
  const layers: Layer[] = [];

  for (const track of [...project.tracks].sort((a, b) => a.order - b.order)) {
    for (const clip of track.clips) {
      const asset = assets.get(clip.assetId);
      if (!asset) continue;
      const active = clip.timelineStart <= t + EPS && t < clipEnd(clip) - EPS;
      const upcoming = !active && clip.timelineStart > t && clip.timelineStart <= t + horizon;
      if (active || upcoming)
        layers.push({ clip, track, asset, role: active ? "active" : "upcoming", visible: false });
    }
  }

  const pictures = layers.filter(
    (l) => l.role === "active" && l.track.type === "video" && !l.track.hidden && l.asset.type !== "audio",
  );
  // layers are in ascending track order, so walk from the end (the top) down to the first opaque picture
  const shown = new Set<Layer>();
  for (let i = pictures.length - 1; i >= 0; i--) {
    shown.add(pictures[i]);
    // text is transparent and a transformed clip no longer covers the canvas: keep going down
    if (!pictures[i].asset.text && !isTransformed(pictures[i].clip)) break;
  }
  return layers.map((l) => (shown.has(l) ? { ...l, visible: true } : l));
}

/** Position inside the source file for timeline time t, clamped to the clip's used range. */
export function sourceTimeFor(clip: TimelineClip, t: number): number {
  const used = (t - clip.timelineStart) * clipSpeed(clip);
  // Reversed clips are previewed from a reversed copy of exactly the used range, which starts at 0.
  if (clip.reversed) return Math.min(clip.sourceOut - clip.sourceIn, Math.max(0, used));
  return Math.min(clip.sourceOut, Math.max(clip.sourceIn, clip.sourceIn + used));
}

/** Where an element should rest while its clip is still upcoming. */
export const restTimeFor = (clip: TimelineClip) => (clip.reversed ? 0 : clip.sourceIn);

/** The webview can only preview this range of speeds reliably; export is exact at any speed. */
export const PREVIEW_SPEED = { min: 0.25, max: 4 } as const;
/** Above this speed sound is muted, in the preview and in the export alike. */
export const MAX_AUDIBLE_SPEED = 4;

/** The rate to give a media element for a clip speed, and whether that is the real speed. */
export function previewRate(speed: number): { rate: number; exact: boolean } {
  const rate = Math.min(PREVIEW_SPEED.max, Math.max(PREVIEW_SPEED.min, speed));
  return { rate, exact: Math.abs(rate - speed) < 1e-9 };
}

/** Timeline time shown by an element that is at `currentTime` in the source. */
export function timelineTimeFor(clip: TimelineClip, currentTime: number): number {
  const base = clip.reversed ? 0 : clip.sourceIn;
  return clip.timelineStart + (currentTime - base) / clipSpeed(clip);
}

/** Stable identity of a layer set; changes only when something mounts, unmounts or toggles visibility. */
export const layerKey = (l: Layer) => `${l.clip.id}:${l.role}:${l.visible ? 1 : 0}`;

export interface SyncInput {
  role: Layer["role"];
  playing: boolean;
  paused: boolean;
  currentTime: number;
  /** Where the element should be right now (sourceIn for upcoming clips). */
  desired: number;
  /** This element drives the playhead: it is never corrected while it plays. */
  lead?: boolean;
  /**
   * The catch-up factor the element is playing with right now (its rate divided by the clip's own speed);
   * 1 when it is not being corrected. Lets a correction, once started, run until it is done.
   */
  nudging?: number;
}

export interface SyncPlan {
  seekTo?: number;
  play?: boolean;
  pause?: boolean;
  /** Playback rate to use while playing (1 = normal). Followers are nudged instead of re-seeked. */
  rate?: number;
}

export function planSync({
  role,
  playing,
  paused,
  currentTime,
  desired,
  lead = false,
  nudging = 1,
}: SyncInput): SyncPlan {
  const ahead = currentTime - desired; // > 0: the element is ahead of the clock
  const off = Math.abs(ahead);
  const plan: SyncPlan = {};

  if (role === "upcoming" || !playing) {
    if (!paused) plan.pause = true;
    if (off > SEEK_EPSILON) plan.seekTo = desired;
    plan.rate = 1;
    return plan;
  }

  if (off > DRIFT_SECONDS) {
    // far away (the user seeked, or it fell badly behind): jump once, then play normally
    plan.seekTo = desired;
    plan.rate = 1;
  } else if (lead) {
    plan.rate = 1;
  } else {
    // A follower catches up by playing a few percent faster or slower. The rate is changed as RARELY as
    // possible: every change of a video's playback rate costs the webview a hitch, and a rate that
    // followed the gap frame by frame made the picture stutter whenever sound led (music under a video,
    // the karaoke track). So: one fixed step, started only when the gap is clearly there, and kept until
    // the gap is closed.
    const correcting = Math.abs(nudging - 1) > 0.001;
    const sameWay = correcting && nudging < 1 === ahead > 0;
    if (sameWay && off > RATE_DEADBAND / 2) plan.rate = nudging;
    else if (off > NUDGE_START) plan.rate = ahead > 0 ? 1 - NUDGE_STEP : 1 + NUDGE_STEP;
    else plan.rate = 1;
  }
  if (paused) plan.play = true;
  return plan;
}

/**
 * The layer whose own clock drives the playhead. Sound comes first: a hiccup in music or speech is far
 * more noticeable than a picture that speeds up by a few percent to keep in step.
 */
export function pickLead(layers: Layer[]): Layer | undefined {
  const active = layers.filter((l) => l.role === "active" && l.asset.type !== "image");
  return active.find((l) => isSoundOnly(l.track, l.asset)) ?? active.find((l) => l.visible) ?? active[0];
}

export function mediaErrorMessage(code: number | undefined): string {
  switch (code) {
    case 2:
      return "could not be read (network/IO error)";
    case 3:
      return "could not be decoded";
    case 4:
      return "is missing, or its format is not supported by the preview";
    default:
      return "could not be played";
  }
}
