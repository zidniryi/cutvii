/** File menu flows: new / open / save / relink. UI-agnostic; dialogs go through `lib/dialog`. */
import { confirmDialog, messageDialog } from "@/lib/dialog";
import { fileName } from "@/lib/media";
import { forgetProjectPath, openProjectFile, pickReplacementMedia, saveProjectFile } from "@/lib/projectFile";
import { parseProject } from "@/project/parse";
import { relinkAsset } from "@/project/relink";
import { usePlaybackStore } from "@/store/playback";
import { selectIsDirty, useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useUiStore } from "@/store/ui";
import type { Canvas } from "@/project/canvas";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function resetSession() {
  useSelectionStore.getState().clear();
  usePlaybackStore.setState({ playhead: 0, playing: false, mediaErrors: {} });
}

async function okToDiscard(action: string): Promise<boolean> {
  if (!selectIsDirty(useProjectStore.getState())) return true;
  return confirmDialog({
    title: "Discard unsaved changes?",
    lines: [`You have changes that have not been saved. ${action} will lose them.`],
    confirmLabel: "Discard changes",
  });
}

/** File > New project: confirm discarding changes, then show the canvas picker. */
export async function newProjectFlow(): Promise<void> {
  if (!(await okToDiscard("Starting a new project"))) return;
  useUiStore.getState().setNewProjectOpen(true);
}

/** Called by the New Project dialog once a canvas is chosen. */
export async function createProjectWithCanvas(canvas: Canvas, pending: boolean): Promise<void> {
  try {
    await forgetProjectPath();
  } catch {
    /* a stale path only matters for plain Save, which asks again for new projects */
  }
  useProjectStore.getState().newProject(undefined, {
    width: canvas.width,
    height: canvas.height,
    fps: canvas.fps,
    fpsNum: canvas.fpsNum,
    fpsDen: canvas.fpsDen,
    canvasPending: pending ? true : undefined,
  });
  resetSession();
  useUiStore.getState().setCanvasNotice(null);
  useUiStore.getState().setNewProjectOpen(false);
}

export async function openProjectFlow(): Promise<void> {
  if (!(await okToDiscard("Opening another project"))) return;
  try {
    const opened = await openProjectFile();
    if (!opened) return;

    const parsed = parseProject(opened.project);
    if (!parsed.ok) {
      await messageDialog("This project can't be opened", parsed.errors.slice(0, 8));
      return;
    }
    useProjectStore.getState().loadProject(parsed.project, opened.path, opened.missingPaths);
    resetSession();

    if (opened.missingPaths.length > 0) {
      await messageDialog("Some media files are missing", [
        ...opened.missingPaths.slice(0, 6).map((p) => fileName(p)),
        ...(opened.missingPaths.length > 6 ? [`…and ${opened.missingPaths.length - 6} more`] : []),
        "Use Relink in the Media panel to point them at the new location. Editing still works.",
      ]);
    }
  } catch (e) {
    await messageDialog("This project can't be opened", [errorText(e)]);
  }
}

let saveInFlight: Promise<boolean> | null = null;

/**
 * Returns true when the project was written; false on cancel or error (an error shows a dialog).
 * Only one save runs at a time: a second request while one is in flight (for example the same key press
 * arriving from both the native menu and the webview) joins the first instead of saving twice.
 */
export function saveFlow(saveAs = false): Promise<boolean> {
  if (saveInFlight) return saveInFlight;
  saveInFlight = runSave(saveAs).finally(() => {
    saveInFlight = null;
    useUiStore.getState().setSaving(false);
  });
  return saveInFlight;
}

async function runSave(saveAs: boolean): Promise<boolean> {
  // Capture the exact object being saved: edits made while the dialog is open must stay "unsaved".
  const snapshot = useProjectStore.getState().project;
  useUiStore.getState().setSaving(true);
  try {
    const path = await saveProjectFile(snapshot, saveAs);
    if (!path) return false;
    useProjectStore.getState().markSaved(snapshot, path);
    return true;
  } catch (e) {
    await messageDialog("Could not save the project", [errorText(e), "Your project is unchanged on disk."]);
    return false;
  }
}

export async function relinkFlow(assetId: string): Promise<void> {
  try {
    const media = await pickReplacementMedia();
    if (!media) return;

    const result = relinkAsset(useProjectStore.getState().project, assetId, media);
    if (!result.ok) {
      await messageDialog("Can't use that file", [result.reason]);
      return;
    }
    useProjectStore
      .getState()
      .execute({ label: "Relink media", apply: () => ({ ok: true, project: result.project }) });
  } catch (e) {
    await messageDialog("Could not relink the media", [errorText(e)]);
  }
}
