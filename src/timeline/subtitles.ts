/** Auto subtitles: speech recognised in a clip (in Rust, on this machine) becomes text clips above it. */
import { invoke } from "@tauri-apps/api/core";
import type { MediaAsset, Project, TextSpec, TimelineClip } from "@/project/model";
import { useAiStore } from "@/store/ai";
import { useProjectStore } from "@/store/project";
import { clipDuration, clipSpeed, findClip } from "./clips";
import { addClip, addTrack, type EditResult } from "./edit";
import { setTextFade, TEXT_FONT_LIMITS } from "./text";
import { withStyle, type StylePreset } from "./textStyles";

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
const SUBTITLE_FONT_SHARE = 0.045;

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
export function subtitleSpec(text: string, canvasHeight: number): TextSpec {
  const size = Math.round(canvasHeight * SUBTITLE_FONT_SHARE);
  return {
    content: text,
    fontSize: Math.min(TEXT_FONT_LIMITS.max, Math.max(TEXT_FONT_LIMITS.min, size)),
    color: "#FFFFFF",
    bold: true,
    align: "center",
    x: 0.5,
    y: 0.88,
  };
}

export interface DrawnSubtitle extends Subtitle {
  spec: TextSpec;
  /** The drawn text picture. */
  picture: string;
  assetId: string;
  clipId: string;
  /** Seconds each subtitle fades in and out over, when its style calls for it. */
  fade?: number;
}

/** Put drawn subtitles on a new video track above everything. One undoable step. */
export function addSubtitleClips(project: Project, items: DrawnSubtitle[], trackId: string): EditResult {
  if (items.length === 0) return { ok: true, project };
  const { width, height } = project.settings;
  const track = addTrack(project, "video", trackId);
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
  style?: StylePreset,
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
  const subtitles = subtitlesFor(now.clip, Array.isArray(segments) ? segments : []);
  if (subtitles.length === 0) return { ok: false, reason: "No speech was found in this clip" };

  const { width, height } = useProjectStore.getState().project.settings;
  const drawn: DrawnSubtitle[] = [];
  try {
    for (const [i, subtitle] of subtitles.entries()) {
      onStage(`Drawing subtitle ${i + 1} of ${subtitles.length}`);
      const plain = subtitleSpec(subtitle.text, height);
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
  const trackId = crypto.randomUUID();
  const result = useProjectStore.getState().execute({
    label: "Add subtitles",
    apply: (p) => addSubtitleClips(p, drawn, trackId),
  });
  return result.ok ? { ok: true, added: drawn.length } : { ok: false, reason: result.error.message };
}
