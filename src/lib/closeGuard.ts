import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirmDialog } from "@/lib/dialog";
import { selectIsDirty, useProjectStore } from "@/store/project";

/**
 * Ask before closing the window with unsaved changes. Returns the unsubscribe function.
 * Outside a Tauri window (browser, tests) this quietly does nothing.
 */
export async function installCloseGuard(): Promise<() => void> {
  try {
    const win = getCurrentWindow();
    return await win.onCloseRequested(async (event) => {
      if (!selectIsDirty(useProjectStore.getState())) return;
      event.preventDefault();
      const quit = await confirmDialog({
        title: "Quit without saving?",
        lines: ["You have unsaved changes. If you quit now they will be lost."],
        confirmLabel: "Quit without saving",
      });
      if (quit) await win.destroy();
    });
  } catch {
    return () => {};
  }
}
