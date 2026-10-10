import { memo, useCallback } from "react";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { usePlaybackStore as usePb } from "@/store/playback";
import { projectDuration } from "@/timeline/clips";
import { quantizeToFrame } from "@/timeline/snap";
import { RULER_HEIGHT, rulerLabel, rulerStep, rulerTicks, timeToX, xToTime } from "@/timeline/geometry";

/** Time ruler. Pointer-down/drag scrubs the playhead (frame-quantized). Only visible ticks are rendered. */
export const Ruler = memo(function Ruler({ pps, from, to }: { pps: number; from: number; to: number }) {
  const step = rulerStep(pps);
  const ticks = rulerTicks(pps, from, to);

  // tenths of a second are plenty for the slider value; avoids re-rendering every tick 60x a second
  const playhead = usePb((s) => Math.round(s.playhead * 10) / 10);
  const fps = useProjectStore((s) => s.project.settings.fps);
  const duration = useProjectStore((s) => projectDuration(s.project));

  const scrub = useCallback(
    (clientX: number, left: number) => {
      const fps = useProjectStore.getState().project.settings.fps;
      const t = quantizeToFrame(xToTime(clientX - left, pps), fps);
      usePlaybackStore.getState().setPlayhead(t);
    },
    [pps],
  );

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    const left = e.currentTarget.getBoundingClientRect().left;
    scrub(e.clientX, left);
    const onMove = (ev: PointerEvent) => scrub(ev.clientX, left);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  return (
    <div
      data-testid="ruler"
      role="slider"
      tabIndex={0}
      aria-label="Playhead position"
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={Math.max(duration, 0)}
      aria-valuenow={Math.round(playhead * 1000) / 1000}
      aria-valuetext={`${playhead.toFixed(2)} seconds`}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 1 : 1 / fps;
        const set = usePlaybackStore.getState().setPlayhead;
        if (e.key === "ArrowRight") set(usePlaybackStore.getState().playhead + step);
        else if (e.key === "ArrowLeft") set(usePlaybackStore.getState().playhead - step);
        else return;
        e.preventDefault();
        e.stopPropagation(); // the global shortcut would otherwise move it a second time
      }}
      onPointerDown={onPointerDown}
      className="absolute inset-x-0 top-0 cursor-col-resize touch-none border-b bg-surface-1 select-none"
      style={{ height: RULER_HEIGHT }}
    >
      {ticks.map((t) => (
        <div
          key={t.time}
          className="absolute bottom-0 border-l"
          style={{ left: timeToX(t.time, pps), height: t.major ? "100%" : "35%" }}
        >
          {t.major && (
            <span className="absolute top-1 left-1 text-[10px] leading-none whitespace-nowrap text-text-muted">
              {rulerLabel(t.time, step)}
            </span>
          )}
        </div>
      ))}
    </div>
  );
});
