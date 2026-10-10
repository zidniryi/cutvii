/** Timeline zoom math (pure). Zoom is pixels-per-second; it lives in UI state only, never in the project. */
import { clampPps, DEFAULT_PPS, MAX_PPS, MIN_PPS, TAIL_SECONDS } from "./geometry";

export const ZOOM_STEP = 1.25;
/** Wheel/pinch: zoom factor per unit of deltaY (negative delta zooms in). */
const WHEEL_SENSITIVITY = 0.0035;

export interface ZoomResult {
  pps: number;
  scrollLeft: number;
}

/**
 * Zoom to `nextPps` keeping the point at `anchorX` (px from the left edge of the visible timeline) fixed:
 * whatever time was under the anchor before is still under it afterwards (as far as scrolling allows).
 */
export function zoomAround(pps: number, nextPps: number, scrollLeft: number, anchorX: number): ZoomResult {
  const clamped = clampPps(nextPps);
  const anchorTime = (scrollLeft + anchorX) / pps;
  return { pps: clamped, scrollLeft: Math.max(0, anchorTime * clamped - anchorX) };
}

/** Where the playhead is in the viewport; when it is off-screen the viewport centre is used instead. */
export function playheadAnchor(
  playhead: number,
  pps: number,
  scrollLeft: number,
  viewportWidth: number,
): number {
  const x = playhead * pps - scrollLeft;
  return x >= 0 && x <= viewportWidth ? x : viewportWidth / 2;
}

/** Multiplicative factor for a wheel/pinch delta, bounded so one event can never jump wildly. */
export function wheelZoomFactor(deltaY: number): number {
  return Math.exp(Math.max(-60, Math.min(60, -deltaY)) * WHEEL_SENSITIVITY);
}

/** Zoom that shows the whole project (plus the tail) in the viewport. */
export function fitPps(duration: number, viewportWidth: number): number {
  if (duration <= 0 || viewportWidth <= 0) return DEFAULT_PPS;
  return clampPps(viewportWidth / (duration + TAIL_SECONDS));
}

export const zoomPercent = (pps: number) => Math.round((pps / DEFAULT_PPS) * 100);
export const canZoomIn = (pps: number) => pps < MAX_PPS - 1e-9;
export const canZoomOut = (pps: number) => pps > MIN_PPS + 1e-9;
