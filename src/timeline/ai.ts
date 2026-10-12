/** Getting to the AI tools: they live in the inspector's AI tab of a video or audio clip. */
import type { Project } from "@/project/model";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useUiStore, type ClipKind } from "@/store/ui";
import { useAutoClipsStore } from "@/store/autoClips";
import { useMediaDetailsStore } from "@/store/mediaDetails";
import { autoClipsBlocker } from "./autoClips";
import { clipEnd, EPS, findClip } from "./clips";

/** The kind of inspector a clip gets if it can use AI tools (it has sound), otherwise null. */
export function aiKindOf(project: Project, clipId: string): ClipKind | null {
  const found = findClip(project, clipId);
  const asset = found && project.assets.find((a) => a.id === found.clip.assetId);
  if (!found || !asset || asset.type === "image") return null;
  return found.track.type === "audio" ? "audio" : asset.type;
}

/**
 * The clip the AI tools should open for: a selected clip with sound, otherwise the one under the playhead
 * (the picture on top first), otherwise the first one on the timeline. Undefined when nothing has sound.
 */
export function aiTarget(project: Project, selected: string[], playhead: number): string | undefined {
  const usable = (id: string) => aiKindOf(project, id) !== null;
  const chosen = selected.find(usable);
  if (chosen) return chosen;
  // top video track first, then down, then the audio tracks
  const tracks = [...project.tracks].sort(
    (a, b) => Number(a.type === "audio") - Number(b.type === "audio") || b.order - a.order,
  );
  const clips = tracks.flatMap((t) => [...t.clips].sort((a, b) => a.timelineStart - b.timelineStart));
  const here = clips.find(
    (c) => usable(c.id) && c.timelineStart <= playhead + EPS && playhead < clipEnd(c) - EPS,
  );
  return (here ?? clips.find((c) => usable(c.id)))?.id;
}

/**
 * Show the AI tools: select the clip they apply to (see `aiTarget`, or `clipId` when given), switch its
 * inspector to the AI tab and move the focus there. Returns false, with a hint for the user, when the
 * timeline has no video or audio clip.
 */
export function openAiTools(clipId?: string): boolean {
  const project = useProjectStore.getState().project;
  const selection = useSelectionStore.getState();
  const target = clipId ?? aiTarget(project, selection.selectedClipIds, usePlaybackStore.getState().playhead);
  const kind = target ? aiKindOf(project, target) : null;
  const ui = useUiStore.getState();
  if (!target || !kind) {
    ui.setNotice("Add a video or audio clip to the timeline to use the AI tools");
    return false;
  }
  if (selection.selectedClipIds.length !== 1 || selection.selectedClipIds[0] !== target)
    selection.select(target);
  ui.setInspectorTab(kind, "ai");
  ui.setSidePanel("inspector"); // on narrow screens the inspector is behind a tab
  ui.focusInspectorTab("ai");
  return true;
}

/**
 * Open the Auto clips wizard for `clipId`, or for the clip the AI tools would pick. A clip that cannot be
 * searched (no sound, under a minute, reversed) gets its reason as a notice instead.
 */
export function openAutoClips(clipId?: string): boolean {
  const project = useProjectStore.getState().project;
  const auto = useAutoClipsStore.getState();
  // results or a running search are shown again as they are
  if (!clipId && (auto.status === "running" || auto.clips.length > 0)) {
    auto.openWizard();
    return true;
  }
  const selection = useSelectionStore.getState();
  const target = clipId ?? aiTarget(project, selection.selectedClipIds, usePlaybackStore.getState().playhead);
  const ui = useUiStore.getState();
  if (!target) {
    ui.setNotice("Add a video or audio clip to the timeline to find short clips");
    return false;
  }
  const found = findClip(project, target);
  const asset = found && project.assets.find((a) => a.id === found.clip.assetId);
  const entry = asset ? useMediaDetailsStore.getState().entries[asset.path] : undefined;
  const blocker = autoClipsBlocker(project, target, entry?.status === "ready" ? entry.details : undefined);
  if (blocker) {
    ui.setNotice(blocker);
    return false;
  }
  auto.openWizard(target);
  return true;
}
