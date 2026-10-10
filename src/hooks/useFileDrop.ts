import { useEffect } from "react";
import { onFileDrop, type FilesDropped } from "@/lib/dropApi";
import { enqueueDroppedFiles } from "@/import/dropImport";
import { useImportsStore } from "@/store/imports";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { useTimelineViewStore } from "@/store/timelineView";
import { useUiStore } from "@/store/ui";
import { newDropPlacement, type DropPlacement } from "@/timeline/editor";
import { SNAP_PX, timelineDropTarget } from "@/timeline/geometry";
import { snapTime } from "@/timeline/snap";

/** If the drop landed on the timeline, work out the lane and (snapped) time from the live layout. */
function placementFor(drop: FilesDropped): DropPlacement | undefined {
  const area = document.querySelector("[data-timeline-area]")?.getBoundingClientRect();
  const lanes = document.querySelector("[data-timeline-lanes]")?.getBoundingClientRect();
  if (!area || !lanes) return undefined;

  const project = useProjectStore.getState().project;
  const { pps, snapping } = useTimelineViewStore.getState();
  const target = timelineDropTarget(
    drop.x,
    drop.y,
    area,
    lanes,
    project.tracks.map((t) => t.id),
    pps,
  );
  if (!target) return undefined;

  const { time } = snapTime(project, target.time, {
    playhead: usePlaybackStore.getState().playhead,
    threshold: snapping ? SNAP_PX / pps : 0,
  });
  return newDropPlacement({ ...target, time });
}

/** OS file drops: onto the timeline they become clips where they land; anywhere else they go to the library. */
export function useFileDrop() {
  useEffect(() => {
    const off = onFileDrop({
      onDrop: (drop) => {
        const placement = placementFor(drop);
        if (!placement) useUiStore.getState().setSidePanel("library"); // narrow layouts: show where the files land
        enqueueDroppedFiles(drop.files, placement);
      },
      onHover: (active) => {
        if (active) useUiStore.getState().setSidePanel("library");
        useImportsStore.getState().setHovering(active);
      },
    });
    return () => void off.then((fn) => fn()).catch(() => {});
  }, []);
}
