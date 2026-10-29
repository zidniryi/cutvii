/**
 * Beat Sync: the beat grid a clip follows and where its beats land on the timeline.
 *
 * The grid is found by Rust (`src-tauri/src/media/beats.rs`) for the source range a clip uses and cached
 * there; a clip stores only `beatFx.gridId` plus the user's adjustments (half / double, BPM override,
 * nudge). Every time here is a source time until `beatsOnTimeline` maps it with the speed formula
 * `timeline = timelineStart + (source - sourceIn) / speed`, so trim and speed keep beats on the same sound.
 */
import { BEAT_LIMITS, type BeatFx, type MediaAsset, type Project, type TimelineClip } from "@/project/model";
import { clipEnd, clipSpeed, EPS, findClip, minClipDuration } from "./clips";
import { addClip, addTrack, deleteClip, splitClip, type EditResult } from "./edit";
import { quantizeToFrame } from "./snap";

/** What `detect_beats` returns (see `BeatGrid` in Rust). Times are source times. */
export interface BeatGrid {
  version: number;
  start: number;
  end: number;
  bpm: number;
  offset: number;
  /** How strongly the sound repeats one beat later, 0..1. */
  clarity: number;
  /** `clarity` is high enough to call it a beat. */
  clear: boolean;
  /** The tracked beats follow a constant tempo (false when the tempo changes). */
  steady: boolean;
  beats: number[];
}

/** Shortest source range worth analysing (the same as `MIN_SECONDS` in Rust). */
export const MIN_BEAT_SECONDS = 3;

/** A constant grid with `period` through `anchor`, from `start` to `end`. */
function constantGrid(anchor: number, period: number, start: number, end: number): number[] {
  const out: number[] = [];
  let t = anchor - Math.floor((anchor - start) / period) * period;
  if (t < start - 1e-9) t += period;
  for (; t < end - 1e-9; t += period) out.push(t);
  return out;
}

/** The tempo the clip follows: the override or the detected one, then halved or doubled. */
export function effectiveBpm(grid: Pick<BeatGrid, "bpm">, fx: BeatFx | undefined): number {
  const base = fx?.bpmOverride ?? grid.bpm;
  return fx?.halfDouble === "half" ? base / 2 : fx?.halfDouble === "double" ? base * 2 : base;
}

/**
 * The beats (source times, in order, inside the analysed range) after the user's adjustments:
 * - a BPM override makes a constant grid at that tempo through the detected first beat;
 * - otherwise a steady grid is used as a constant grid, an unsteady one (tempo changes) as its tracked beats;
 * - the nudge moves everything; "half" keeps every other beat, "double" adds one half-way between each two.
 */
export function adjustedBeats(grid: BeatGrid, fx: BeatFx | undefined): number[] {
  const shift = (fx?.offsetMs ?? 0) / 1000;
  const anchor = grid.offset + shift;
  let beats: number[];
  if (fx?.bpmOverride) beats = constantGrid(anchor, 60 / fx.bpmOverride, grid.start, grid.end);
  else if (grid.steady && grid.bpm > 0) beats = constantGrid(anchor, 60 / grid.bpm, grid.start, grid.end);
  else beats = grid.beats.map((b) => b + shift).filter((b) => b >= grid.start && b < grid.end);
  if (fx?.halfDouble === "half") {
    // keep the beat nearest the anchor (the detected first beat) and every other one from it
    const keep = beats.reduce(
      (best, b, i) => (Math.abs(b - anchor) < Math.abs(beats[best] - anchor) ? i : best),
      0,
    );
    beats = beats.filter((_, i) => (i - keep) % 2 === 0);
  } else if (fx?.halfDouble === "double") {
    beats = beats.flatMap((b, i) => (i + 1 < beats.length ? [b, (b + beats[i + 1]) / 2] : [b]));
  }
  return beats;
}

/**
 * Where the clip's beats are on the timeline, in order. Only the source range the clip uses counts.
 * A reversed clip gives `null`: its beats are not drawn or used (the UI says so).
 */
