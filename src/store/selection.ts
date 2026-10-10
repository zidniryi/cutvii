import { create } from "zustand";

interface SelectionState {
  selectedClipIds: string[];
  /** Replace the selection, or toggle `id` in it when `additive`. */
  select: (id: string, additive?: boolean) => void;
  setSelection: (ids: string[]) => void;
  clear: () => void;
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
}));
