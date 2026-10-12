/**
 * What step 3 of Auto clips is doing: saving the clips as files, or adding them to the timeline. Kept here,
 * not in the dialog, so closing the wizard never hides a running export or loses its result.
 */
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import type { Quality } from "@/export/options";
import { cancelExport } from "@/lib/exportApi";
import {
  createClipsInProject,
  exportSelectedClips,
  type BatchReport,
  type ExportSize,
} from "@/timeline/createClips";
import { useAutoClipsStore } from "./autoClips";
import { useUiStore } from "./ui";

export interface BatchProgress {
  index: number;
  total: number;
  fraction: number;
}

interface ClipOutputState {
  busy: "export" | "create" | null;
  stage: string | null;
  progress: BatchProgress | null;
  problem: string | null;
  done: { report: BatchReport; expected: number[] } | null;
  size: ExportSize;
  quality: Quality;
  setSize: (size: ExportSize) => void;
  setQuality: (quality: Quality) => void;
  /** Ask for a folder, then write one file per included clip. */
  exportFiles: () => Promise<void>;
  stopExport: () => void;
  /** Put the included clips on the timeline (one undo step), then close the wizard. */
  addToTimeline: () => Promise<void>;
  clear: () => void;
}

let attached: Promise<unknown> | null = null;

export const useClipOutputStore = create<ClipOutputState>((set, get) => ({
  busy: null,
  stage: null,
  progress: null,
  problem: null,
  done: null,
  size: 1080,
  quality: "standard",
  setSize: (size) => set({ size }),
  setQuality: (quality) => set({ quality }),
  exportFiles: async () => {
    if (get().busy) return;
    attached ??= listen<BatchProgress>("export-clips-progress", (e) => {
      if (get().busy === "export") set({ progress: e.payload });
    }).catch(() => null);
    set({ busy: "export", stage: "Choose a folder…", progress: null, problem: null, done: null });
    const result = await exportSelectedClips(get().size, get().quality, (stage) => set({ stage }));
    set({ busy: null, stage: null, progress: null });
    if (!result.ok) return set({ problem: result.reason });
    if (result.report) set({ done: { report: result.report, expected: result.expected } });
  },
  stopExport: () => void cancelExport().catch(() => undefined),
  addToTimeline: async () => {
    if (get().busy) return;
    set({ busy: "create", stage: "Preparing…", problem: null });
    const result = await createClipsInProject((stage) => set({ stage }));
    set({ busy: null, stage: null });
    if (!result.ok) return set({ problem: result.reason });
    const n = result.clipIds.length;
    useAutoClipsStore.getState().hide();
    useUiStore
      .getState()
      .setNotice(
        `Added ${n} clip${n === 1 ? "" : "s"} at the end of the timeline${result.subtitles > 0 ? `, with ${result.subtitles} subtitles` : ""}. They are selected; Undo removes them all.`,
      );
  },
  clear: () => set({ problem: null, done: null }),
}));
