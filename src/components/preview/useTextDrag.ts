import { useCallback, useState } from "react";
import type { Layer } from "@/playback/engine";
import { useSelectionStore } from "@/store/selection";
import { useUiStore } from "@/store/ui";
import { editText, textHitBox } from "@/timeline/text";

/** Pointer travel (share of the preview) below which a press is a click, not a move. */
const MOVE_THRESHOLD = 0.004;
/** How long a moved text waits for its redrawn picture before the on-screen shift is dropped regardless. */
const SETTLE_TIMEOUT_MS = 1500;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

interface Drag {
  clipId: string;
  /** Pointer position at the start, in window px. */
  fromX: number;
  fromY: number;
  /** Where the text was (shares of the canvas). */
  x: number;
  y: number;
  /** How far it has been moved so far (shares of the canvas). */
  dx: number;
  dy: number;
}

/**
 * Moving text by dragging it in the preview. While dragging, the picture is only shifted on screen; on
 * release the text is redrawn at the new position as one undo step (the same edit the inspector makes).
 */
export function useTextDrag(layers: Layer[], canvas: { width: number; height: number }) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const [hovering, setHovering] = useState(false);

  /** The top text under a point given in shares of the stage. */
  const textAt = useCallback(
    (fx: number, fy: number) =>
      [...layers].reverse().find((l) => {
        if (!l.visible || !l.asset.text) return false;
        const box = textHitBox(l.asset.text, canvas.width, canvas.height);
        return fx >= box.left && fx <= box.right && fy >= box.top && fy <= box.bottom;
      }),
    [layers, canvas.width, canvas.height],
  );

  const share = (e: React.PointerEvent<HTMLElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0
      ? { rect, fx: (e.clientX - rect.left) / rect.width, fy: (e.clientY - rect.top) / rect.height }
      : null;
  };

  function onPointerDown(e: React.PointerEvent<HTMLElement>) {
    if (e.button !== 0 || drag) return;
    const at = share(e);
    const layer = at && textAt(at.fx, at.fy);
    const spec = layer?.asset.text;
    if (!layer || !spec) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    useSelectionStore.getState().select(layer.clip.id);
    setDrag({
      clipId: layer.clip.id,
      fromX: e.clientX,
      fromY: e.clientY,
      x: spec.x,
      y: spec.y,
      dx: 0,
      dy: 0,
    });
  }

  function onPointerMove(e: React.PointerEvent<HTMLElement>) {
    const at = share(e);
    if (!at) return;
    if (!drag) {
      const over = Boolean(textAt(at.fx, at.fy));
      if (over !== hovering) setHovering(over);
      return;
    }
    // the text centre stays inside the canvas, so what is shown is exactly what will be saved
    const dx = clamp01(drag.x + (e.clientX - drag.fromX) / at.rect.width) - drag.x;
    const dy = clamp01(drag.y + (e.clientY - drag.fromY) / at.rect.height) - drag.y;
    setDrag({ ...drag, dx, dy });
  }

  function onPointerUp() {
    if (!drag) return;
    const { clipId, x, y, dx, dy } = drag;
    if (Math.abs(dx) < MOVE_THRESHOLD && Math.abs(dy) < MOVE_THRESHOLD) return setDrag(null);
    const round = (v: number) => Math.round(v * 1000) / 1000;
    // Keep the shifted picture on screen until the redrawn one has replaced it (`settled`), so the text
    // never jumps back for a moment. If the edit fails, or no new picture ever shows up, let go anyway.
    const release = () => setDrag((d) => (d?.clipId === clipId ? null : d));
    void editText(clipId, { x: round(x + dx), y: round(y + dy) }).then((problem) => {
      if (!problem) return void setTimeout(release, SETTLE_TIMEOUT_MS);
      useUiStore.getState().setNotice(problem);
      release();
    }, release);
  }

  return {
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: () => setDrag(null) },
    /** The redrawn picture of `clipId` is on screen: its shift is no longer needed. */
    settled: (clipId: string) => setDrag((d) => (d?.clipId === clipId ? null : d)),
    /** How far the picture of `clipId` is shifted right now, in shares of the stage. */
    shiftOf: (clipId: string) => (drag?.clipId === clipId ? { dx: drag.dx, dy: drag.dy } : null),
    cursor: drag ? "grabbing" : hovering ? "grab" : undefined,
  };
}
