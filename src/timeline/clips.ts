import type { Project, TimelineClip, TimelineTrack } from "@/project/model";

/** Tolerance (seconds) for "touching" clips and float noise. */
export const EPS = 1e-6;

export const clipDuration = (c: TimelineClip) => c.sourceOut - c.sourceIn;
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
