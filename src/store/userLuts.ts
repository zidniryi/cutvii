/**
 * The LUTs (`.cube` files) the user imported. Rust checks every file as untrusted input and keeps CutVii's
 * own copy in the app data folder (`src-tauri/src/media/cube.rs`); here is only the list.
 */
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

export interface UserLut {
  /** Hash of the table: what a clip refers to. */
  id: string;
  name: string;
  /** Points per side. */
  size: number;
}

export interface LutImportSummary {
  added: UserLut[];
  problems: { file: string; message: string }[];
}

interface UserLutState {
  /** null until the list has been read once. */
  luts: UserLut[] | null;
  /** Read the list once. Safe to call on every render. */
  ensure: () => void;
  refresh: () => Promise<void>;
  /** Native "Import LUT" dialog (in Rust). Empty when cancelled; rejects with a readable message. */
  importFiles: () => Promise<LutImportSummary>;
  /** Forget an imported LUT (CutVii's copy; the user's file is never touched). */
  remove: (id: string) => Promise<void>;
}

const message = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : "Failed");
const isLut = (v: unknown): v is UserLut => {
  const o = v as Partial<UserLut> | null;
  return typeof o?.id === "string" && typeof o.name === "string" && typeof o.size === "number";
};

let asked = false;

export const useUserLutStore = create<UserLutState>((set, get) => ({
  luts: null,
  ensure: () => {
    if (asked) return;
    asked = true;
    get()
      .refresh()
      .catch(() => {
        asked = false; // try again next time the list is needed
      });
  },
  refresh: async () => {
    const list = await invoke<unknown>("color_luts");
    set({ luts: Array.isArray(list) ? list.filter(isLut) : [] });
  },
  importFiles: async () => {
    let raw: { luts?: unknown; problems?: unknown } | null;
    try {
      raw = await invoke("import_color_luts");
    } catch (e) {
      throw new Error(message(e), { cause: e });
    }
    const added = Array.isArray(raw?.luts) ? raw.luts.filter(isLut) : [];
    const problems = Array.isArray(raw?.problems)
      ? raw.problems.flatMap((p) =>
          Array.isArray(p) && typeof p[0] === "string" && typeof p[1] === "string"
            ? [{ file: p[0], message: p[1].replace(/^invalid input: /, "") }]
            : [],
        )
      : [];
    if (added.length > 0) await get().refresh();
    return { added, problems };
  },
  remove: async (id) => {
    try {
      await invoke("delete_color_lut", { id });
    } catch (e) {
      throw new Error(message(e), { cause: e });
    }
    await get().refresh();
  },
}));

/** For tests: forget the list and that it was asked for. */
export function resetUserLuts() {
  asked = false;
  useUserLutStore.setState({ luts: null });
}