export function beatsOnTimeline(
  clip: Pick<TimelineClip, "timelineStart" | "sourceIn" | "sourceOut" | "speed" | "reversed" | "beatFx">,
  grid: BeatGrid,
): number[] | null {
  if (clip.reversed) return null;
  const speed = clipSpeed(clip);
  return adjustedBeats(grid, clip.beatFx)
    .filter((s) => s >= clip.sourceIn - 1e-9 && s < clip.sourceOut - 1e-9)
    .map((s) => clip.timelineStart + (s - clip.sourceIn) / speed);
}

/** The grid was found for another part of the source than the clip uses now (it was trimmed longer). */
export const gridCoversClip = (clip: Pick<TimelineClip, "sourceIn" | "sourceOut">, grid: BeatGrid) =>
  clip.sourceIn >= grid.start - 1e-3 && clip.sourceOut <= grid.end + 1e-3;

/**
 * Tempo from taps (times in milliseconds, oldest first): the median gap of the last eight taps. Needs four
 * taps; a pause of more than two seconds starts over. `null` until then or when it is out of range.
 */
export function tapTempo(taps: number[]): number | null {
  let from = 0;
  for (let i = 1; i < taps.length; i++) if (taps[i] - taps[i - 1] > 2000) from = i;
  const recent = taps.slice(from).slice(-8);
  if (recent.length < 4) return null;
  const gaps = recent
    .slice(1)
    .map((t, i) => t - recent[i])
    .sort((a, b) => a - b);
  const mid = gaps.length >> 1;
  const gap = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
  if (!(gap > 0)) return null;
  const bpm = Math.round((60000 / gap) * 10) / 10;
  return bpm >= BEAT_LIMITS.minBpm && bpm <= BEAT_LIMITS.maxBpm ? bpm : null;
}

/** A change to `beatFx`: a key set to `undefined` is removed. */
export type BeatFxPatch = { [K in keyof BeatFx]?: BeatFx[K] | undefined };

const hasSound = (asset: Pick<MediaAsset, "type"> | undefined) => !!asset && asset.type !== "image";

/** Change a clip's beat settings. Empty settings are dropped from the clip. Pure; one undo step via the editor. */
export function setClipBeatFx(project: Project, clipId: string, patch: BeatFxPatch): EditResult {
  const found = findClip(project, clipId);
  if (!found) return { ok: false, error: { code: "unknown-clip", message: `Unknown clip ${clipId}` } };
  if (!hasSound(project.assets.find((a) => a.id === found.clip.assetId))) {
    return { ok: false, error: { code: "incompatible-track", message: "This clip has no sound" } };
  }
  const next: BeatFx = { effects: [], ...found.clip.beatFx };
  for (const [key, value] of Object.entries(patch) as [keyof BeatFxPatch, unknown][]) {
    if (key === "effects" && value === undefined) next.effects = [];
    else if (value === undefined && key !== "effects") delete next[key];
    else (next as Record<string, unknown>)[key] = value;
  }
  const { bpmOverride, offsetMs } = next;
  if (
    bpmOverride !== undefined &&
    !(bpmOverride >= BEAT_LIMITS.minBpm && bpmOverride <= BEAT_LIMITS.maxBpm)
  ) {
    return {
      ok: false,
      error: {
        code: "out-of-range",
        message: `Tempo must be ${BEAT_LIMITS.minBpm} to ${BEAT_LIMITS.maxBpm} BPM`,
      },
    };
  }
  if (offsetMs !== undefined && !(Math.abs(offsetMs) <= BEAT_LIMITS.maxGridOffsetMs)) {
    return { ok: false, error: { code: "out-of-range", message: "The beats can move at most 2 seconds" } };
  }
  if (offsetMs === 0) delete next.offsetMs;
  const empty = next.effects.length === 0 && Object.keys(next).length === 1;
  return {
    ok: true,
    project: {
      ...project,
      tracks: project.tracks.map((t) =>
        t.id !== found.track.id
          ? t
          : {
              ...t,
              clips: t.clips.map((c) => {
                if (c.id !== clipId) return c;
                const out = { ...c };
                if (empty) delete out.beatFx;
                else out.beatFx = next;
                return out;
              }),
            },
      ),
    },
  };
}

/**
 * Every beat of every clip that has a loaded grid, on the timeline, sorted and without doubles. These are
 * the extra snap targets of "Snap to beats". The clip being dragged is left out (its beats move with it).
 */
