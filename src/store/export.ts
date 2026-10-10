import { create } from "zustand";
import type { ExportReport } from "@/lib/exportApi";

export type ExportPhase = "closed" | "settings" | "running" | "done" | "error";

interface ExportState {
  phase: ExportPhase;
  /** 0..1 while running. */
  progress: number;
  report: ExportReport | null;
  error: string | null;
  /** True once cancel was requested for the running job. */
  cancelling: boolean;
  /** Bumped on every open so the dialog body remounts with fresh default options. */
  session: number;
  open: () => void;
  close: () => void;
  set: (patch: Partial<Omit<ExportState, "open" | "close" | "set">>) => void;
}

export const useExportStore = create<ExportState>((set) => ({
  phase: "closed",
  progress: 0,
  report: null,
  error: null,
  cancelling: false,
  session: 0,
  open: () =>
    set((s) => ({
      phase: "settings",
      progress: 0,
      report: null,
      error: null,
      cancelling: false,
      session: s.session + 1,
    })),
  close: () => set({ phase: "closed" }),
  set: (patch) => set(patch),
}));
