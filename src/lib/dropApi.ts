import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ImportedMedia } from "@/lib/media";

/** A file the user dropped. The path stays in Rust; the webview only holds this id. */
export interface DroppedFile {
  id: number;
  name: string;
}

export interface FilesDropped {
  files: DroppedFile[];
  /** Logical (CSS) px relative to the window; used by timeline drops. */
  x: number;
  y: number;
}

export async function importDroppedFile(id: number): Promise<ImportedMedia> {
  try {
    return await invoke<ImportedMedia>("import_dropped_file", { id });
  } catch (e) {
    throw new Error(typeof e === "string" ? e : e instanceof Error ? e.message : "Import failed", {
      cause: e,
    });
  }
}

/** Subscribe to OS drops and drag-hover. Returns the unsubscribe function. */
export async function onFileDrop(handlers: {
  onDrop: (drop: FilesDropped) => void;
  onHover: (active: boolean) => void;
  /** Pointer position while files hover over the window (logical px). */
  onOver?: (pos: { x: number; y: number }) => void;
}): Promise<() => void> {
  const offs = await Promise.all([
    listen<FilesDropped>("files-dropped", (e) => handlers.onDrop(e.payload)),
    listen<{ active: boolean }>("file-drop-hover", (e) => handlers.onHover(e.payload.active)),
    listen<{ x: number; y: number }>("file-drop-over", (e) => handlers.onOver?.(e.payload)),
  ]);
  return () => offs.forEach((off) => off());
}
