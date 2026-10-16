import { useEffect, useRef, useState } from "react";
import type { MediaAsset, TimelineClip } from "@/project/model";
import { usePlaybackStore } from "@/store/playback";
import { useUiStore } from "@/store/ui";
import { changeTransformAt, report } from "@/timeline/editor";
import {
  boxCorners,
  centreOf,
  keepCentre,
  layerBox,
  moved,
  ownTransformAt,
  ROTATE_STEP,
  rotatedFrom,
  scaledFrom,
  type Pt,
} from "@/timeline/transformBox";
import { TRANSFORM_LIMITS } from "@/project/model";
import type { Transform } from "@/timeline/transform";
import { PositionGuides } from "./PositionGuides";

/** Visible size of a handle (px); on a touch screen the grab area is larger. */
const HANDLE = 12;
/** How far the turn handle sits beyond the top edge (screen px). */
const ROTATE_OFFSET = 30;
/** Pointer travel (screen px) before a press on the box counts as a move. */
const MOVE_SLOP = 3;
/** A trackpad pinch sends no end event: the change is saved when it has been quiet for this long. */
const WHEEL_SETTLE_MS = 250;

type Mode = "move" | "scale" | "rotate";
interface Drag {
  mode: Mode;
  /** Pointer at the start, in canvas px. */
  from: Pt;
  fromScreen: Pt;
  start: Transform;
  moving: boolean;
}

type Patch = Partial<Record<"x" | "y" | "scale" | "rotation", number>>;

/**
 * Box over the selected clip in the preview: drag the box to move, a corner to resize, the round handle to
 * turn (Shift = steps of 15 degrees, Alt = no snapping). On a Mac trackpad, pinch resizes and a two-finger
 * twist turns. Nothing is saved while dragging; each gesture is one undo step. The values are the
 * inspector's Transform values, so the export follows.
 */
