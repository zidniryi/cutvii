import { useShallow } from "zustand/react/shallow";
import type { MediaAsset, TimelineClip } from "@/project/model";
import { useBeatSafety } from "@/store/beatSafety";
import { useBeatStore } from "@/store/beats";
import { usePlaybackStore } from "@/store/playback";
import { useUiStore } from "@/store/ui";
import type { BeatGrid } from "@/timeline/beats";
import { look, NO_LOOK, setupFor, type Look, type Setup } from "@/timeline/beatFxMath";

const cache = new WeakMap<TimelineClip, { key: unknown[]; setup: Setup | null }>();

/** The clip's effect setup; worked out again only when the clip, its beats or the safety setting change. */
function setupOf(clip: TimelineClip, asset: MediaAsset, grid: BeatGrid | undefined, reduce: boolean) {
  const key = [grid, reduce, asset.width, asset.height, asset.type];
  const hit = cache.get(clip);
  if (hit && hit.key.length === key.length && hit.key.every((v, i) => v === key[i])) return hit.setup;
  const setup = setupFor(clip, asset, grid, reduce);
  cache.set(clip, { key, setup });
  return setup;
}

/**
 * What the beat effects of a clip look like at the playhead, for the preview. `null` when the clip has none
 * (or "Preview on canvas" is off), so the layer is drawn as it always was.
 */
export function useBeatLook(clip: TimelineClip, asset: MediaAsset): Look | null {
  const grid =
    useBeatStore((s) => (clip.beatFx?.gridId ? s.grids[clip.beatFx.gridId] : undefined)) ?? undefined;
  const on = useUiStore((s) => s.beatPreview);
  const reduce = useBeatSafety((s) => s.reduceFlashing);
  const setup = on && clip.beatFx?.effects.length ? setupOf(clip, asset, grid, reduce) : null;
  const now = usePlaybackStore(
    useShallow((s) => (setup ? look(setup, s.playhead - clip.timelineStart) : NO_LOOK)),
  );
  return setup ? now : null;
}
