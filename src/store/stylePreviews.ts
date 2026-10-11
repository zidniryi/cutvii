import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { TextStyle } from "@/project/model";

/** Identity of a sample picture: the style and the name written in it. */
export const previewKey = (style: TextStyle, label: string) => JSON.stringify([label, style]);

interface StylePreviewState {
  /** `previewKey` -> the sample picture Rust drew for it (cached on disk by Rust). */
  previews: Record<string, string>;
  asked: Record<string, true>;
  /** Ask Rust for a style's sample picture once. Safe to call on every render. */
  ensure: (style: TextStyle, label: string) => void;
}

/**
 * The ONE preview renderer for text styles: Rust draws the sample with the same rasterizer that draws the
 * text in the preview and the export, so a style looks in every list exactly as it will on the video.
 */
export const useStylePreviewStore = create<StylePreviewState>((set, get) => ({
  previews: {},
  asked: {},
  ensure: (style, label) => {
    const key = previewKey(style, label);
    if (get().asked[key]) return;
    set((s) => ({ asked: { ...s.asked, [key]: true } }));
    Promise.resolve(invoke<string>("text_style_preview", { style, label })).then(
      (path) => {
        if (typeof path === "string") set((s) => ({ previews: { ...s.previews, [key]: path } }));
      },
      () => {
        /* no picture: the card shows "Aa" instead */
      },
    );
  },
}));
