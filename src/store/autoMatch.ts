import { create } from "zustand";

/** The Auto-match dialog: the library media chosen when it was opened (in the order picked), `null` when closed. */
export const useAutoMatch = create<{
  assetIds: string[] | null;
  open: (assetIds: string[]) => void;
  close: () => void;
}>((set) => ({
  assetIds: null,
  open: (assetIds) => set({ assetIds }),
  close: () => set({ assetIds: null }),
}));
