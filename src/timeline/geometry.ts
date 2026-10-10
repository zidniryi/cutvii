/** Pure layout math for the timeline (seconds <-> pixels, ruler ticks, windowing). */
import type { TimelineClip } from "@/project/model";
import { clipEnd } from "./clips";
import { formatDuration } from "@/lib/timecode";

export const ROW_HEIGHT = 64;
export const RULER_HEIGHT = 28;
export const HEADER_WIDTH = 112;
export const DEFAULT_PPS = 50;
export const MIN_PPS = 4;
export const MAX_PPS = 480;
/** Empty space kept after the last clip so there is room to drop and extend. */
export const TAIL_SECONDS = 10;
/** Pixels of attraction for snapping, independent of zoom. */
export const SNAP_PX = 8;

const STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];

export const clampPps = (pps: number) => Math.min(MAX_PPS, Math.max(MIN_PPS, pps));
export const timeToX = (time: number, pps: number) => time * pps;
export const xToTime = (x: number, pps: number) => x / pps;

/** Smallest "nice" label step that keeps labels at least `minPx` apart. */
export function rulerStep(pps: number, minPx = 80): number {
  return STEPS.find((s) => s * pps >= minPx) ?? STEPS[STEPS.length - 1];
}

export interface Tick {
  time: number;
  major: boolean;
}

/** Ticks in [from, to]: a labelled major tick every `step`, four minor ticks between. */
export function rulerTicks(pps: number, from: number, to: number): Tick[] {
  const minor = rulerStep(pps) / 5;
  const first = Math.max(0, Math.floor(from / minor));
  const last = Math.ceil(to / minor);
  const ticks: Tick[] = [];
  for (let i = first; i <= last; i++) ticks.push({ time: i * minor, major: i % 5 === 0 });
  return ticks;
}

export function rulerLabel(time: number, step: number): string {
  if (step >= 1) return formatDuration(time);
  const whole = Math.floor(time + 1e-9);
  const tenth = Math.round((time - whole) * 10);
  return tenth === 10 ? formatDuration(whole + 1) + ".0" : `${formatDuration(whole)}.${tenth}`;
}

export function visibleClips(clips: TimelineClip[], from: number, to: number): TimelineClip[] {
  return clips.filter((c) => clipEnd(c) >= from && c.timelineStart <= to);
}

export function trackIndexAt(clientY: number, lanesTop: number, trackCount: number): number {
  if (trackCount <= 0) return -1;
  return Math.min(trackCount - 1, Math.max(0, Math.floor((clientY - lanesTop) / ROW_HEIGHT)));
}

export function contentWidth(duration: number, viewportWidth: number, pps: number): number {
  return Math.max(viewportWidth, Math.ceil((duration + TAIL_SECONDS) * pps));
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Translate a pointer position (window px) into a timeline drop: which lane, or the empty space below the
 * lanes (a new track), and at what time. Returns null when the pointer is not over the timeline at all.
 * `lanes.left` is where time 0 is drawn (it already moves with horizontal scrolling).
 */
export function timelineDropTarget(
  x: number,
  y: number,
  area: Box,
  lanes: Pick<Box, "left" | "top">,
  trackIds: string[],
  pps: number,
): { kind: "track"; trackId: string; time: number } | { kind: "new-track"; time: number } | null {
  if (area.right <= area.left || area.bottom <= area.top) return null; // timeline not laid out
  if (x < area.left || x > area.right || y < area.top || y > area.bottom) return null;
  const time = Math.max(0, xToTime(x - lanes.left, pps));
  const row = Math.floor((y - lanes.top) / ROW_HEIGHT);
  if (trackIds.length === 0 || row >= trackIds.length) return { kind: "new-track", time };
  return { kind: "track", trackId: trackIds[Math.max(0, row)], time };
}
