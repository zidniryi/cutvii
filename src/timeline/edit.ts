/**
 * Pure timeline edit operations: (project, args) -> EditResult. Nothing here touches stores or the DOM.
 *
 * Rules (also what export will assume, Phase 6):
 * - Clips on the same track never overlap; touching is fine. Gaps are allowed (black / silence).
 * - Clips on different tracks may overlap; a higher track `order` is drawn on top.
 * - Audio tracks hold audio assets; video tracks hold video and image assets.
 * - Timeline length == (sourceOut - sourceIn) / speed. Speed is per clip (default 1); stills have none.
 * - add/move/split reject invalid requests; trim clamps to the nearest valid edge (drag-friendly).
 */
import {
  CropSchema,
  type Crop,
  type FitBackground,
  type FitMode,
  type Project,
  type TimelineClip,
  type TimelineTrack,
} from "@/project/model";
import { clipDuration, clipEnd, clipSpeed, EPS, findClip, minClipDuration } from "./clips";
import { DEFAULT_FIT_MODE, isCropped } from "./fit";

export const DEFAULT_IMAGE_DURATION = 5;

export type EditErrorCode =
  | "unknown-clip"
  | "unknown-asset"
  | "unknown-track"
  | "incompatible-track"
  | "overlap"
  | "out-of-range"
  | "needs-ripple";

export interface EditError {
  code: EditErrorCode;
  message: string;
}

export type EditResult = { ok: true; project: Project } | { ok: false; error: EditError };

const ok = (project: Project): EditResult => ({ ok: true, project });
const fail = (code: EditErrorCode, message: string): EditResult => ({ ok: false, error: { code, message } });

