/**
 * Pure timeline edit operations: (project, args) -> EditResult. Nothing here touches stores or the DOM.
 *
 * Rules (also what export will assume, Phase 6):
 * - Clips on the same track never overlap; touching is fine. Gaps are allowed (black / silence).
 * - Clips on different tracks may overlap; a higher track `order` is drawn on top.
 * - Audio tracks hold audio assets; video tracks hold video and image assets.
 * - Speed is always 1, so timeline length == sourceOut - sourceIn.
 * - add/move/split reject invalid requests; trim clamps to the nearest valid edge (drag-friendly).
 */
import type { FitMode, Project, TimelineClip, TimelineTrack } from "@/project/model";
import { clipDuration, clipEnd, EPS, findClip, minClipDuration } from "./clips";

export const DEFAULT_IMAGE_DURATION = 5;

export type EditErrorCode =
  "unknown-clip" | "unknown-asset" | "unknown-track" | "incompatible-track" | "overlap" | "out-of-range";

export interface EditError {
  code: EditErrorCode;
  message: string;
}

export type EditResult = { ok: true; project: Project } | { ok: false; error: EditError };

const ok = (project: Project): EditResult => ({ ok: true, project });
const fail = (code: EditErrorCode, message: string): EditResult => ({ ok: false, error: { code, message } });

const byStart = (a: TimelineClip, b: TimelineClip) => a.timelineStart - b.timelineStart;
const clampRange = (t: number, lo: number, hi: number) => Math.min(Math.max(t, lo), Math.max(lo, hi));

function overlaps(clips: TimelineClip[], start: number, end: number, ignoreId?: string): boolean {
  return clips.some((c) => c.id !== ignoreId && c.timelineStart < end - EPS && start < clipEnd(c) - EPS);
}

function acceptsAsset(track: TimelineTrack, assetType: "video" | "audio" | "image"): boolean {
  return track.type === "audio" ? assetType === "audio" : assetType !== "audio";
}

function withTracks(project: Project, tracks: TimelineTrack[]): Project {
  return { ...project, tracks };
}

export interface AddClipArgs {
  assetId: string;
  trackId: string;
  start: number;
  /** Defaults to the asset duration (images: DEFAULT_IMAGE_DURATION). */
  duration?: number;
  id?: string;
}

export function addClip(project: Project, args: AddClipArgs): EditResult {
  const asset = project.assets.find((a) => a.id === args.assetId);
  if (!asset) return fail("unknown-asset", `Unknown asset ${args.assetId}`);
  const track = project.tracks.find((t) => t.id === args.trackId);
  if (!track) return fail("unknown-track", `Unknown track ${args.trackId}`);
  if (!acceptsAsset(track, asset.type)) {
    return fail("incompatible-track", `A ${asset.type} cannot be placed on a ${track.type} track`);
  }
  if (!(args.start >= 0)) return fail("out-of-range", "Clip cannot start before 0");

  const available = asset.type === "image" ? DEFAULT_IMAGE_DURATION : (asset.duration ?? 0);
  const duration = args.duration ?? available;
  if (!(duration > 0)) return fail("out-of-range", "Clip would have no length");
  if (asset.type !== "image" && asset.duration !== undefined && duration > asset.duration + EPS) {
    return fail("out-of-range", "Clip is longer than its source media");
  }
  if (overlaps(track.clips, args.start, args.start + duration)) {
    return fail("overlap", "Clip would overlap another clip on this track");
  }

  const clip: TimelineClip = {
    id: args.id ?? crypto.randomUUID(),
    assetId: asset.id,
    trackId: track.id,
    timelineStart: args.start,
    sourceIn: 0,
    sourceOut: duration,
    volume: 1,
    x: 0,
    y: 0,
    scale: 1,
    opacity: 1,
  };
  return ok(
    withTracks(
      project,
      project.tracks.map((t) => (t.id === track.id ? { ...t, clips: [...t.clips, clip].sort(byStart) } : t)),
    ),
  );
}

