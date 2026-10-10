import type { Project, TimelineClip } from "@/project/model";
import { clipDuration, clipEnd } from "./clips";

export type SnapKind = "zero" | "playhead" | "clip-start" | "clip-end";

export interface SnapTarget {
  time: number;
  kind: SnapKind;
}

export interface SnapOptions {
  playhead: number;
  /** Max distance (seconds) at which a target attracts; the UI converts pixels using the zoom level. */
  threshold: number;
  /** Clip being dragged; its own edges are not targets. */
  excludeClipId?: string;
}

export interface SnapResult {
  time: number;
  /** null when no target was in range and the time was only rounded to the frame grid. */
  snappedTo: SnapKind | null;
}

export const quantizeToFrame = (time: number, fps: number) => Math.round(time * fps) / fps;

export function snapTargets(
  project: Project,
  opts: Pick<SnapOptions, "playhead" | "excludeClipId">,
): SnapTarget[] {
  const targets: SnapTarget[] = [
    { time: 0, kind: "zero" },
    { time: opts.playhead, kind: "playhead" },
  ];
  for (const track of project.tracks) {
    for (const c of track.clips) {
      if (c.id === opts.excludeClipId) continue;
      targets.push({ time: c.timelineStart, kind: "clip-start" }, { time: clipEnd(c), kind: "clip-end" });
    }
  }
  return targets;
}

function nearest(targets: SnapTarget[], time: number, threshold: number): SnapTarget | undefined {
  let best: SnapTarget | undefined;
  for (const t of targets) {
    const d = Math.abs(t.time - time);
    if (d <= threshold && (!best || d < Math.abs(best.time - time))) best = t;
  }
  return best;
}

/** Snap a single point (e.g. a trim edge or the playhead) to targets, else to the frame grid. */
export function snapTime(project: Project, time: number, opts: SnapOptions): SnapResult {
  const hit = nearest(snapTargets(project, opts), time, opts.threshold);
  if (hit) return { time: hit.time, snappedTo: hit.kind };
  return { time: Math.max(0, quantizeToFrame(time, project.settings.fps)), snappedTo: null };
}

/** Snap a clip being moved: either its start or its end may attract, whichever is closer. */
export function snapClipMove(
  project: Project,
  clip: Pick<TimelineClip, "id" | "sourceIn" | "sourceOut">,
  desiredStart: number,
  opts: Omit<SnapOptions, "excludeClipId">,
): SnapResult {
  const targets = snapTargets(project, { ...opts, excludeClipId: clip.id });
  const duration = clipDuration(clip as TimelineClip);
  const startHit = nearest(targets, desiredStart, opts.threshold);
  const endHit = nearest(targets, desiredStart + duration, opts.threshold);

  const startDist = startHit ? Math.abs(startHit.time - desiredStart) : Infinity;
  const endDist = endHit ? Math.abs(endHit.time - (desiredStart + duration)) : Infinity;

  if (startHit && startDist <= endDist) return { time: Math.max(0, startHit.time), snappedTo: startHit.kind };
  if (endHit) return { time: Math.max(0, endHit.time - duration), snappedTo: endHit.kind };
  return { time: Math.max(0, quantizeToFrame(desiredStart, project.settings.fps)), snappedTo: null };
}
