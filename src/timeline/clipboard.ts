/** Cut / copy / paste of timeline clips. The clipboard lives in memory only (never the OS clipboard). */
import { create } from "zustand";
import type { Project, TimelineClip } from "@/project/model";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { clipDuration } from "./clips";
import { deleteClip, firstFreeStart, type EditResult } from "./edit";
import { pruneSelection } from "./editor";

interface Copied {
  clip: TimelineClip;
  trackType: "video" | "audio";
}

interface ClipboardState {
  items: Copied[];
  set: (items: Copied[]) => void;
}

export const useClipboardStore = create<ClipboardState>((set) => ({
  items: [],
  set: (items) => set({ items }),
}));

const fail = (message: string): EditResult => ({ ok: false, error: { code: "unknown-clip", message } });

function selectedClips(project: Project): Copied[] {
  const ids = new Set(useSelectionStore.getState().selectedClipIds);
  return project.tracks
    .flatMap((t) => t.clips.filter((c) => ids.has(c.id)).map((clip) => ({ clip, trackType: t.type })))
    .sort((a, b) => a.clip.timelineStart - b.clip.timelineStart);
}

/** Copy the selection. Returns how many clips were copied. */
export function copySelected(): number {
  const items = selectedClips(useProjectStore.getState().project);
  if (items.length > 0) useClipboardStore.getState().set(items);
  return items.length;
}

/** Copy, then remove the selection (one undo step). */
export function cutSelected(): EditResult {
  const items = selectedClips(useProjectStore.getState().project);
  if (items.length === 0) return fail("Nothing selected");
  useClipboardStore.getState().set(items);
  const result = useProjectStore.getState().execute({
    label: items.length > 1 ? "Cut clips" : "Cut clip",
    apply: (p) => {
      let next = p;
      for (const { clip } of items) {
        const r = deleteClip(next, clip.id);
        if (!r.ok) return r;
        next = r.project;
      }
      return { ok: true, project: next };
    },
  });
  if (result.ok) pruneSelection();
  return result;
}

/**
 * Pure paste: copies keep their spacing, the earliest one starts at `time`, each goes back to its own track
 * (or the first track of the same kind if that one is gone) and slides right past anything in the way.
 */
export function pasteClips(
  project: Project,
  items: Copied[],
  time: number,
  newId: () => string = () => crypto.randomUUID(),
): { project: Project; ids: string[] } | null {
  const usable = items.filter((i) => project.assets.some((a) => a.id === i.clip.assetId));
  if (usable.length === 0) return null;
  const origin = Math.min(...usable.map((i) => i.clip.timelineStart));
  let tracks = project.tracks;
  const ids: string[] = [];

  for (const { clip, trackType } of usable) {
    const target =
      tracks.find((t) => t.id === clip.trackId && t.type === trackType) ??
      [...tracks].sort((a, b) => a.order - b.order).find((t) => t.type === trackType);
    if (!target) continue;
    const start = firstFreeStart(target.clips, time + (clip.timelineStart - origin), clipDuration(clip));
    const copy: TimelineClip = { ...clip, id: newId(), trackId: target.id, timelineStart: start };
    ids.push(copy.id);
    tracks = tracks.map((t) =>
      t.id === target.id
        ? { ...t, clips: [...t.clips, copy].sort((a, b) => a.timelineStart - b.timelineStart) }
        : t,
    );
  }
  return ids.length ? { project: { ...project, tracks }, ids } : null;
}

/** Paste at the playhead as one undo step and select what was pasted. */
export function pasteAtPlayhead(): EditResult {
  const items = useClipboardStore.getState().items;
  if (items.length === 0) return fail("Nothing to paste");
  const time = usePlaybackStore.getState().playhead;
  let pasted: string[] = [];
  const result = useProjectStore.getState().execute({
    label: items.length > 1 ? "Paste clips" : "Paste clip",
    apply: (p) => {
      const r = pasteClips(p, items, time);
      if (!r) return fail("The copied media is no longer in the project");
      pasted = r.ids;
      return { ok: true, project: r.project };
    },
  });
  if (result.ok) useSelectionStore.getState().setSelection(pasted);
  return result;
}
