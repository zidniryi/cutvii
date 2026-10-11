/** Pure crop math for the crop box in the preview and the aspect presets ("reframe"). */
import { MAX_CROP, type Crop } from "@/project/model";

/** The least that must be left of the picture along each axis. */
export const MIN_KEPT = 1 - MAX_CROP;

export type CropHandle = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
export const CORNER_HANDLES: CropHandle[] = ["nw", "ne", "sw", "se"];
export const EDGE_HANDLES: CropHandle[] = ["n", "s", "w", "e"];

export const CROP_PRESETS: { id: string; ratio: number }[] = [
  { id: "16:9", ratio: 16 / 9 },
  { id: "9:16", ratio: 9 / 16 },
  { id: "1:1", ratio: 1 },
  { id: "4:5", ratio: 4 / 5 },
  { id: "4:3", ratio: 4 / 3 },
];

const round = (v: number) => Math.round(v * 1000) / 1000;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** Width / height of what a crop keeps of a `srcW x srcH` picture. */
export function keptAspect(srcW: number, srcH: number, c: Crop): number {
  return (srcW * (1 - c.left - c.right)) / (srcH * (1 - c.top - c.bottom));
}

/** The largest centred crop of a `srcW x srcH` picture with the given width / height ratio. */
export function cropForAspect(srcW: number, srcH: number, ratio: number): Crop {
  const relative = ratio / (srcW / srcH); // < 1: the wanted shape is narrower than the picture
  const keptW = relative < 1 ? Math.max(MIN_KEPT, relative) : 1;
  const keptH = relative < 1 ? 1 : Math.max(MIN_KEPT, 1 / relative);
  const side = round((1 - keptW) / 2);
  const end = round((1 - keptH) / 2);
  return { left: side, right: side, top: end, bottom: end };
}

/**
 * The crop after dragging `handle` by (`dx`, `dy`), given in shares of the whole picture.
 * `move` slides the box without resizing it. Edges and corners resize it; the box never leaves the picture
 * and never gets smaller than `MIN_KEPT`. With `ratio` (width / height of the kept part, in source pixels)
 * the corners keep that shape and the edges do nothing.
 */
export function dragCrop(
  start: Crop,
  handle: CropHandle,
  dx: number,
  dy: number,
  locked?: { ratio: number; srcW: number; srcH: number },
): Crop {
  let x0 = start.left;
  let y0 = start.top;
  let x1 = 1 - start.right;
  let y1 = 1 - start.bottom;

  if (handle === "move") {
    const mx = clamp(dx, -x0, 1 - x1);
    const my = clamp(dy, -y0, 1 - y1);
    [x0, x1, y0, y1] = [x0 + mx, x1 + mx, y0 + my, y1 + my];
  } else if (locked) {
    if (handle.length !== 2) return start; // edges cannot keep a shape
    // height of the box per unit of width, both as shares of the picture
    const k = locked.srcW / locked.srcH / locked.ratio;
    const west = handle.includes("w");
    const north = handle.includes("n");
    const wantW = west ? x1 - (x0 + dx) : x1 + dx - x0;
    const wantH = north ? y1 - (y0 + dy) : y1 + dy - y0;
    const roomW = west ? x1 : 1 - x0;
    const roomH = north ? y1 : 1 - y0;
    const smallest = Math.max(MIN_KEPT, MIN_KEPT / k);
    const largest = Math.min(roomW, roomH / k);
    if (largest < smallest) return start;
    // follow whichever way the pointer moved more, so the corner can be pulled in along either side
    const w = clamp(Math.abs(dx) >= Math.abs(dy) / k ? wantW : wantH / k, smallest, largest);
    if (west) x0 = x1 - w;
    else x1 = x0 + w;
    if (north) y0 = y1 - w * k;
    else y1 = y0 + w * k;
  } else {
    if (handle.includes("w")) x0 = clamp(x0 + dx, 0, x1 - MIN_KEPT);
    if (handle.includes("e")) x1 = clamp(x1 + dx, x0 + MIN_KEPT, 1);
    if (handle.includes("n")) y0 = clamp(y0 + dy, 0, y1 - MIN_KEPT);
    if (handle.includes("s")) y1 = clamp(y1 + dy, y0 + MIN_KEPT, 1);
  }
  return {
    left: Math.max(0, round(x0)),
    top: Math.max(0, round(y0)),
    right: Math.max(0, round(1 - x1)),
    bottom: Math.max(0, round(1 - y1)),
  };
}

export const sameCrop = (a: Crop, b: Crop) =>
  a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