export function moveClip(
  project: Project,
  clipId: string,
  to: { start: number; trackId?: string },
): EditResult {
  const found = findClip(project, clipId);
  if (!found) return fail("unknown-clip", `Unknown clip ${clipId}`);
  const { clip } = found;
  const target = project.tracks.find((t) => t.id === (to.trackId ?? clip.trackId));
  if (!target) return fail("unknown-track", `Unknown track ${to.trackId}`);
  const asset = project.assets.find((a) => a.id === clip.assetId);
  if (!asset) return fail("unknown-asset", `Unknown asset ${clip.assetId}`);
  if (!acceptsAsset(target, asset.type)) {
    return fail("incompatible-track", `A ${asset.type} cannot be placed on a ${target.type} track`);
  }
  if (!(to.start >= 0)) return fail("out-of-range", "Clip cannot start before 0");

  const end = to.start + clipDuration(clip);
  if (overlaps(target.clips, to.start, end, clip.id)) {
    return fail("overlap", "Clip would overlap another clip on this track");
  }
  if (target.id === clip.trackId && Math.abs(to.start - clip.timelineStart) < EPS) return ok(project);

  const moved: TimelineClip = { ...clip, timelineStart: to.start, trackId: target.id };
  return ok(
    withTracks(
      project,
      project.tracks.map((t) => {
        const without = t.clips.filter((c) => c.id !== clip.id);
        return t.id === target.id
          ? { ...t, clips: [...without, moved].sort(byStart) }
          : { ...t, clips: without };
      }),
    ),
  );
}

/** Trim one edge to `time` (timeline seconds). Clamps to neighbours, source media limits and one frame. */
export function trimClip(project: Project, clipId: string, edge: "start" | "end", time: number): EditResult {
  const found = findClip(project, clipId);
  if (!found) return fail("unknown-clip", `Unknown clip ${clipId}`);
  const { clip, track } = found;
  const asset = project.assets.find((a) => a.id === clip.assetId);
  const min = minClipDuration(project);
  const others = track.clips.filter((c) => c.id !== clip.id);
  const start = clip.timelineStart;
  const end = clipEnd(clip);

  let next: TimelineClip;
  if (edge === "start") {
    const prevEnd = Math.max(0, ...others.filter((c) => clipEnd(c) <= start + EPS).map(clipEnd));
    const t = clampRange(time, Math.max(prevEnd, start - clip.sourceIn), end - min);
    next = { ...clip, timelineStart: t, sourceIn: Math.max(0, clip.sourceIn + (t - start)) };
  } else {
    const nextStart = Math.min(
      Infinity,
      ...others.filter((c) => c.timelineStart >= end - EPS).map((c) => c.timelineStart),
    );
    const finite = asset?.type !== "image" && asset?.duration !== undefined;
    const sourceLimit = finite ? start + (asset.duration! - clip.sourceIn) : Infinity;
    const t = clampRange(time, start + min, Math.min(nextStart, sourceLimit));
    const atSourceEnd = finite && t >= sourceLimit - EPS;
    next = { ...clip, sourceOut: atSourceEnd ? asset.duration! : clip.sourceIn + (t - start) };
  }

  if (
    next.timelineStart === clip.timelineStart &&
    next.sourceIn === clip.sourceIn &&
    next.sourceOut === clip.sourceOut
  ) {
    return ok(project);
  }
  return ok(
    withTracks(
      project,
      project.tracks.map((t) =>
        t.id === track.id ? { ...t, clips: t.clips.map((c) => (c.id === clip.id ? next : c)) } : t,
      ),
    ),
  );
}

/** Split at `time`. The left part keeps the id; the right part gets `newId`. Total length is preserved. */
export function splitClip(
  project: Project,
  clipId: string,
  time: number,
  newId: string = crypto.randomUUID(),
): EditResult {
  const found = findClip(project, clipId);
  if (!found) return fail("unknown-clip", `Unknown clip ${clipId}`);
  const { clip, track } = found;
  const min = minClipDuration(project);
  if (time < clip.timelineStart + min - EPS || time > clipEnd(clip) - min + EPS) {
    return fail("out-of-range", "Playhead must be inside the clip, at least one frame from either edge");
  }

  const cut = clip.sourceIn + (time - clip.timelineStart);
  const left: TimelineClip = { ...clip, sourceOut: cut };
  const right: TimelineClip = { ...clip, id: newId, timelineStart: time, sourceIn: cut };
  return ok(
    withTracks(
      project,
      project.tracks.map((t) =>
        t.id === track.id
          ? { ...t, clips: t.clips.flatMap((c) => (c.id === clip.id ? [left, right] : [c])) }
          : t,
      ),
    ),
  );
}

