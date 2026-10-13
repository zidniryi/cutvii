import { memo, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Blend, Film, Image as ImageIcon, Music } from "lucide-react";
import { ClipWaveform } from "@/components/timeline/ClipWaveform";
import type { MediaType, TimelineClip } from "@/project/model";
import { clipDuration } from "@/timeline/clips";
import { changeTransition, report } from "@/timeline/editor";
import { timeToX } from "@/timeline/geometry";
import { useSelectionStore } from "@/store/selection";
import { useUiStore } from "@/store/ui";
import { TRANSITION_LIMITS, TRANSITIONS, transitionOf, transitionOutOf } from "@/timeline/transitions";
import { cn } from "@/lib/utils";

const COLOR: Record<MediaType, string> = {
  video: "bg-clip-video",
  audio: "bg-clip-audio",
  image: "bg-clip-image",
};
const ICON = { video: Film, audio: Music, image: ImageIcon } as const;

interface Props {
  clip: TimelineClip;
  name: string;
  type: MediaType;
  pps: number;
  selected: boolean;
  /** Source file not found: drawn dashed/dim so it is obvious before playback fails. */
  missing?: boolean;
  /** File whose audio is drawn in the clip, with the slice (px from the clip's left edge) in view. */
  wavePath?: string;
  waveFrom?: number;
  waveTo?: number;
  /** The clip's track is muted. */
  muted?: boolean;
  onBodyPointerDown: (e: React.PointerEvent, clip: TimelineClip) => void;
  onTrimPointerDown: (e: React.PointerEvent, clip: TimelineClip, edge: "start" | "end") => void;
  onContextMenu: (e: React.MouseEvent, clip: TimelineClip) => void;
  onActivate: (clip: TimelineClip, additive: boolean) => void;
}

/** Width in px of a transition's block on a clip that is `room` px wide. */
const markWidth = (seconds: number, pps: number, room: number) =>
  Math.min(room, Math.max(10, timeToX(seconds, pps)));

/**
 * A transition shown on its clip as a block of its own: darker, at the end it belongs to, as wide as it
 * lasts. Click it to edit it in the Transition tab; Delete removes it (the clip stays). The bar on its
 * inner edge is pulled to make it longer or shorter (stored on release, one undo step).
 */
function TransitionMark({
  clip,
  way,
  seconds,
  pps,
  room,
  clipSelected,
}: {
  clip: TimelineClip;
  /** The clip is the selected one. */
  clipSelected: boolean;
  way: "in" | "out";
  /** Its length as applied. */
  seconds: number;
  pps: number;
  /** Width of the clip in px. */
  room: number;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? seconds;
  const stored = way === "in" ? clip.transitionIn : clip.transitionOut;

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

  const wide = markWidth(shown, pps, room);
  const active = useUiStore((s) => clipSelected && s.transitionWay === way);
  const kindName = TRANSITIONS.find((k) => k.id === stored?.kind);
  const label = `${way === "in" ? "Transition in" : "Transition out"}: ${
    (way === "in" ? kindName?.name : kindName?.outName) ?? "transition"
  }, ${shown.toFixed(1)} s`;
  /** Select the clip and show this end of it in the Transition tab. */
  function open() {
    useSelectionStore.getState().select(clip.id);
    const ui = useUiStore.getState();
    ui.setTransitionWay(way);
    for (const kind of ["video", "image"] as const) ui.setInspectorTab(kind, "transition");
  }
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={label}
      title={`${label}. Click to edit, Delete to remove.`}
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
          // the transition goes, the clip stays
          e.preventDefault();
          e.stopPropagation();
          report(changeTransition(clip.id, null, way));
        }
      }}
      className={cn(
        "absolute inset-y-0 z-[5] flex cursor-pointer items-center justify-center bg-[#1a1408] text-accent outline-none [&_svg]:size-3",
        way === "in" ? "left-0 rounded-l-md" : "right-0 rounded-r-md",
        active ? "ring-2 ring-accent ring-inset" : "ring-1 ring-accent/50 ring-inset focus-visible:ring-2",
      )}
      style={{ width: wide }}
    >
      {wide > 22 && <Blend aria-hidden />}
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
          "pointer-events-auto absolute inset-y-0 w-2 cursor-ew-resize touch-none bg-accent/80 hover:bg-accent pointer-coarse:w-4",
          way === "in" ? "right-0" : "left-0",
        )}
      />
    </span>
  );
}

/** One clip on a lane. Edge handles are wider on touch screens; the body is the move handle. */
export const ClipView = memo(function ClipView({
  clip,
  name,
  type,
  pps,
  selected,
  missing = false,
  wavePath,
  waveFrom = 0,
  waveTo = 0,
  muted = false,
  onBodyPointerDown,
  onTrimPointerDown,
  onContextMenu,
  onActivate,
}: Props) {
  const Icon = ICON[type];
  const width = Math.max(2, timeToX(clipDuration(clip), pps));
  const coming = transitionOf(clip);
  const going = transitionOutOf(clip);
  const handle =
    "absolute top-0 bottom-0 z-10 w-2 cursor-ew-resize touch-none pointer-coarse:w-4 hover:bg-white/25";
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`${name} clip`}
      title={missing ? `${name} — file not found` : name}
      aria-pressed={selected}
      data-clip-id={clip.id}
      onPointerDown={(e) => onBodyPointerDown(e, clip)}
      onContextMenu={(e) => onContextMenu(e, clip)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onActivate(clip, e.shiftKey);
      }}
      className={cn(
        "absolute top-1 bottom-1 flex cursor-grab touch-none items-center gap-1 overflow-hidden rounded-md px-2 text-xs text-text select-none",
        COLOR[type],
        selected
          ? "ring-2 ring-accent"
          : missing
            ? "ring-2 ring-danger/70 ring-offset-0"
            : "ring-1 ring-black/40",
        missing && "opacity-60",
      )}
      style={{
        left: timeToX(clip.timelineStart, pps),
        width,
        // the name starts after the block of the transition in, and stops before the one of the way out
        paddingLeft: coming && clip.transitionIn ? markWidth(coming.seconds, pps, width) + 6 : undefined,
        paddingRight: going && clip.transitionOut ? markWidth(going.seconds, pps, width) + 6 : undefined,
      }}
    >
      <div
        data-testid="trim-start"
        className={cn(handle, "left-0")}
        onPointerDown={(e) => {
          e.stopPropagation();
          onTrimPointerDown(e, clip, "start");
        }}
      />
      {/* its transitions: a darker block of its own at each end, as wide as the transition lasts */}
      {coming && clip.transitionIn && (
        <TransitionMark
          clip={clip}
          way="in"
          seconds={coming.seconds}
          pps={pps}
          room={width}
          clipSelected={selected}
        />
      )}
      {going && clip.transitionOut && (
        <TransitionMark
          clip={clip}
          way="out"
          seconds={going.seconds}
          pps={pps}
          room={width}
          clipSelected={selected}
        />
      )}
      {wavePath && waveTo > waveFrom && (
        <ClipWaveform path={wavePath} clip={clip} pps={pps} from={waveFrom} to={waveTo} muted={muted} />
      )}
      <Icon className="relative size-3.5 shrink-0 opacity-80" />
      <span className="relative truncate">{name}</span>
      <div
        data-testid="trim-end"
        className={cn(handle, "right-0")}
        onPointerDown={(e) => {
          e.stopPropagation();
          onTrimPointerDown(e, clip, "end");
        }}
      />
    </div>
  );
});
