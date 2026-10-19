/**
 * How long captions are cut into readable pieces. The numbers live in `presets/caption-rules.json`, which Rust
 * (`media/captions.rs`, where the cutting happens) reads too. Here: the limits' schema and the starting
 * limits for a canvas shape.
 */
import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import raw from "../../presets/caption-rules.json";

const range = (key: keyof typeof raw.ranges) => raw.ranges[key] as [number, number];
const between = (key: keyof typeof raw.ranges) => z.number().min(range(key)[0]).max(range(key)[1]);

export const CaptionLimitsSchema = z
  .object({
    maxLines: between("maxLines").int(),
    maxChars: between("maxChars").int(),
    /** At most this many words a caption; null for no word limit. */
    maxWords: between("maxWords").int().nullable(),
    maxSeconds: between("maxSeconds"),
    minSeconds: between("minSeconds"),
    /** Reading speed, characters a second. */
    maxCps: between("maxCps"),
  })
  .strict()
  .refine((l) => l.minSeconds <= l.maxSeconds, "The shortest time cannot be longer than the longest");
export type CaptionLimits = z.infer<typeof CaptionLimitsSchema>;

export const CAPTION_RANGES = {
  maxLines: range("maxLines"),
  maxChars: range("maxChars"),
  maxWords: range("maxWords"),
  maxSeconds: range("maxSeconds"),
  minSeconds: range("minSeconds"),
  maxCps: range("maxCps"),
} as const;

/** Capitals are wider: an uppercase style gets this share of the characters a line. */
export const UPPERCASE_FACTOR = raw.uppercaseFactor;

export type CanvasShape = "landscape" | "square" | "vertical";

export function canvasShape(width: number, height: number): CanvasShape {
  const aspect = width / height;
  if (aspect >= raw.landscapeFrom) return "landscape";
  if (aspect < raw.verticalBelow) return "vertical";
  return "square";
}

export const DEFAULT_CAPTION_LIMITS: Record<CanvasShape, CaptionLimits> = {
  landscape: CaptionLimitsSchema.parse(raw.defaults.landscape),
  square: CaptionLimitsSchema.parse(raw.defaults.square),
  vertical: CaptionLimitsSchema.parse(raw.defaults.vertical),
};

/** A piece of text with its time in seconds, to be cut. */
export interface CaptionSource {
  start: number;
  end: number;
  text: string;
  words?: { start: number; end: number; text: string }[];
}

/** One piece, as cut by Rust. `text` holds its lines joined with "\n". */
export interface Caption {
  start: number;
  end: number;
  text: string;
  lines: number;
  /** Reads faster than the reading speed allows and there was no room to show it longer. */
  fast: boolean;
}

export interface SplitOptions {
  limits: CaptionLimits;
  /** Speech language ("id", "en"); null when unknown. Chooses the function-word list. */
  language: string | null;
  fps: number;
  /** Nothing runs past this time. */
  endLimit: number;
  uppercase: boolean;
  /** The captions sit at the bottom of the picture (the shorter line goes on top). */
  bottom: boolean;
}

/** Cut `sources` into captions (in Rust, `split_captions`). The words are only cut, never changed. */
export async function splitCaptions(sources: CaptionSource[], o: SplitOptions): Promise<Caption[]> {
  return invoke<Caption[]>("split_captions", {
    request: {
      sources,
      limits: o.limits,
      language: o.language,
      fps: o.fps,
      endLimit: o.endLimit,
      uppercase: o.uppercase,
      bottom: o.bottom,
    },
  });
}
