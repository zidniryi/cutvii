import { memo, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Film, Image as ImageIcon, Music } from "lucide-react";
import { ClipWaveform } from "@/components/timeline/ClipWaveform";
import type { MediaType, TimelineClip } from "@/project/model";
import { formatDuration } from "@/lib/timecode";
import { MAX_FADE, smoothStep, soundFadesOf } from "@/timeline/audio";
import { clipDuration } from "@/timeline/clips";
import { changeClipSound, report } from "@/timeline/editor";
import { timeToX } from "@/timeline/geometry";
import { useSelectionStore } from "@/store/selection";
import { useUiStore } from "@/store/ui";
import { useWaveformStore } from "@/store/waveforms";
import { transitionOf, transitionOutOf } from "@/timeline/transitions";
import { transitionWidth } from "@/components/timeline/TransitionBlock";
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

/** A fade set by dragging or with the arrow keys is kept to 0.01 s, like in the Sound tab. */
const snapFade = (seconds: number) => Math.round(seconds * 100) / 100;
const FADE_KEY_STEP = 0.1;
/**
 * The knob is a 14 px dot inside a 28 px grab area (bigger on touch screens), so a slightly missed press still
 * grabs the fade and does not pick up the clip. The area sits on the end of the ramp, never outside the clip.
 */
const GRAB_PX = 28;
/** The knob of a fade shows while the pointer is this close to that end of the clip (or nearer than its ramp). */
const EDGE_ZONE_PX = 64;

/** The ramp drawn in a 1 x 1 box (y down): the same half-sine curve the sound follows, as short lines. */
const RAMP_SAMPLES = 20;
const curve = (way: "in" | "out") =>
  Array.from({ length: RAMP_SAMPLES + 1 }, (_, i) => {
    const u = i / RAMP_SAMPLES;
    return `${u.toFixed(3)},${(1 - smoothStep(way === "in" ? u : 1 - u)).toFixed(3)}`;
  });
const RAMP = {
  in: { line: curve("in").join(" "), area: ["0,0", ...curve("in")].join(" ") },
  out: { line: curve("out").join(" "), area: [...curve("out"), "1,0"].join(" ") },
} as const;

/**
 * The sound's fade at one end of a clip: a darker ramp shows the volume going up (in) or down (out), and a
 * knob on the ramp's end is dragged along the clip to make it longer or shorter. The change is stored on
 * release (one undo step); the bars of the waveform follow it while dragging. Double-click, or Delete, removes
 * the fade; the arrow keys change it by 0.1 s.
 */
