/**
 * Auto clips (section 6u): which clip can be searched, what the user asked for, and the typed bridge to the
 * Rust engine (`find_clips_in_media`). Everything here is pure except `searchClips`, which calls Rust.
 */
import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import type { MediaDetails } from "@/store/mediaDetails";
import type { Project } from "@/project/model";
import { clipSpeed, findClip, sourceDuration } from "./clips";

/** A clip must use at least this much of its file to be searched (the spec's 60 s). */
export const MIN_SOURCE_SECONDS = 60;
/** The engine's limits (kept in step with `commands/clipper.rs`). */
export const LENGTH_LIMITS = { min: 5, max: 180 } as const;

export type LengthId = "short" | "medium" | "long" | "custom";
export const LENGTH_PRESETS: { id: Exclude<LengthId, "custom">; label: string; min: number; max: number }[] =
  [
    { id: "short", label: "15–30 s", min: 15, max: 30 },
    { id: "medium", label: "30–60 s", min: 30, max: 60 },
    { id: "long", label: "60–90 s", min: 60, max: 90 },
  ];

export type OutputShape = "vertical" | "square" | "keep";
export const OUTPUTS: { id: OutputShape; label: string; hint: string }[] = [
  { id: "vertical", label: "Vertical 9:16", hint: "TikTok, Shorts, Reels" },
  { id: "square", label: "Square 1:1", hint: "Feed posts" },
  { id: "keep", label: "Keep canvas", hint: "Same shape as the project" },
];

export interface AutoClipsSettings {
  length: LengthId;
  customMin: number;
  customMax: number;
  /** `null` = Auto. */
  count: number | null;
  /** Whisper's language code; "" lets the model detect it. */
  language: string;
  /** Speech model id; `null` = pick one that is installed. */
  model: string | null;
  output: OutputShape;
  /** Burn the subtitle style in when the clips are created (step 3). */
  subtitles: boolean;
}

export const DEFAULT_SETTINGS: AutoClipsSettings = {
  length: "medium",
  customMin: 20,
  customMax: 45,
  count: null,
  language: "",
  model: null,
  output: "vertical",
  subtitles: true,
};

export const COUNT_CHOICES: (number | null)[] = [null, 3, 5, 10];

/** The seconds range for the chosen length, or why it cannot be used. */
export function lengthRange(
  s: Pick<AutoClipsSettings, "length" | "customMin" | "customMax">,
): { ok: true; min: number; max: number } | { ok: false; reason: string } {
  if (s.length !== "custom") {
    const p = LENGTH_PRESETS.find((x) => x.id === s.length)!;
    return { ok: true, min: p.min, max: p.max };
  }
  const { customMin: min, customMax: max } = s;
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { ok: false, reason: "Enter both lengths." };
  if (min < LENGTH_LIMITS.min) return { ok: false, reason: `The shortest clip is ${LENGTH_LIMITS.min} s.` };
  if (max > LENGTH_LIMITS.max) return { ok: false, reason: `The longest clip is ${LENGTH_LIMITS.max} s.` };
  if (min >= max) return { ok: false, reason: "The shortest length must be below the longest." };
  return { ok: true, min, max };
}

/**
 * Why a clip cannot be searched, or null when it can. `details` is what FFprobe said about the file, when
 * it is known: a video file without a sound track has nothing to find.
 */
export function autoClipsBlocker(
  project: Project,
  clipId: string,
  details?: Pick<MediaDetails, "audioCodec">,
): string | null {
  const found = findClip(project, clipId);
  const asset = found && project.assets.find((a) => a.id === found.clip.assetId);
  if (!found || !asset) return "The clip is missing from the project.";
  if (asset.type === "image") return "Images have no sound.";
  if (found.clip.reversed) return "Reversed clips cannot be searched: speech is read forwards.";
  if (asset.type === "video" && details && details.audioCodec === undefined)
    return "This video has no sound track.";
  if (sourceDuration(found.clip) < MIN_SOURCE_SECONDS)
    return `The clip uses under ${MIN_SOURCE_SECONDS} s of its file; auto clips needs a longer recording.`;
  return null;
}

// ---------------------------------------------------------------------------------------------------
// What Rust sends back (validated: it crosses a process boundary)
// ---------------------------------------------------------------------------------------------------

const ReasonSchema = z.object({
  rule: z.string(),
  label: z.string(),
  value: z.number().min(0).max(1),
  met: z.boolean(),
});
export type ClipReason = z.infer<typeof ReasonSchema>;

const FoundClipSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  text: z.string(),
  sourceIn: z.number().nonnegative(),
  sourceOut: z.number().positive(),
  timelineStart: z.number().nonnegative(),
  timelineDuration: z.number().positive(),
  score: z.number().min(0).max(1),
  tier: z.enum(["low", "medium", "high"]),
  reasons: z.array(ReasonSchema),
});
export type FoundClip = z.infer<typeof FoundClipSchema>;
export type Tier = FoundClip["tier"];

const SentenceSchema = z.object({ start: z.number(), end: z.number(), text: z.string() });
export type TranscriptSentence = z.infer<typeof SentenceSchema>;

const FoundSchema = z.object({
  clips: z.array(FoundClipSchema),
  sentences: z.array(SentenceSchema),
  fromCache: z.boolean(),
  notice: z.string().nullable(),
});
export type Found = z.infer<typeof FoundSchema>;

export interface SourceSpan {
  start: number;
  end: number;
}

const message = (e: unknown) =>
  typeof e === "string" ? e : e instanceof Error ? e.message : "The search failed.";

/** What to ask the engine for, from a timeline clip and the user's settings. */
export function searchRequest(
  project: Project,
  clipId: string,
  settings: AutoClipsSettings,
  model: string,
  options: { exclude?: SourceSpan[]; count?: number | null } = {},
) {
  const found = findClip(project, clipId);
  const asset = found && project.assets.find((a) => a.id === found.clip.assetId);
  const range = lengthRange(settings);
  if (!found || !asset) throw new Error("The clip is missing from the project.");
  if (!range.ok) throw new Error(range.reason);
  const { clip } = found;
  return {
    path: asset.path,
    sourceIn: clip.sourceIn,
    sourceOut: clip.sourceOut,
    timelineStart: clip.timelineStart,
    speed: clipSpeed(clip),
    reversed: clip.reversed === true,
    model,
    language: settings.language === "" ? null : settings.language,
    minSeconds: range.min,
    maxSeconds: range.max,
    count: options.count === undefined ? settings.count : options.count,
    fps: project.settings.fps,
    exclude: options.exclude ?? [],
  };
}

/** Run the search in Rust (speech recognition runs there, on this computer). Throws a readable message. */
export async function searchClips(request: ReturnType<typeof searchRequest>): Promise<Found> {
  let raw: unknown;
  try {
    raw = await invoke("find_clips_in_media", { request });
  } catch (e) {
    throw new Error(message(e), { cause: e });
  }
  const parsed = FoundSchema.safeParse(raw);
  if (!parsed.success) throw new Error("The clip search returned something unexpected.");
  return parsed.data;
}

// ---------------------------------------------------------------------------------------------------
// Review helpers
// ---------------------------------------------------------------------------------------------------

export type SortBy = "score" | "time";

export interface ReviewClip extends FoundClip {
  included: boolean;
}

export function sortedClips<T extends FoundClip>(clips: T[], by: SortBy): T[] {
  const out = [...clips];
  out.sort((a, b) =>
    by === "score" ? b.score - a.score || a.sourceIn - b.sourceIn : a.sourceIn - b.sourceIn,
  );
  return out;
}

export const TIER_LABEL: Record<Tier, string> = { low: "Low", medium: "Medium", high: "High" };

/** The reasons that count for a clip, in the order the engine lists them (strongest rules first). */
export const metReasons = (c: Pick<FoundClip, "reasons">) => c.reasons.filter((r) => r.met);

// ---------------------------------------------------------------------------------------------------
// Editing a cut in the review
// ---------------------------------------------------------------------------------------------------

/** Padding around a sentence, the same the engine uses (`CONFIG.lead_in` / `tail` in `media/clipper.rs`). */
export const LEAD_IN = 0.15;
export const TAIL = 0.3;
/** A clip cannot be trimmed shorter than this in the review. */
export const MIN_REVIEW_SECONDS = 1;

export type Edge = "start" | "end";

/** What the cuts of a search are measured against: the searched range of the file and its timeline clip. */
export interface CutContext {
  fps: number;
  /** Source seconds of the searched range. */
  rangeIn: number;
  rangeOut: number;
  /** Where the searched clip starts on the timeline, and its speed. */
  timelineStart: number;
  speed: number;
}

/**
 * Where a cut may land when it snaps to sentences: just before each sentence for the start, just after
 * each for the end, never reaching into the neighbouring sentence.
 */
export function cutPoints(sentences: TranscriptSentence[], edge: Edge): number[] {
  return sentences.map((s, i) => {
    if (edge === "start") {
      const before = i === 0 ? -Infinity : (sentences[i - 1].end + s.start) / 2;
      return Math.max(s.start - LEAD_IN, before, 0);
    }
    const after = i === sentences.length - 1 ? Infinity : (s.end + sentences[i + 1].start) / 2;
    return Math.min(s.end + TAIL, after);
  });
}

