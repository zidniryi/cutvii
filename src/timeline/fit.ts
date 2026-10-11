/**
 * How a picture is scaled to the canvas. One set of rules, used by the preview and mirrored by the export
 * filter graph (`src-tauri/src/export/plan.rs`): the picture is never shown at its native pixel size.
 */
import type { Crop, FitBackground, FitMode, TimelineClip } from "@/project/model";

export { MAX_CROP } from "@/project/model";

export const DEFAULT_FIT_MODE: FitMode = "fill";
/** Blur strength for "blur-bg", as a fraction of the canvas height (export uses the same 3 %). */
export const BLUR_FRACTION = 0.03;

/** A rectangle in canvas fractions: 0..1 is inside the canvas, values outside it are cropped away. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FitLayout {
  /** Where the sharp picture goes. */
  picture: Rect;
  /** The blurred, covering copy behind it ("blur-bg" only). */
  backdrop?: Rect;
}

function centred(width: number, height: number): Rect {
  return { x: (1 - width) / 2, y: (1 - height) / 2, width, height };
}

/**
 * Layout of a `srcW x srcH` picture on a `canvasW x canvasH` canvas.
 * - fit: the whole picture, as large as it can be; the rest of the canvas shows the background.
 * - fill: the canvas is covered; whatever overflows is cropped equally on both sides.
 * - blur-bg: "fit" in front of a "fill" copy of the same picture (which the renderer blurs).
 */
export function fitLayout(
  srcW: number,
  srcH: number,
  canvasW: number,
  canvasH: number,
  mode: FitMode,
): FitLayout {
  if (!(srcW > 0 && srcH > 0 && canvasW > 0 && canvasH > 0)) return { picture: centred(1, 1) };
  const relative = srcW / srcH / (canvasW / canvasH); // > 1: the picture is wider than the canvas
  const contain = relative >= 1 ? centred(1, 1 / relative) : centred(relative, 1);
  const cover = relative >= 1 ? centred(relative, 1) : centred(1, 1 / relative);

  if (mode === "fit") return { picture: contain };
  if (mode === "blur-bg") return { picture: contain, backdrop: cover };
  return { picture: cover };
}

/** CSS for a `Rect` inside a positioned container. */
export const rectStyle = (r: Rect) => ({
  left: `${r.x * 100}%`,
  top: `${r.y * 100}%`,
  width: `${r.width * 100}%`,
  height: `${r.height * 100}%`,
});

export const DEFAULT_BLUR_AMOUNT = 30;
export const DEFAULT_FIT_BACKGROUND: FitBackground = { kind: "black" };

/** The clip's background with defaults filled in. */
export function backgroundOf(clip: Pick<TimelineClip, "fitBackground">): FitBackground & { blur: number } {
  const bg = clip.fitBackground ?? DEFAULT_FIT_BACKGROUND;
  return { ...bg, blur: bg.blur ?? DEFAULT_BLUR_AMOUNT };
}

/** The colour to paint behind the picture ("image" falls back to black until the image is drawn over it). */
export const backgroundColor = (bg: FitBackground) =>
  bg.kind === "color" && bg.color ? bg.color : "#000000";

/** Blur radius as a fraction of the canvas height: amount 30 -> 3 % (the export uses the same number). */
export const blurFraction = (amount: number) => Math.min(100, Math.max(0, amount)) / 1000;

/** The background choice matters when the picture can leave canvas uncovered. */
export const showsBackground = (mode: FitMode) => mode !== "fill";

export const NO_CROP: Crop = { left: 0, top: 0, right: 0, bottom: 0 };
export const cropOf = (clip: Pick<TimelineClip, "crop">): Crop => clip.crop ?? NO_CROP;
export const isCropped = (c: Crop) => c.left > 0 || c.top > 0 || c.right > 0 || c.bottom > 0;

/** Size of what is left of a `width x height` picture after cropping: this is what gets fitted to the canvas. */
export const croppedSize = (width: number, height: number, c: Crop) => ({
  width: width * (1 - c.left - c.right),
  height: height * (1 - c.top - c.bottom),
});

/**
 * CSS for a whole picture inside a clipping frame that should show only its kept part: the picture is
 * enlarged and shifted so the kept part exactly fills the frame (the export crops the same shares).
 */
export function cropInnerStyle(c: Crop) {
  const keptW = 1 - c.left - c.right;
  const keptH = 1 - c.top - c.bottom;
  return {
    left: `${(-c.left / keptW) * 100}%`,
    top: `${(-c.top / keptH) * 100}%`,
    width: `${100 / keptW}%`,
    height: `${100 / keptH}%`,
  };
}
