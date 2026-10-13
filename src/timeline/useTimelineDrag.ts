import { useCallback, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { Project } from "@/project/model";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { useTimelineViewStore } from "@/store/timelineView";
import { findClip, clipDuration } from "./clips";
import { placeClip, trimClip } from "./edit";
import { dropClipAt, report, trimClipEdge } from "./editor";
import { SNAP_PX, trackIndexAt } from "./geometry";
import { quantizeToFrame, snapClipMove, snapTime } from "./snap";

const DRAG_THRESHOLD_PX = 3;

export type DragState =
  | {
      kind: "move";
      clipId: string;
      start: number;
      trackId: string;
      duration: number;
      valid: boolean;
      error?: string;
      /** The project as it would look if dropped now (only when valid). */
      preview: Project | null;
      guide: number | null;
      /** How far the clip has gone from where it was (seconds; where it lands, not where the pointer is). */
      delta: number;
      /** Where the pointer is, for the little time label that follows it. */
      pointer: { x: number; y: number };
    }
  | {
      kind: "trim";
      clipId: string;
      edge: "start" | "end";
      time: number;
      preview: Project;
      guide: number | null;
    };

/**
 * Move/trim drags with live preview. Listeners live on `window` so the drag survives the clip element
 * being re-parented (cross-track moves). Nothing is committed to history until pointer-up.
 */
export function useTimelineDrag(lanesRef: RefObject<HTMLElement | null>) {
  const [drag, setDrag] = useState<DragState | null>(null);

  const begin = useCallback(
    (e: ReactPointerEvent, clipId: string, mode: "move" | { trim: "start" | "end" }) => {
      if (e.button !== 0) return;
      const origin = useProjectStore.getState().project;
      const found = findClip(origin, clipId);
      if (!found) return;

      const startX = e.clientX;
      const startY = e.clientY;
      const originStart = found.clip.timelineStart;
      const duration = clipDuration(found.clip);
      let moved = false;
      let last: DragState | null = null;

      const compute = (ev: PointerEvent): DragState | null => {
        const project = useProjectStore.getState().project;
        if (!findClip(project, clipId)) return null;
        const { pps, snapping } = useTimelineViewStore.getState();
        const playhead = usePlaybackStore.getState().playhead;
        const threshold = snapping ? SNAP_PX / pps : 0;
        const dt = (ev.clientX - startX) / pps;

        if (mode === "move") {
          const clip = findClip(project, clipId)!.clip;
          const desired = originStart + dt;
          const snap = snapping
            ? snapClipMove(project, clip, desired, { playhead, threshold })
            : { time: Math.max(0, quantizeToFrame(desired, project.settings.fps)), snappedTo: null };
          const top = lanesRef.current?.getBoundingClientRect().top ?? 0;
          const sorted = project.tracks;
          const idx = trackIndexAt(ev.clientY, top, sorted.length);
          const trackId = sorted[idx]?.id ?? clip.trackId;
          // onto another clip: it goes in before or after that clip, and the rest makes room
          const r = placeClip(project, clipId, { start: snap.time, trackId });
          return {
            kind: "move",
            clipId,
            start: snap.time,
            trackId,
            duration,
            valid: r.ok,
            error: r.ok ? undefined : r.error.message,
            preview: r.ok ? r.project : null,
            guide: snap.snappedTo ? snap.time : null,
            delta:
              (r.ok ? (findClip(r.project, clipId)?.clip.timelineStart ?? snap.time) : snap.time) -
              originStart,
            pointer: { x: ev.clientX, y: ev.clientY },
          };
        }

        const origEdge = mode.trim === "start" ? originStart : originStart + duration;
        const snap = snapping
          ? snapTime(project, origEdge + dt, { playhead, threshold, excludeClipId: clipId })
          : { time: Math.max(0, quantizeToFrame(origEdge + dt, project.settings.fps)), snappedTo: null };
        const r = trimClip(project, clipId, mode.trim, snap.time);
        return {
          kind: "trim",
          clipId,
          edge: mode.trim,
          time: snap.time,
          preview: r.ok ? r.project : project,
          guide: snap.snappedTo ? snap.time : null,
        };
      };

      const cleanup = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("keydown", onKey);
      };
      const onMove = (ev: PointerEvent) => {
        if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD_PX) return;
        moved = true;
        last = compute(ev);
        if (!last) return onCancel();
        setDrag(last);
      };
      const onUp = () => {
        cleanup();
        setDrag(null);
        if (!moved || !last) return;
        if (last.kind === "move") {
          if (last.valid) dropClipAt(last.clipId, last.start, last.trackId);
          else if (last.error) report({ ok: false, error: { code: "overlap", message: last.error } });
        } else {
          trimClipEdge(last.clipId, last.edge, last.time);
        }
      };
      const onCancel = () => {
        cleanup();
        setDrag(null);
      };
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key === "Escape") onCancel();
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("keydown", onKey);
    },
    [lanesRef],
  );

  return { drag, begin };
}
