import { useEffect, useRef, useState } from "react";
import { mediaUrl } from "@/lib/media";
import { cn } from "@/lib/utils";
import type { Crop, MediaAsset, TimelineClip } from "@/project/model";
import { CORNER_HANDLES, dragCrop, EDGE_HANDLES, sameCrop, type CropHandle } from "@/timeline/crop";
import { changeCrop, report } from "@/timeline/editor";
import { cropOf, fitLayout, rectStyle } from "@/timeline/fit";

/** The whole picture is shown a little smaller than the preview, so the handles at its edges can be reached. */
const INSET = 0.86;
/** Width of the copy of the video frame that is drawn (it is only a guide while cropping). */
const FRAME_WIDTH = 960;

const HANDLE_PLACE: Record<Exclude<CropHandle, "move">, string> = {
  nw: "left-0 top-0 cursor-nwse-resize",
  ne: "left-full top-0 cursor-nesw-resize",
  sw: "left-0 top-full cursor-nesw-resize",
  se: "left-full top-full cursor-nwse-resize",
  n: "left-1/2 top-0 cursor-ns-resize",
  s: "left-1/2 top-full cursor-ns-resize",
  w: "left-0 top-1/2 cursor-ew-resize",
  e: "left-full top-1/2 cursor-ew-resize",
};

interface Props {
  clip: TimelineClip;
  asset: MediaAsset;
  canvas: { width: number; height: number };
  /** The playing <video> of this clip (its current frame is what gets cropped). */
  video: () => HTMLVideoElement | undefined;
  /** Width / height the crop must keep, when an aspect preset is chosen. */
  lockRatio: number | null;
  onDone: () => void;
}

interface Drag {
  handle: CropHandle;
  fromX: number;
  fromY: number;
  start: Crop;
}

/**
 * Crop box over the preview: the whole, uncropped picture with the kept part highlighted. Drag the box to
 * move it, a handle to resize it. Nothing is saved while dragging; each release is one undo step.
 */
export function CropOverlay({ clip, asset, canvas, video, lockRatio, onDone }: Props) {
  const stored = cropOf(clip);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [draft, setDraft] = useState<Crop | null>(null);
  const picture = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLCanvasElement>(null);
  const crop = draft ?? stored;
  const [srcW, srcH] = [asset.width ?? 0, asset.height ?? 0];
  const locked = lockRatio && srcW > 0 && srcH > 0 ? { ratio: lockRatio, srcW, srcH } : undefined;

  const whole = fitLayout(srcW, srcH, canvas.width, canvas.height, "fit").picture;
  const rect = {
    x: 0.5 - (whole.width * INSET) / 2,
    y: 0.5 - (whole.height * INSET) / 2,
    width: whole.width * INSET,
    height: whole.height * INSET,
  };

  // a video is shown by copying its current frame, so the clip keeps its one decoder
  useEffect(() => {
    if (asset.type !== "video") return;
    let raf = 0;
    const draw = () => {
      const source = video();
      const target = frame.current;
      const ctx = target?.getContext?.("2d");
      if (source && target && ctx && source.videoWidth > 0) {
        const h = Math.max(2, Math.round((FRAME_WIDTH * source.videoHeight) / source.videoWidth));
        if (target.width !== FRAME_WIDTH || target.height !== h) {
          target.width = FRAME_WIDTH;
          target.height = h;
        }
        ctx.drawImage(source, 0, 0, FRAME_WIDTH, h);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [asset.type, video]);

  function begin(e: React.PointerEvent, handle: CropHandle) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    picture.current?.setPointerCapture?.(e.pointerId);
    setDrag({ handle, fromX: e.clientX, fromY: e.clientY, start: stored });
    setDraft(stored);
  }
  function move(e: React.PointerEvent) {
    const box = picture.current?.getBoundingClientRect();
    if (!drag || !box || box.width <= 0 || box.height <= 0) return;
    const dx = (e.clientX - drag.fromX) / box.width;
    const dy = (e.clientY - drag.fromY) / box.height;
    setDraft(dragCrop(drag.start, drag.handle, dx, dy, locked));
  }
  function end() {
    if (!drag) return;
    const result = draft;
    setDrag(null);
    setDraft(null);
    if (result && !sameCrop(result, drag.start)) report(changeCrop(clip.id, result));
  }

  const box = {
    left: `${crop.left * 100}%`,
    top: `${crop.top * 100}%`,
    width: `${(1 - crop.left - crop.right) * 100}%`,
    height: `${(1 - crop.top - crop.bottom) * 100}%`,
  };
  const handles = locked ? CORNER_HANDLES : [...CORNER_HANDLES, ...EDGE_HANDLES];
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <div
      data-testid="crop-overlay"
      role="group"
      aria-label="Crop in the preview"
      className="absolute inset-0 z-[60] touch-none bg-black select-none"
      // presses here never reach what is underneath (dragging text, for example)
      onPointerDown={stop}
      onKeyDown={(e) => {
        if (e.key === "Escape" || e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          onDone();
        }
      }}
    >
      <div
        ref={picture}
        data-testid="crop-picture"
        className="absolute"
        style={rectStyle(rect)}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={() => {
          setDrag(null);
          setDraft(null);
        }}
      >
        {asset.type === "video" ? (
          <canvas ref={frame} aria-hidden className="absolute inset-0 h-full w-full" />
        ) : (
          <img
            src={mediaUrl(asset.path)}
            alt=""
            draggable={false}
            className="absolute inset-0 h-full w-full"
          />
        )}
        {/* everything outside the box is dimmed by the box's own (clipped) shadow */}
        <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute shadow-[0_0_0_9999px_rgba(0,0,0,0.65)]" style={box} />
        </div>
        <div
          data-testid="crop-box"
          className={cn("absolute border border-accent", drag ? "cursor-grabbing" : "cursor-move")}
          style={box}
          onPointerDown={(e) => begin(e, "move")}
        >
          <div aria-hidden className="pointer-events-none absolute inset-0">
            <div className="absolute inset-y-0 left-1/3 w-px bg-white/25" />
            <div className="absolute inset-y-0 left-2/3 w-px bg-white/25" />
            <div className="absolute inset-x-0 top-1/3 h-px bg-white/25" />
            <div className="absolute inset-x-0 top-2/3 h-px bg-white/25" />
          </div>
          {handles.map((handle) => (
            <div
              key={handle}
              data-handle={handle}
              aria-hidden
              onPointerDown={(e) => begin(e, handle)}
              className={cn(
                "absolute flex size-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center pointer-coarse:size-11",
                HANDLE_PLACE[handle as Exclude<CropHandle, "move">],
              )}
            >
              <span className="size-3 rounded-[2px] border border-black/60 bg-accent" />
            </div>
          ))}
        </div>
      </div>

      <div className="absolute inset-x-2 top-2 flex items-center justify-between gap-2">
        <p className="rounded-md bg-black/70 px-2 py-1 text-xs text-text-muted">
          Drag the box to move it, a handle to resize it.
        </p>
        <button
          type="button"
          autoFocus
          onClick={onDone}
          className="h-8 rounded-md bg-accent px-3 text-xs font-medium text-black hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent pointer-coarse:h-11"
        >
          Done
        </button>
      </div>
    </div>
  );
}
