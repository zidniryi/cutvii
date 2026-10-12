/**
 * Auto clips, step 3: turn the reviewed candidates into real timeline clips. They reference the original
 * file by `sourceIn` / `sourceOut` (no new media), go on new tracks after everything already on the
 * timeline (so nothing existing moves), and the whole batch is ONE undoable step.
 */
import { invoke } from "@tauri-apps/api/core";
import type { Project, TimelineClip } from "@/project/model";
import { useAutoClipsStore } from "@/store/autoClips";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { DEFAULT_STYLE, subtitleStyleOf, useTextStyleStore } from "@/store/textStyles";
import { sortedClips, wordsOf, type FoundClip, type OutputShape, type TranscriptSentence } from "./autoClips";
import { projectDuration } from "./clips";
import { addClip, addTrack, type EditResult } from "./edit";
import {
  addSubtitleClips,
  MIN_SUBTITLE_SECONDS,
  SUBTITLE_FONT_SHARE,
  subtitleSpec,
  subtitleWrap,
  type DrawnSubtitle,
  type Subtitle,
} from "./subtitles";
import { DEFAULT_SUBTITLE_POSITION } from "./textPosition";
import { withStyle } from "./textStyles";

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
  const drawn: DrawnSubtitle[] = [];
  if (auto.settings.subtitles) {
    const styles = useTextStyleStore.getState();
    const subtitle = subtitleStyleOf(styles);
    const look = subtitle.id === DEFAULT_STYLE && !subtitle.customised ? undefined : subtitle;
    const at = styles.subtitlePosition ?? DEFAULT_SUBTITLE_POSITION;
    const share = styles.subtitleSize ?? SUBTITLE_FONT_SHARE;
    const { width, height } = project.settings;
    const fit = ctx.video && auto.settings.output !== "keep" ? { fitMode: "fill" as const } : {};
    const wrap = ctx.video ? subtitleWrap({ ...fit } as TimelineClip, asset, width, height) : undefined;
    const lines = placed.flatMap((p) => subtitlesForPlaced(p, auto.sentences));
    try {
      for (const [i, line] of lines.entries()) {
        onStage(`Drawing subtitle ${i + 1} of ${lines.length}`);
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
