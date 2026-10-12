/**
 * Auto clips, step 3: turn the reviewed candidates into real timeline clips. They reference the original
 * file by `sourceIn` / `sourceOut` (no new media), go on new tracks after everything already on the
 * timeline (so nothing existing moves), and the whole batch is ONE undoable step.
 */
import { invoke } from "@tauri-apps/api/core";
import { createProject } from "@/project/factory";
import type { MediaAsset, Project, TimelineClip } from "@/project/model";
import type { ExportOptions, Quality } from "@/export/options";
import type { ExportReport } from "@/lib/exportApi";
import { useAutoClipsStore } from "@/store/autoClips";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { DEFAULT_STYLE, subtitleStyleOf, useTextStyleStore } from "@/store/textStyles";
import {
  sortedClips,
  wordsOf,
  type FoundClip,
  type OutputShape,
  type TranscriptSentence,
  CLIP_SUBTITLE_SIZE,
} from "./autoClips";
import { projectDuration } from "./clips";
import { addClip, addTrack, type EditResult } from "./edit";
import {
  addSubtitleClips,
  MIN_SUBTITLE_SECONDS,
  subtitleSpec,
  subtitleWrap,
  type DrawnSubtitle,
  type Subtitle,
} from "./subtitles";
import type { Position } from "./textPosition";
import { withStyle } from "./textStyles";

/** Share of the canvas width a clip's subtitles may take when the picture fills it. */
export const CLIP_SUBTITLE_WRAP = 0.8;

/**
 * Where a clip's subtitles go unless the user chose a place: a little higher than ordinary subtitles, so a
 * three-line caption with a box still ends above the 5 % safe margin of a vertical video.
 */
export const CLIP_SUBTITLE_POSITION: Position = { x: 0.5, y: 0.8 };

/** A subtitle shows at most this many words, so it stays readable on a phone. */
export const SUBTITLE_WORDS = 7;

export interface PlacedClip {
  id: string;
  title: string;
  sourceIn: number;
  sourceOut: number;
  /** Where it goes on the timeline. */
  start: number;
}

/**
 * Line the chosen clips up one after another, in the order they are spoken, starting on the first whole
 * frame after everything already on the timeline.
 */
export function placeClips(project: Project, clips: FoundClip[], ids: string[]): PlacedClip[] {
  const fps = project.settings.fps;
  let at = Math.ceil(projectDuration(project) * fps - 1e-6) / fps;
  return sortedClips(clips, "time").map((c, i) => {
    const placed = { id: ids[i], title: c.title, sourceIn: c.sourceIn, sourceOut: c.sourceOut, start: at };
    // whole frames, so the next clip starts exactly where this one ends
    at = Math.round((at + (c.sourceOut - c.sourceIn)) * fps) / fps;
    return placed;
  });
}

/**
 * Subtitles for one placed clip: the words spoken inside it, a few at a time, at timeline seconds. Word
 * times are shared out inside each sentence (the speech model gives none), which is close enough to read.
 */
export function subtitlesForPlaced(clip: PlacedClip, sentences: TranscriptSentence[]): Subtitle[] {
  const out: Subtitle[] = [];
  const end = clip.start + (clip.sourceOut - clip.sourceIn);
  for (const sentence of sentences) {
    if (sentence.end <= clip.sourceIn || sentence.start >= clip.sourceOut) continue;
    const words = wordsOf(sentence).filter(
      (w) => w.end > clip.sourceIn + 1e-6 && w.start < clip.sourceOut - 1e-6,
    );
    for (let i = 0; i < words.length; i += SUBTITLE_WORDS) {
      const group = words.slice(i, i + SUBTITLE_WORDS);
      const from = Math.max(
        out.at(-1) ? out.at(-1)!.start + out.at(-1)!.duration : clip.start,
        clip.start + group[0].start - clip.sourceIn,
      );
      const to = Math.min(end, clip.start + group[group.length - 1].end - clip.sourceIn);
      if (to - from < MIN_SUBTITLE_SECONDS) continue;
      out.push({ start: from, duration: to - from, text: group.map((w) => w.text).join(" ") });
    }
  }
  return out;
}