function FadeHandle({
  clip,
  way,
  seconds,
  longest,
  pps,
  room,
  revealed,
  touchShown,
  onDraft,
}: {
  clip: TimelineClip;
  way: "in" | "out";
  /** The fade as shown now (applied, or the value being dragged). */
  seconds: number;
  /** The most it can be made without squeezing the fade at the other end. */
  longest: number;
  pps: number;
  /** Width of the clip in px. */
  room: number;
  /** The pointer is near this end of the clip: the knob fades in. It is also there while dragging. */
  revealed: boolean;
  /** The clip is selected: on a touch screen, where there is no hover, the knob stays in view. */
  touchShown: boolean;
  /** The length being dragged, or null when the drag is over. */
  onDraft: (seconds: number | null) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const side = way === "in" ? "left" : "right";
  const wide = Math.min(room, Math.max(0, timeToX(seconds, pps)));
  const label = way === "in" ? "Sound fade in" : "Sound fade out";
  const commit = (value: number) => {
    const next = snapFade(Math.min(longest, Math.max(0, value)));
    report(changeClipSound(clip.id, way === "in" ? { fadeIn: next } : { fadeOut: next }));
  };

  function onPointerDown(e: ReactPointerEvent<HTMLSpanElement>) {
    if (e.button !== 0) return;
    e.stopPropagation(); // not a move of the clip
    e.preventDefault();
    // editing a clip's fade makes it the selected one, so the Sound tab shows the same value
    useSelectionStore.getState().select(clip.id);
    const startX = e.clientX;
    const from = seconds;
    let latest = from;
    let moved = false;
    setDragging(true);
    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) * (way === "in" ? 1 : -1);
      latest = Math.min(longest, Math.max(0, from + dx / pps));
      moved = moved || Math.abs(ev.clientX - startX) > 1;
      onDraft(snapFade(latest));
    };
    const done = (apply: boolean) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      setDragging(false);
      onDraft(null);
      if (apply && moved) commit(latest);
    };
    const onUp = () => done(true);
    const onCancel = () => done(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  }

  const grow = way === "in" ? "ArrowRight" : "ArrowLeft";
  const shrink = way === "in" ? "ArrowLeft" : "ArrowRight";

  return (
    <>
      {wide > 0 && (
        <svg
          aria-hidden
          data-testid={`fade-${way}-ramp`}
          viewBox="0 0 1 1"
          preserveAspectRatio="none"
          className="pointer-events-none absolute inset-y-0 z-[2]"
          style={{ [side]: 0, width: wide, height: "100%" }}
        >
          <polygon points={RAMP[way].area} fill="rgba(0, 0, 0, 0.38)" />
          <polyline
            points={RAMP[way].line}
            fill="none"
            stroke="rgba(255, 255, 255, 0.75)"
            strokeWidth={1.5}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      )}
      <span
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={longest}
        aria-valuenow={seconds}
        aria-valuetext={`${seconds.toFixed(1)} seconds`}
        data-testid={`fade-${way}-handle`}
        onPointerDown={onPointerDown}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => {
          e.stopPropagation();
          commit(0);
        }}
        onContextMenu={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === grow || e.key === shrink) {
            e.preventDefault();
            e.stopPropagation();
            commit(seconds + (e.key === grow ? FADE_KEY_STEP : -FADE_KEY_STEP));
          } else if (e.key === "Delete" || e.key === "Backspace") {
            e.preventDefault();
            e.stopPropagation();
            commit(0);
          }
        }}
        // above the trim handles (z-10): a press at the corner is the fade's, not a trim of the clip
        className={cn(
          "group/fade absolute top-0 z-[11] flex cursor-ew-resize touch-none items-start justify-center outline-none",
          "pointer-coarse:h-9 pointer-coarse:w-9",
          dragging && "cursor-grabbing",
        )}
        style={{
          [side]: Math.min(Math.max(0, wide - GRAB_PX / 2), Math.max(0, room - GRAB_PX)),
          width: GRAB_PX,
          height: GRAB_PX,
        }}
      >
        <span
          aria-hidden
          className={cn(
            "mt-[7px] size-3.5 rounded-full border-2 border-white bg-accent shadow-[0_1px_4px_rgb(0_0_0/0.5)]",
            "transition-[opacity,transform] duration-150 ease-out",
            "group-hover/fade:scale-125 group-focus-visible/fade:scale-125 group-focus-visible/fade:opacity-100 group-focus-visible/fade:ring-2 group-focus-visible/fade:ring-white",
            dragging && "scale-125",
            revealed || dragging ? "scale-100 opacity-100" : "scale-75 opacity-0",
            touchShown && "pointer-coarse:scale-100 pointer-coarse:opacity-100",
          )}
        />
        {/* the length as a small readout instead of a browser tooltip, which would cover the clip's name */}
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute top-7 z-[12] rounded bg-black/80 px-1.5 py-0.5 text-[10px] whitespace-nowrap text-white tabular-nums",
            way === "in" ? "left-0" : "right-0",
            dragging
              ? "opacity-100"
              : "opacity-0 group-hover/fade:opacity-100 group-focus-visible/fade:opacity-100",
          )}
        >
          {way === "in" ? "Fade in" : "Fade out"} {seconds.toFixed(2)} s
        </span>
      </span>
    </>
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
  const length = clipDuration(clip);
  const width = Math.max(2, timeToX(length, pps));
  const coming = transitionOf(clip);
  const going = transitionOutOf(clip);
  // a fade being dragged is shown at once; it is stored when the knob is let go
  const [fadeDraft, setFadeDraft] = useState<{ in: number | null; out: number | null }>({
    in: null,
    out: null,
  });
  const dragged = fadeDraft.in !== null || fadeDraft.out !== null;
  // which end of the clip the pointer is near: only that fade's knob shows
  const [nearEnd, setNearEnd] = useState<"in" | "out" | null>(null);
  const fades = soundFadesOf(
    dragged ? { ...clip, fadeIn: fadeDraft.in ?? clip.fadeIn, fadeOut: fadeDraft.out ?? clip.fadeOut } : clip,
  );
  // a clip with sound that is on: not a still, and not one whose file has no audio at all
  const silent = useWaveformStore((s) => (wavePath ? s.entries[wavePath]?.status === "none" : true));
  const fadable = type !== "image" && !muted && !missing && !silent;
  // at an end that has a transition the sound already fades with it (set in the Sound tab)
  const fadeInHandle = fadable && !(coming && clip.transitionIn);
  const fadeOutHandle = fadable && !(going && clip.transitionOut);
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
      onPointerDown={(e) => {
        useUiStore.getState().setSelectedTransition(null); // pressing the clip itself: Delete is for the clip
        onBodyPointerDown(e, clip);
      }}
      onPointerMove={(e) => {
        if (!fadeInHandle && !fadeOutHandle) return;
        const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
        const inZone = fadeInHandle && x <= Math.max(EDGE_ZONE_PX, timeToX(fades.fadeIn, pps) + GRAB_PX);
        const outZone =
          fadeOutHandle && x >= width - Math.max(EDGE_ZONE_PX, timeToX(fades.fadeOut, pps) + GRAB_PX);
        const next =
          inZone && outZone ? (x < width / 2 ? "in" : "out") : inZone ? "in" : outZone ? "out" : null;
        setNearEnd((current) => (current === next ? current : next));
      }}
      onPointerLeave={() => setNearEnd(null)}
      onContextMenu={(e) => onContextMenu(e, clip)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          useUiStore.getState().setSelectedTransition(null);
          onActivate(clip, e.shiftKey);
        }
      }}
      className={cn(
        "group absolute top-1 bottom-1 flex cursor-grab touch-none items-center gap-1 overflow-hidden rounded-md px-2 text-xs text-text shadow-[inset_0_1px_0_rgb(255_255_255/0.14)] select-none",
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
        paddingLeft:
          coming && clip.transitionIn ? transitionWidth(coming.seconds, pps, width) + 6 : undefined,
        paddingRight:
          going && clip.transitionOut ? transitionWidth(going.seconds, pps, width) + 6 : undefined,
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
      {wavePath && waveTo > waveFrom && (
        <ClipWaveform
          path={wavePath}
          clip={clip}
          pps={pps}
          from={waveFrom}
          to={waveTo}
          muted={muted}
          fadeIn={fades.fadeIn}
          fadeOut={fades.fadeOut}
        />
      )}
      {fadeInHandle && (
        <FadeHandle
          clip={clip}
          way="in"
          seconds={fades.fadeIn}
          longest={Math.min(MAX_FADE, Math.max(0, length - fades.fadeOut))}
          pps={pps}
          room={width}
          revealed={nearEnd === "in"}
          touchShown={selected}
          onDraft={(v) => setFadeDraft((d) => ({ ...d, in: v }))}
        />
      )}
      {fadeOutHandle && (
        <FadeHandle
          clip={clip}
          way="out"
          seconds={fades.fadeOut}
          longest={Math.min(MAX_FADE, Math.max(0, length - fades.fadeIn))}
          pps={pps}
          room={width}
          revealed={nearEnd === "out"}
          touchShown={selected}
          onDraft={(v) => setFadeDraft((d) => ({ ...d, out: v }))}
        />
      )}
      {/* the name sits on its own dark pill, so it stays readable over the bars of the waveform */}
      <div className="relative z-[3] flex min-w-0 items-center gap-1 rounded bg-black/55 px-1.5 py-0.5 backdrop-blur-[2px]">
        <Icon className="size-3.5 shrink-0 opacity-90" />
        <span className="truncate">{name}</span>
        {width > 160 && (
          <span className="shrink-0 pl-1 text-[10px] tabular-nums text-white/60">
            {formatDuration(length)}
          </span>
        )}
      </div>
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
