import { create } from "zustand";

export type SidePanel = "library" | "inspector";

export interface DialogState {
  title: string;
  lines: string[];
  confirmLabel: string;
  /** null = message dialog with a single button. */
  cancelLabel: string | null;
  resolve: (confirmed: boolean) => void;
}

interface UiState {
  /** Which side panel is visible on narrow screens (wide screens show both). */
  sidePanel: SidePanel;
  setSidePanel: (panel: SidePanel) => void;
  /** Short, transient message about the last edit that did not work (e.g. "would overlap"). */
  notice: string | null;
  setNotice: (notice: string | null) => void;
  newProjectOpen: boolean;
  setNewProjectOpen: (open: boolean) => void;
  canvasDialogOpen: boolean;
  setCanvasDialogOpen: (open: boolean) => void;
  /** "Canvas set from your first video" banner. Undo is offered while `pastLength` is still the history top. */
  canvasNotice: { message: string; pastLength: number } | null;
  setCanvasNotice: (notice: { message: string; pastLength: number } | null) => void;
  /** A save is being written (drives the status text; also stops a second save from starting). */
  saving: boolean;
  setSaving: (saving: boolean) => void;
  /** In-app modal (we avoid window.confirm: it is blocking and unreliable in webviews). */
  dialog: DialogState | null;
  openDialog: (dialog: DialogState) => void;
  closeDialog: (confirmed: boolean) => void;
}

export const useUiStore = create<UiState>((set, get) => ({
  sidePanel: "library",
  setSidePanel: (sidePanel) => set({ sidePanel }),
  notice: null,
  setNotice: (notice) => set({ notice }),
  newProjectOpen: false,
  setNewProjectOpen: (newProjectOpen) => set({ newProjectOpen }),
  canvasDialogOpen: false,
  setCanvasDialogOpen: (canvasDialogOpen) => set({ canvasDialogOpen }),
  canvasNotice: null,
  setCanvasNotice: (canvasNotice) => set({ canvasNotice }),
  saving: false,
  setSaving: (saving) => set({ saving }),
  dialog: null,
  openDialog: (dialog) => set({ dialog }),
  closeDialog: (confirmed) => {
    const d = get().dialog;
    set({ dialog: null });
    d?.resolve(confirmed);
  },
}));
