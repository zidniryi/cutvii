import { useState, type PointerEvent as ReactPointerEvent } from "react";
import { Blend, X } from "lucide-react";
import type { TimelineClip } from "@/project/model";
import { cn } from "@/lib/utils";
import { useSelectionStore } from "@/store/selection";
import { useUiStore } from "@/store/ui";
import { clipDuration } from "@/timeline/clips";
import { changeTransition, report } from "@/timeline/editor";
import { timeToX } from "@/timeline/geometry";
import { TRANSITION_LIMITS, TRANSITIONS } from "@/timeline/transitions";

/** Width in px of a transition's block on a clip that is `room` px wide. */
export const transitionWidth = (seconds: number, pps: number, room: number) =>
  Math.min(room, Math.max(10, timeToX(seconds, pps)));

/**
 * A transition on the timeline as a block of its own (its own colour), drawn over the end of its clip it
 * belongs to, as wide as it lasts. It is not part of the clip: a click picks the block (and opens it in the Transition tab), Delete
 * or its ✕ removes just the transition, and the bar on its inner edge is pulled to make it longer or shorter
 * (stored on release, one undo step).
 */
export function TransitionBlock({
  clip,
  way,
  seconds,
  pps,
}: {
  clip: TimelineClip;
  way: "in" | "out";
  /** Its length as applied. */
  seconds: number;
  pps: number;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? seconds;
  const stored = way === "in" ? clip.transitionIn : clip.transitionOut;
  const room = Math.max(2, timeToX(clipDuration(clip), pps));
  const wide = transitionWidth(shown, pps, room);
  const clipLeft = timeToX(clip.timelineStart, pps);
  const left = way === "in" ? clipLeft : clipLeft + room - wide;

  const picked = useUiStore(
    (s) => s.selectedTransition?.clipId === clip.id && s.selectedTransition.way === way,
  );
  const clipSelected = useSelectionStore(
    (s) => s.selectedClipIds.length === 1 && s.selectedClipIds[0] === clip.id,
  );
  const active = picked && clipSelected;

  function onPointerDown(e: ReactPointerEvent<HTMLSpanElement>) {
    if (e.button !== 0 || !stored) return;
    e.stopPropagation(); // not a move of the clip
    e.preventDefault();
    const startX = e.clientX;
    const from = seconds;
    let latest = from;
    const longest = Math.min(TRANSITION_LIMITS.max, clipDuration(clip));
    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) * (way === "in" ? 1 : -1);
      const next = Math.min(longest, Math.max(TRANSITION_LIMITS.min, from + dx / pps));
      latest = Math.round(next * 10) / 10;
      setDraft(latest);
    };
    const done = (commit: boolean) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      setDraft(null);
      if (commit && latest !== stored.duration) {
        report(changeTransition(clip.id, { kind: stored.kind, duration: latest }, way));
      }
    };
    const onUp = () => done(true);
    const onCancel = () => done(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  }

  const kindName = TRANSITIONS.find((k) => k.id === stored?.kind);
  const label = `${way === "in" ? "Transition in" : "Transition out"}: ${
    (way === "in" ? kindName?.name : kindName?.outName) ?? "transition"
  }, ${shown.toFixed(1)} s`;

  /** Pick this block: its clip is selected and this end of it shows in the Transition tab. */
  function open() {
    useSelectionStore.getState().select(clip.id);
    const ui = useUiStore.getState();
    ui.setTransitionWay(way);
    ui.setSelectedTransition({ clipId: clip.id, way });
    for (const kind of ["video", "image"] as const) ui.setInspectorTab(kind, "transition");
  }
  /** Take the transition away; the clip stays. */
  function remove() {
    useUiStore.getState().setSelectedTransition(null);
    report(changeTransition(clip.id, null, way));
  }

  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-pressed={active}
      title={`${label}. Click to pick it, Delete to remove it.`}
      data-testid={`transition-${way}-mark`}
      // a block of its own: a press here is not a press on the clip under it
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        open();
      }}
      onContextMenu={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          open();
        } else if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          e.stopPropagation();
          remove();
        }
      }}
      className={cn(
        "absolute top-[3px] bottom-[3px] z-[5] flex cursor-pointer items-center justify-center overflow-hidden rounded-md border bg-clip-transition text-white shadow-[0_2px_6px_rgb(0_0_0/0.5)] outline-none transition-[filter,border-color] [&_svg]:size-3",
        active
          ? "border-white brightness-125 ring-2 ring-white/80"
          : "border-white/30 hover:brightness-110 focus-visible:ring-2 focus-visible:ring-white",
      )}
      style={{ left, width: wide }}
    >
      {active && wide > 34 ? (
        <button
          type="button"
          aria-label="Remove transition"
          title="Remove transition (Delete)"
          data-testid={`transition-${way}-remove`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            remove();
          }}
          className="flex size-5 items-center justify-center rounded-full bg-white text-clip-transition hover:bg-white/85 pointer-coarse:size-7"
        >
          <X aria-hidden />
        </button>
      ) : (
        wide > 22 && <Blend aria-hidden />
      )}
      <span
        role="slider"
        tabIndex={-1}
        aria-label={way === "in" ? "Length of the transition in" : "Length of the transition out"}
        aria-valuemin={TRANSITION_LIMITS.min}
        aria-valuemax={TRANSITION_LIMITS.max}
        aria-valuenow={shown}
        aria-valuetext={`${shown.toFixed(1)} seconds`}
        title="Drag to change how long the transition lasts"
        onPointerDown={onPointerDown}
        className={cn(
          "pointer-events-auto absolute inset-y-0 w-2 cursor-ew-resize touch-none bg-white/45 hover:bg-white/80 pointer-coarse:w-4",
          way === "in" ? "right-0" : "left-0",
        )}
      />
    </span>
  );
}
