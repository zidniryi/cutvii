/** Auto subtitles: speech recognised in a clip (in Rust, on this machine) becomes text clips above it. */
import { invoke } from "@tauri-apps/api/core";
import type { MediaAsset, Project, TextSpec, TimelineClip } from "@/project/model";
import { useAiStore } from "@/store/ai";
import { useProjectStore } from "@/store/project";
import { clipDuration, clipSpeed, findClip } from "./clips";
import { addClip, addTrack, type EditResult } from "./edit";
import { pictureWidthShare } from "./fit";
import { setTextFade, TEXT_FONT_LIMITS } from "./text";
import type { TextStyle } from "@/project/model";
import { DEFAULT_SUBTITLE_POSITION, type Position } from "./textPosition";
import { withStyle } from "./textStyles";
import { canvasShape, DEFAULT_CAPTION_LIMITS, splitCaptions, type CaptionLimits } from "./captionRules";

/** One stretch of speech; times are seconds from the start of the clip's used source range. */
export interface SpeechSegment {
  start: number;
  end: number;
  text: string;
}

export interface Subtitle {
  /** Timeline seconds. */
  start: number;
  duration: number;
  text: string;
}

/** A subtitle shorter than this cannot be read; it is dropped. */
export const MIN_SUBTITLE_SECONDS = 0.2;
export const SUBTITLE_FONT_SHARE = 0.045;
/** The smallest and largest subtitle size that can be chosen, as shares of the canvas height. */
export const SUBTITLE_SIZE_LIMITS = { min: 0.02, max: 0.2 } as const;

/**
 * Where each recognised segment sits on the timeline: scaled by the clip's speed, kept inside the clip, and
 * never overlapping the one before (they share a track). Reversed clips are not supported: the speech was
 * recognised forwards.
 */
export function subtitlesFor(clip: TimelineClip, segments: SpeechSegment[]): Subtitle[] {
  if (clip.reversed) return [];
  const speed = clipSpeed(clip);
  const clipEndsAt = clip.timelineStart + clipDuration(clip);
  const out: Subtitle[] = [];
  let free = clip.timelineStart;
  for (const segment of [...segments].sort((a, b) => a.start - b.start)) {
    const text = segment.text.trim();
    const start = Math.max(free, clip.timelineStart + segment.start / speed);
    const end = Math.min(clipEndsAt, clip.timelineStart + segment.end / speed);
    if (!text || end - start < MIN_SUBTITLE_SECONDS) continue;
    out.push({ start, duration: end - start, text });
    free = end;
  }
  return out;
}

/** How subtitles look: white, centred, near the bottom, sized for the canvas. Editable like any text. */
export function subtitleSpec(
  text: string,
  canvasHeight: number,
  at: Position = DEFAULT_SUBTITLE_POSITION,
  /** Font size as a share of the canvas height. */
  share: number = SUBTITLE_FONT_SHARE,
  /** Share of the canvas width the lines may take; the usual text width when absent. */
  wrap?: number,
): TextSpec {
  const size = Math.round(canvasHeight * share);
  const spec: TextSpec = {
    content: text,
    fontSize: Math.min(TEXT_FONT_LIMITS.max, Math.max(TEXT_FONT_LIMITS.min, size)),
    color: "#FFFFFF",
    bold: true,
    align: "center",
    x: at.x,
    y: at.y,
  };
  if (wrap !== undefined) spec.wrap = wrap;
  return spec;
}

/** Subtitles keep this share of their picture's width (the same margin ordinary text keeps on the canvas). */
export const SUBTITLE_WIDTH_IN_PICTURE = 0.9;

/**
 * The width subtitles of `clip` wrap at, as a share of the canvas: inside the clip's picture when that is
 * narrower than the canvas (a portrait video on a wide canvas), `undefined` when the picture fills it.
 */
export function subtitleWrap(
  clip: TimelineClip,
  asset: Pick<MediaAsset, "width" | "height">,
  canvasWidth: number,
  canvasHeight: number,
): number | undefined {
  const picture = pictureWidthShare(clip, asset.width, asset.height, canvasWidth, canvasHeight);
  if (picture >= 0.999) return undefined;
  return Math.max(MIN_SUBTITLE_WRAP, Math.round(picture * SUBTITLE_WIDTH_IN_PICTURE * 1000) / 1000);
}
/** Narrower than this a subtitle is a column of single words. */
const MIN_SUBTITLE_WRAP = 0.2;

