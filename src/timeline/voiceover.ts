/** Voice-over: speech made from text (in Rust, on this computer) becomes a sound clip at the playhead. */
import type { MediaAsset, Project, TimelineClip } from "@/project/model";
import { clipEnd, EPS } from "./clips";
import { addTrack, type EditResult } from "./edit";

export const VOICEOVER_TRACK_NAME = "Voice-over";

/** A voice-over Rust made: the sound file and its length in seconds. */
export interface Spoken {
  path: string;
  duration: number;
}

/**
 * Put a voice-over on the timeline at `at`: on the "Voice-over" track when the place is free there,
 * otherwise on a new audio track of that name. Pure: the caller makes it one undo step.
 */
export function addVoiceover(
  project: Project,
  made: Spoken,
  at: number,
  ids: { asset: string; track: string; clip: string },
): EditResult {
  if (!(made.duration > 0) || !made.path) {
    return { ok: false, error: { code: "out-of-range", message: "The voice-over has no sound" } };
  }
  const start = Math.max(0, at);
  const free = project.tracks.find(
    (t) =>
      t.type === "audio" &&
      t.name === VOICEOVER_TRACK_NAME &&
      t.clips.every((c) => clipEnd(c) <= start + EPS || c.timelineStart >= start + made.duration - EPS),
  );
  let next = project;
  let trackId = free?.id;
  if (!trackId) {
    const added = addTrack(project, "audio", ids.track);
    if (!added.ok) return added;
    next = added.project;
    trackId = ids.track;
  }
  const asset: MediaAsset = { id: ids.asset, path: made.path, type: "audio", duration: made.duration };
  const clip: TimelineClip = {
    id: ids.clip,
    assetId: ids.asset,
    trackId,
    timelineStart: start,
    sourceIn: 0,
    sourceOut: made.duration,
    volume: 1,
    x: 0,
    y: 0,
    scale: 1,
    opacity: 1,
  };
  return {
    ok: true,
    project: {
      ...next,
      assets: [...next.assets, asset],
      tracks: next.tracks.map((t) =>
        t.id === trackId ? { ...t, name: VOICEOVER_TRACK_NAME, clips: [...t.clips, clip] } : t,
      ),
    },
  };
}
