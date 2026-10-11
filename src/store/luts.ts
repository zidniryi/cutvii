import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { colorKey, parseLut, type ColorAdjust, type Lut } from "@/timeline/color";

export type LutEntry = { status: "loading" } | { status: "ready"; lut: Lut } | { status: "failed" };

/** Tables kept in memory; older ones are dropped (a slider drag makes many). */
const KEEP = 24;

interface LutState {
  /** Keyed by `colorKey`. Baked and cached on disk by Rust; loaded through the asset protocol. */
  entries: Record<string, LutEntry>;
  order: string[];
  /** The last table each holder (a clip) was given: shown while its next one is still being made. */
  held: Record<string, Lut>;
  /** Ask for the table of a setting once. Safe to call on every render. `holder` remembers it as its latest. */
  ensure: (adjust: ColorAdjust, holder?: string) => void;
}

async function load(adjust: ColorAdjust): Promise<Lut> {
  const file = await invoke<string>("bake_color_lut", { adjust });
  if (typeof file !== "string") throw new Error("no colour table");
  const response = await fetch(convertFileSrc(file));
  if (!response.ok) throw new Error(`colour table request failed: ${response.status}`);
  return parseLut(await response.arrayBuffer());
}

export const useLutStore = create<LutState>((set, get) => ({
  entries: {},
  order: [],
  held: {},
  ensure: (adjust, holder) => {
    const key = colorKey(adjust);
    const known = get().entries[key];
    if (known) {
      if (holder && known.status === "ready" && get().held[holder] !== known.lut) {
        set((s) => ({ held: { ...s.held, [holder]: known.lut } }));
      }
      return;
    }
    const put = (entry: LutEntry) =>
      set((s) => {
        const order = [...s.order.filter((k) => k !== key), key];
        const entries = { ...s.entries, [key]: entry };
        for (const old of order.splice(0, Math.max(0, order.length - KEEP))) delete entries[old];
        return { entries, order };
      });
    put({ status: "loading" });
    load(adjust).then(
      (lut) => {
        put({ status: "ready", lut });
        if (holder) set((s) => ({ held: { ...s.held, [holder]: lut } }));
      },
      () => put({ status: "failed" }),
    );
  },
}));
