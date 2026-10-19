/**
 * "Re-split long captions": every text clip of a track that is above the caption limits is cut into pieces by
 * the one splitter in Rust (`split_captions`, the same one auto subtitles use). The words are only cut, never
 * changed; each piece keeps the clip's look (per-line colours included), position and fades. One undo step.
 */
import { invoke } from "@tauri-apps/api/core";
import type { MediaAsset, Project, TextSpec, TimelineClip } from "@/project/model";
import { useProjectStore } from "@/store/project";
import { lineCounts } from "@/store/textLines";
import { useTextStyleStore } from "@/store/textStyles";
import {
  canvasShape,
  DEFAULT_CAPTION_LIMITS,
  splitCaptions,
  UPPERCASE_FACTOR,
  type CaptionLimits,
} from "./captionRules";
import { clipDuration, clipEnd, findClip } from "./clips";
import type { EditResult } from "./edit";

/** The caption limits for a canvas: the user's own for its shape, else the starting ones. */
export function limitsFor(width: number, height: number): CaptionLimits {
  const shape = canvasShape(width, height);
  return useTextStyleStore.getState().captionLimits[shape] ?? DEFAULT_CAPTION_LIMITS[shape];
}

/**
 * Whether a text is above the limits: more drawn lines than allowed (`lines` is the rasterizer's count,
 * wrapping included), more words, longer on screen (unless it is one word), or a typed line longer than a
 * line may be.
 */
export function overLimits(spec: TextSpec, seconds: number, lines: number, limits: CaptionLimits): boolean {
  const words = spec.content.split(/\s+/).filter(Boolean).length;
  const maxChars = spec.uppercase ? Math.floor(limits.maxChars * UPPERCASE_FACTOR) : limits.maxChars;
  return (
    lines > limits.maxLines ||
    (limits.maxWords !== null && words > limits.maxWords) ||
    (words > 1 && seconds > limits.maxSeconds + 1e-6) ||
    spec.content.split("\n").some((line) => [...line.trim()].length > maxChars)
  );
}

export interface Piece {
  /** Timeline seconds. */
  start: number;
  end: number;
  text: string;
  /** The drawn picture of the piece. */
  picture: string;
  assetId: string;
  /** The first piece keeps the id of the clip it came from. */
  clipId: string;
}

/**
 * Put the pieces in place of their clips: each a copy of its clip (look, position, transform, fades, the
 * source times its keyframes refer to) with its own text. A transition in stays on the first piece, one out
 * on the last. Pure; the caller makes it one undo step.
 */
export function replaceWithPieces(
  project: Project,
  plans: { clipId: string; pieces: Piece[] }[],
): EditResult {
  const assets: MediaAsset[] = [];
  const replaced = new Map<string, TimelineClip[]>();
  for (const { clipId, pieces } of plans) {
    const found = findClip(project, clipId);
    const asset = found && project.assets.find((a) => a.id === found.clip.assetId);
    if (!found || !asset?.text || pieces.length === 0) {
      return {
        ok: false,
        error: { code: "unknown-clip", message: "That text is no longer on the timeline" },
      };
    }
    const clip = found.clip;
    replaced.set(
      clipId,
      pieces.map((p, i) => {
        assets.push({ ...asset, id: p.assetId, path: p.picture, text: { ...asset.text!, content: p.text } });
        const length = p.end - p.start;
        const sourceIn = clip.sourceIn + (p.start - clip.timelineStart);
        const piece: TimelineClip = {
          ...clip,
          id: p.clipId,
          assetId: p.assetId,
          timelineStart: p.start,
          sourceIn,
          sourceOut: sourceIn + length,
        };
        // a fade fits the piece: at most a third of it, as subtitles get when they are added
        if (piece.fadeIn !== undefined) piece.fadeIn = Math.min(piece.fadeIn, length / 3);
        if (piece.fadeOut !== undefined) piece.fadeOut = Math.min(piece.fadeOut, length / 3);
        if (i > 0) delete piece.transitionIn;
        if (i < pieces.length - 1) delete piece.transitionOut;
        return piece;
      }),
    );
  }
  return {
    ok: true,
    project: {
      ...project,
      assets: [...project.assets, ...assets],
      tracks: project.tracks.map((t) =>
        t.clips.some((c) => replaced.has(c.id))
          ? {
              ...t,
              clips: t.clips
                .flatMap((c) => replaced.get(c.id) ?? [c])
                .sort((a, b) => a.timelineStart - b.timelineStart),
            }
          : t,
      ),
    },
  };
}

const message = (e: unknown) =>
  typeof e === "string" ? e : e instanceof Error ? e.message : "unknown error";

export type ResplitResult = { ok: true; changed: number } | { ok: false; reason: string };

/** What to tell the user after a re-split. */
export const resplitNotice = (r: ResplitResult) =>
  !r.ok
    ? r.reason
    : r.changed === 0
      ? "Every caption on this track is within the limits"
      : `Re-split ${r.changed} long caption${r.changed === 1 ? "" : "s"}`;

/** Re-split every text clip of `trackId` that is above the caption limits. Nothing changes if it fails. */
export async function resplitTrack(trackId: string): Promise<ResplitResult> {
  const before = useProjectStore.getState().project;
  const track = before.tracks.find((t) => t.id === trackId);
  if (!track) return { ok: false, reason: "That track is no longer there" };
  const { width, height, fps } = before.settings;
  const limits = limitsFor(width, height);
  const clips = [...track.clips].sort((a, b) => a.timelineStart - b.timelineStart);
  const texts = clips.flatMap((clip, i) => {
    const spec = before.assets.find((a) => a.id === clip.assetId)?.text;
    return spec ? [{ clip, spec, next: clips[i + 1] }] : [];
  });

  const plans: { clipId: string; pieces: Piece[] }[] = [];
  try {
    const counts = await lineCounts(
      texts.map((t) => t.spec),
      width,
      height,
    );
    for (const [i, { clip, spec, next }] of texts.entries()) {
      if (!overLimits(spec, clipDuration(clip), counts[i], limits)) continue;
      const cut = await splitCaptions(
        [{ start: clip.timelineStart, end: clipEnd(clip), text: spec.content }],
        {
          limits,
          language: null,
          fps,
          // a piece that reads too fast may stay on into the free time before the next clip
          endLimit: next ? next.timelineStart : clipEnd(clip),
          uppercase: spec.uppercase === true,
          bottom: spec.y >= 0.5,
        },
      );
      if (cut.length === 0 || (cut.length === 1 && cut[0].text === spec.content)) continue;
      const pieces: Piece[] = [];
      for (const [k, c] of cut.entries()) {
        const picture = await invoke<string>("render_text", {
          spec: { ...spec, content: c.text },
          width,
          height,
        });
        pieces.push({
          start: c.start,
          end: c.end,
          text: c.text,
          picture,
          assetId: crypto.randomUUID(),
          clipId: k === 0 ? clip.id : crypto.randomUUID(),
        });
      }
      plans.push({ clipId: clip.id, pieces });
    }
  } catch (e) {
    return { ok: false, reason: `Could not re-split the captions: ${message(e)}` };
  }
  if (plans.length === 0) return { ok: true, changed: 0 };
  if (useProjectStore.getState().project !== before) {
    return { ok: false, reason: "The timeline changed while the captions were being split; try again" };
  }
  const result = useProjectStore.getState().execute({
    label: "Re-split long captions",
    apply: (p) => replaceWithPieces(p, plans),
  });
  if (!result.ok) return { ok: false, reason: result.error.message };
  return { ok: true, changed: plans.length };
}
