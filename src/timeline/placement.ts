/** Where a dropped asset lands (pure). Shared by the live ghost and the actual drop, so they always agree. */
import type { MediaAsset, Project } from "@/project/model";
import { DEFAULT_IMAGE_DURATION, firstFreeStart } from "./edit";

/** Where a drop landed on the timeline. */
export type DropTarget =
  { kind: "track"; trackId: string; time: number } | { kind: "new-track"; time: number };

/** State shared by the files of one drop, so they line up one after another. */
export interface DropPlacement {
  target: DropTarget;
  /** Next free start per track type. */
  cursor: Partial<Record<"video" | "audio", number>>;
  /** Tracks this drop created (dropped on empty space). */
  created: Partial<Record<"video" | "audio", string>>;
}

export const newDropPlacement = (target: DropTarget): DropPlacement => ({ target, cursor: {}, created: {} });

export interface PlacementPlan {
  /** Existing track to use, or null when a new track must be created. */
  trackId: string | null;
  trackType: "video" | "audio";
  start: number;
  duration: number;
  /** The pointer was on a lane that cannot hold this media, so another lane is used. */
  adapted: boolean;
  hint?: string;
}

const HINT = {
  audio: "Audio goes on an audio track",
  video: "Video and images go on a video track",
} as const;

export function assetDuration(asset: Pick<MediaAsset, "type" | "duration">): number {
  return asset.type === "image" ? DEFAULT_IMAGE_DURATION : (asset.duration ?? 0);
}

/**
 * Rules: use the lane under the pointer when it accepts the media; otherwise the first lane that does
 * (with a hint), or a new track when dropped on empty space or when no suitable lane exists.
 * Never overlap: slide to the first free spot at or after the wanted time.
 */
export function planPlacement(
  project: Project,
  placement: DropPlacement,
  asset: Pick<MediaAsset, "type" | "duration">,
): PlacementPlan {
  const wanted = asset.type === "audio" ? "audio" : "video";
  const { target } = placement;
  const dropped = target.kind === "track" ? project.tracks.find((t) => t.id === target.trackId) : undefined;
  const wrongLane = Boolean(dropped && dropped.type !== wanted);

  const existing =
    (placement.created[wanted]
      ? project.tracks.find((t) => t.id === placement.created[wanted])
      : undefined) ??
    (dropped?.type === wanted ? dropped : undefined) ??
    (target.kind === "track"
      ? [...project.tracks].sort((a, b) => a.order - b.order).find((t) => t.type === wanted)
      : undefined);

  const duration = assetDuration(asset);
  const desired = placement.cursor[wanted] ?? target.time;
  return {
    trackId: existing?.id ?? null,
    trackType: wanted,
    start: firstFreeStart(existing?.clips ?? [], desired, duration),
    duration,
    adapted: wrongLane,
    hint: wrongLane ? HINT[wanted] : undefined,
  };
}