/** "A video", "An audio", "An image". */
const article = (word: string) => `${/^[aeiou]/i.test(word) ? "An" : "A"} ${word}`;
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
    return fail(
      "incompatible-track",
      `${article(asset.type)} cannot be placed on ${article(track.type).toLowerCase()} track`,
    );
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
    return fail(
      "incompatible-track",
      `${article(asset.type)} cannot be placed on ${article(target.type).toLowerCase()} track`,
    );
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
  const speed = clipSpeed(clip);

  const finite = asset?.type !== "image" && asset?.duration !== undefined;
  const reversed = clip.reversed === true;
  // How far each edge may still grow, in source seconds. A reversed clip starts at sourceOut and runs
  // down to sourceIn, so its start edge is limited by what lies after sourceOut and its end edge by sourceIn.
  const roomAtStart = reversed ? (finite ? asset.duration! - clip.sourceOut : Infinity) : clip.sourceIn;
  const roomAtEnd = reversed ? clip.sourceIn : finite ? asset.duration! - clip.sourceOut : Infinity;

  let next: TimelineClip;
  if (edge === "start") {
    const prevEnd = Math.max(0, ...others.filter((c) => clipEnd(c) <= start + EPS).map(clipEnd));
    const t = clampRange(time, Math.max(prevEnd, start - roomAtStart / speed), end - min);
    const moved = (t - start) * speed; // source seconds removed (+) or revealed (-)
    next = reversed
      ? {
          ...clip,
          timelineStart: t,
          sourceOut: finite ? Math.min(asset.duration!, clip.sourceOut - moved) : clip.sourceOut - moved,
        }
      : { ...clip, timelineStart: t, sourceIn: Math.max(0, clip.sourceIn + moved) };
  } else {
    const nextStart = Math.min(
      Infinity,
      ...others.filter((c) => c.timelineStart >= end - EPS).map((c) => c.timelineStart),
    );
    const limit = end + roomAtEnd / speed;
    const t = clampRange(time, start + min, Math.min(nextStart, limit));
    const atLimit = Number.isFinite(limit) && t >= limit - EPS;
    const used = (t - start) * speed; // source seconds the clip covers after the trim
    next = reversed
      ? { ...clip, sourceIn: atLimit ? 0 : Math.max(0, clip.sourceOut - used) }
      : { ...clip, sourceOut: atLimit && finite ? asset.duration! : clip.sourceIn + used };
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

  const used = (time - clip.timelineStart) * clipSpeed(clip);
  // a reversed clip plays from sourceOut down: its first part is the *end* of the source range
  const cut = clip.reversed ? clip.sourceOut - used : clip.sourceIn + used;
  const left: TimelineClip = clip.reversed ? { ...clip, sourceIn: cut } : { ...clip, sourceOut: cut };
  const right: TimelineClip = clip.reversed
    ? { ...clip, id: newId, timelineStart: time, sourceOut: cut }
    : { ...clip, id: newId, timelineStart: time, sourceIn: cut };
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

/** How a video or image clip is scaled to the canvas: fill (crop), fit (bars) or blur-bg. One rule for preview and export. */
export function setClipFit(project: Project, clipId: string, fitMode: FitMode): EditResult {
  const found = findClip(project, clipId);
  if (!found) return fail("unknown-clip", `Unknown clip ${clipId}`);
  if ((found.clip.fitMode ?? DEFAULT_FIT_MODE) === fitMode) return ok(project);
  return ok(
    withTracks(
      project,
      project.tracks.map((t) =>
        t.id === found.track.id
          ? { ...t, clips: t.clips.map((c) => (c.id === clipId ? { ...c, fitMode } : c)) }
          : t,
      ),
    ),
  );
}

/** Cut away the edges of a clip's picture (`null` or all zeros removes the crop). Not for sound or text. */
export function setClipCrop(project: Project, clipId: string, crop: Crop | null): EditResult {
  const found = findClip(project, clipId);
  if (!found) return fail("unknown-clip", `Unknown clip ${clipId}`);
  const asset = project.assets.find((a) => a.id === found.clip.assetId);
  if (!asset || asset.type === "audio" || asset.text) {
    return fail("incompatible-track", "Only video and image clips can be cropped");
  }
  const wanted = crop && isCropped(crop) ? crop : undefined;
  if (wanted && !CropSchema.safeParse(wanted).success) {
    return fail("out-of-range", "At least a tenth of the picture must remain");
  }
  const current = found.clip.crop;
  const same = wanted
    ? current !== undefined &&
      (["left", "top", "right", "bottom"] as const).every((k) => current[k] === wanted[k])
    : current === undefined;
  if (same) return ok(project);
  return ok(
    withTracks(
      project,
      project.tracks.map((t) =>
        t.id === found.track.id
          ? {
              ...t,
              clips: t.clips.map((c) => {
                if (c.id !== clipId) return c;
                const next = { ...c };
                if (wanted) next.crop = wanted;
                else delete next.crop;
                return next;
              }),
            }
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

export const MIN_SPEED = 0.1;
export const MAX_SPEED = 10;

/**
 * Change a clip's speed. The source range stays the same, so the clip gets shorter (faster) or longer (slower).
 * If the longer clip would run into the clips after it on the same track, the result is `needs-ripple`
 * unless `ripple` is set, in which case those later clips are pushed right by exactly the overlap.
 */
export function setClipSpeed(
  project: Project,
  clipId: string,
  speed: number,
  opts: { ripple?: boolean } = {},
): EditResult {
  const found = findClip(project, clipId);
  if (!found) return fail("unknown-clip", `Unknown clip ${clipId}`);
  const { clip, track } = found;
  const asset = project.assets.find((a) => a.id === clip.assetId);
  if (asset?.type === "image")
    return fail("out-of-range", "Images have no speed; change their duration instead");
  if (!Number.isFinite(speed) || speed < MIN_SPEED - EPS || speed > MAX_SPEED + EPS) {
    return fail("out-of-range", `Speed must be between ${MIN_SPEED}× and ${MAX_SPEED}×`);
  }
  if (Math.abs(clipSpeed(clip) - speed) < EPS) return ok(project);
  if ((clip.sourceOut - clip.sourceIn) / speed < minClipDuration(project) - EPS) {
    return fail("out-of-range", "At that speed the clip would be shorter than one frame");
  }

  const next: TimelineClip = { ...clip, speed };
  const newEnd = clipEnd(next);
  const later = track.clips.filter((c) => c.id !== clip.id && c.timelineStart >= clip.timelineStart - EPS);
  const firstLater = Math.min(Infinity, ...later.map((c) => c.timelineStart));
  const push = newEnd - firstLater;

  if (push > EPS && !opts.ripple) {
    return fail("needs-ripple", "The slower clip would overlap the clips after it on this track");
  }
  const laterIds = new Set(later.map((c) => c.id));
  return ok(
    withTracks(
      project,
      project.tracks.map((t) =>
        t.id !== track.id
          ? t
          : {
              ...t,
              clips: t.clips.map((c) =>
                c.id === clip.id
                  ? next
                  : push > EPS && laterIds.has(c.id)
                    ? { ...c, timelineStart: c.timelineStart + push }
                    : c,
              ),
            },
      ),
    ),
  );
}

export function setClipKeepPitch(project: Project, clipId: string, keepPitch: boolean): EditResult {
  const found = findClip(project, clipId);
  if (!found) return fail("unknown-clip", `Unknown clip ${clipId}`);
  if ((found.clip.keepPitch ?? true) === keepPitch) return ok(project);
  return ok(
    withTracks(
      project,
      project.tracks.map((t) =>
        t.id === found.track.id
          ? { ...t, clips: t.clips.map((c) => (c.id === clipId ? { ...c, keepPitch } : c)) }
          : t,
      ),
    ),
  );
}

export const FREEZE_SECONDS = 2;

/** Reverse the used source range (video and audio). Length and position on the timeline do not change. */
export function setClipReversed(project: Project, clipId: string, reversed: boolean): EditResult {
  const found = findClip(project, clipId);
  if (!found) return fail("unknown-clip", `Unknown clip ${clipId}`);
  const asset = project.assets.find((a) => a.id === found.clip.assetId);
  if (asset?.type === "image") return fail("out-of-range", "Images cannot be reversed");
  if ((found.clip.reversed ?? false) === reversed) return ok(project);
  return ok(
    withTracks(
      project,
      project.tracks.map((t) =>
        t.id === found.track.id
          ? { ...t, clips: t.clips.map((c) => (c.id === clipId ? { ...c, reversed } : c)) }
          : t,
      ),
    ),
  );
}

/** Source time (in the original file) shown at timeline `time`, honouring speed and reverse. */
export function sourceTimeAt(clip: TimelineClip, time: number): number {
  const used = (time - clip.timelineStart) * clipSpeed(clip);
  const t = clip.reversed ? clip.sourceOut - used : clip.sourceIn + used;
  return Math.min(clip.sourceOut, Math.max(clip.sourceIn, t));
}

/**
 * Freeze frame: split the clip at `time`, hold `image` (the extracted frame, already an asset of the
 * project) for `FREEZE_SECONDS`, and push the second half and everything after it on that track later.
 */
export function insertFreezeFrame(
  project: Project,
  clipId: string,
  time: number,
  imageAssetId: string,
  ids: { right?: string; still?: string } = {},
): EditResult {
  const found = findClip(project, clipId);
  if (!found) return fail("unknown-clip", `Unknown clip ${clipId}`);
  if (found.track.type !== "video") return fail("incompatible-track", "Freeze frame needs a video clip");
  if (!project.assets.some((a) => a.id === imageAssetId && a.type === "image")) {
    return fail("unknown-asset", "The frame image is not in the project");
  }

  const split = splitClip(project, clipId, time, ids.right ?? crypto.randomUUID());
  if (!split.ok) return split;
  const track = split.project.tracks.find((t) => t.id === found.track.id)!;
  const still: TimelineClip = {
    id: ids.still ?? crypto.randomUUID(),
    assetId: imageAssetId,
    trackId: track.id,
    timelineStart: time,
    sourceIn: 0,
    sourceOut: FREEZE_SECONDS,
    volume: 1,
    x: 0,
    y: 0,
    scale: 1,
    opacity: 1,
  };
  const clips = [
    ...track.clips.map((c) =>
      c.timelineStart >= time - EPS ? { ...c, timelineStart: c.timelineStart + FREEZE_SECONDS } : c,
    ),
    still,
  ].sort(byStart);
  return ok(
    withTracks(
      split.project,
      split.project.tracks.map((t) => (t.id === track.id ? { ...t, clips } : t)),
    ),
  );
}

function checkBackground(project: Project, bg: FitBackground): EditError | null {
  if (bg.kind === "color" && !/^#[0-9a-fA-F]{6}$/.test(bg.color ?? "")) {
    return { code: "out-of-range", message: "Choose a colour for the background" };
  }
  if (bg.kind === "image" && !project.assets.some((a) => a.id === bg.assetId && a.type === "image")) {
    return { code: "unknown-asset", message: "Choose an image from the media library for the background" };
  }
  if (bg.blur !== undefined && !(bg.blur >= 0 && bg.blur <= 100)) {
    return { code: "out-of-range", message: "Blur must be between 0 and 100" };
  }
  return null;
}

const sameBackground = (a: FitBackground | undefined, b: FitBackground) =>
  JSON.stringify(a ?? { kind: "black" }) === JSON.stringify(b);

/** Set what shows behind one clip's picture (colour, image, blur amount). */
export function setClipFitBackground(
  project: Project,
  clipId: string,
  background: FitBackground,
): EditResult {
  const found = findClip(project, clipId);
  if (!found) return fail("unknown-clip", `Unknown clip ${clipId}`);
  const problem = checkBackground(project, background);
  if (problem) return { ok: false, error: problem };
  if (sameBackground(found.clip.fitBackground, background)) return ok(project);
  return ok(
    withTracks(
      project,
      project.tracks.map((t) =>
        t.id === found.track.id
          ? { ...t, clips: t.clips.map((c) => (c.id === clipId ? { ...c, fitBackground: background } : c)) }
          : t,
      ),
    ),
  );
}

/** Give every clip on a video track the same background (one undo step). */
export function applyFitBackgroundToAll(project: Project, background: FitBackground): EditResult {
  const problem = checkBackground(project, background);
  if (problem) return { ok: false, error: problem };
  let changed = false;
  const tracks = project.tracks.map((t) => {
    if (t.type !== "video") return t;
    const clips = t.clips.map((c) => {
      if (sameBackground(c.fitBackground, background)) return c;
      changed = true;
      return { ...c, fitBackground: background };
    });
    return { ...t, clips };
  });
  return ok(changed ? withTracks(project, tracks) : project);
}