export function projectBeatTimes(
  project: Project,
  grids: Record<string, BeatGrid | null | undefined>,
  excludeClipId?: string,
): number[] {
  const all: number[] = [];
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      const grid = clip.beatFx?.gridId ? grids[clip.beatFx.gridId] : undefined;
      if (!grid || clip.id === excludeClipId) continue;
      all.push(...(beatsOnTimeline(clip, grid) ?? []));
    }
  }
  all.sort((a, b) => a - b);
  return all.filter((t, i) => i === 0 || t - all[i - 1] > 1e-6);
}

export const CUT_EVERY = [1, 2, 4, 8] as const;
export type CutEvery = (typeof CUT_EVERY)[number];

/** The beats a "Cut on beats" would cut at: the 1st, then every `every`-th beat inside the clip. */
export function cutPoints(
  clip: Parameters<typeof beatsOnTimeline>[0],
  grid: BeatGrid,
  every: CutEvery,
): number[] {
  return (beatsOnTimeline(clip, grid) ?? []).filter((_, i) => i % every === 0);
}

/**
 * Split a clip at every `every`-th beat, counting from the first beat inside it. A beat less than one frame
 * from the clip's edge or from the last cut is skipped. Both halves of a cut keep the clip's beat settings.
 *
 * `removeLeadIn` is the ripple: when the first cut is a real cut, the part of the clip before it is deleted
 * and everything from there on, on that track, moves earlier by its length, so the edit starts on a beat.
 * Without it nothing moves and the total length stays the same. The whole action is one undo step.
 */
export function cutOnBeats(
  project: Project,
  clipId: string,
  grid: BeatGrid,
  options: { every: CutEvery; removeLeadIn?: boolean },
  newId: () => string = () => crypto.randomUUID(),
): EditResult {
  const found = findClip(project, clipId);
  if (!found) return { ok: false, error: { code: "unknown-clip", message: `Unknown clip ${clipId}` } };
  const { clip } = found;
  const refuse = (message: string): EditResult => ({ ok: false, error: { code: "out-of-range", message } });
  if (clip.reversed) return refuse("A clip that plays backwards has no beats to cut on");
  const points = cutPoints(clip, grid, options.every);
  if (points.length === 0) return refuse("There is no beat inside this clip");

  let next = project;
  let current = clipId;
  let cuts = 0;
  let firstCut: number | undefined;
  let leadInCut = false;
  for (const [i, time] of points.entries()) {
    const id = newId();
    const r = splitClip(next, current, time, id);
    if (!r.ok) continue; // too close to an edge or to the previous cut
    next = r.project;
    current = id;
    cuts++;
    firstCut ??= time;
    if (i === 0) leadInCut = true;
  }
  if (cuts === 0 || firstCut === undefined) {
    return refuse("No beat is far enough from the clip's edges to cut at");
  }
  if (options.removeLeadIn && leadInCut) {
    const removed = deleteClip(next, clipId);
    if (!removed.ok) return removed;
    const gap = firstCut - clip.timelineStart;
    const trackId = found.track.id;
    next = {
      ...removed.project,
      tracks: removed.project.tracks.map((t) =>
        t.id !== trackId
          ? t
          : {
              ...t,
              clips: t.clips.map((c) =>
                c.timelineStart >= firstCut - EPS ? { ...c, timelineStart: c.timelineStart - gap } : c,
              ),
            },
      ),
    };
  }
  return { ok: true, project: next };
}

/** How many pieces a cut would leave (a hint for the button; the cut itself skips beats at the edges). */
export function piecesAfterCut(
  project: Project,
  clip: Parameters<typeof beatsOnTimeline>[0] & { id?: string },
  grid: BeatGrid,
  every: CutEvery,
): number {
  const min = minClipDuration(project);
  const start = clip.timelineStart;
  const end = clipEnd(clip as Parameters<typeof clipEnd>[0]);
  let pieces = 1;
  let last = start;
  for (const t of cutPoints(clip, grid, every)) {
    if (t - last >= min - EPS && end - t >= min - EPS) {
      pieces++;
      last = t;
    }
  }
  return pieces;
}

export interface AutoMatchOptions {
  /** How many beats each clip lasts. */
  beatsPerClip: CutEvery;
  /** Go round the list again until the beats run out. */
  repeat?: boolean;
  /** Videos keep their own sound; by default they are muted so the music is what is heard. */
  keepSound?: boolean;
}

