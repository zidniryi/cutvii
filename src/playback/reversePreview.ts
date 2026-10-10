/** Background preparation of reversed preview copies (cached by Rust; originals are only read). */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Project } from "@/project/model";
import { reverseKey, useReverseStore } from "@/store/reverse";

let listening: Promise<unknown> | null = null;

function ensureListening() {
  listening ??= listen<{ key: string; fraction: number }>("reverse-progress", (e) => {
    const { previews, set } = useReverseStore.getState();
    const current = previews[e.payload.key];
    if (current?.status === "preparing") set(e.payload.key, { ...current, progress: e.payload.fraction });
  }).catch(() => null);
}

/** Start preparing a reversed copy for every reversed clip that does not have one yet. */
export function ensureReversePreviews(project: Project) {
  const assets = new Map(project.assets.map((a) => [a.id, a]));
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      const asset = assets.get(clip.assetId);
      if (!clip.reversed || !asset || asset.type === "image") continue;
      const key = reverseKey(asset.path, clip.sourceIn, clip.sourceOut);
      const store = useReverseStore.getState();
      if (store.previews[key]) continue;

      ensureListening();
      store.set(key, { status: "preparing", progress: 0 });
      invoke<string>("prepare_reverse_preview", {
        key,
        path: asset.path,
        sourceIn: clip.sourceIn,
        sourceOut: clip.sourceOut,
      }).then(
        (path) => useReverseStore.getState().set(key, { status: "ready", progress: 1, path }),
        (e: unknown) =>
          useReverseStore.getState().set(key, {
            status: "failed",
            progress: 0,
            error:
              typeof e === "string"
                ? e
                : e instanceof Error
                  ? e.message
                  : "Could not prepare the reverse preview",
          }),
      );
    }
  }
}
