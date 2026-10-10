/** Freeze frame: extract the exact frame under the playhead and hold it for two seconds. */
import { invoke } from "@tauri-apps/api/core";
import type { ImportedMedia } from "@/lib/media";
import { MediaAssetSchema, type MediaAsset } from "@/project/model";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useUiStore } from "@/store/ui";
import { clipEnd, EPS, minClipDuration } from "./clips";
import { insertFreezeFrame, sourceTimeAt } from "./edit";

/** The video clip to freeze: the selected one if the playhead is inside it, else the topmost under the playhead. */
export function freezeTarget(): { clipId: string; assetPath: string; sourceTime: number } | null {
  const project = useProjectStore.getState().project;
  const time = usePlaybackStore.getState().playhead;
  const min = minClipDuration(project);
  const selected = new Set(useSelectionStore.getState().selectedClipIds);
  const inside = (start: number, end: number) => time > start + min - EPS && time < end - min + EPS;

  const candidates = [...project.tracks]
    .sort((a, b) => b.order - a.order)
    .filter((t) => t.type === "video" && !t.hidden)
    .flatMap((t) => t.clips)
    .filter((c) => inside(c.timelineStart, clipEnd(c)));
  const clip = candidates.find((c) => selected.has(c.id)) ?? candidates[0];
  const asset = clip && project.assets.find((a) => a.id === clip.assetId);
  if (!clip || !asset || asset.type !== "video") return null;
  return { clipId: clip.id, assetPath: asset.path, sourceTime: sourceTimeAt(clip, time) };
}

let busy = false;

/** Returns true when a freeze frame was inserted. Failures are shown as a timeline notice. */
export async function freezeFrameAtPlayhead(): Promise<boolean> {
  if (busy) return false;
  const notice = useUiStore.getState().setNotice;
  const target = freezeTarget();
  if (!target) {
    notice("Move the playhead inside a video clip to freeze a frame");
    return false;
  }
  const time = usePlaybackStore.getState().playhead;
  busy = true;
  try {
    const media = await invoke<ImportedMedia>("extract_freeze_frame", {
      path: target.assetPath,
      time: target.sourceTime,
    });
    const store = useProjectStore.getState();
    const existing = store.project.assets.find((a) => a.path === media.path);
    const parsed = MediaAssetSchema.safeParse({
      id: existing?.id ?? crypto.randomUUID(),
      path: media.path,
      type: "image",
      width: media.width,
      height: media.height,
      thumbnailPath: media.thumbnailPath,
    });
    if (!parsed.success) throw new Error("The extracted frame could not be read");
    const image: MediaAsset = parsed.data;

    // adding the image and editing the timeline are one undo step
    const result = store.execute({
      label: "Freeze frame",
      apply: (p) => {
        const withAsset = existing ? p : { ...p, assets: [...p.assets, image] };
        return insertFreezeFrame(withAsset, target.clipId, time, image.id);
      },
    });
    if (!result.ok) notice(result.error.message);
    return result.ok;
  } catch (e) {
    notice(
      `Freeze frame failed: ${typeof e === "string" ? e : e instanceof Error ? e.message : "unknown error"}`,
    );
    return false;
  } finally {
    busy = false;
  }
}
