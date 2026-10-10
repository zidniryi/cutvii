/** Zoom actions: read the live scroll position, apply the pure math, store the result. */
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { useTimelineViewStore } from "@/store/timelineView";
import { projectDuration } from "./clips";
import { timelineScroller } from "./dropTargeting";
import { fitPps, playheadAnchor, wheelZoomFactor, zoomAround, ZOOM_STEP } from "./zoom";

const FALLBACK_WIDTH = 1000;

function viewport() {
  const el = timelineScroller();
  return {
    scrollLeft: el?.scrollLeft ?? 0,
    width: el?.clientWidth || FALLBACK_WIDTH,
    left: el?.getBoundingClientRect().left ?? 0,
  };
}

function apply(nextPps: number, anchorX: number) {
  const view = useTimelineViewStore.getState();
  const v = viewport();
  const r = zoomAround(view.pps, nextPps, v.scrollLeft, anchorX);
  view.applyZoom(r.pps, r.scrollLeft);
}

/** Keyboard and toolbar: one step in or out, anchored at the playhead. */
export function zoomStep(direction: 1 | -1) {
  const { pps } = useTimelineViewStore.getState();
  const v = viewport();
  const anchor = playheadAnchor(usePlaybackStore.getState().playhead, pps, v.scrollLeft, v.width);
  apply(direction > 0 ? pps * ZOOM_STEP : pps / ZOOM_STEP, anchor);
}

/** Wheel and pinch: anchored at the pointer. */
export function zoomByFactorAt(factor: number, clientX: number) {
  const { pps } = useTimelineViewStore.getState();
  const v = viewport();
  apply(pps * factor, Math.max(0, Math.min(v.width, clientX - v.left)));
}

export const zoomByWheel = (deltaY: number, clientX: number) =>
  zoomByFactorAt(wheelZoomFactor(deltaY), clientX);

/** Show the whole project. */
export function zoomToFit() {
  const duration = projectDuration(useProjectStore.getState().project);
  useTimelineViewStore.getState().applyZoom(fitPps(duration, viewport().width), 0);
}
