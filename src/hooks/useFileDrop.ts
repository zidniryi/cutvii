import { useEffect } from "react";
import { onFileDrop } from "@/lib/dropApi";
import { useStylePackStore } from "@/store/stylePacks";
import { isPackFile } from "@/timeline/stylePack";
import { enqueueDroppedFiles } from "@/import/dropImport";
import { useDragDropStore } from "@/store/dragDrop";
import { useImportsStore } from "@/store/imports";
import { useProjectStore } from "@/store/project";
import { useUiStore } from "@/store/ui";
import { newDropPlacement } from "@/timeline/editor";
import { autoScrollTimeline, dropTargetAt } from "@/timeline/dropTargeting";
import { DEFAULT_IMAGE_DURATION } from "@/timeline/edit";

/** While OS files hover, we do not know what they are yet: show a generic ghost on the lane under the pointer. */
function previewOsDrag(x: number, y: number) {
  autoScrollTimeline(x, y);
  const target = dropTargetAt(x, y);
  const tracks = useProjectStore.getState().project.tracks;
  const lane = target?.kind === "track" ? tracks.find((t) => t.id === target.trackId) : undefined;
  useDragDropStore.getState().set({
    dragging: { source: "os", label: "Drop to add", x, y },
    preview: target
      ? {
          trackId: lane?.id ?? null,
          trackType: lane?.type ?? "video",
          start: target.time,
          duration: DEFAULT_IMAGE_DURATION,
          label: "Drop to add",
        }
      : null,
  });
  // the library overlay is for drops that will only import
  useImportsStore.getState().setHovering(!target);
}

/** OS file drops: onto the timeline they become clips where they land; anywhere else they go to the library. */
export function useFileDrop() {
  useEffect(() => {
    const off = onFileDrop({
      onDrop: (drop) => {
        const target = dropTargetAt(drop.x, drop.y);
        useDragDropStore.getState().clear();
        // a style pack is not media: it opens its import preview (the first one, if several were dropped)
        const packs = drop.files.filter((f) => isPackFile(f.name));
        const media = drop.files.filter((f) => !isPackFile(f.name));
        if (packs.length > 0) void useStylePackStore.getState().openDropped(packs[0].id);
        if (media.length === 0) return;
        if (!target) useUiStore.getState().setSidePanel("library"); // narrow layouts: show where the files land
        enqueueDroppedFiles(media, target ? newDropPlacement(target) : undefined);
      },
      onHover: (active) => {
        if (active) useUiStore.getState().setSidePanel("library");
        else useDragDropStore.getState().clear();
        useImportsStore.getState().setHovering(active);
      },
      onOver: ({ x, y }) => previewOsDrag(x, y),
    });
    return () => void off.then((fn) => fn()).catch(() => {});
  }, []);
}
