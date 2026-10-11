import { listen } from "@tauri-apps/api/event";
import { newProjectFlow, openProjectFlow, openRecentFlow, saveFlow } from "@/project/fileActions";
import { useUiStore } from "@/store/ui";

const ACTIONS: Record<string, () => unknown> = {
  "new-project": () => newProjectFlow(),
  "open-project": () => openProjectFlow(),
  "save-project": () => saveFlow(false),
  "save-project-as": () => saveFlow(true),
  about: () => useUiStore.getState().setAboutOpen(true),
};

/** Native menu bar (File > New Project, Open Project, Save, Save As) -> the same flows as the in-app menu. */
export async function onMenuAction(): Promise<() => void> {
  return listen<string>("menu-action", (e) => {
    const recent = /^recent-(\d+)$/.exec(e.payload);
    if (recent) void openRecentFlow(Number(recent[1]));
    else void ACTIONS[e.payload]?.();
  });
}
