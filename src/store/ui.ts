import { create } from "zustand";
import type { ClipLut, ColorAdjust } from "@/project/model";

export type SidePanel = "library" | "text" | "inspector";
export type InspectorTab = "video" | "audio" | "speed" | "info" | "text" | "ai" | "color" | "transition";
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
  /** The preview (with its transport bar) fills the whole window. */
  previewFull: boolean;
  setPreviewFull: (full: boolean) => void;
  /** What the left panel shows on wide screens: the media, or the text styles. */
  leftPanel: "library" | "text";
  /** Short, transient message about the last edit that did not work (e.g. "would overlap"). */
  notice: string | null;
  /** Something the user can do about the notice, shown as a button in the toast. */
  noticeAction: { label: string; run: () => void } | null;
  setNotice: (notice: string | null, action?: { label: string; run: () => void }) => void;
  newProjectOpen: boolean;
  setNewProjectOpen: (open: boolean) => void;
  /** CutVii's own About window. */
  aboutOpen: boolean;
  setAboutOpen: (open: boolean) => void;
  /** The "Support CutVii" popup. Only a click opens it. */
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  /** Which end of the clip the Transition tab is showing; a transition block on the timeline sets it. */
  transitionWay: "in" | "out";
  setTransitionWay: (way: "in" | "out") => void;
  supportOpen: boolean;
  setSupportOpen: (open: boolean) => void;
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
  /** Colour values being tried while a slider is dragged: the preview shows them, nothing is saved yet. */
  /** `lut` is set while the LUT intensity is being dragged. */
  colorDraft: { clipId: string; adjust: ColorAdjust; lut?: ClipLut } | null;
  setColorDraft: (draft: { clipId: string; adjust: ColorAdjust; lut?: ClipLut } | null) => void;
  /** The clip shown without its colour changes while "Before" is held. */
  colorBefore: string | null;
  /** Colour settings copied from a clip, to paste on another. Kept while the app is open. */
  colorClipboard: ColorAdjust | null;
  setColorClipboard: (color: ColorAdjust | null) => void;
  setColorBefore: (clipId: string | null) => void;
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
  setSidePanel: (sidePanel) =>
    set(sidePanel === "inspector" ? { sidePanel } : { sidePanel, leftPanel: sidePanel }),
  leftPanel: "library",
  previewFull: false,
  setPreviewFull: (previewFull) => set({ previewFull }),
  notice: null,
  noticeAction: null,
  setNotice: (notice, action) => set({ notice, noticeAction: notice && action ? action : null }),
  newProjectOpen: false,
  setNewProjectOpen: (newProjectOpen) => set({ newProjectOpen }),
  aboutOpen: false,
  setAboutOpen: (aboutOpen) => set({ aboutOpen }),
  settingsOpen: false,
  transitionWay: "in",
  setTransitionWay: (transitionWay) => set({ transitionWay }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  supportOpen: false,
  setSupportOpen: (supportOpen) => set({ supportOpen }),
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
  colorDraft: null,
  setColorDraft: (colorDraft) => set({ colorDraft }),
  colorBefore: null,
  colorClipboard: null,
  setColorClipboard: (colorClipboard) => set({ colorClipboard }),
  setColorBefore: (colorBefore) => set({ colorBefore }),
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
