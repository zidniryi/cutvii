import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { MediaAsset, MediaType } from "@/project/model";

/** Shape returned by the Rust `import_media` command (optional fields are omitted, never null). */
export interface ImportedMedia {
  path: string;
  mediaType: MediaType;
  duration?: number;
  width?: number;
  height?: number;
  thumbnailPath?: string;
  /** Exact frame rate of a video, e.g. 30000 / 1001. */
  fpsNum?: number;
  fpsDen?: number;
  /** A still whose pixels were found to be partly see-through. */
  alpha?: boolean;
}

export interface ImportReport {
  imported: ImportedMedia[];
  failed: { path: string; error: string }[];
}

/** Opens the native picker in Rust and imports the chosen files. Rejects with a readable message. */
export async function importMedia(): Promise<ImportReport> {
  try {
    return await invoke<ImportReport>("import_media");
  } catch (e) {
    throw new Error(typeof e === "string" ? e : e instanceof Error ? e.message : "Import failed", {
      cause: e,
    });
  }
}

export function thumbnailUrl(path: string): string {
  return convertFileSrc(path);
}

/** Linux only: the local media server's base URL (WebKitGTK cannot play video from `asset:`). */
let mediaServer: string | null = null;

/** Asks Rust once, before the app renders, whether media should come from the local media server. */
export async function initMediaUrls(): Promise<void> {
  try {
    mediaServer = (await invoke<string | null>("media_server_url")) ?? null;
  } catch {
    mediaServer = null;
  }
}

/** URL the webview can load for an imported file (the file must be in the asset-protocol scope). */
export function mediaUrl(path: string): string {
  return mediaServer ? `${mediaServer}/${encodeURIComponent(path)}` : convertFileSrc(path);
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** What to call an asset in the UI: the file name, or the first line of a text picture's text. */
export function assetName(asset: Pick<MediaAsset, "path" | "text">): string {
  return asset.text ? asset.text.content.trim().split("\n")[0] : fileName(asset.path);
}