export function TransformOverlay({
  clip,
  asset,
  canvas,
}: {
  clip: TimelineClip;
  asset: MediaAsset;
  canvas: { width: number; height: number };
}) {
  const root = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  // the stage's width on screen, to turn screen px (handle sizes) into canvas px
  const [stageWidth, setStageWidth] = useState(0);
  const [guides, setGuides] = useState<{ vertical: number[]; horizontal: number[] } | null>(null);
  const draft = useUiStore((s) => (s.transformDraft?.clipId === clip.id ? s.transformDraft.patch : null));
  const playhead = usePlaybackStore((s) => s.playhead);

  const box = layerBox(clip, asset, canvas);
  const stored = ownTransformAt(clip, playhead);
  const t: Transform = { ...stored, ...draft };
  const corners = boxCorners(box, t, canvas);
  const centre = centreOf(corners);

  /** Window position to canvas px. */
  const toCanvas = (e: { clientX: number; clientY: number }): Pt => {
    const r = root.current!.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * canvas.width,
      y: ((e.clientY - r.top) / r.height) * canvas.height,
    };
  };
  const screenScale = stageWidth > 0 ? canvas.width / stageWidth : 1;
  const setDraftPatch = (patch: Patch | null) =>
    useUiStore.getState().setTransformDraft(patch ? { clipId: clip.id, patch } : null);
  const commit = (patch: Patch) => {
    useUiStore.getState().setTransformDraft(null);
    setGuides(null);
    report(changeTransformAt(clip.id, patch, usePlaybackStore.getState().playhead));
  };
  const round = (v: number, d = 1000) => Math.round(v * d) / d;

  function press(mode: Mode, e: React.PointerEvent<Element>) {
    if (e.button !== 0 || drag) return;
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDrag({ mode, from: toCanvas(e), fromScreen: { x: e.clientX, y: e.clientY }, start: t, moving: false });
  }

  /** The values the pointer at `e` gives for the drag. */
  function patchFor(d: Drag, e: React.PointerEvent<Element>): { patch: Patch; guides?: typeof guides } {
    const to = toCanvas(e);
    if (d.mode === "move") {
      const r = moved(d.start, box, canvas, to.x - d.from.x, to.y - d.from.y, e.altKey);
      return {
        patch: { x: round(r.x), y: round(r.y) },
        guides: { vertical: r.vertical, horizontal: r.horizontal },
      };
    }
    const c = centreOf(boxCorners(box, d.start, canvas));
    const next =
      d.mode === "scale"
        ? { ...d.start, scale: scaledFrom(d.start.scale, c, d.from, to) }
        : {
            ...d.start,
            rotation: rotatedFrom(d.start.rotation, c, d.from, to, e.shiftKey ? ROTATE_STEP : 0),
          };
    const kept = keepCentre(d.start, next, box, canvas);
    return d.mode === "scale"
      ? { patch: { scale: round(kept.scale), x: round(kept.x), y: round(kept.y) } }
      : { patch: { rotation: kept.rotation, x: round(kept.x), y: round(kept.y) } };
  }

  function onMove(e: React.PointerEvent<Element>) {
    if (!drag) return;
    const travelled = Math.hypot(e.clientX - drag.fromScreen.x, e.clientY - drag.fromScreen.y);
    if (!drag.moving && travelled < MOVE_SLOP) return;
    if (!drag.moving) setDrag({ ...drag, moving: true });
    const { patch, guides: g } = patchFor(drag, e);
    setDraftPatch(patch);
    setGuides(g ?? null);
  }

  function onUp(e: React.PointerEvent<Element>) {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    if (!d.moving) return;
    commit(patchFor(d, e).patch);
  }

  function cancel() {
    setDrag(null);
    setDraftPatch(null);
    setGuides(null);
  }

  // Escape puts a gesture back
  useEffect(() => {
    if (!drag) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && cancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Mac trackpad: WebKit's gesture events (pinch = scale, twist = rotation) and ctrl + wheel (pinch elsewhere)
  const live = useRef({ t, box, canvas, clip });
  useEffect(() => {
    live.current = { t, box, canvas, clip };
  });
  useEffect(() => {
    const el = root.current?.parentElement;
    if (!el) return;
    let start: Transform | null = null;
    let patch: Patch | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const apply = (next: Transform) => {
      const { box: b, canvas: c, t: current } = live.current;
      const kept = keepCentre(current, next, b, c);
      patch = {
        scale: round(kept.scale),
        rotation: kept.rotation,
        x: round(kept.x),
        y: round(kept.y),
      };
      useUiStore.getState().setTransformDraft({ clipId: live.current.clip.id, patch });
    };
    const finish = () => {
      clearTimeout(timer);
      const done = patch;
      start = null;
      patch = null;
      if (done) commit(done);
    };
    type GestureEvent = Event & { scale: number; rotation: number };
    const onStart = (e: Event) => {
      e.preventDefault();
      start = live.current.t;
    };
    const onChange = (e: Event) => {
      e.preventDefault();
      const g = e as GestureEvent;
      if (!start) start = live.current.t;
      const { minScale, maxScale } = TRANSFORM_LIMITS;
      apply({
        ...start,
        scale: Math.min(maxScale, Math.max(minScale, start.scale * g.scale)),
        rotation: rotatedFrom(start.rotation, { x: 0, y: 0 }, { x: 1, y: 0 }, rotationPoint(g.rotation)),
      });
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      if (!start) start = live.current.t;
      const { minScale, maxScale } = TRANSFORM_LIMITS;
      const current = patch?.scale ?? start.scale;
      apply({
        ...start,
        scale: Math.min(maxScale, Math.max(minScale, current * Math.exp(-e.deltaY * 0.01))),
      });
      clearTimeout(timer);
      timer = setTimeout(finish, WHEEL_SETTLE_MS);
    };
    el.addEventListener("gesturestart", onStart);
    el.addEventListener("gesturechange", onChange);
    el.addEventListener("gestureend", finish);
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("gesturestart", onStart);
      el.removeEventListener("gesturechange", onChange);
      el.removeEventListener("gestureend", finish);
      el.removeEventListener("wheel", onWheel);
      clearTimeout(timer);
    };
    // the handlers read the latest values through `live`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const measure = () => setStageWidth(el.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // the draft belongs to this clip: let go of it when the clip changes or the box goes away
  useEffect(() => () => useUiStore.getState().setTransformDraft(null), [clip.id]);

  const pct = (p: Pt) => ({ left: `${(p.x / canvas.width) * 100}%`, top: `${(p.y / canvas.height) * 100}%` });
  const points = corners.map((p) => `${p.x},${p.y}`).join(" ");
  // the turn handle: out from the box centre through the middle of the top edge
  const topMid = { x: (corners[0].x + corners[1].x) / 2, y: (corners[0].y + corners[1].y) / 2 };
  const len = Math.hypot(topMid.x - centre.x, topMid.y - centre.y) || 1;
  const out = ROTATE_OFFSET * screenScale;
  const rotateAt = {
    x: topMid.x + ((topMid.x - centre.x) / len) * out,
    y: topMid.y + ((topMid.y - centre.y) / len) * out,
  };
  const cursors = ["nwse-resize", "nesw-resize", "nwse-resize", "nesw-resize"];

  return (
    <div ref={root} data-testid="transform-overlay" className="pointer-events-none absolute inset-0 z-30">
      <svg
        aria-hidden
        className="absolute inset-0 size-full overflow-visible"
        viewBox={`0 0 ${canvas.width} ${canvas.height}`}
        preserveAspectRatio="none"
      >
        <polygon
          data-testid="transform-body"
          points={points}
          fill="transparent"
          stroke="var(--accent)"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
          style={{ pointerEvents: "all", cursor: drag?.mode === "move" && drag.moving ? "grabbing" : "grab" }}
          onPointerDown={(e) => press("move", e)}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={cancel}
        />
        <line
          x1={topMid.x}
          y1={topMid.y}
          x2={rotateAt.x}
          y2={rotateAt.y}
          stroke="var(--accent)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {corners.map((p, i) => (
        <button
          key={i}
          type="button"
          tabIndex={-1}
          aria-label="Resize"
          data-handle="scale"
          className="pointer-events-auto absolute flex size-11 -translate-x-1/2 -translate-y-1/2 touch-none items-center justify-center pointer-fine:size-6"
          style={{ ...pct(p), cursor: cursors[i] }}
          onPointerDown={(e) => press("scale", e)}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={cancel}
        >
          <span
            className="block rounded-[3px] border-2 border-accent bg-bg"
            style={{ width: HANDLE, height: HANDLE }}
          />
        </button>
      ))}
      <button
        type="button"
        tabIndex={-1}
        aria-label="Rotate"
        data-handle="rotate"
        className="pointer-events-auto absolute flex size-11 -translate-x-1/2 -translate-y-1/2 touch-none items-center justify-center pointer-fine:size-6"
        style={{ ...pct(rotateAt), cursor: "grab" }}
        onPointerDown={(e) => press("rotate", e)}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={cancel}
      >
        <span
          className="block rounded-full border-2 border-accent bg-accent"
          style={{ width: HANDLE, height: HANDLE }}
        />
      </button>
      {guides && <PositionGuides safe={false} {...guides} />}
      {drag?.moving && drag.mode === "rotate" && (
        <span
          className="pointer-events-none absolute -translate-x-1/2 rounded bg-bg/90 px-1.5 py-0.5 text-[11px] tabular-nums text-text"
          style={{ ...pct({ x: centre.x, y: rotateAt.y - 24 * screenScale }) }}
        >
          {Math.round(t.rotation)}°
        </span>
      )}
    </div>
  );
}

/** A point at `deg` degrees from the +x axis, so a gesture's rotation can reuse `rotatedFrom`. */
const rotationPoint = (deg: number): Pt => ({
  x: Math.cos((deg * Math.PI) / 180),
  y: Math.sin((deg * Math.PI) / 180),
});
