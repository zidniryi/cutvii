import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ExportOptions } from "@/export/options";
import type { Project } from "@/project/model";

export interface ExportReport {
  path: string;
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  sizeBytes: number;
  encoder: string;
}

export const CANCELLED_MESSAGE = "export cancelled";

const message = (e: unknown) =>
  typeof e === "string" ? e : e instanceof Error ? e.message : "Export failed";

/** Plan, ask where to save (native dialog), render. Resolves null if the save dialog was dismissed. */
export async function exportProject(project: Project, options: ExportOptions): Promise<ExportReport | null> {
  try {
    return await invoke<ExportReport | null>("export_project", { project, options });
  } catch (e) {
    throw new Error(message(e), { cause: e });
  }
}

export async function cancelExport(): Promise<void> {
  await invoke("cancel_export");
}

/** Subscribe to 0..1 progress; returns the unsubscribe function. */
export async function onExportProgress(cb: (fraction: number) => void): Promise<() => void> {
  return listen<{ fraction: number }>("export-progress", (e) => cb(e.payload.fraction));
}
