import { create } from "zustand";

export type SidePanel = "library" | "inspector";
export type InspectorTab = "video" | "audio" | "speed" | "info" | "text" | "ai";
export type ClipKind = "video" | "audio" | "image";

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
  /** Last inspector tab the user chose, per kind of clip (UI state only). */
  inspectorTab: Partial<Record<ClipKind, InspectorTab>>;
  setInspectorTab: (kind: ClipKind, tab: InspectorTab) => void;
  /** Ask the inspector to move keyboard focus to a tab and show it from the top. `n` makes each ask unique. */
  inspectorFocus: { tab: InspectorTab; n: number } | null;
  focusInspectorTab: (tab: InspectorTab) => void;
  /** The clip whose crop box is being adjusted in the preview, if any. */
  cropEdit: { clipId: string } | null;
  setCropEdit: (cropEdit: { clipId: string } | null) => void;
  /** Aspect preset chosen for a clip's crop: the crop box keeps this width / height while it is resized. */
  cropLock: { clipId: string; ratio: number } | null;
  setCropLock: (cropLock: { clipId: string; ratio: number } | null) => void;
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
  inspectorTab: {},
  setInspectorTab: (kind, tab) => set((s) => ({ inspectorTab: { ...s.inspectorTab, [kind]: tab } })),
  inspectorFocus: null,
  focusInspectorTab: (tab) => set((s) => ({ inspectorFocus: { tab, n: (s.inspectorFocus?.n ?? 0) + 1 } })),
  cropEdit: null,
  setCropEdit: (cropEdit) => set({ cropEdit }),
  cropLock: null,
  setCropLock: (cropLock) => set({ cropLock }),
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
