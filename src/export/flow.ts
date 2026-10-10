import type { ExportOptions } from "@/export/options";
import { CANCELLED_MESSAGE, cancelExport, exportProject, onExportProgress } from "@/lib/exportApi";
import { useExportStore } from "@/store/export";
import { useProjectStore } from "@/store/project";

/** Run an export and keep the export store in sync (progress, result, error, cancel). */
export async function startExport(options: ExportOptions): Promise<void> {
  const store = useExportStore.getState();
  store.set({ phase: "running", progress: 0, error: null, report: null, cancelling: false });

  let unlisten: (() => void) | undefined;
  try {
    unlisten = await onExportProgress((fraction) => useExportStore.getState().set({ progress: fraction }));
    // the project is snapshotted here; the dialog is modal so it cannot change underneath
    const report = await exportProject(useProjectStore.getState().project, options);
    if (!report) {
      // save dialog dismissed: nothing happened, back to the settings
      useExportStore.getState().set({ phase: "settings", progress: 0 });
      return;
    }
    useExportStore.getState().set({ phase: "done", progress: 1, report });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === CANCELLED_MESSAGE) {
      useExportStore.getState().set({ phase: "settings", progress: 0, cancelling: false });
    } else {
      useExportStore.getState().set({ phase: "error", error: msg, cancelling: false });
    }
  } finally {
    unlisten?.();
  }
}

export async function cancelRunningExport(): Promise<void> {
  useExportStore.getState().set({ cancelling: true });
  try {
    await cancelExport();
  } catch {
    /* if the job already finished there is nothing to cancel */
  }
}