export interface DrawnSubtitle extends Subtitle {
  spec: TextSpec;
  /** The drawn text picture. */
  picture: string;
  assetId: string;
  clipId: string;
  /** Seconds each subtitle fades in and out over, when its style calls for it. */
  fade?: number;
}

/**
 * Put drawn subtitles on a video track above everything: the top track when it is an empty video track
 * (left behind by deleting earlier subtitles), otherwise a new one with the id `newTrackId`. One undoable step.
 */
export function addSubtitleClips(project: Project, items: DrawnSubtitle[], newTrackId: string): EditResult {
  if (items.length === 0) return { ok: true, project };
  const { width, height } = project.settings;
  const top = [...project.tracks].sort((a, b) => b.order - a.order)[0];
  const reuse = top && top.type === "video" && top.clips.length === 0 ? top : undefined;
  const trackId = reuse?.id ?? newTrackId;
  const track: EditResult = reuse ? { ok: true, project } : addTrack(project, "video", trackId);
  if (!track.ok) return track;
  const assets: MediaAsset[] = items.map((item) => ({
    id: item.assetId,
    path: item.picture,
    type: "image",
    width,
    height,
    text: item.spec,
  }));
  let next: Project = { ...track.project, assets: [...track.project.assets, ...assets] };
  for (const item of items) {
    const added = addClip(next, {
      assetId: item.assetId,
      trackId,
      start: item.start,
      duration: item.duration,
      id: item.clipId,
    });
    if (!added.ok) return added;
    next = added.project;
    if (item.fade) {
      // never longer than the subtitle itself can show: a short line fades for at most a third of it
      const faded = setTextFade(next, item.clipId, Math.min(item.fade, item.duration / 3));
      if (!faded.ok) return faded;
      next = faded.project;
    }
  }
  return { ok: true, project: next };
}

/** Scroll the timeline so the track holding `clipId` is in view (it may be below the visible tracks). */
function showTrackOf(clipId: string) {
  const track = useProjectStore.getState().project.tracks.find((t) => t.clips.some((c) => c.id === clipId));
  if (!track || typeof document === "undefined") return;
  // after the timeline has drawn the new track
  requestAnimationFrame(() => {
    const lane = Array.from(document.querySelectorAll("[data-track-id]")).find(
      (el) => el.getAttribute("data-track-id") === track.id,
    );
    if (lane && typeof lane.scrollIntoView === "function") lane.scrollIntoView({ block: "nearest" });
  });
}

const message = (e: unknown) =>
  typeof e === "string" ? e : e instanceof Error ? e.message : "unknown error";

export type SubtitleResult = { ok: true; added: number } | { ok: false; reason: string };

/**
 * Recognise the speech of a clip and add it as subtitles. `onStage` reports what is happening
 * ("Listening…" progress comes through the AI store). Nothing changes if it fails or is cancelled.
 */
