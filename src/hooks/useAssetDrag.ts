import type { PointerEvent as ReactPointerEvent } from "react";
import { fileName } from "@/lib/media";
import type { MediaAsset } from "@/project/model";
import { useDragDropStore } from "@/store/dragDrop";
import { useProjectStore } from "@/store/project";
import { placeAssetAtDrop, report } from "@/timeline/editor";
import { autoScrollTimeline, dropTargetAt } from "@/timeline/dropTargeting";
import { newDropPlacement, planPlacement } from "@/timeline/placement";

const THRESHOLD_PX = 4;

/**
 * Drag a media card onto the timeline with pointer events (works with mouse, pen and touch, and does not
 * depend on HTML5 drag-and-drop, which the OS file-drop handling disables on Windows).
 */
export function beginAssetDrag(e: ReactPointerEvent, asset: MediaAsset) {
  if (e.button !== 0) return;
  if ((e.target as HTMLElement).closest("button, input, a")) return; // the card's own buttons keep working
  const startX = e.clientX;
  const startY = e.clientY;
  const label = fileName(asset.path);
  let last = { x: startX, y: startY };
  let moved = false;
  let raf = 0;

  const update = () => {
    const target = dropTargetAt(last.x, last.y);
    const project = useProjectStore.getState().project;
    const plan = target ? planPlacement(project, newDropPlacement(target), asset) : null;
    useDragDropStore.getState().set({
      dragging: { source: "library", label, x: last.x, y: last.y },
      preview: plan
        ? {
            trackId: plan.trackId,
            trackType: plan.trackType,
            start: plan.start,
            duration: plan.duration,
            label,
            hint: plan.hint,
          }
        : null,
    });
  };
  // keeps scrolling (and re-targeting) while the pointer rests near an edge
  const frame = () => {
    if (autoScrollTimeline(last.x, last.y)) update();
    raf = requestAnimationFrame(frame);
  };

  const cleanup = () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("keydown", onKey);
    useDragDropStore.getState().clear();
  };
  const onMove = (ev: PointerEvent) => {
    last = { x: ev.clientX, y: ev.clientY };
    if (!moved) {
      if (Math.hypot(last.x - startX, last.y - startY) < THRESHOLD_PX) return;
      moved = true;
      raf = requestAnimationFrame(frame);
    }
    update();
  };
  const onUp = (ev: PointerEvent) => {
    const target = moved ? dropTargetAt(ev.clientX, ev.clientY) : null;
    cleanup();
    if (target) report(placeAssetAtDrop(asset.id, newDropPlacement(target)));
  };
  const onCancel = () => cleanup();
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") cleanup();
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  window.addEventListener("keydown", onKey);
}
