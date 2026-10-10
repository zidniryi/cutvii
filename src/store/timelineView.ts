import { create } from "zustand";
import { clampPps, DEFAULT_PPS } from "@/timeline/geometry";

const ZOOM_FACTOR = 1.5;

interface TimelineViewState {
  /** Pixels per second. */
  pps: number;
  snapping: boolean;
  setPps: (pps: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  toggleSnapping: () => void;
}

export const useTimelineViewStore = create<TimelineViewState>((set) => ({
  pps: DEFAULT_PPS,
  snapping: true,
  setPps: (pps) => set({ pps: clampPps(pps) }),
  zoomIn: () => set((s) => ({ pps: clampPps(s.pps * ZOOM_FACTOR) })),
  zoomOut: () => set((s) => ({ pps: clampPps(s.pps / ZOOM_FACTOR) })),
  toggleSnapping: () => set((s) => ({ snapping: !s.snapping })),
}));
