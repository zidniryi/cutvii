import { create } from "zustand";
import { createProject } from "@/project/factory";
import type { MediaAsset, Project, ProjectSettings } from "@/project/model";
import { addAsset, removeAsset, type AddAssetResult } from "@/project/ops";
import type { EditResult } from "@/timeline/edit";

/** Command pattern: a labelled, pure transformation of the project. */
export interface Command {
  label: string;
  apply: (project: Project) => EditResult;
}

/** `project` is the state to restore: before the command (past) or after it (future). Never media data. */
interface HistoryEntry {
  label: string;
  project: Project;
}

export const HISTORY_LIMIT = 200;

interface ProjectState {
  project: Project;
  /** The project object as last saved/loaded. `project !== saved` means unsaved changes (undo back = clean). */
  saved: Project;
  /** Path of the project file, or null for a project that was never saved. */
  filePath: string | null;
  /** Asset paths that were not found on disk when the project was opened. */
  missingPaths: string[];
  past: HistoryEntry[];
  future: HistoryEntry[];
  newProject: (name?: string, settings?: Partial<ProjectSettings>) => void;
  /** Replace the whole session with a project read from disk. */
  loadProject: (project: Project, filePath: string, missingPaths: string[]) => void;
  /** Record that exactly `project` (captured before saving) is now on disk at `filePath`. */
  markSaved: (project: Project, filePath: string) => void;
  /** Runs a command; on success records it for undo. A no-op result (same project) is not recorded. */
  execute: (command: Command) => EditResult;
  undo: () => void;
  redo: () => void;
  addAsset: (asset: MediaAsset) => AddAssetResult;
  removeAsset: (assetId: string) => void;
}

const initialProject = createProject();

export const useProjectStore = create<ProjectState>((set, get) => ({
  project: initialProject,
  saved: initialProject,
  filePath: null,
  missingPaths: [],
  past: [],
  future: [],

  newProject: (name, settings) => {
    const project = createProject(name, settings);
    set({ project, saved: project, filePath: null, missingPaths: [], past: [], future: [] });
  },

  loadProject: (project, filePath, missingPaths) =>
    set({ project, saved: project, filePath, missingPaths, past: [], future: [] }),

  markSaved: (project, filePath) => set({ saved: project, filePath }),

  execute: (command) => {
    const { project, past } = get();
    const result = command.apply(project);
    if (result.ok && result.project !== project) {
      set({
        project: { ...result.project, modifiedAt: new Date().toISOString() },
        past: [...past, { label: command.label, project }].slice(-HISTORY_LIMIT),
        future: [],
      });
    }
    return result;
  },

  undo: () => {
    const { project, past, future } = get();
    const entry = past[past.length - 1];
    if (!entry) return;
    set({
      project: entry.project,
      past: past.slice(0, -1),
      future: [...future, { label: entry.label, project }],
    });
  },

  redo: () => {
    const { project, past, future } = get();
    const entry = future[future.length - 1];
    if (!entry) return;
    set({
      project: entry.project,
      past: [...past, { label: entry.label, project }],
      future: future.slice(0, -1),
    });
  },

  addAsset: (asset) => {
    const result = addAsset(get().project, asset);
    if (result.ok)
      get().execute({ label: "Import media", apply: () => ({ ok: true, project: result.project }) });
    return result;
  },

  removeAsset: (assetId) =>
    void get().execute({
      label: "Remove media",
      apply: (p) => ({ ok: true, project: removeAsset(p, assetId) }),
    }),
}));

export const selectIsDirty = (s: ProjectState) => s.project !== s.saved;
export const selectCanUndo = (s: ProjectState) => s.past.length > 0;
export const selectCanRedo = (s: ProjectState) => s.future.length > 0;