type Cut = Pick<FoundClip, "sourceIn" | "sourceOut">;

/** Put `time` on a whole frame and keep the clip inside the range and at least a second long. */
function settle(clip: Cut, edge: Edge, time: number, ctx: CutContext, round: (v: number) => number): Cut {
  const { fps } = ctx;
  const first = Math.ceil(ctx.rangeIn * fps - 1e-6) / fps;
  const last = Math.floor(ctx.rangeOut * fps + 1e-6) / fps;
  const minFrames = Math.ceil(MIN_REVIEW_SECONDS * fps - 1e-6);
  const frame = round(time * fps);
  if (edge === "start") {
    const limit = Math.round(clip.sourceOut * fps) - minFrames;
    const at = Math.min(Math.max(frame, Math.round(first * fps)), limit);
    return { sourceIn: at / fps, sourceOut: clip.sourceOut };
  }
  const limit = Math.round(clip.sourceIn * fps) + minFrames;
  const at = Math.max(Math.min(frame, Math.round(last * fps)), limit);
  return { sourceIn: clip.sourceIn, sourceOut: at / fps };
}

/**
 * Move one cut of a clip to `time` (source seconds). By default it snaps to the nearest sentence boundary;
 * `free` puts it anywhere. Either way the result is on a whole frame, inside the searched range.
 */
export function moveCut(
  clip: Cut,
  edge: Edge,
  time: number,
  ctx: CutContext,
  sentences: TranscriptSentence[],
  free: boolean,
): Cut {
  if (free || sentences.length === 0) return settle(clip, edge, time, ctx, Math.round);
  const points = cutPoints(sentences, edge);
  const nearest = points.reduce((best, p) => (Math.abs(p - time) < Math.abs(best - time) ? p : best));
  // outwards, like the engine: a start never eats the first word, an end never clips the last
  return settle(
    clip,
    edge,
    nearest,
    ctx,
    edge === "start" ? (v) => Math.floor(v + 1e-6) : (v) => Math.ceil(v - 1e-6),
  );
}

/** Nudge a cut one step earlier (-1) or later (+1): one sentence, or one frame when `free`. */
export function nudgeCut(
  clip: Cut,
  edge: Edge,
  direction: -1 | 1,
  ctx: CutContext,
  sentences: TranscriptSentence[],
  free: boolean,
): Cut {
  const now = edge === "start" ? clip.sourceIn : clip.sourceOut;
  if (free || sentences.length === 0) return settle(clip, edge, now + direction / ctx.fps, ctx, Math.round);
  // compare where each boundary would really land (on its frame), so a boundary a fraction of a frame
  // away from the cut does not count as a step
  const half = 0.5 / ctx.fps;
  const landings = cutPoints(sentences, edge).map((p) => moveCut(clip, edge, p, ctx, sentences, false));
  const at = (c: Cut) => (edge === "start" ? c.sourceIn : c.sourceOut);
  const next =
    direction > 0
      ? landings.find((c) => at(c) > now + half)
      : [...landings].reverse().find((c) => at(c) < now - half);
  return next ?? { sourceIn: clip.sourceIn, sourceOut: clip.sourceOut };
}

/** A found clip with new cut points: its place on the timeline follows. */
export function withCut<T extends FoundClip>(clip: T, cut: Cut, ctx: CutContext): T {
  return {
    ...clip,
    ...cut,
    timelineStart: ctx.timelineStart + (cut.sourceIn - ctx.rangeIn) / ctx.speed,
    timelineDuration: (cut.sourceOut - cut.sourceIn) / ctx.speed,
  };
}

export interface TranscriptWord {
  text: string;
  start: number;
  end: number;
}

/** The words of a sentence with estimated times (shared out by length: the speech model gives no word times). */
export function wordsOf(sentence: TranscriptSentence): TranscriptWord[] {
  const parts = sentence.text.split(/\s+/).filter(Boolean);
  const total = parts.reduce((n, w) => n + w.length, 0) || 1;
  let done = 0;
  return parts.map((text) => {
    const start = sentence.start + ((sentence.end - sentence.start) * done) / total;
    done += text.length;
    return { text, start, end: sentence.start + ((sentence.end - sentence.start) * done) / total };
  });
}

/** Clicking a word moves the nearer cut to it: the start goes before the word, the end after it. */
export function cutAtWord(clip: Cut, word: TranscriptWord, ctx: CutContext): Cut {
  const edge: Edge =
    Math.abs(word.start - clip.sourceIn) <= Math.abs(word.end - clip.sourceOut) ? "start" : "end";
  return settle(clip, edge, edge === "start" ? word.start : word.end, ctx, Math.round);
}