export async function generateSubtitles(
  clipId: string,
  model: string,
  language: string | null,
  onStage: (stage: string) => void = () => {},
  /** A text style for the subtitles; without one they get the plain subtitle look. */
  style?: { style: TextStyle; fade?: number },
  /** Where the subtitles go; the usual place at the bottom when absent. */
  at?: Position,
  /** Font size as a share of the canvas height; the usual subtitle size when absent. */
  share?: number,
  /** How long a caption may be; the starting limits for the canvas shape when absent. */
  limits?: CaptionLimits,
): Promise<SubtitleResult> {
  const before = useProjectStore.getState().project;
  const found = findClip(before, clipId);
  const asset = found && before.assets.find((a) => a.id === found.clip.assetId);
  if (!found || !asset || asset.type === "image") return { ok: false, reason: "This clip has no speech" };
  if (found.clip.reversed) return { ok: false, reason: "Reversed clips cannot be subtitled" };

  const ai = useAiStore.getState();
  ai.setListening({ clipId, percent: 0 });
  let segments: SpeechSegment[];
  try {
    segments = await invoke<SpeechSegment[]>("transcribe_media", {
      path: asset.path,
      sourceIn: found.clip.sourceIn,
      sourceOut: found.clip.sourceOut,
      model,
      language,
    });
  } catch (e) {
    return { ok: false, reason: message(e) };
  } finally {
    useAiStore.getState().setListening(null);
  }

  // the clip may have been edited while listening: place the words by where it is now
  const now = findClip(useProjectStore.getState().project, clipId);
  if (!now) return { ok: false, reason: "The clip was removed while listening" };
  const whole = subtitlesFor(now.clip, Array.isArray(segments) ? segments : []);
  if (whole.length === 0) return { ok: false, reason: "No speech was found in this clip" };

  const { width, height } = useProjectStore.getState().project.settings;
  return placeSubtitles(whole, {
    label: "Add subtitles",
    language,
    endLimit: now.clip.timelineStart + clipDuration(now.clip),
    wrap: subtitleWrap(now.clip, asset, width, height),
    onStage,
    style,
    at,
    share,
    limits,
  });
}

export interface PlaceOptions {
  /** The undo label. */
  label: string;
  /** Language of the words ("id", "en"); null when unknown. */
  language: string | null;
  /** No caption runs past this timeline time. */
  endLimit: number;
  /** Share of the canvas width the lines may take; the usual text width when absent. */
  wrap?: number;
  onStage?: (stage: string) => void;
  style?: { style: TextStyle; fade?: number };
  at?: Position;
  share?: number;
  /** How long a caption may be; the starting limits for the canvas shape when absent. */
  limits?: CaptionLimits;
}

/**
 * Cut `whole` (timeline times) into readable captions with the one splitter, draw them and put them on a
 * subtitle track as ONE undo step. Used by auto subtitles and by `.srt` import. Nothing changes on failure.
 */
export async function placeSubtitles(whole: Subtitle[], o: PlaceOptions): Promise<SubtitleResult> {
  const { width, height, fps } = useProjectStore.getState().project.settings;
  const { style, at, share, onStage = () => {} } = o;
  // a segment can be a whole long sentence: cut it into captions a viewer can read
  let subtitles: Subtitle[];
  try {
    const pieces = await splitCaptions(
      whole.map((s) => ({ start: s.start, end: s.start + s.duration, text: s.text })),
      {
        limits: o.limits ?? DEFAULT_CAPTION_LIMITS[canvasShape(width, height)],
        language: o.language,
        fps,
        endLimit: o.endLimit,
        uppercase: style?.style.uppercase === true,
        bottom: (at ?? DEFAULT_SUBTITLE_POSITION).y >= 0.5,
      },
    );
    subtitles = pieces.map((p) => ({ start: p.start, duration: p.end - p.start, text: p.text }));
  } catch (e) {
    return { ok: false, reason: `Could not cut the subtitles into captions: ${message(e)}` };
  }

  const drawn: DrawnSubtitle[] = [];
  try {
    for (const [i, subtitle] of subtitles.entries()) {
      onStage(`Drawing subtitle ${i + 1} of ${subtitles.length}`);
      const plain = subtitleSpec(subtitle.text, height, at, share, o.wrap);
      const spec = style ? withStyle(plain, style.style) : plain;
      const picture = await invoke<string>("render_text", { spec, width, height });
      drawn.push({
        ...subtitle,
        spec,
        picture,
        assetId: crypto.randomUUID(),
        clipId: crypto.randomUUID(),
        fade: style?.fade,
      });
    }
  } catch (e) {
    return { ok: false, reason: `Could not draw the subtitles: ${message(e)}` };
  }
  if (drawn.length === 0) return { ok: false, reason: "There are no subtitles to add" };
  const trackId = crypto.randomUUID();
  const result = useProjectStore.getState().execute({
    label: o.label,
    apply: (p) => addSubtitleClips(p, drawn, trackId),
  });
  if (!result.ok) return { ok: false, reason: result.error.message };
  showTrackOf(drawn[0].clipId);
  return { ok: true, added: drawn.length };
}
