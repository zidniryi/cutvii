/** User-level editing actions: read the stores, run one undoable command, keep selection sane. */
import { useSelectionStore } from "@/store/selection";
import { useUiStore } from "@/store/ui";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { clipEnd, EPS, minClipDuration } from "./clips";
import type { FitMode } from "@/project/model";
import {
  addClip,
  addTrack,
  DEFAULT_IMAGE_DURATION,
  deleteClip,
  firstFreeStart,
  moveClip,
  setClipFit,
  setClipVolume,
  setTrackFlag,
  splitClip,
  trimClip,
  type EditResult,
} from "./edit";

const project = () => useProjectStore.getState().project;
const run = (label: string, apply: (p: ReturnType<typeof project>) => EditResult) =>
  useProjectStore.getState().execute({ label, apply });

/** Drop selected ids that no longer exist (after delete/undo/redo). */
export function pruneSelection() {
  const existing = new Set(project().tracks.flatMap((t) => t.clips.map((c) => c.id)));
  const sel = useSelectionStore.getState();
  const kept = sel.selectedClipIds.filter((id) => existing.has(id));
  if (kept.length !== sel.selectedClipIds.length) sel.setSelection(kept);
}

export function undo() {
  useProjectStore.getState().undo();
  pruneSelection();
}

export function redo() {
  useProjectStore.getState().redo();
  pruneSelection();
}

/** Place an asset on a track (default: first compatible track), at `start` (default: end of that track). */
export function addAssetToTimeline(
  assetId: string,
  opts: { trackId?: string; start?: number } = {},
): EditResult {
  const p = project();
  const asset = p.assets.find((a) => a.id === assetId);
  const wanted = asset?.type === "audio" ? "audio" : "video";
  const track = opts.trackId
    ? p.tracks.find((t) => t.id === opts.trackId)
    : [...p.tracks].sort((a, b) => a.order - b.order).find((t) => t.type === wanted);
  if (!track) return { ok: false, error: { code: "unknown-track", message: "No suitable track" } };
  const start = opts.start ?? Math.max(0, ...track.clips.map(clipEnd));

  const id = crypto.randomUUID();
  const result = run("Add clip", (pr) => addClip(pr, { assetId, trackId: track.id, start, id }));
  if (result.ok) useSelectionStore.getState().select(id);
  return result;
}

export function moveClipTo(clipId: string, start: number, trackId?: string): EditResult {
  return run("Move clip", (p) => moveClip(p, clipId, { start, trackId }));
}

export function trimClipEdge(clipId: string, edge: "start" | "end", time: number): EditResult {
  return run("Trim clip", (p) => trimClip(p, clipId, edge, time));
}

export function changeVolume(clipId: string, volume: number): EditResult {
  return run("Change volume", (p) => setClipVolume(p, clipId, volume));
}

export function changeFit(clipId: string, fit: FitMode): EditResult {
  return run("Change image fit", (p) => setClipFit(p, clipId, fit));
}

/** Where an OS drop landed on the timeline. */
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

/**
 * Put one dropped asset on the timeline: on the lane under the pointer when it accepts the media, otherwise on
 * the first lane that does, or on a new track when dropped on empty space. Never overlaps: it slides to the
 * first free spot at or after the drop time. Adding the track and the clip is one undo step.
 */
export function placeAssetAtDrop(assetId: string, placement: DropPlacement): EditResult {
  const p = project();
  const asset = p.assets.find((a) => a.id === assetId);
  if (!asset)
    return { ok: false, error: { code: "unknown-asset", message: "That media is no longer in the project" } };
  const wanted = asset.type === "audio" ? "audio" : "video";
  const { target } = placement;

  const dropped = target.kind === "track" ? p.tracks.find((t) => t.id === target.trackId) : undefined;
  const existing =
    (placement.created[wanted] ? p.tracks.find((t) => t.id === placement.created[wanted]) : undefined) ??
    (dropped?.type === wanted ? dropped : undefined) ??
    (target.kind === "track"
      ? [...p.tracks].sort((a, b) => a.order - b.order).find((t) => t.type === wanted)
      : undefined);

  const trackId = existing?.id ?? crypto.randomUUID();
  const duration = asset.type === "image" ? DEFAULT_IMAGE_DURATION : (asset.duration ?? 0);
  const desired = placement.cursor[wanted] ?? target.time;
  const start = firstFreeStart(existing?.clips ?? [], desired, duration);
  const id = crypto.randomUUID();

  const result = run("Add clip", (pr) => {
    let next = pr;
    if (!existing) {
      const t = addTrack(next, wanted, trackId);
      if (!t.ok) return t;
      next = t.project;
    }
    return addClip(next, { assetId, trackId, start, id });
  });
  if (result.ok) {
    if (!existing) placement.created[wanted] = trackId;
    placement.cursor[wanted] = start + duration;
    useSelectionStore.getState().select(id);
  }
  return result;
}

export function toggleTrackFlag(trackId: string, flag: "muted" | "hidden"): EditResult {
  const track = project().tracks.find((t) => t.id === trackId);
  const turningOn = track ? !track[flag] : true;
  const label =
    flag === "muted" ? (turningOn ? "Mute track" : "Unmute track") : turningOn ? "Hide track" : "Show track";
  return run(label, (p) => setTrackFlag(p, trackId, flag, turningOn));
}

/**
 * Split at the playhead: selected clips under it, or every clip under it when nothing is selected.
 * All cuts are one undo step.
 */
export function splitAtPlayhead(): EditResult {
  const time = usePlaybackStore.getState().playhead;
  const selected = new Set(useSelectionStore.getState().selectedClipIds);

  return run("Split at playhead", (p) => {
    const min = minClipDuration(p);
    const under = p.tracks
      .flatMap((t) => t.clips)
      .filter((c) => time > c.timelineStart + min - EPS && time < clipEnd(c) - min + EPS);
    const targets = selected.size > 0 ? under.filter((c) => selected.has(c.id)) : under;
    if (targets.length === 0) {
      return { ok: false, error: { code: "out-of-range", message: "No clip under the playhead" } };
    }
    let next = p;
    for (const c of targets) {
      const r = splitClip(next, c.id, time);
      if (!r.ok) return r;
      next = r.project;
    }
    return { ok: true, project: next };
  });
}

export function deleteSelected(): EditResult {
  const ids = useSelectionStore.getState().selectedClipIds;
  if (ids.length === 0) {
    return { ok: false, error: { code: "unknown-clip", message: "Nothing selected" } };
  }
  const result = run(ids.length > 1 ? "Delete clips" : "Delete clip", (p) => {
    let next = p;
    for (const id of ids) {
      const r = deleteClip(next, id);
      if (!r.ok) return r;
      next = r.project;
    }
    return { ok: true, project: next };
  });
  if (result.ok) pruneSelection();
  return result;
}

/** Surface a failed edit to the user (transient notice). Successful results pass through untouched. */
export function report(result: EditResult): EditResult {
  if (!result.ok) useUiStore.getState().setNotice(result.error.message);
  return result;
}
