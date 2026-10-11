/** Text and titles: a text clip is an image asset whose picture CutVii draws from its `text` properties. */
import { invoke } from "@tauri-apps/api/core";
import type { MediaAsset, Project, TextSpec } from "@/project/model";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useUiStore } from "@/store/ui";
import { clipEnd, EPS } from "./clips";
import { addClip, addTrack, DEFAULT_IMAGE_DURATION, type EditResult } from "./edit";

export const TEXT_FONT_LIMITS = { min: 8, max: 2000 } as const;
/** New text is this tall, as a share of the canvas height. */
const DEFAULT_FONT_SHARE = 0.09;

export function defaultTextSpec(canvasHeight: number): TextSpec {
  const size = Math.round(canvasHeight * DEFAULT_FONT_SHARE);
  return {
    content: "Text",
    fontSize: Math.min(TEXT_FONT_LIMITS.max, Math.max(TEXT_FONT_LIMITS.min, size)),
    color: "#FFFFFF",
    bold: true,
    align: "center",
    x: 0.5,
    y: 0.5,
  };
}

/**
 * Where new text goes: the top video track when it is free for the whole clip, otherwise a new track above
 * everything (null), so text never ends up underneath the picture it is meant to sit on.
 */
export function textTrackFor(project: Project, start: number, duration: number): string | null {
  const top = project.tracks.filter((t) => t.type === "video").sort((a, b) => b.order - a.order)[0];
  if (!top) return null;
  const busy = top.clips.some((c) => c.timelineStart < start + duration - EPS && start < clipEnd(c) - EPS);
  return busy ? null : top.id;
}

/** Add a drawn text picture as an asset and put it on the timeline at `start`. One undoable step. */
export function addTextClip(
  project: Project,
  args: { picture: string; spec: TextSpec; start: number; assetId: string; clipId: string; trackId: string },
): EditResult {
  const { width, height } = project.settings;
  const asset: MediaAsset = {
    id: args.assetId,
    path: args.picture,
    type: "image",
    width,
    height,
    text: args.spec,
  };
  let next: Project = { ...project, assets: [...project.assets, asset] };
  const existing = textTrackFor(project, args.start, DEFAULT_IMAGE_DURATION);
  if (!existing) {
    const added = addTrack(next, "video", args.trackId);
    if (!added.ok) return added;
    next = added.project;
  }
  return addClip(next, {
    assetId: asset.id,
    trackId: existing ?? args.trackId,
    start: args.start,
    id: args.clipId,
  });
}

/** "Add text": draw the default text for this canvas (in Rust) and place it at the playhead. */
export async function addTextAtPlayhead(): Promise<void> {
  const { width, height } = useProjectStore.getState().project.settings;
  const spec = defaultTextSpec(height);
  let picture: string;
  try {
    picture = await invoke<string>("render_text", { spec, width, height });
  } catch (e) {
    const reason = typeof e === "string" ? e : e instanceof Error ? e.message : "unknown error";
    useUiStore.getState().setNotice(`Could not add text: ${reason}`);
    return;
  }
  const clipId = crypto.randomUUID();
  const result = useProjectStore.getState().execute({
    label: "Add text",
    apply: (p) =>
      addTextClip(p, {
        picture,
        spec,
        start: usePlaybackStore.getState().playhead,
        assetId: crypto.randomUUID(),
        clipId,
        trackId: crypto.randomUUID(),
      }),
  });
  if (result.ok) useSelectionStore.getState().select(clipId);
  else useUiStore.getState().setNotice(result.error.message);
}
