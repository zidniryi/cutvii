import { create } from "zustand";

interface PlaybackState {
  /** Seconds from the start of the timeline. */
  playhead: number;
  playing: boolean;
  /** assetId -> why the preview could not play it. Cleared when the asset loads. */
  mediaErrors: Record<string, string>;
  setPlayhead: (seconds: number) => void;
  play: () => void;
  pause: () => void;
  setMediaError: (assetId: string, message: string | null) => void;
}

export const usePlaybackStore = create<PlaybackState>((set) => ({
  playhead: 0,
  playing: false,
  mediaErrors: {},
  setPlayhead: (seconds) => set({ playhead: Math.max(0, seconds) }),
  play: () => set({ playing: true }),
  pause: () => set({ playing: false }),
  setMediaError: (assetId, message) =>
    set((s) => {
      if ((s.mediaErrors[assetId] ?? null) === message) return s;
      const next = { ...s.mediaErrors };
      if (message === null) delete next[assetId];
      else next[assetId] = message;
      return { mediaErrors: next };
    }),
}));
