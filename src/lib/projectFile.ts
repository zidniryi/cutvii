import { invoke } from "@tauri-apps/api/core";
import type { ImportedMedia } from "@/lib/media";

export interface OpenedProjectFile {
  path: string;
  /** Already migrated and validated by Rust; the frontend validates again with Zod. */
  project: unknown;
  missingPaths: string[];
}

const message = (e: unknown) =>
  typeof e === "string" ? e : e instanceof Error ? e.message : "Unknown error";

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw new Error(message(e), { cause: e });
  }
}

/** Native open dialog + read. null when cancelled. */
export const openProjectFile = () => call<OpenedProjectFile | null>("open_project");
/** Open the project at a position of File > Open Recent; Rust resolves the path from its own list. */
export const openRecentProjectFile = (index: number) =>
  call<OpenedProjectFile>("open_recent_project", { index });

/** Write the project to its file (or ask for one). Returns the path, or null when cancelled. */
export const saveProjectFile = (project: unknown, saveAs: boolean) =>
  call<string | null>("save_project", { project, saveAs });

export const forgetProjectPath = () => call<void>("forget_project_path");

/** Native picker for a replacement media file. null when cancelled. */
export const pickReplacementMedia = () => call<ImportedMedia | null>("relink_media");
