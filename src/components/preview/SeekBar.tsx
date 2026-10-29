import { useEffect, useMemo, useRef, useState } from "react";
import { formatTimecode } from "@/lib/timecode";
import { scrub, seekTo, stepFrames } from "@/playback/controller";
import { useBeatStore } from "@/store/beats";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { beatsOnTimeline } from "@/timeline/beats";
import { findClip, projectDuration } from "@/timeline/clips";

/** Time under a pointer at `clientX` on a bar spanning [left, left + width]. */
export function timeAtPointer(clientX: number, left: number, width: number, duration: number): number {
  if (!(width > 0) || !(duration > 0)) return 0;
  return Math.min(1, Math.max(0, (clientX - left) / width)) * duration;
}

/** Ticks on the bar are at least this far apart (out of 1000 units across the bar). */
const MIN_TICK_GAP = 3;

/**
 * The beats of the selected clip as ticks above the bar, so cuts can be lined up while scrubbing. One path
 * in one SVG stretched over the bar; nothing is shown for a clip without loaded beats or a reversed one.
 */
function BeatTicks({ duration }: { duration: number }) {
  const selectedId = useSelectionStore((s) =>
    s.selectedClipIds.length === 1 ? s.selectedClipIds[0] : undefined,
  );
  const clip = useProjectStore((s) => (selectedId ? findClip(s.project, selectedId)?.clip : undefined));
  const path = useProjectStore((s) =>
    clip ? s.project.assets.find((a) => a.id === clip.assetId)?.path : undefined,
  );
  const gridId = clip?.beatFx?.gridId;
  const grid = useBeatStore((s) => (gridId ? s.grids[gridId] : undefined));
  useEffect(() => {
    if (gridId && path) useBeatStore.getState().ensureGrid(path, gridId);
  }, [gridId, path]);
  const d = useMemo(() => {
    const beats = clip && grid && duration > 0 ? beatsOnTimeline(clip, grid) : null;
    if (!beats?.length) return "";
    let last = -Infinity;
    let out = "";
    for (const t of beats) {
      const x = (t / duration) * 1000;
      if (x < 0 || x > 1000 || x - last < MIN_TICK_GAP) continue;
      last = x;
      out += `M${x.toFixed(1)} 0V10`;
    }
    return out;
  }, [clip, grid, duration]);
  if (!d) return null;
  return (
    <svg
      aria-hidden
      data-testid="seek-beats"
      className="pointer-events-none absolute -top-2 left-0 h-2.5 w-full"
      viewBox="0 0 1000 10"
      preserveAspectRatio="none"
    >
      <path
        d={d}
        stroke="rgba(255,255,255,0.55)"
        strokeWidth={1}
        fill="none"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/**
 * Seek bar for the whole project. Click to jump, drag to scrub (at most one seek per animation frame),
 * with a time bubble while dragging. It reads and writes the same playhead as the timeline and timecode.
 */
export function SeekBar() {
  const playhead = usePlaybackStore((s) => s.playhead);
  const duration = useProjectStore((s) => projectDuration(s.project));
  const fps = useProjectStore((s) => s.project.settings.fps);
  const barRef = useRef<HTMLDivElement>(null);
  const [bubble, setBubble] = useState<{ time: number; fraction: number } | null>(null);
  const fraction = duration > 0 ? Math.min(1, playhead / duration) : 0;

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0 || duration <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const at = (clientX: number) => timeAtPointer(clientX, rect.left, rect.width, duration);
    const show = (t: number) => setBubble({ time: t, fraction: t / duration });

    const first = at(e.clientX);
    seekTo(first); // a click jumps immediately
    show(first);

    const onMove = (ev: PointerEvent) => {
      const t = at(ev.clientX);
      show(t);
      scrub.request(t); // coalesced: one seek per frame, the last frame stays on screen meanwhile
    };
    const end = () => {
      scrub.flush();
      setBubble(null);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const actions: Record<string, () => void> = {
      ArrowLeft: () => (e.shiftKey ? seekTo(playhead - 1) : stepFrames(-1)),
      ArrowRight: () => (e.shiftKey ? seekTo(playhead + 1) : stepFrames(1)),
      Home: () => seekTo(0),
      End: () => seekTo(duration),
    };
    const action = actions[e.key];
    if (!action) return;
    e.preventDefault();
    e.stopPropagation(); // the global shortcut would otherwise move it a second time
    action();
  }

  return (
    <div
      ref={barRef}
      role="slider"
      tabIndex={0}
      aria-label="Seek"
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration * 1000) / 1000}
      aria-valuenow={Math.round(playhead * 1000) / 1000}
      aria-valuetext={formatTimecode(playhead, fps)}
      aria-disabled={duration <= 0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      // 44 px tall hit area around a thin visual track
      className="group relative flex h-11 w-full cursor-pointer touch-none items-center select-none aria-disabled:cursor-default aria-disabled:opacity-50"
    >
      <div className="relative h-1 w-full rounded-full bg-surface-2 group-hover:h-1.5">
        <BeatTicks duration={duration} />
        <div
          className="h-full rounded-full bg-accent"
          style={{ width: `${fraction * 100}%` }}
          data-testid="seek-fill"
        />
        <div
          className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent shadow"
          style={{ left: `${fraction * 100}%` }}
        />
      </div>
      {bubble && (
        <div
          data-testid="seek-bubble"
          className="pointer-events-none absolute bottom-9 -translate-x-1/2 rounded-md border bg-popover px-1.5 py-0.5 font-mono text-[11px] tabular-nums shadow"
          style={{ left: `${Math.min(1, Math.max(0, bubble.fraction)) * 100}%` }}
        >
          {formatTimecode(bubble.time, fps)}
        </div>
      )}
    </div>
  );
}
