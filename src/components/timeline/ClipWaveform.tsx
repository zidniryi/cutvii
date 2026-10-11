import { memo, useEffect, useRef } from "react";
import type { TimelineClip } from "@/project/model";
import { useWaveformStore } from "@/store/waveforms";
import { ROW_HEIGHT } from "@/timeline/geometry";
import { waveColumns } from "@/timeline/waveform";

/** Clips are inset 4px from the top and bottom of their lane. */
const HEIGHT = ROW_HEIGHT - 8;
const PADDING = 4;
const MAX_DPR = 2;
/** The waveform is a row of bars: each is this wide, with a gap before the next. */
const BAR_WIDTH = 2;
const BAR_STEP = 3;
const MIN_BAR = 2;

interface Props {
  path: string;
  clip: TimelineClip;
  pps: number;
  /** Slice of the clip to draw, in px from its left edge (see `waveWindow`). */
  from: number;
  to: number;
  /** The track is muted: drawn faint. */
  muted: boolean;
}

/** The clip's audio drawn as bars behind its label; a flat line until the peaks are ready. */
export const ClipWaveform = memo(function ClipWaveform({ path, clip, pps, from, to, muted }: Props) {
  const entry = useWaveformStore((s) => s.entries[path]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const data = entry?.status === "ready" ? entry.data : null;
  const { sourceIn, sourceOut, speed, reversed, volume } = clip;

  useEffect(() => useWaveformStore.getState().ensure(path), [path]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !data) return;
    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    canvas.width = Math.round((to - from) * dpr);
    canvas.height = Math.round(HEIGHT * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, to - from, HEIGHT);
    ctx.fillStyle = muted ? "rgba(255, 255, 255, 0.14)" : "rgba(255, 255, 255, 0.36)";
    // One value per bar: the same math as one column per pixel, on a timeline BAR_STEP times coarser.
    // Bars are counted from the clip's left edge, so they stay put when the drawn slice changes.
    const first = Math.floor(from / BAR_STEP);
    const bars = waveColumns(
      data,
      { sourceIn, sourceOut, speed, reversed, volume },
      pps / BAR_STEP,
      first,
      Math.ceil(to / BAR_STEP),
    );
    for (let i = 0; i < bars.length; i++) {
      const h = Math.max(MIN_BAR, bars[i] * (HEIGHT - PADDING * 2));
      ctx.fillRect((first + i) * BAR_STEP - from, (HEIGHT - h) / 2, BAR_WIDTH, h);
    }
  }, [data, sourceIn, sourceOut, speed, reversed, volume, pps, from, to, muted]);

  if (!entry || entry.status === "loading") {
    return (
      <div
        aria-hidden
        data-testid="waveform-placeholder"
        className="pointer-events-none absolute inset-x-0 top-1/2 h-px bg-white/25"
      />
    );
  }
  if (!data) return null;
  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      data-testid="waveform"
      className="pointer-events-none absolute top-0"
      style={{ left: from, width: to - from, height: HEIGHT }}
    />
  );
});