export interface Placement {
  assetId: string;
  start: number;
  duration: number;
  /** The media is shorter than its slot, so a gap is left after it. */
  short: boolean;
}

/** Most clips one Auto-match places (a long song with a 1-beat cut and "repeat" would give thousands). */
export const MAX_AUTO_MATCH_CLIPS = 300;

/**
 * Where Auto-match would put the clips: the slots between every `beatsPerClip`-th beat of the music clip,
 * from its first beat, one list entry per slot (videos and pictures only; sound files are skipped).
 * Slot edges are rounded to whole frames, and shared by neighbours, so clips touch and never overlap.
 * A video always starts at its beginning; one shorter than its slot ends early (`short`).
 */
export function planAutoMatch(
  project: Project,
  music: Parameters<typeof beatsOnTimeline>[0],
  grid: BeatGrid,
  assetIds: readonly string[],
  options: AutoMatchOptions,
): { ok: true; placements: Placement[]; skipped: number } | { ok: false; message: string } {
  if (music.reversed) return { ok: false, message: "A clip that plays backwards has no beats to match" };
  const assets = assetIds
    .map((id) => project.assets.find((a) => a.id === id))
    .filter((a): a is MediaAsset => !!a && a.type !== "audio");
  const skipped = assetIds.length - assets.length;
  if (assets.length === 0) {
    return { ok: false, message: "Select videos or pictures in the media library first" };
  }
  const beats = beatsOnTimeline(music, grid) ?? [];
  const every = options.beatsPerClip;
  if (beats.length < every + 1) {
    return { ok: false, message: `The music has fewer than ${every + 1} beats to match` };
  }
  const min = minClipDuration(project);
  const fps = project.settings.fps;
  const placements: Placement[] = [];
  let next = 0;
  for (let i = 0; i + every < beats.length; i += every) {
    if (next >= assets.length && !options.repeat) break;
    if (placements.length >= MAX_AUTO_MATCH_CLIPS) break;
    const start = quantizeToFrame(beats[i], fps);
    const slot = quantizeToFrame(beats[i + every], fps) - start;
    if (slot < min - EPS) continue; // a slot under one frame: try the next one with the same media
    const asset = assets[next % assets.length];
    next++;
    const available = asset.type === "image" ? Infinity : (asset.duration ?? Infinity);
    const duration = Math.min(slot, available);
    if (duration < min - EPS) continue;
    placements.push({ assetId: asset.id, start, duration, short: duration < slot - EPS });
  }
  if (placements.length === 0) return { ok: false, message: "No beat slot is long enough for a clip" };
  return { ok: true, placements, skipped };
}

/**
 * Put the planned clips one after another on a new video track named "Beat edit", each as long as its slot.
 * Videos are muted unless `keepSound`. One edit (the editor makes it one undo step).
 */
export function autoMatch(
  project: Project,
  musicClipId: string,
  grid: BeatGrid,
  assetIds: readonly string[],
  options: AutoMatchOptions,
  trackId: string = crypto.randomUUID(),
): EditResult {
  const found = findClip(project, musicClipId);
  if (!found) return { ok: false, error: { code: "unknown-clip", message: `Unknown clip ${musicClipId}` } };
  const plan = planAutoMatch(project, found.clip, grid, assetIds, options);
  if (!plan.ok) return { ok: false, error: { code: "out-of-range", message: plan.message } };

  const withTrack = addTrack(project, "video", trackId);
  if (!withTrack.ok) return withTrack;
  let next: Project = {
    ...withTrack.project,
    tracks: withTrack.project.tracks.map((t) => (t.id === trackId ? { ...t, name: "Beat edit" } : t)),
  };
  for (const p of plan.placements) {
    const id = crypto.randomUUID();
    const added = addClip(next, { assetId: p.assetId, trackId, start: p.start, duration: p.duration, id });
    if (!added.ok) return added;
    next = added.project;
    const asset = next.assets.find((a) => a.id === p.assetId);
    if (asset?.type === "video" && !options.keepSound) {
      next = {
        ...next,
        tracks: next.tracks.map((t) =>
          t.id !== trackId
            ? t
            : { ...t, clips: t.clips.map((c) => (c.id === id ? { ...c, muted: true } : c)) },
        ),
      };
    }
  }
  return { ok: true, project: next };
}
