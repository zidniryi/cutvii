/**
 * The user's own export presets: a named set of the export options (size, frame rate, quality, format).
 * Kept in local preferences, never in the project. The schema is also the one check for a preset that
 * comes from outside (a shared file later), so the limits live here: even sizes 16..8192, 1..120 fps, and
 * only the qualities and formats CutVii can write.
 */
import { z } from "zod";
import type { ExportOptions } from "./options";

export const EXPORT_SIZE_LIMITS = { min: 16, max: 8192 } as const;
export const EXPORT_FPS_LIMITS = { min: 1, max: 120 } as const;
export const MAX_EXPORT_PRESET_NAME = 40;
export const MAX_EXPORT_PRESETS = 100;

const side = z
  .number()
  .int()
  .min(EXPORT_SIZE_LIMITS.min)
  .max(EXPORT_SIZE_LIMITS.max)
  .refine((n) => n % 2 === 0, "must be an even number");

export const ExportOptionsSchema = z
  .object({
    width: side,
    height: side,
    fps: z.number().min(EXPORT_FPS_LIMITS.min).max(EXPORT_FPS_LIMITS.max),
    quality: z.enum(["draft", "standard", "high"]),
    format: z.enum(["mp4", "m4a", "mp3", "wav"]),
  })
  .strict();

export const ExportPresetSchema = z
  .object({
    id: z.string().min(1).max(80),
    name: z.string().min(1).max(MAX_EXPORT_PRESET_NAME),
    options: ExportOptionsSchema,
    /** Set on a preset that came from someone else's pack. */
    source: z.literal("imported").optional(),
  })
  .strict();
export type ExportPreset = z.infer<typeof ExportPresetSchema>;

export const sameOptions = (a: ExportOptions, b: ExportOptions) =>
  a.width === b.width &&
  a.height === b.height &&
  a.fps === b.fps &&
  a.quality === b.quality &&
  a.format === b.format;

/** "1080×1920 · 30 fps · Standard · MP4", or just the format for sound-only presets. */
export function describeOptions(o: ExportOptions): string {
  const fps = Number.isInteger(o.fps) ? String(o.fps) : String(Math.round(o.fps * 100) / 100);
  const quality = o.quality[0].toUpperCase() + o.quality.slice(1);
  return o.format === "mp4"
    ? `${o.width}×${o.height} · ${fps} fps · ${quality} · MP4`
    : `${o.format.toUpperCase()} sound`;
}
