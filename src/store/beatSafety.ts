import { create } from "zustand";

const KEY = "cutvii.beat-safety.v1";

/** "Reduce flashing" (default on): caps a flash and its rate in the export. Kept on this computer only. */
function read(): boolean {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as { reduceFlashing?: unknown };
    return typeof v.reduceFlashing === "boolean" ? v.reduceFlashing : true;
  } catch {
    return true;
  }
}

export const useBeatSafety = create<{ reduceFlashing: boolean; setReduceFlashing: (on: boolean) => void }>(
  (set) => ({
    reduceFlashing: read(),
    setReduceFlashing: (on) => {
      try {
        localStorage.setItem(KEY, JSON.stringify({ reduceFlashing: on }));
      } catch {
        /* the choice then lasts until the app closes */
      }
      set({ reduceFlashing: on });
    },
  }),
);
