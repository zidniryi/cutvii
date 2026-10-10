/**
 * How a picture is scaled to the canvas. One set of rules, used by the preview and mirrored by the export
 * filter graph (`src-tauri/src/export/plan.rs`): the picture is never shown at its native pixel size.
 */
import type { FitBackground, FitMode, TimelineClip } from "@/project/model";

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