export function deleteClip(project: Project, clipId: string): EditResult {
  const found = findClip(project, clipId);
  if (!found) return fail("unknown-clip", `Unknown clip ${clipId}`);
  return ok(
    withTracks(
      project,
      project.tracks.map((t) =>
        t.id === found.track.id ? { ...t, clips: t.clips.filter((c) => c.id !== clipId) } : t,
      ),
    ),
  );
}

export const MAX_VOLUME = 2;

/** Volume is a gain multiplier: 0 (silent) to 2 (200 %). Preview plays up to 100 %; export applies the full gain. */
export function setClipVolume(project: Project, clipId: string, volume: number): EditResult {
  const found = findClip(project, clipId);
  if (!found) return fail("unknown-clip", `Unknown clip ${clipId}`);
  if (!Number.isFinite(volume) || volume < 0 || volume > MAX_VOLUME) {
    return fail("out-of-range", `Volume must be between 0 % and ${MAX_VOLUME * 100} %`);
  }
  if (found.clip.volume === volume) return ok(project);
  return ok(
    withTracks(
      project,
      project.tracks.map((t) =>
        t.id === found.track.id
          ? { ...t, clips: t.clips.map((c) => (c.id === clipId ? { ...c, volume } : c)) }
          : t,
      ),
    ),
  );
}

/** `muted` silences a track; `hidden` removes its picture. Both apply to preview and export alike. */
export function setTrackFlag(
  project: Project,
  trackId: string,
  flag: "muted" | "hidden",
  value: boolean,
): EditResult {
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track) return fail("unknown-track", `Unknown track ${trackId}`);
  if (track[flag] === value) return ok(project);
  return ok(
    withTracks(
      project,
      project.tracks.map((t) => (t.id === trackId ? { ...t, [flag]: value } : t)),
    ),
  );
}

/** Still-image placement: fit (bars), fill (crop) or blur (blurred copy behind). One rule for preview and export. */
export function setClipFit(project: Project, clipId: string, fit: FitMode): EditResult {
  const found = findClip(project, clipId);
  if (!found) return fail("unknown-clip", `Unknown clip ${clipId}`);
  if ((found.clip.fit ?? "fit") === fit) return ok(project);
  return ok(
    withTracks(
      project,
      project.tracks.map((t) =>
        t.id === found.track.id
          ? { ...t, clips: t.clips.map((c) => (c.id === clipId ? { ...c, fit } : c)) }
          : t,
      ),
    ),
  );
}

/** Append an empty track. It gets the highest `order`, so a new video track is drawn on top. */
export function addTrack(
  project: Project,
  type: "video" | "audio",
  id: string = crypto.randomUUID(),
): EditResult {
  const label = type === "video" ? "Video" : "Audio";
  const count = project.tracks.filter((t) => t.type === type).length;
  const order = Math.max(-1, ...project.tracks.map((t) => t.order)) + 1;
  const track: TimelineTrack = {
    id,
    name: `${label} ${count + 1}`,
    type,
    order,
    muted: false,
    hidden: false,
    clips: [],
  };
  return ok(withTracks(project, [...project.tracks, track]));
}

/** Earliest start at or after `desired` where a clip of `duration` fits without overlapping `clips`. */
export function firstFreeStart(clips: TimelineClip[], desired: number, duration: number): number {
  let start = Math.max(0, desired);
  for (const c of [...clips].sort(byStart)) {
    if (c.timelineStart < start + duration - EPS && start < clipEnd(c) - EPS) start = clipEnd(c);
  }
  return start;
}
