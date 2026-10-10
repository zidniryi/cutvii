import { create } from "zustand";

interface PlaybackState {
  /** Seconds from the start of the timeline. */
  playhead: number;
  playing: boolean;
  /** assetId -> why the preview could not play it. Cleared when the asset loads. */
  mediaErrors: Record<string, string>;
  /** Monitor volume 0..1 and mute. Preview only: never saved, never exported. */
  volume: number;
  muted: boolean;
  /** Start again from the beginning when the end is reached. */
  loop: boolean;
  /** Preview-only playback speed (0.5 / 1 / 1.5 / 2). Never touches clip speed, the project or the export. */
  previewSpeed: number;
  setPlayhead: (seconds: number) => void;
  setVolume: (volume: number) => void;
  setMuted: (muted: boolean) => void;
  setLoop: (loop: boolean) => void;
  setPreviewSpeed: (speed: number) => void;
  play: () => void;
  pause: () => void;
  setMediaError: (assetId: string, message: string | null) => void;
}

export const usePlaybackStore = create<PlaybackState>((set) => ({
  playhead: 0,
  playing: false,
  mediaErrors: {},
  volume: 1,
  muted: false,
  loop: false,
  previewSpeed: 1,
  setVolume: (volume) => set({ volume: Math.min(1, Math.max(0, volume)), muted: false }),
  setMuted: (muted) => set({ muted }),
  setLoop: (loop) => set({ loop }),
  setPreviewSpeed: (previewSpeed) => set({ previewSpeed }),
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