export interface CreateIds {
  clipTrack: string;
  subtitleTrack: string;
}

/**
 * Add the placed clips on a new track (and their drawn subtitles on another above it). Video is centred and
 * fills the canvas unless the canvas shape is being kept. Pure: the caller runs it as one undoable command.
 */
export function addAutoClips(
  project: Project,
  assetId: string,
  placed: PlacedClip[],
  subtitles: DrawnSubtitle[],
  output: OutputShape,
  ids: CreateIds,
  /** The clips are sound only (an audio file, or a video's detached sound). */
  soundOnly: boolean,
): EditResult {
  const asset = project.assets.find((a) => a.id === assetId);
  if (!asset)
    return {
      ok: false,
      error: { code: "unknown-asset", message: "The original media is no longer in the project" },
    };
  if (placed.length === 0) return { ok: true, project };
  const track = addTrack(project, soundOnly ? "audio" : "video", ids.clipTrack);
  if (!track.ok) return track;
  let next = track.project;
  for (const p of placed) {
    const added = addClip(next, {
      assetId,
      trackId: ids.clipTrack,
      start: p.start,
      duration: p.sourceOut - p.sourceIn,
      id: p.id,
    });
    if (!added.ok) return added;
    next = {
      ...added.project,
      tracks: added.project.tracks.map((t) =>
        t.id !== ids.clipTrack
          ? t
          : {
              ...t,
              clips: t.clips.map((c): TimelineClip =>
                c.id !== p.id
                  ? c
                  : {
                      ...c,
                      sourceIn: p.sourceIn,
                      sourceOut: p.sourceOut,
                      // centre reframe: the picture fills the canvas, cropped evenly on both sides
                      ...(!soundOnly && output !== "keep" ? { fitMode: "fill" as const } : {}),
                    },
              ),
            },
      ),
    };
  }
  return subtitles.length > 0
    ? addSubtitleClips(next, subtitles, ids.subtitleTrack)
    : { ok: true, project: next };
}

const message = (e: unknown) =>
  typeof e === "string" ? e : e instanceof Error ? e.message : "unknown error";

/** Draw subtitle lines for a canvas, in the shared subtitle style (the same look Auto subtitles uses). */
async function drawSubtitles(
  lines: Subtitle[],
  canvas: { width: number; height: number },
  asset: MediaAsset,
  video: boolean,
  output: OutputShape,
  /** Font size as a share of the canvas height. */
  size: number,
  onLine: (n: number) => void,
): Promise<DrawnSubtitle[]> {
  const styles = useTextStyleStore.getState();
  const subtitle = subtitleStyleOf(styles);
  const look = subtitle.id === DEFAULT_STYLE && !subtitle.customised ? undefined : subtitle;
  const at = styles.subtitlePosition ?? CLIP_SUBTITLE_POSITION;
  // the clips' own size: the size chosen for Auto subtitles was picked for another canvas shape
  const share = Math.min(CLIP_SUBTITLE_SIZE.max, Math.max(CLIP_SUBTITLE_SIZE.min, size));
  const { width, height } = canvas;
  const fit = video && output !== "keep" ? { fitMode: "fill" as const } : {};
  // a little narrower than the canvas, so thick outlines and boxes stay inside the 5 % safe margin
  const wrap =
    (video ? subtitleWrap({ ...fit } as TimelineClip, asset, width, height) : undefined) ??
    CLIP_SUBTITLE_WRAP;
  const drawn: DrawnSubtitle[] = [];
  for (const [i, line] of lines.entries()) {
    onLine(i + 1);
    const plain = subtitleSpec(line.text, height, at, share, wrap);
    const spec = look ? withStyle(plain, look.style) : plain;
    const picture = await invoke<string>("render_text", { spec, width, height });
    drawn.push({
      ...line,
      spec,
      picture,
      assetId: crypto.randomUUID(),
      clipId: crypto.randomUUID(),
      fade: look?.fade,
    });
  }
  return drawn;
}

