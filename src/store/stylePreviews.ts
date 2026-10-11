import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

interface StylePreviewState {
  /** Preset id -> a small picture of sample text in that style (drawn and cached by Rust). */
  previews: Record<string, string>;
  loaded: boolean;
  /** Ask Rust for the pictures once. Safe to call on every render. */
  ensure: () => void;
}

export const useStylePreviewStore = create<StylePreviewState>((set, get) => ({
  previews: {},
  loaded: false,
  ensure: () => {
    if (get().loaded) return;
    set({ loaded: true });
    Promise.resolve(invoke<{ id: string; preview: string }[]>("text_style_previews")).then(
      (list) => {
        if (Array.isArray(list)) set({ previews: Object.fromEntries(list.map((p) => [p.id, p.preview])) });
      },
      () => set({ loaded: false }), // try again the next time the gallery opens
    );
  },
}));
