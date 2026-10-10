import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

interface ImagePreviewState {
  /** Original image path -> downscaled cached copy (made by Rust; the original is only read). */
  previews: Record<string, string>;
  requested: Record<string, true>;
  /** Ask for a preview copy once per path. Safe to call on every render. */
  ensure: (path: string) => void;
}

export const useImagePreviewStore = create<ImagePreviewState>((set, get) => ({
  previews: {},
  requested: {},
  ensure: (path) => {
    if (get().requested[path]) return;
    set((s) => ({ requested: { ...s.requested, [path]: true } }));
    Promise.resolve(invoke<string>("prepare_image_preview", { path })).then(
      (preview) => {
        if (typeof preview === "string") set((s) => ({ previews: { ...s.previews, [path]: preview } }));
      },
      () => {
        /* no preview copy: the thumbnail (or plain black) is shown instead */
      },
    );
  },
}));
