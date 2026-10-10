import { create } from "zustand";

export interface ReversePreview {
  status: "preparing" | "ready" | "failed";
  /** 0..1 while preparing. */
  progress: number;
  /** The reversed copy the preview plays (ready only). */
  path?: string;
  error?: string;
}

interface ReverseState {
  /** Keyed by `reverseKey` (file + used range). */
  previews: Record<string, ReversePreview>;
  set: (key: string, value: ReversePreview) => void;
}

export const useReverseStore = create<ReverseState>((set) => ({
  previews: {},
  set: (key, value) => set((s) => ({ previews: { ...s.previews, [key]: value } })),
}));

/** One reversed copy per file and used range. */
export const reverseKey = (path: string, sourceIn: number, sourceOut: number) =>
  `${path}|${sourceIn.toFixed(3)}|${sourceOut.toFixed(3)}`;
