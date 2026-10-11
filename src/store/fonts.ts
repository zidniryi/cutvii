import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

export interface FontInfo {
  family: string;
  /** Comes with CutVii (as opposed to imported on this machine). */
  bundled: boolean;
  /** Picture of the family name drawn in the font (made and cached by Rust), for the font picker. */
  preview?: string;
}

/** The font of a text that names none. Same as in Rust (`media/text.rs`). */
export const DEFAULT_FONT = "Noto Sans";

interface FontState {
  /** Fonts text can be drawn in. Until Rust has answered, just the default. */
  fonts: FontInfo[];
  loaded: boolean;
  /** Ask Rust for the list once. Safe to call on every render. */
  ensure: () => void;
  /**
   * Native "Import font" dialog (in Rust): the chosen files are copied into the app data folder.
   * Resolves with the imported family names (empty when cancelled); rejects with a readable message.
   */
  importFont: () => Promise<string[]>;
}

const message = (e: unknown) =>
  typeof e === "string" ? e : e instanceof Error ? e.message : "unknown error";

export const useFontStore = create<FontState>((set, get) => {
  const refresh = async () => {
    const fonts = await invoke<FontInfo[]>("text_fonts");
    if (Array.isArray(fonts) && fonts.length > 0) set({ fonts });
  };
  return {
    fonts: [{ family: DEFAULT_FONT, bundled: true }],
    loaded: false,
    ensure: () => {
      if (get().loaded) return;
      set({ loaded: true });
      refresh().catch(() => set({ loaded: false })); // try again next time the list is needed
    },
    importFont: async () => {
      try {
        const families = await invoke<string[]>("import_text_font");
        if (!Array.isArray(families) || families.length === 0) return [];
        await refresh();
        return families;
      } catch (e) {
        throw new Error(message(e), { cause: e });
      }
    },
  };
});
