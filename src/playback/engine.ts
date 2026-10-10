/**
 * Pure preview logic: which clips are on screen at time t, and what each media element should do.
 * Kept free of React/DOM so it can be unit-tested; the Preview component only applies the plans.
 */
import type { MediaAsset, Project, TimelineClip, TimelineTrack } from "@/project/model";
import { clipEnd, EPS } from "@/timeline/clips";

/** Clips starting within this many seconds are mounted (paused) so they are ready when reached. */
export const PRELOAD_SECONDS = 1;
/** While playing, correct a media element only when it drifts further than this from the clock. */
export const DRIFT_SECONDS = 0.3;
/** While paused/scrubbing, seek when further than this (about half a frame at 24fps). */
export const SEEK_EPSILON = 0.02;

export interface Layer {
  clip: TimelineClip;
  track: TimelineTrack;
  asset: MediaAsset;
  role: "active" | "upcoming";
  /** Exactly one active, non-hidden video/image layer is visible: the one on the highest track. */
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

  const top = layers
    .filter(
      (l) => l.role === "active" && l.track.type === "video" && !l.track.hidden && l.asset.type !== "audio",
    )
    .at(-1); // layers are in ascending track order, so the last one is on top
  return layers.map((l) => (l === top ? { ...l, visible: true } : l));
}

/** Position inside the source file for timeline time t, clamped to the clip's used range. */
export function sourceTimeFor(clip: TimelineClip, t: number): number {
  return Math.min(clip.sourceOut, Math.max(clip.sourceIn, clip.sourceIn + (t - clip.timelineStart)));
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
}

export interface SyncPlan {
  seekTo?: number;
  play?: boolean;
  pause?: boolean;
}

export function planSync({ role, playing, paused, currentTime, desired }: SyncInput): SyncPlan {
  const off = Math.abs(currentTime - desired);
  const plan: SyncPlan = {};

  if (role === "upcoming" || !playing) {
    if (!paused) plan.pause = true;
    if (off > SEEK_EPSILON) plan.seekTo = desired;
    return plan;
  }
  if (off > DRIFT_SECONDS) plan.seekTo = desired;
  if (paused) plan.play = true;
  return plan;
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