export type CreateResult = { ok: true; clipIds: string[]; subtitles: number } | { ok: false; reason: string };

/**
 * Create the included clips in the open project. Subtitle pictures are drawn first (in Rust); the project
 * changes once, at the end, as one undo step. Nothing changes if anything fails.
 */
export async function createClipsInProject(
  onStage: (stage: string) => void = () => {},
): Promise<CreateResult> {
  const auto = useAutoClipsStore.getState();
  const ctx = auto.context;
  const chosen = auto.clips.filter((c) => c.included);
  if (!ctx || chosen.length === 0) return { ok: false, reason: "Select at least one clip" };
  const project = useProjectStore.getState().project;
  const asset = project.assets.find((a) => a.path === ctx.path);
  if (!asset)
    return {
      ok: false,
      reason: "The original media is no longer in the project. Import or relink it first.",
    };
  if (chosen.some((c) => asset.duration !== undefined && c.sourceOut > asset.duration + 1e-3))
    return { ok: false, reason: "The media file changed since the search. Search again." };

  const placed = placeClips(
    project,
    chosen,
    chosen.map(() => crypto.randomUUID()),
  );
  let drawn: DrawnSubtitle[] = [];
  if (auto.settings.subtitles) {
    const lines = placed.flatMap((p) => subtitlesForPlaced(p, auto.sentences));
    try {
      drawn = await drawSubtitles(
        lines,
        project.settings,
        asset,
        ctx.video,
        auto.settings.output,
        auto.settings.subtitleSize,
        (i) => onStage(`Drawing subtitle ${i} of ${lines.length}`),
      );
    } catch (e) {
      return { ok: false, reason: `Could not draw the subtitles: ${message(e)}` };
    }
  }

  onStage("Adding the clips");
  const ids = { clipTrack: crypto.randomUUID(), subtitleTrack: crypto.randomUUID() };
  const result = useProjectStore.getState().execute({
    label: `Create ${placed.length} clip${placed.length === 1 ? "" : "s"}`,
    apply: (p) => addAutoClips(p, asset.id, placed, drawn, auto.settings.output, ids, !ctx.video),
  });
  if (!result.ok) return { ok: false, reason: result.error.message };
  const clipIds = placed.map((p) => p.id);
  useSelectionStore.getState().setSelection(clipIds);
  usePlaybackStore.getState().setPlayhead(placed[0].start);
  return { ok: true, clipIds, subtitles: drawn.length };
}

// ---------------------------------------------------------------------------------------------------
// Export each clip as its own file
// ---------------------------------------------------------------------------------------------------

/** Export sizes on offer: the short side of the picture. */
export const EXPORT_SIZES = [1080, 720] as const;
export type ExportSize = (typeof EXPORT_SIZES)[number];

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** The canvas a clip is exported on: 9:16, 1:1, or the project's own shape, `size` on the short side. */
export function exportCanvas(
  output: OutputShape,
  size: ExportSize,
  project: Pick<Project["settings"], "width" | "height">,
): { width: number; height: number } {
  if (output === "vertical") return { width: size, height: even((size * 16) / 9) };
  if (output === "square") return { width: size, height: size };
  const scale = size / Math.min(project.width, project.height);
  return { width: even(project.width * scale), height: even(project.height * scale) };
}

/**
 * A small project holding just one clip from 0 (and its subtitles), on the export canvas. It is never
 * opened or saved: it only tells the exporter what to render.
 */
