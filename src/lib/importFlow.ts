import { fileName, importMedia, type ImportedMedia } from "@/lib/media";
import { canvasFromAsset, canvasLabel, withCanvas } from "@/project/canvas";
import { MediaAssetSchema, type MediaAsset } from "@/project/model";
import { useUiStore } from "@/store/ui";
import { useProjectStore } from "@/store/project";

export interface ImportSummary {
  added: number;
  duplicates: string[];
  failed: { name: string; error: string }[];
  cancelled: boolean;
}

export type CommitResult =
  | { status: "added"; asset: MediaAsset }
  | { status: "duplicate"; existing: MediaAsset }
  | { status: "invalid" };

/** Validate what the media engine reported and add it to the project (the duplicate guard lives here). */
export function commitImportedMedia(m: ImportedMedia): CommitResult {
  const parsed = MediaAssetSchema.safeParse({
    id: crypto.randomUUID(),
    path: m.path,
    type: m.mediaType,
    duration: m.duration,
    width: m.width,
    height: m.height,
    thumbnailPath: m.thumbnailPath,
    fpsNum: m.fpsNum,
    fpsDen: m.fpsDen,
    alpha: m.alpha || undefined,
  });
  if (!parsed.success) return { status: "invalid" };
  const result = useProjectStore.getState().addAsset(parsed.data);
  return result.ok
    ? { status: "added", asset: parsed.data }
    : { status: "duplicate", existing: result.existing };
}

/** Pick files, probe them in Rust, and add them to the current project (skipping duplicates). */
export async function importIntoProject(): Promise<ImportSummary> {
  const report = await importMedia();
  let firstAdded: MediaAsset | undefined;
  const summary: ImportSummary = {
    added: 0,
    duplicates: [],
    failed: report.failed.map((f) => ({ name: fileName(f.path), error: f.error })),
    cancelled: report.imported.length === 0 && report.failed.length === 0,
  };

  for (const m of report.imported) {
    const r = commitImportedMedia(m);
    if (r.status === "added") {
      summary.added += 1;
      firstAdded ??= r.asset;
    } else if (r.status === "duplicate") summary.duplicates.push(fileName(m.path));
    else summary.failed.push({ name: fileName(m.path), error: "unexpected metadata from media engine" });
  }

  // once per batch, after all assets are in, so the canvas notice's Undo stays valid
  if (firstAdded) applyPendingCanvas(firstAdded);
  return summary;
}

/**
 * "Original" canvas waiting for media: the project's very first media decides it.
 * A no-op unless the project is still pending and `asset` really is its first asset.
 * Applied as its own undoable step, with a notice offering Undo.
 */
export function applyPendingCanvas(asset: MediaAsset) {
  const project = useProjectStore.getState().project;
  if (project.settings.canvasPending !== true || project.assets[0]?.id !== asset.id) return;

  const original = canvasFromAsset(asset);
  useProjectStore.getState().execute({
    label: original.fallback ? "Set default canvas" : "Set canvas from first video",
    apply: (p) => ({ ok: true, project: withCanvas(p, original.canvas, false) }),
  });

  const label = canvasLabel(original.canvas);
  const message = original.fallback
    ? `${original.notes[0]}, so the canvas is ${label}. Change it from the canvas menu.`
    : `Canvas set to ${label} from your first video${original.notes.length ? ` (${original.notes.join("; ")})` : ""}.`;
  useUiStore.getState().setCanvasNotice({ message, pastLength: useProjectStore.getState().past.length });
}
