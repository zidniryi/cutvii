import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { ColorAdjust } from "@/project/model";
import { colorKey } from "@/timeline/color";

/** Gallery pictures of one frame of a file through each look. Made and cached by Rust; never saved. */
interface LookPreviewState {
  /** Picture path by `previewKey`. */
  pictures: Record<string, string>;
  asked: Record<string, true>;
  /** Ask for the pictures of a frame through `looks` once. Safe to call on every render. */
  ensure: (path: string, at: number, looks: ColorAdjust[]) => void;
}

export const lookPreviewKey = (path: string, at: number, look: ColorAdjust) =>
  `${path}|${at.toFixed(3)}|${colorKey(look)}`;

export const useLookPreviewStore = create<LookPreviewState>((set, get) => ({
  pictures: {},
  asked: {},
  ensure: (path, at, looks) => {
    const missing = looks.filter((l) => !get().asked[lookPreviewKey(path, at, l)]);
    if (missing.length === 0) return;
    set((s) => ({
      asked: {
        ...s.asked,
        ...Object.fromEntries(missing.map((l) => [lookPreviewKey(path, at, l), true as const])),
      },
    }));
    Promise.resolve(invoke<string[]>("look_previews", { path, at, looks: missing })).then(
      (files) => {
        if (!Array.isArray(files) || files.length !== missing.length) return;
        set((s) => ({
          pictures: {
            ...s.pictures,
            ...Object.fromEntries(missing.map((l, i) => [lookPreviewKey(path, at, l), files[i]])),
          },
        }));
      },
      () => undefined, // no picture: the card shows the name only
    );
  },
}));
