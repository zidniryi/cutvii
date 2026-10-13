import { useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { Ban, Play } from "lucide-react";
import { beginTransitionDrag } from "@/hooks/useTransitionDrag";
import { cn } from "@/lib/utils";
import type { ClipTransition, TimelineClip } from "@/project/model";
import { usePlaybackStore } from "@/store/playback";
import { useUiStore } from "@/store/ui";
import { clipEnd } from "@/timeline/clips";
import { changeTransition, report } from "@/timeline/editor";
import {
  DEFAULT_TRANSITION_SECONDS,
  TRANSITION_LIMITS,
  TRANSITIONS,
  transitionOf,
  transitionOutOf,
  type TransitionKind,
} from "@/timeline/transitions";

type Way = "in" | "out";

/** Seconds of the timeline shown before a transition when "Play it" is pressed. */
const LEAD_IN = 0.6;

/** Where the little demo block starts (or, leaving, ends up): the kind's `from`, as CSS variables. */
const demoStyle = (from: TransitionKind["from"]): CSSProperties =>
  ({
    "--tx": `${from.x * 100}%`,
    "--ty": `${from.y * 100}%`,
    "--r": `${from.rotation}deg`,
    "--s": String(from.scale),
    "--o": String(from.opacity),
  }) as CSSProperties;

/** A choice: a small stage whose block shows the movement when the pointer or the keyboard is on it. */
function Tile({
  name,
  selected,
  onChoose,
  way,
  from,
  onDrag,
}: {
  name: string;
  selected: boolean;
  onChoose: () => void;
  way: Way;
  /** Absent for "None". */
  from?: TransitionKind["from"];
  /** Start dragging this kind onto a clip in the timeline. */
  onDrag?: (e: ReactPointerEvent) => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={name}
      title={onDrag ? `${name}: click to use it, or drag it onto a clip in the timeline` : name}
      onClick={onChoose}
      onPointerDown={onDrag}
      className={cn(
        "group flex touch-none flex-col gap-1 rounded-md border p-1 text-left select-none pointer-coarse:min-h-11",
        selected ? "border-accent bg-accent-soft" : "border-border bg-surface-2 hover:border-text-muted",
      )}
    >
      <span className="relative block aspect-video w-full overflow-hidden rounded-sm bg-bg">
        {from ? (
          <span
            data-way={way}
            style={demoStyle(from)}
            className="transition-demo absolute inset-0 rounded-sm bg-accent/80"
          />
        ) : (
          <span className="absolute inset-0 flex items-center justify-center text-text-muted [&_svg]:size-4">
            <Ban />
          </span>
        )}
      </span>
      <span className={cn("truncate px-0.5 text-[11px]", selected ? "text-text" : "text-text-muted")}>
        {name}
      </span>
    </button>
  );
}

/**
 * The transitions a clip comes in and leaves with, as a gallery. Coming in, the clip that ends right before
 * it on the same track holds its last frame underneath (except "Fade from black"). The clip's sound fades
 * with its picture. One undo step per change; the export does the same.
 */
export function TransitionPanel({ clip }: { clip: TimelineClip }) {
  const way = useUiStore((s) => s.transitionWay);
  const setWay = useUiStore((s) => s.setTransitionWay);
  const [draft, setDraft] = useState<number | null>(null);
  const current: ClipTransition | null = (way === "in" ? clip.transitionIn : clip.transitionOut) ?? null;
  const seconds = draft ?? current?.duration ?? DEFAULT_TRANSITION_SECONDS;
  const title = way === "in" ? "Transition in" : "Transition out";

  function choose(kind: string | null) {
    if (kind === null) return void report(changeTransition(clip.id, null, way));
    const duration = current?.duration ?? DEFAULT_TRANSITION_SECONDS;
    report(changeTransition(clip.id, { kind, duration }, way));
  }
  function commit() {
    if (draft === null || !current) return;
    const duration = draft;
    setDraft(null);
    report(changeTransition(clip.id, { ...current, duration }, way));
  }
  /** Put the playhead a moment before the transition and play, to watch it. */
  function playIt() {
    const applied = way === "in" ? transitionOf(clip) : transitionOutOf(clip);
    const from = way === "in" ? clip.timelineStart : clipEnd(clip) - (applied?.seconds ?? 0);
    const playback = usePlaybackStore.getState();
    playback.setPlayhead(Math.max(0, from - LEAD_IN));
    playback.play();
  }

  return (
    <div role="group" aria-label="Transition" className="space-y-3">
      <div role="tablist" aria-label="Which end of the clip" className="grid grid-cols-2 gap-1">
        {(["in", "out"] as const).map((w) => {
          const set = (w === "in" ? clip.transitionIn : clip.transitionOut) !== undefined;
          return (
            <button
              key={w}
              type="button"
              role="tab"
              aria-selected={way === w}
              onClick={() => {
                setDraft(null);
                setWay(w);
              }}
              className={cn(
                "flex h-9 items-center justify-center gap-1.5 rounded-md border text-xs pointer-coarse:h-11",
                way === w
                  ? "border-accent bg-accent-soft text-text"
                  : "border-border bg-surface-2 text-text-muted hover:text-text",
              )}
            >
              {w === "in" ? "Coming in" : "Leaving"}
              {set && <span aria-label="set" className="size-1.5 rounded-full bg-accent" />}
            </button>
          );
        })}
      </div>

      <div role="radiogroup" aria-label={title} className="grid grid-cols-3 gap-1.5">
        <Tile name="None" way={way} selected={current === null} onChoose={() => choose(null)} />
        {TRANSITIONS.map((k) => (
          <Tile
            key={k.id}
            name={way === "in" ? k.name : k.outName}
            way={way}
            from={k.from}
            selected={current?.kind === k.id}
            onChoose={() => choose(k.id)}
            onDrag={(e) => beginTransitionDrag(e, { id: k.id, label: way === "in" ? k.name : k.outName })}
          />
        ))}
      </div>

      {current ? (
        <>
          <div>
            <div className="mb-1 flex items-center justify-between text-xs text-text-muted">
              <label htmlFor="clip-transition-length">Length</label>
              <span className="tabular-nums">{seconds.toFixed(1)} s</span>
            </div>
            <input
              id="clip-transition-length"
              type="range"
              min={TRANSITION_LIMITS.min}
              max={TRANSITION_LIMITS.max}
              step={0.1}
              value={seconds}
              aria-valuetext={`${seconds.toFixed(1)} seconds`}
              className="w-full accent-[var(--accent)] pointer-coarse:h-11"
              onChange={(e) => setDraft(Number(e.target.value))}
              onPointerUp={commit}
              onKeyUp={commit}
              onBlur={commit}
            />
          </div>
          <button
            type="button"
            onClick={playIt}
            className="flex h-9 w-full items-center justify-center gap-2 rounded-md border border-border bg-surface-2 text-xs text-text-muted hover:text-text pointer-coarse:h-11 [&_svg]:size-4"
          >
            <Play /> Play it
          </button>
          <p className="text-xs text-text-muted">
            {way === "in"
              ? "The sound fades in with it. A clip that ends right before this one on the same track holds its last frame underneath."
              : "The sound fades out with it."}
          </p>
        </>
      ) : (
        <p className="text-xs text-text-muted">
          Point at a tile to see the movement, click to use it, or drag it onto a clip in the timeline (left
          half = coming in, right half = leaving). Tip: “Fade out” on one clip and “Fade from black” on the
          next gives a fade through black.
        </p>
      )}
    </div>
  );
}
