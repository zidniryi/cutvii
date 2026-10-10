import type { Project, TimelineClip, TimelineTrack } from "@/project/model";

/** Tolerance (seconds) for "touching" clips and float noise. */
export const EPS = 1e-6;

export const clipSpeed = (c: Pick<TimelineClip, "speed">) => c.speed ?? 1;
/** Seconds of source media the clip uses. */
export const sourceDuration = (c: Pick<TimelineClip, "sourceIn" | "sourceOut">) => c.sourceOut - c.sourceIn;
/** Seconds the clip occupies on the timeline: the source range divided by the speed. */
export const clipDuration = (c: TimelineClip) => sourceDuration(c) / clipSpeed(c);
export const clipEnd = (c: TimelineClip) => c.timelineStart + clipDuration(c);

/** Shortest clip we allow: one frame. */
export const minClipDuration = (project: Project) => 1 / project.settings.fps;

export function findClip(
  project: Project,
  clipId: string,
): { clip: TimelineClip; track: TimelineTrack } | undefined {
  for (const track of project.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { clip, track };
  }
  return undefined;
}

/** End of the last clip on any track (0 for an empty timeline). */
export function projectDuration(project: Project): number {
  return Math.max(0, ...project.tracks.flatMap((t) => t.clips.map(clipEnd)));
}
