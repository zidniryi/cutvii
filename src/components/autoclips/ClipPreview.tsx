import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import { mediaUrl } from "@/lib/media";
import { formatDuration } from "@/lib/timecode";
import { cn } from "@/lib/utils";
import { useAutoClipsStore } from "@/store/autoClips";
import { wordsOf, type Edge, type ReviewClip } from "@/timeline/autoClips";

/** Seconds of the recording shown either side of the clip in the mini timeline and transcript. */
const AROUND = 10;
const nudgeButton =
  "flex size-9 items-center justify-center rounded-md border border-border bg-surface-2 text-text-muted hover:text-text pointer-coarse:size-11 focus-visible:outline-accent [&_svg]:size-4";

const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName);

function Nudge({ clip, edge }: { clip: ReviewClip; edge: Edge }) {
  const name = edge === "start" ? "Start" : "End";
  const at = edge === "start" ? clip.sourceIn : clip.sourceOut;
  const go = (direction: -1 | 1) => (e: React.MouseEvent) =>
    useAutoClipsStore.getState().nudge(clip.id, edge, direction, e.altKey || e.shiftKey);
  return (
    <div className="flex items-center gap-1 text-xs">
      <span className="w-9 text-text-muted">{name}</span>
      <button type="button" aria-label={`${name} earlier`} className={nudgeButton} onClick={go(-1)}>
        <ChevronLeft />
      </button>
      <span className="w-14 text-center tabular-nums">{formatDuration(at)}</span>
      <button type="button" aria-label={`${name} later`} className={nudgeButton} onClick={go(1)}>
        <ChevronRight />
      </button>
    </div>
  );
}

