import { listen } from "@tauri-apps/api/event";
import { newProjectFlow, openProjectFlow, saveFlow } from "@/project/fileActions";

const ACTIONS: Record<string, () => unknown> = {
  "new-project": () => newProjectFlow(),
  "open-project": () => openProjectFlow(),
  "save-project": () => saveFlow(false),
  "save-project-as": () => saveFlow(true),
};

/** Native menu bar (File > New Project, Open Project, Save, Save As) -> the same flows as the in-app menu. */
export async function onMenuAction(): Promise<() => void> {
  return listen<string>("menu-action", (e) => void ACTIONS[e.payload]?.());
}
