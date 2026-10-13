import type { PointerEvent as ReactPointerEvent } from "react";
import { useDragDropStore } from "@/store/dragDrop";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { findClip } from "@/timeline/clips";
import { changeTransition, report } from "@/timeline/editor";
import { DEFAULT_TRANSITION_SECONDS } from "@/timeline/transitions";

const THRESHOLD_PX = 4;

/** The clip under a point of the window, and which half of it: the left half takes a transition in. */
export function transitionTargetAt(x: number, y: number): { clipId: string; way: "in" | "out" } | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-clip-id]");
  const clipId = el?.dataset.clipId;
  if (!el || !clipId) return null;
  const box = el.getBoundingClientRect();
  return { clipId, way: x < box.left + box.width / 2 ? "in" : "out" };
}

/**
 * Drag a transition from the gallery onto a clip in the timeline, with pointer events like the media
 * cards. Dropped on the left half of a clip it becomes that clip's transition in, on the right half its
 * transition out; the clip is selected. A press without a drag is left to the tile's own click.
 */
export function beginTransitionDrag(e: ReactPointerEvent, kind: { id: string; label: string }) {
  if (e.button !== 0) return;
  const startX = e.clientX;
  const startY = e.clientY;
  let moved = false;
  let marked: HTMLElement | null = null;

  const mark = (x: number, y: number) => {
    const target = transitionTargetAt(x, y);
    const el = target
      ? document.querySelector<HTMLElement>(`[data-clip-id="${CSS.escape(target.clipId)}"]`)
      : null;
    if (marked && marked !== el) delete marked.dataset.dropWay;
    if (el && target) el.dataset.dropWay = target.way;
    marked = el;
  };
  const cleanup = () => {
    if (marked) delete marked.dataset.dropWay;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", cleanup);
    window.removeEventListener("keydown", onKey);
    useDragDropStore.getState().clear();
  };
  const onMove = (ev: PointerEvent) => {
    if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < THRESHOLD_PX) return;
    moved = true;
    mark(ev.clientX, ev.clientY);
    useDragDropStore
      .getState()
      .set({ dragging: { source: "transition", label: kind.label, x: ev.clientX, y: ev.clientY } });
  };
  const onUp = (ev: PointerEvent) => {
    const target = moved ? transitionTargetAt(ev.clientX, ev.clientY) : null;
    cleanup();
    if (!target) return;
    const found = findClip(useProjectStore.getState().project, target.clipId);
    if (!found) return;
    const now = target.way === "in" ? found.clip.transitionIn : found.clip.transitionOut;
    const duration = now?.duration ?? DEFAULT_TRANSITION_SECONDS;
    const result = changeTransition(target.clipId, { kind: kind.id, duration }, target.way);
    report(result);
    if (result.ok) useSelectionStore.getState().select(target.clipId);
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") cleanup();
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", cleanup);
  window.addEventListener("keydown", onKey);
}