/** The selected candidate: a player for just that stretch, a mini timeline with its two cuts, and the words. */
export function ClipPreview({ clip }: { clip: ReviewClip }) {
  const context = useAutoClipsStore((s) => s.context);
  const sentences = useAutoClipsStore((s) => s.sentences);
  const snap = useAutoClipsStore((s) => s.snap);
  const mediaRef = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(clip.sourceIn);
  // the window stays put while a handle is dragged, so the handle does not run away from the pointer
  const [held, setHeld] = useState<{ from: number; to: number } | null>(null);

  const from = held?.from ?? Math.max(context?.rangeIn ?? 0, clip.sourceIn - AROUND);
  const to = held?.to ?? Math.min(context?.rangeOut ?? clip.sourceOut, clip.sourceOut + AROUND);
  const share = (t: number) => `${(Math.min(1, Math.max(0, (t - from) / (to - from))) * 100).toFixed(3)}%`;
  const shown = useMemo(() => sentences.filter((s) => s.end > from && s.start < to), [sentences, from, to]);

  // a new clip or a moved start: stand at the start, stopped
  useEffect(() => {
    const media = mediaRef.current;
    if (!media) return;
    media.pause();
    media.currentTime = clip.sourceIn;
    setPosition(clip.sourceIn);
    setPlaying(false);
  }, [clip.id, clip.sourceIn]);

  const { sourceIn, sourceOut } = clip;
  const toggle = useCallback(() => {
    const media = mediaRef.current;
    if (!media) return;
    if (!media.paused) return media.pause();
    if (media.currentTime < sourceIn || media.currentTime >= sourceOut - 0.05) media.currentTime = sourceIn;
    void Promise.resolve(media.play()).catch(() => setPlaying(false));
  }, [sourceIn, sourceOut]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== " " || typing(e.target)) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  function onTime() {
    const media = mediaRef.current;
    if (!media) return;
    if (media.currentTime >= clip.sourceOut) {
      media.pause();
      media.currentTime = clip.sourceIn;
    }
    setPosition(media.currentTime);
  }

  function dragHandle(edge: Edge) {
    return {
      onPointerDown: (e: React.PointerEvent) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        setHeld({ from, to });
      },
      onPointerMove: (e: React.PointerEvent) => {
        const bar = barRef.current?.getBoundingClientRect();
        if (!held || !bar || bar.width === 0) return;
        const time = held.from + ((e.clientX - bar.left) / bar.width) * (held.to - held.from);
        useAutoClipsStore.getState().setCut(clip.id, edge, time, e.altKey || e.shiftKey);
      },
      onPointerUp: () => setHeld(null),
      onPointerCancel: () => setHeld(null),
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        e.stopPropagation();
        useAutoClipsStore
          .getState()
          .nudge(clip.id, edge, e.key === "ArrowLeft" ? -1 : 1, e.altKey || e.shiftKey);
      },
    };
  }
  const handle = (edge: Edge) => {
    const at = edge === "start" ? clip.sourceIn : clip.sourceOut;
    return (
      <div
        role="slider"
        tabIndex={0}
        aria-label={edge === "start" ? "Clip start" : "Clip end"}
        aria-valuemin={Math.round(from * 100) / 100}
        aria-valuemax={Math.round(to * 100) / 100}
        aria-valuenow={Math.round(at * 100) / 100}
        aria-valuetext={formatDuration(at)}
        title="Drag, or use the arrow keys. Hold Alt or Shift to cut anywhere."
        className="absolute inset-y-0 z-10 flex w-11 -translate-x-1/2 cursor-ew-resize touch-none items-center justify-center focus-visible:outline-accent"
        style={{ left: share(at) }}
        {...dragHandle(edge)}
      >
        <span className="h-full w-1 rounded-full bg-accent" />
      </div>
    );
  };

  if (!context) return null;
  const Media = context.video ? "video" : "audio";
  return (
    <div className="space-y-3">
      <div className={cn("overflow-hidden rounded-lg border bg-black", !context.video && "bg-surface-2 p-3")}>
        <Media
          ref={mediaRef}
          aria-label={`Preview of ${clip.title || "clip"}`}
          src={mediaUrl(context.path)}
          preload="metadata"
          playsInline
          className={context.video ? "mx-auto max-h-[38vh] w-full object-contain" : "hidden"}
          onTimeUpdate={onTime}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
        />
        {!context.video && <p className="text-xs text-text-muted">Sound only</p>}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          aria-label={playing ? "Pause" : "Play this clip"}
          title="Space"
          onClick={toggle}
          className="flex size-10 items-center justify-center rounded-full bg-accent text-black hover:bg-accent-hover pointer-coarse:size-11 focus-visible:outline-accent [&_svg]:size-4"
        >
          {playing ? <Pause /> : <Play />}
        </button>
        <span className="text-xs text-text-muted tabular-nums">
          {formatDuration(Math.max(0, position - clip.sourceIn))} /{" "}
          {formatDuration(clip.sourceOut - clip.sourceIn)}
        </span>
        <Nudge clip={clip} edge="start" />
        <Nudge clip={clip} edge="end" />
        <label className="flex min-h-9 items-center gap-2 text-xs text-text-muted pointer-coarse:min-h-11">
          <input
            type="checkbox"
            className="size-4 accent-[var(--accent)]"
            checked={snap}
            onChange={(e) => useAutoClipsStore.getState().setSnap(e.target.checked)}
          />
          Snap to sentences
        </label>
      </div>

      <div
        ref={barRef}
        role="group"
        aria-label="Clip range"
        className="relative h-11 rounded-md border bg-surface-2"
      >
        {shown.map((s) => (
          <span
            key={s.start}
            aria-hidden
            className="absolute inset-y-2 rounded-sm bg-text-muted/25"
            style={{ left: share(s.start), right: `calc(100% - ${share(s.end)})` }}
          />
        ))}
        <span
          aria-hidden
          className="absolute inset-y-0 border-y-2 border-accent bg-accent-soft"
          style={{ left: share(clip.sourceIn), right: `calc(100% - ${share(clip.sourceOut)})` }}
        />
        <span aria-hidden className="absolute inset-y-0 w-px bg-text" style={{ left: share(position) }} />
        {handle("start")}
        {handle("end")}
      </div>

      <p aria-label="Transcript" className="max-h-40 overflow-y-auto rounded-md border p-2 text-sm leading-7">
        {shown.flatMap((s) =>
          wordsOf(s).map((w) => {
            const inside = w.start >= clip.sourceIn - 1e-6 && w.end <= clip.sourceOut + 1e-6;
            return (
              <button
                key={`${s.start}-${w.start}`}
                type="button"
                title="Move the nearest cut here"
                onClick={() => useAutoClipsStore.getState().cutAtWord(clip.id, w)}
                className={cn(
                  "mr-1 rounded-sm px-0.5 hover:bg-accent-soft focus-visible:outline-accent",
                  inside ? "text-text" : "text-text-muted/60",
                )}
              >
                {w.text}
              </button>
            );
          }),
        )}
      </p>
      <p className="text-xs text-text-muted">
        Cuts snap to whole sentences. Hold Alt or Shift (or switch snapping off) to cut anywhere; click a word
        to move the nearest cut to it. Word times are estimates.
      </p>
    </div>
  );
}
