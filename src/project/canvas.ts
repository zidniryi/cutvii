/** Canvas (width / height / frame rate): templates, detection from the first video, validation. */
import { CanvasSchema, type MediaAsset, type Project } from "./model";

export interface Canvas {
  width: number;
  height: number;
  fps: number;
  /** Exact rate as a fraction, when known (30000/1001 for "29.97"). */
  fpsNum?: number;
  fpsDen?: number;
}

export const FALLBACK_CANVAS: Canvas = { width: 1920, height: 1080, fps: 30, fpsNum: 30, fpsDen: 1 };

export interface PlatformTemplate {
  id: string;
  name: string;
  ratio: string;
  width: number;
  height: number;
  fps: number;
}

/** Templates only fill width, height and frame rate. */
export const PLATFORM_TEMPLATES: PlatformTemplate[] = [
  { id: "reel", name: "Reel / TikTok / Story", ratio: "9:16", width: 1080, height: 1920, fps: 30 },
  { id: "youtube", name: "YouTube", ratio: "16:9", width: 1920, height: 1080, fps: 30 },
  { id: "instagram-post", name: "Instagram Post", ratio: "4:5", width: 1080, height: 1350, fps: 30 },
  { id: "square", name: "Square", ratio: "1:1", width: 1080, height: 1080, fps: 30 },
];

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
const NTSC: [number, number][] = [
  [24000, 1001],
  [30000, 1001],
  [60000, 1001],
  [120000, 1001],
];

/** Exact fraction for a frame rate: integers stay integers, 29.97-style rates become 30000/1001. */
export function rationalFromFps(fps: number): { num: number; den: number } {
  if (Number.isInteger(fps)) return { num: fps, den: 1 };
  for (const [n, d] of NTSC) if (Math.abs(fps - n / d) < 0.005) return { num: n, den: d };
  const num = Math.round(fps * 1000);
  const g = gcd(num, 1000);
  return { num: num / g, den: 1000 / g };
}

export function canvasFromValues(width: number, height: number, fps: number): Canvas {
  const r = rationalFromFps(fps);
  return { width, height, fps: r.num / r.den, fpsNum: r.num, fpsDen: r.den };
}

export function formatFps(fps: number): string {
  return Number.isInteger(fps) ? String(fps) : String(Math.round(fps * 1000) / 1000);
}

export const canvasLabel = (c: Pick<Canvas, "width" | "height" | "fps">) =>
  `${c.width}×${c.height} · ${formatFps(c.fps)} fps`;

// ---------------------------------------------------------------- validation (Custom)

export type CanvasErrors = Partial<Record<"width" | "height" | "fps", string>>;

/** Validate user-entered canvas values with the same Zod rules the project file uses. */
export function validateCanvas(input: {
  width: unknown;
  height: unknown;
  fps: unknown;
}): { ok: true; canvas: Canvas } | { ok: false; errors: CanvasErrors } {
  const parsed = CanvasSchema.safeParse(input);
  if (parsed.success)
    return { ok: true, canvas: canvasFromValues(parsed.data.width, parsed.data.height, parsed.data.fps) };

  const errors: CanvasErrors = {};
  for (const issue of parsed.error.issues) {
    const key = issue.path[0] as keyof CanvasErrors;
    if (key && !errors[key]) errors[key] = issue.message;
  }
  return { ok: false, errors };
}

/** "" and junk become NaN so validation reports "must be a number" instead of silently using 0. */
export const toNumber = (text: string): number => (text.trim() === "" ? Number.NaN : Number(text));

/** With the aspect lock on: the other side that keeps `ratio` (= width / height), as an even number. */
export function lockedSide(value: number, ratio: number, changed: "width" | "height"): number {
  const other = changed === "width" ? value / ratio : value * ratio;
  return Math.max(2, Math.round(other / 2) * 2);
}

// ---------------------------------------------------------------- Original (follow the first video)

export interface OriginalResult {
  canvas: Canvas;
  /** True when the media could not provide a canvas and 1920x1080 @ 30 was used. */
  fallback: boolean;
  /** Plain-language notes for the user (why a fallback, what was adjusted). */
  notes: string[];
}

const evenDown = (n: number) => n - (n % 2);

/**
 * Canvas for "Original": the size and exact frame rate of the first video.
 * `width`/`height` are already the displayed size (the Rust probe applies rotation metadata).
 * Odd sizes are rounded down to even; sizes beyond the limit are scaled down keeping the aspect ratio.
 */
export function canvasFromAsset(
  asset: Pick<MediaAsset, "type" | "width" | "height" | "fpsNum" | "fpsDen">,
): OriginalResult {
  const fallback = (why: string): OriginalResult => ({
    canvas: { ...FALLBACK_CANVAS },
    fallback: true,
    notes: [why],
  });

  if (asset.type !== "video") {
    return fallback(`The first media is ${asset.type === "image" ? "an image" : "audio"}, not a video`);
  }
  if (!asset.width || !asset.height) return fallback("The video's size could not be read");

  const { minSide, maxSide, minFps, maxFps } = { minSide: 16, maxSide: 8192, minFps: 1, maxFps: 120 };
  const notes: string[] = [];
  let w = asset.width;
  let h = asset.height;

  if (Math.max(w, h) > maxSide) {
    const k = maxSide / Math.max(w, h);
    w = Math.floor(w * k);
    h = Math.floor(h * k);
    notes.push(`scaled down to fit ${maxSide} px`);
  }
  const evenW = evenDown(w);
  const evenH = evenDown(h);
  if (evenW !== w || evenH !== h) notes.push(`odd size ${w}×${h} rounded down to even`);
  if (evenW < minSide || evenH < minSide) return fallback(`The video is smaller than ${minSide} px`);

  let fps = 30;
  let fpsNum: number | undefined = 30;
  let fpsDen: number | undefined = 1;
  if (asset.fpsNum && asset.fpsDen) {
    const value = asset.fpsNum / asset.fpsDen;
    if (value >= minFps && value <= maxFps) {
      fps = value;
      fpsNum = asset.fpsNum;
      fpsDen = asset.fpsDen;
    } else {
      notes.push(
        `frame rate ${formatFps(Math.round(value * 100) / 100)} fps is outside ${minFps}–${maxFps}, using 30`,
      );
    }
  } else {
    notes.push("frame rate unknown, using 30");
  }

  return { canvas: { width: evenW, height: evenH, fps, fpsNum, fpsDen }, fallback: false, notes };
}

// ---------------------------------------------------------------- applying to a project

/** Same project with a new canvas. `pending` marks "Original, waiting for the first media". */
export function withCanvas(project: Project, canvas: Canvas, pending = false): Project {
  const { canvasPending: _drop, fpsNum: _n, fpsDen: _d, ...rest } = project.settings;
  void _drop;
  void _n;
  void _d;
  return {
    ...project,
    settings: {
      ...rest,
      width: canvas.width,
      height: canvas.height,
      fps: canvas.fps,
      ...(canvas.fpsNum !== undefined && canvas.fpsDen !== undefined
        ? { fpsNum: canvas.fpsNum, fpsDen: canvas.fpsDen }
        : {}),
      ...(pending ? { canvasPending: true } : {}),
    },
  };
}

export const canvasOf = (p: Project): Canvas => ({
  width: p.settings.width,
  height: p.settings.height,
  fps: p.settings.fps,
  fpsNum: p.settings.fpsNum,
  fpsDen: p.settings.fpsDen,
});
