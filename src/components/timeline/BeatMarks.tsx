import { memo, useEffect, useMemo } from "react";
import type { TimelineClip } from "@/project/model";
import { useBeatStore } from "@/store/beats";
import { beatsOnTimeline } from "@/timeline/beats";
import { clipDuration } from "@/timeline/clips";

/** Ticks closer together than this (px) are left out, so a far-out zoom does not turn into a solid bar. */
const MIN_GAP_PX = 4;
const TICK_HEIGHT = 7;

/**
 * The clip's beats as short ticks along its bottom edge: one path in one SVG, however many beats. They
 * follow trim and speed (`beatsOnTimeline`); a reversed clip, or one whose beats are not loaded, shows none.
 */
export const BeatMarks = memo(function BeatMarks({
  clip,
  path,
  pps,
}: {
  clip: TimelineClip;
  path: string;
  pps: number;
}) {
  const gridId = clip.beatFx?.gridId;
  const grid = useBeatStore((s) => (gridId ? s.grids[gridId] : undefined));
  useEffect(() => {
    if (gridId) useBeatStore.getState().ensureGrid(path, gridId);
  }, [path, gridId]);

  const width = clipDuration(clip) * pps;
  const d = useMemo(() => {
    const beats = grid ? beatsOnTimeline(clip, grid) : null;
    if (!beats?.length) return "";
    let last = -Infinity;
    let out = "";
    for (const t of beats) {
      const x = (t - clip.timelineStart) * pps;
      if (x - last < MIN_GAP_PX) continue;
      last = x;
      out += `M${x.toFixed(1)} 0v${TICK_HEIGHT}`;
    }
    return out;
  }, [clip, grid, pps]);

  if (!d) return null;
  return (
    <svg
      aria-hidden
      data-testid="beat-marks"
      className="pointer-events-none absolute bottom-0 left-0 z-[2]"
      width={width}
      height={TICK_HEIGHT}
    >
      <path d={d} stroke="rgba(255,255,255,0.7)" strokeWidth={1} fill="none" />
    </svg>
  );
});
