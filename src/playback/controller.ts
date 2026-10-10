import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { EPS, projectDuration } from "@/timeline/clips";

/** Play/pause. At the end of the timeline, play restarts from the beginning. Empty timeline: no-op. */
export function togglePlayback() {
  const pb = usePlaybackStore.getState();
  if (pb.playing) return pb.pause();

  const duration = projectDuration(useProjectStore.getState().project);
  if (duration <= 0) return;
  if (pb.playhead >= duration - EPS) pb.setPlayhead(0);
  pb.play();
}

export function goToStart() {
  usePlaybackStore.getState().setPlayhead(0);
}

export function goToEnd() {
  usePlaybackStore.getState().setPlayhead(projectDuration(useProjectStore.getState().project));
}

/** Seek to a time, kept inside the project. */
export function seekTo(seconds: number) {
  const duration = projectDuration(useProjectStore.getState().project);
  usePlaybackStore.getState().setPlayhead(Math.min(Math.max(0, seconds), duration));
}

/** Step whole frames from the frame the playhead is on (`,` and `.`). */
export function stepFrames(frames: number) {
  const fps = useProjectStore.getState().project.settings.fps;
  const current = Math.round(usePlaybackStore.getState().playhead * fps);
  seekTo((current + frames) / fps);
}

export const PREVIEW_SPEEDS = [0.5, 1, 1.5, 2] as const;

/**
 * Coalesce many requests into one per animation frame: only the latest value is applied.
 * Used for scrubbing, so the picture is asked to seek at most once per frame (the element keeps showing
 * its last frame until the new one is decoded).
 */
export function createFrameThrottle<T>(apply: (value: T) => void) {
  let pending: { value: T } | null = null;
  let raf = 0;
  const flush = () => {
    raf = 0;
    if (!pending) return;
    const { value } = pending;
    pending = null;
    apply(value);
  };
  return {
    request(value: T) {
      pending = { value };
      if (!raf) raf = requestAnimationFrame(flush);
    },
    /** Apply whatever is pending right now (pointer released). */
    flush() {
      if (raf) cancelAnimationFrame(raf);
      flush();
    },
    cancel() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      pending = null;
    },
  };
}

/** Scrubbing entry point shared by the seek bar. */
export const scrub = createFrameThrottle<number>(seekTo);

/** What the picture/sound on screen says the time is, if anything is driving it. */
export type MediaClock = () => { time: number } | "waiting" | null;

let mediaClock: MediaClock | null = null;
/** The preview registers the element that should lead playback (the visible video, else an audio clip). */
export function setMediaClock(clock: MediaClock | null) {
  mediaClock = clock;
}

/** How long the playhead may hold still for media that is starting, seeking or buffering. */
export const MAX_MEDIA_WAIT = 0.4;
/** Media further than this from the playhead is not "the same moment" (the user seeked): ignore it. */
const FOLLOW_WINDOW = 0.75;

/**
 * Advance the playhead while playing.
 *
 * The media element leads: when a video (or audio clip) is actually playing, the playhead follows *its*
 * clock, so the picture is never re-seeked to chase a wall clock (that was the cause of stuttering).
 * While that element is starting or buffering the playhead holds briefly instead of running ahead.
 * With nothing to follow (gaps, stills, broken media) it falls back to the wall clock.
 * Stops (and pauses) at the end.
 */
export function startClock(): () => void {
  let raf = 0;
  let last = performance.now();
  let waited = 0;

  const tick = (now: number) => {
    const pb = usePlaybackStore.getState();
    const dt = Math.max(0, now - last) / 1000;
    last = now;

    const media = mediaClock?.() ?? null;
    let next = pb.playhead + dt * pb.previewSpeed;
    if (media === "waiting") {
      waited += dt;
      if (waited < MAX_MEDIA_WAIT) next = pb.playhead;
    } else if (media && Math.abs(media.time - pb.playhead) < FOLLOW_WINDOW) {
      waited = 0;
      next = Math.max(pb.playhead, media.time); // never step backwards; a lagging picture is simply waited for
    } else {
      waited = 0;
    }

    const duration = projectDuration(useProjectStore.getState().project);
    if (next >= duration) {
      if (pb.loop && duration > 0) {
        pb.setPlayhead(0); // the media elements are far from 0 now, so the sync re-seeks them
        waited = 0;
        raf = requestAnimationFrame(tick);
        return;
      }
      pb.setPlayhead(duration);
      pb.pause();
      return;
    }
    if (next !== pb.playhead) pb.setPlayhead(next);
    raf = requestAnimationFrame(tick);
  };

  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}
