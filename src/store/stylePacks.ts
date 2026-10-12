/** Style packs dialog state: which side is open, and the pack being previewed for import. */
import { create } from "zustand";
import {
  conflictOf,
  importItems,
  openPack,
  readDroppedPack,
  type Choice,
  type Pack,
} from "@/timeline/stylePack";
import { useUiStore } from "./ui";

interface StylePackState {
  open: boolean;
  tab: "export" | "import";
  /** The pack read from a file, waiting for the user to choose what to take. */
  pack: Pack | null;
  /** Item keys that are ticked. */
  ticked: string[];
  /** What to do with a clashing item, by item key ("keep" when absent). */
  choices: Record<string, Choice>;
  problem: string | null;
  openDialog: (tab?: "export" | "import") => void;
  hide: () => void;
  setTab: (tab: "export" | "import") => void;
  /** Pick a pack file (native dialog) and show its preview. */
  choosePack: () => Promise<void>;
  /** A pack file was dropped on the window. */
  openDropped: (id: number) => Promise<void>;
  toggle: (key: string) => void;
  setAll: (on: boolean) => void;
  choose: (key: string, choice: Choice) => void;
  /** Take the ticked items into My styles / My presets / My export presets. */
  importTicked: () => void;
  forgetPack: () => void;
}

const message = (e: unknown) => (e instanceof Error ? e.message : typeof e === "string" ? e : "Failed");

export const useStylePackStore = create<StylePackState>((set, get) => {
  const show = (pack: Pack) =>
    set({
      open: true,
      tab: "import",
      pack,
      ticked: pack.items.map((i) => i.key),
      choices: {},
      problem: pack.items.length === 0 ? "This pack has nothing in it that CutVii can use." : null,
    });
  return {
    open: false,
    tab: "export",
    pack: null,
    ticked: [],
    choices: {},
    problem: null,
    openDialog: (tab) => set((s) => ({ open: true, tab: tab ?? s.tab, problem: null })),
    hide: () => set({ open: false }),
    setTab: (tab) => set({ tab, problem: null }),
    choosePack: async () => {
      set({ problem: null });
      try {
        const pack = await openPack();
        if (pack) show(pack);
      } catch (e) {
        set({ problem: message(e) });
      }
    },
    openDropped: async (id) => {
      try {
        show(await readDroppedPack(id));
      } catch (e) {
        set({ open: true, tab: "import", pack: null, problem: message(e) });
      }
    },
    toggle: (key) =>
      set((s) => ({
        ticked: s.ticked.includes(key) ? s.ticked.filter((k) => k !== key) : [...s.ticked, key],
      })),
    setAll: (on) => set((s) => ({ ticked: on && s.pack ? s.pack.items.map((i) => i.key) : [] })),
    choose: (key, choice) => set((s) => ({ choices: { ...s.choices, [key]: choice } })),
    importTicked: () => {
      const { pack, ticked, choices } = get();
      if (!pack) return;
      const items = pack.items.filter((i) => ticked.includes(i.key));
      if (items.length === 0) return set({ problem: "Tick at least one item to import." });
      // "replace" only means something for a clash with one of the user's own
      const safe: Record<string, Choice> = {};
      for (const item of items) {
        const choice = choices[item.key] ?? "keep";
        safe[item.key] = choice === "replace" && conflictOf(item) !== "own" ? "keep" : choice;
      }
      const { added, replaced, skipped } = importItems(items, safe);
      set({ open: false, pack: null, ticked: [], choices: {}, problem: null });
      const parts = [
        added.length > 0 ? `Added ${added.join(", ")}.` : "",
        replaced.length > 0 ? `Replaced ${replaced.join(", ")}.` : "",
        skipped.length > 0 ? `Skipped ${skipped.join(", ")}.` : "",
      ].filter(Boolean);
      useUiStore.getState().setNotice(`Style pack “${pack.name}”: ${parts.join(" ") || "nothing to do."}`);
    },
    forgetPack: () => set({ pack: null, ticked: [], choices: {}, problem: null }),
  };
});
