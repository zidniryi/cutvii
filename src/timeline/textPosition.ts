/**
 * Where a text sits on the canvas. A position is only ever the text's `x` / `y` (shares of the canvas):
 * the anchor grid, the safe margin and snapping all just work out those two numbers.
 */
import { invoke } from "@tauri-apps/api/core";
import { TextSpecSchema, type Project, type TextSpec, type TimelineClip } from "@/project/model";
import { useProjectStore } from "@/store/project";
import { applyTextEdit, HIT_PADDING, textHitBox } from "./text";

export interface Position {
  x: number;
  y: number;
}
export interface Canvas {
  width: number;
  height: number;
}

/** The share of the canvas kept free at every edge when "Safe margin" is on. */
export const SAFE_MARGIN = 0.05;
/** How close (share of the canvas) a dragged text must come to a guide to snap onto it. */
export const SNAP_DISTANCE = 0.015;
export const DEFAULT_TEXT_POSITION: Position = { x: 0.5, y: 0.5 };
export const DEFAULT_SUBTITLE_POSITION: Position = { x: 0.5, y: 0.88 };

export const ANCHORS = [
  { id: "top-left", label: "Top left", col: 0, row: 0 },
  { id: "top-center", label: "Top centre", col: 1, row: 0 },
  { id: "top-right", label: "Top right", col: 2, row: 0 },
  { id: "middle-left", label: "Middle left", col: 0, row: 1 },
  { id: "center", label: "Centre", col: 1, row: 1 },
  { id: "middle-right", label: "Middle right", col: 2, row: 1 },
  { id: "bottom-left", label: "Bottom left", col: 0, row: 2 },
  { id: "bottom-center", label: "Bottom centre", col: 1, row: 2 },
  { id: "bottom-right", label: "Bottom right", col: 2, row: 2 },
] as const;
export type AnchorId = (typeof ANCHORS)[number]["id"];

const round = (v: number) => Math.round(v * 1000) / 1000;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
export const samePosition = (a: Position, b: Position) =>
  Math.abs(a.x - b.x) < 0.0015 && Math.abs(a.y - b.y) < 0.0015;

/** About where the words themselves are (shares of the canvas), with the text at `at`. */
export function textBounds(spec: TextSpec, canvas: Canvas, at: Position = spec) {
  const box = textHitBox({ ...spec, x: at.x, y: at.y }, canvas.width, canvas.height);
  return {
    left: box.left + HIT_PADDING,
    right: box.right - HIT_PADDING,
    top: box.top + HIT_PADDING,
    bottom: box.bottom - HIT_PADDING,
  };
}

/**
 * The `x` / `y` that put the words at an anchor: against the safe margin (or the canvas edge when `safe`
 * is off) for the outer rows and columns, centred for the middle ones. Alignment is not touched.
 */
export function anchorPosition(anchor: AnchorId, spec: TextSpec, canvas: Canvas, safe: boolean): Position {
  const { col, row } = ANCHORS.find((a) => a.id === anchor)!;
  const margin = safe ? SAFE_MARGIN : 0;
  const b = textBounds(spec, canvas);
  const toLeft = spec.x - b.left;
  const toRight = b.right - spec.x;
  const half = (b.bottom - b.top) / 2;
  const x = col === 0 ? margin + toLeft : col === 2 ? 1 - margin - toRight : 0.5 + (toLeft - toRight) / 2;
  const y = row === 0 ? margin + half : row === 2 ? 1 - margin - half : 0.5;
  return { x: round(clamp01(x)), y: round(clamp01(y)) };
}

/** The anchor a text sits on right now, or null when its position is a custom one. */
export function anchorOf(spec: TextSpec, canvas: Canvas, safe: boolean): AnchorId | null {
  return ANCHORS.find((a) => samePosition(anchorPosition(a.id, spec, canvas, safe), spec))?.id ?? null;
}

export interface Snapped extends Position {
  /** Guide lines the text snapped onto: across positions of vertical lines, down positions of horizontal ones. */
  vertical: number[];
  horizontal: number[];
}

/**
 * A dragged position, pulled onto the nearest guide within reach: the centre of the canvas, and with `safe`
 * the safe-margin lines (which the edges of the words snap to).
 */
