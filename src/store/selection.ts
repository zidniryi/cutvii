import { create } from "zustand";

/** Which part of the editor the keyboard acts on (Select all, Delete): where the pointer last went down. */
export type SelectionArea = "timeline" | "library";

interface SelectionState {
  selectedClipIds: string[];
  /** Replace the selection, or toggle `id` in it when `additive`. */
  select: (id: string, additive?: boolean) => void;
  setSelection: (ids: string[]) => void;
  clear: () => void;

  area: SelectionArea;
  setArea: (area: SelectionArea) => void;
  /** Media selected in the library (asset ids), for removing several at once. */
  selectedAssetIds: string[];
  /** The media a Shift-click extends from. */
  assetAnchor: string | null;
  /** The media as the library lists them now (after its search), top to bottom. */
  libraryOrder: string[];
  setLibraryOrder: (ids: string[]) => void;
  /**
   * Click a media card: `replace` selects just it, `toggle` adds or removes it (Ctrl/Cmd-click), `range`
   * selects everything from the anchor to it (Shift-click).
   */
  selectAsset: (id: string, mode: "replace" | "toggle" | "range") => void;
  setAssetSelection: (ids: string[]) => void;
}

export const useSelectionStore = create<SelectionState>((set) => ({
  selectedClipIds: [],
  select: (id, additive = false) =>
    set((s) => ({
      selectedClipIds: !additive
        ? [id]
        : s.selectedClipIds.includes(id)
          ? s.selectedClipIds.filter((x) => x !== id)
          : [...s.selectedClipIds, id],
    })),
  setSelection: (ids) => set({ selectedClipIds: ids }),
  clear: () => set({ selectedClipIds: [] }),

  area: "timeline",
  setArea: (area) => set({ area }),
  selectedAssetIds: [],
  assetAnchor: null,
  libraryOrder: [],
  setLibraryOrder: (ids) =>
    set((s) => ({
      libraryOrder: ids,
      // media that is gone (removed, or undone away) cannot stay selected
      selectedAssetIds: s.selectedAssetIds.filter((id) => ids.includes(id)),
      assetAnchor: s.assetAnchor && ids.includes(s.assetAnchor) ? s.assetAnchor : null,
    })),
  selectAsset: (id, mode) =>
    set((s) => {
      if (mode === "toggle") {
        const selected = s.selectedAssetIds.includes(id)
          ? s.selectedAssetIds.filter((x) => x !== id)
          : [...s.selectedAssetIds, id];
        return { selectedAssetIds: selected, assetAnchor: id, area: "library" };
      }
      const from = s.assetAnchor ? s.libraryOrder.indexOf(s.assetAnchor) : -1;
      const to = s.libraryOrder.indexOf(id);
      if (mode === "range" && from >= 0 && to >= 0) {
        const range = s.libraryOrder.slice(Math.min(from, to), Math.max(from, to) + 1);
        return { selectedAssetIds: range, area: "library" }; // the anchor stays, so the range can be changed
      }
      return { selectedAssetIds: [id], assetAnchor: id, area: "library" };
    }),
  setAssetSelection: (ids) => set({ selectedAssetIds: ids, assetAnchor: ids[0] ?? null }),
}));