export function clipProject(
  source: Project,
  asset: MediaAsset,
  clip: Pick<FoundClip, "title" | "sourceIn" | "sourceOut">,
  subtitles: DrawnSubtitle[],
  canvas: { width: number; height: number },
  output: OutputShape,
  soundOnly: boolean,
): EditResult {
  const base = createProject(clip.title || "Clip", {
    ...canvas,
    fps: source.settings.fps,
    backgroundColor: source.settings.backgroundColor,
  });
  const placed: PlacedClip = {
    id: crypto.randomUUID(),
    title: clip.title,
    sourceIn: clip.sourceIn,
    sourceOut: clip.sourceOut,
    start: 0,
  };
  return addAutoClips(
    { ...base, tracks: [], assets: [asset] },
    asset.id,
    [placed],
    subtitles,
    output,
    { clipTrack: crypto.randomUUID(), subtitleTrack: crypto.randomUUID() },
    soundOnly,
  );
}

export interface BatchFile {
  title: string;
  report?: ExportReport;
  error?: string;
}
export interface BatchReport {
  folder: string;
  files: BatchFile[];
  cancelled: boolean;
}
export type ExportClipsResult =
  { ok: true; report: BatchReport | null; expected: number[] } | { ok: false; reason: string };

/**
 * Export every included clip as its own MP4. Rust asks for the folder once, names the files from the titles
 * and never overwrites. `expected` holds each clip's length, to compare with what FFprobe measured.
 * Resolves with `report: null` when the folder dialog was dismissed. The open project is not changed.
 */
export async function exportSelectedClips(
  size: ExportSize,
  quality: Quality,
  onStage: (stage: string) => void = () => {},
): Promise<ExportClipsResult> {
  const auto = useAutoClipsStore.getState();
  const ctx = auto.context;
  const chosen = sortedClips(
    auto.clips.filter((c) => c.included),
    "time",
  );
  if (!ctx || chosen.length === 0) return { ok: false, reason: "Select at least one clip" };
  const project = useProjectStore.getState().project;
  const asset = project.assets.find((a) => a.path === ctx.path);
  if (!asset)
    return {
      ok: false,
      reason: "The original media is no longer in the project. Import or relink it first.",
    };
  // the folder first: nothing is prepared for an export the user backs out of
  let folder: string | null;
  try {
    folder = (await invoke<string | null>("choose_clips_folder")) ?? null;
  } catch (e) {
    return { ok: false, reason: message(e) };
  }
  if (!folder) return { ok: true, report: null, expected: [] };
  const output = ctx.video ? auto.settings.output : "keep";
  const canvas = exportCanvas(output, size, project.settings);
  const items: { title: string; project: Project }[] = [];
  try {
    for (const [i, clip] of chosen.entries()) {
      onStage(`Preparing clip ${i + 1} of ${chosen.length}`);
      const lines = auto.settings.subtitles
        ? subtitlesForPlaced(
            { id: "", title: clip.title, sourceIn: clip.sourceIn, sourceOut: clip.sourceOut, start: 0 },
            auto.sentences,
          )
        : [];
      const drawn = await drawSubtitles(
        lines,
        canvas,
        asset,
        ctx.video,
        output,
        auto.settings.subtitleSize,
        () => {},
      );
      const built = clipProject(project, asset, clip, drawn, canvas, output, !ctx.video);
      if (!built.ok) return { ok: false, reason: built.error.message };
      items.push({ title: clip.title, project: built.project });
    }
  } catch (e) {
    return { ok: false, reason: `Could not draw the subtitles: ${message(e)}` };
  }
  const options: ExportOptions = {
    ...canvas,
    fps: project.settings.fps,
    quality,
    format: ctx.video ? "mp4" : "m4a",
  };
  onStage("Starting…");
  try {
    const report = await invoke<BatchReport | null>("export_clips", { items, options });
    return { ok: true, report: report ?? null, expected: chosen.map((c) => c.sourceOut - c.sourceIn) };
  } catch (e) {
    return { ok: false, reason: message(e) };
  }
}