export function snapPosition(at: Position, spec: TextSpec, canvas: Canvas, safe: boolean): Snapped {
  const b = textBounds(spec, canvas, at);
  const pick = (candidates: { delta: number; guide: number }[]) =>
    candidates
      .filter((c) => Math.abs(c.delta) <= SNAP_DISTANCE)
      .sort((a, z) => Math.abs(a.delta) - Math.abs(z.delta))[0];
  const across = pick([
    { delta: 0.5 - (b.left + b.right) / 2, guide: 0.5 },
    ...(safe
      ? [
          { delta: SAFE_MARGIN - b.left, guide: SAFE_MARGIN },
          { delta: 1 - SAFE_MARGIN - b.right, guide: 1 - SAFE_MARGIN },
        ]
      : []),
  ]);
  const down = pick([
    { delta: 0.5 - (b.top + b.bottom) / 2, guide: 0.5 },
    ...(safe
      ? [
          { delta: SAFE_MARGIN - b.top, guide: SAFE_MARGIN },
          { delta: 1 - SAFE_MARGIN - b.bottom, guide: 1 - SAFE_MARGIN },
        ]
      : []),
  ]);
  return {
    x: round(clamp01(at.x + (across?.delta ?? 0))),
    y: round(clamp01(at.y + (down?.delta ?? 0))),
    vertical: across ? [across.guide] : [],
    horizontal: down ? [down.guide] : [],
  };
}

export interface TrackText {
  clip: TimelineClip;
  spec: TextSpec;
}

/** Every text on the track of `clipId`, in timeline order (for subtitles: all the lines). */
export function trackTexts(project: Project, clipId: string): TrackText[] {
  const track = project.tracks.find((t) => t.clips.some((c) => c.id === clipId));
  if (!track) return [];
  const assets = new Map(project.assets.map((a) => [a.id, a]));
  return [...track.clips]
    .sort((a, b) => a.timelineStart - b.timelineStart)
    .flatMap((clip) => {
      const spec = assets.get(clip.assetId)?.text;
      return spec ? [{ clip, spec }] : [];
    });
}

/**
 * The position a track's texts share: the one most of them have (the earliest wins a tie). A text
 * somewhere else has been moved on its own; it keeps that place until the positions are reset.
 */
export function trackPosition(texts: TrackText[]): Position | null {
  let best: { at: Position; count: number } | null = null;
  for (const { spec } of texts) {
    const count = texts.filter((t) => samePosition(t.spec, spec)).length;
    if (!best || count > best.count) best = { at: { x: spec.x, y: spec.y }, count };
  }
  return best?.at ?? null;
}

/** The texts of a track that were moved on their own, away from the track's position. */
export function movedOnTheirOwn(texts: TrackText[]): TrackText[] {
  const base = trackPosition(texts);
  return base ? texts.filter((t) => !samePosition(t.spec, base)) : [];
}

/** Move the given texts to one position: each is redrawn, and all of it is ONE undo step. */
export async function moveTexts(clipIds: string[], to: Position, label: string): Promise<string | null> {
  const project = useProjectStore.getState().project;
  const { width, height } = project.settings;
  const at = { x: round(clamp01(to.x)), y: round(clamp01(to.y)) };
  const jobs: { clipId: string; spec: TextSpec }[] = [];
  for (const clipId of clipIds) {
    const clip = project.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
    const text = clip && project.assets.find((a) => a.id === clip.assetId)?.text;
    if (!text || samePosition(text, at)) continue;
    const parsed = TextSpecSchema.safeParse({ ...text, ...at });
    if (!parsed.success) return parsed.error.issues[0]?.message ?? "Invalid position";
    jobs.push({ clipId, spec: parsed.data });
  }
  if (jobs.length === 0) return null;
  let pictures: string[];
  try {
    pictures = await Promise.all(
      jobs.map((job) => invoke<string>("render_text", { spec: job.spec, width, height })),
    );
  } catch (e) {
    const reason = typeof e === "string" ? e : e instanceof Error ? e.message : "unknown error";
    return `Could not draw the text: ${reason}`;
  }
  const result = useProjectStore.getState().execute({
    label,
    apply: (p) => {
      let next = p;
      for (const [i, job] of jobs.entries()) {
        const edited = applyTextEdit(next, {
          clipId: job.clipId,
          picture: pictures[i],
          spec: job.spec,
          newAssetId: crypto.randomUUID(),
        });
        if (!edited.ok) return edited;
        next = edited.project;
      }
      return { ok: true, project: next };
    },
  });
  return result.ok ? null : result.error.message;
}

/**
 * Move a whole track of texts: every text at the track's position goes to `to`, together with the text
 * that was moved. Texts moved on their own earlier stay where they are. ONE undo step.
 */
export function moveTrackTexts(clipId: string, to: Position): Promise<string | null> {
  const texts = trackTexts(useProjectStore.getState().project, clipId);
  const base = trackPosition(texts);
  const ids = texts
    .filter((t) => t.clip.id === clipId || (base && samePosition(t.spec, base)))
    .map((t) => t.clip.id);
  return moveTexts(ids, to, "Move texts");
}

/** Put every text of a track back on the track's position, dropping the moves made to single texts. */
export function resetTrackPositions(clipId: string): Promise<string | null> {
  const texts = trackTexts(useProjectStore.getState().project, clipId);
  const base = trackPosition(texts);
  if (!base) return Promise.resolve(null);
  return moveTexts(
    texts.map((t) => t.clip.id),
    base,
    "Reset text positions",
  );
}
