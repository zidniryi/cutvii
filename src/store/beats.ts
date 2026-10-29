import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { findClip } from "@/timeline/clips";
import { MIN_BEAT_SECONDS, type BeatGrid } from "@/timeline/beats";
import { changeBeatFx } from "@/timeline/editor";
import { useProjectStore } from "./project";

/**
 * Beat grids loaded from Rust's cache, by grid id, and the one detection that may run. A grid is never
 * stored in the project; a reopened project loads it again by id (`beat_grid`).
 */
interface BeatState {
  /** `null`: the clip's grid is not in the cache any more (or the file changed). */
  grids: Record<string, BeatGrid | null>;
  running: { clipId: string; done: number; startedAt: number } | null;
  /** Find the beats of the part of the source the clip uses and point the clip at them (one undo step).
   * Returns a message when it did not work; `null` when it worked or was stopped. */
  detect: (clipId: string) => Promise<string | null>;
  cancel: () => void;
  /** Load a clip's grid from the cache if it is not loaded yet. */
  ensureGrid: (path: string, gridId: string) => void;
}

const message = (e: unknown) =>
  (typeof e === "string" ? e : e instanceof Error ? e.message : "unknown error").replace(
    /^invalid input: /,
    "",
  );

let attached: Promise<unknown> | null = null;
let cancelled = false;
const loading = new Set<string>();

export const useBeatStore = create<BeatState>((set, get) => {
  const attach = () => {
    attached ??= listen<{ gridId: string; done: number }>("beats-progress", (e) => {
      const current = get().running;
      if (current) set({ running: { ...current, done: e.payload.done } });
    }).catch(() => null);
  };
  return {
    grids: {},
    running: null,
    detect: async (clipId) => {
      const project = useProjectStore.getState().project;
      const found = findClip(project, clipId);
      const asset = found && project.assets.find((a) => a.id === found.clip.assetId);
      if (!found || !asset || asset.type === "image") return "This clip has no sound";
      if (get().running) return "Beats are already being found for another clip";
      const { sourceIn, sourceOut } = found.clip;
      if (sourceOut - sourceIn < MIN_BEAT_SECONDS) {
        return `Beats need at least ${MIN_BEAT_SECONDS} seconds of sound`;
      }
      attach();
      cancelled = false;
      set({ running: { clipId, done: 0, startedAt: Date.now() } });
      try {
        const result = await invoke<{ gridId: string; grid: BeatGrid }>("detect_beats", {
          path: asset.path,
          start: sourceIn,
          end: sourceOut,
        });
        set((s) => ({ grids: { ...s.grids, [result.gridId]: result.grid } }));
        if (findClip(useProjectStore.getState().project, clipId)?.clip.beatFx?.gridId === result.gridId)
          return null;
        const done = changeBeatFx(clipId, { gridId: result.gridId }, "Detect beats");
        return done.ok ? null : done.error.message;
      } catch (e) {
        return cancelled ? null : message(e);
      } finally {
        set({ running: null });
      }
    },
    cancel: () => {
      if (!get().running) return;
      cancelled = true;
      invoke("cancel_beat_job").catch(() => undefined);
    },
    ensureGrid: (path, gridId) => {
      if (gridId in get().grids || loading.has(gridId)) return;
      loading.add(gridId);
      invoke<BeatGrid | null>("beat_grid", { path, gridId })
        .then((grid) => set((s) => ({ grids: { ...s.grids, [gridId]: grid ?? null } })))
        .catch(() => set((s) => ({ grids: { ...s.grids, [gridId]: null } })))
        .finally(() => loading.delete(gridId));
    },
  };
});
