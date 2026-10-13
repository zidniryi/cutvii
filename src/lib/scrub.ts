import type { PointerEvent as ReactPointerEvent } from "react";

/** A press on a label only becomes a scrub once the pointer has gone this far; a plain click stays a click. */
const SCRUB_START_PX = 3;
/** Pixels of travel for one step: slow enough to land on an exact number. */
const PX_PER_STEP = 2;

export interface Scrub {
  value: number;
  /** What one step adds, in the unit of `value`. */
  step: number;
  min: number;
  max: number;
  /** The number under the pointer while dragging; null when the drag was called off. */
  onDraft: (v: number | null) => void;
  /** The number the pointer was let go on. Called once, so the change is one undo step. */
  onCommit: (v: number) => void;
}

/**
 * Props for a field's label that make its number scrubbable: drag the label left or right to change the
 * value. Pointer events, so it works with a finger as well as a mouse.
 */
export function scrubProps({ value, step, min, max, onDraft, onCommit }: Scrub) {
  return {
    title: "Drag left or right to change",
    className: "cursor-ew-resize touch-none select-none",
    onPointerDown(e: ReactPointerEvent<HTMLElement>) {
      if (e.button !== 0) return;
      const startX = e.clientX;
      let latest = value;
      let moved = false;
      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        if (!moved && Math.abs(dx) < SCRUB_START_PX) return;
        moved = true;
        const next = value + Math.round(dx / PX_PER_STEP) * step;
        latest = Number(Math.min(max, Math.max(min, next)).toFixed(6));
        onDraft(latest);
      };
      const done = (apply: boolean) => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        if (!moved) return;
        if (apply) onCommit(latest);
        else onDraft(null);
      };
      const onUp = () => done(true);
      const onCancel = () => done(false);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
    },
  };
}
