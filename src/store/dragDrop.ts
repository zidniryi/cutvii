import { create } from "zustand";

/** What the timeline should draw while something is being dragged over it. */
export interface DropPreview {
  /** Lane that will receive the clip; null = a new track will be created. */
  trackId: string | null;
  trackType: "video" | "audio";
  start: number;
  duration: number;
  label: string;
  /** Shown when the lane under the pointer cannot take this media and another one is used. */
  hint?: string;
}

interface DragDropState {
  /** A drag is in progress (a media card, files from the OS, or a transition from the gallery). */
  dragging: { source: "library" | "os" | "transition"; label: string; x: number; y: number } | null;
  preview: DropPreview | null;
  set: (patch: Partial<Pick<DragDropState, "dragging" | "preview">>) => void;
  clear: () => void;
}

export const useDragDropStore = create<DragDropState>((set) => ({
  dragging: null,
  preview: null,
  set: (patch) => set(patch),
  clear: () => set({ dragging: null, preview: null }),
}));
