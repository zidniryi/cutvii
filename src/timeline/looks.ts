/**
 * Looks: ready-made colour settings (section 6p). A look is only a named set of the Adjust values, so it
 * uses the one colour path of the sliders and is the same in preview and export. The bundled ones live in
 * `presets/color-looks.json` (Rust checks the same file) and are CutVii's own.
 */
import { z } from "zod";
import raw from "../../presets/color-looks.json";
import { ColorAdjustSchema, type ColorAdjust, type Project } from "@/project/model";
import { COLOR_FIELDS, colorOf, isGraded, NO_COLOR, sameColor, setClipColor } from "./color";
import type { EditResult } from "./edit";

export const LookSchema = z
  .object({
    id: z.string().min(1).max(80),
    name: z.string().min(1).max(40),
    adjust: ColorAdjustSchema,
    /** Set on a preset that came from someone else's file or pack. */
    source: z.literal("imported").optional(),
  })
  .strict();
export type Look = z.infer<typeof LookSchema>;

/** The bundled looks, checked once at start (a broken file is a build mistake). */
export const LOOKS: Look[] = LookSchema.array().parse(raw);

const KEYS = COLOR_FIELDS.map((f) => f.id);
const hundredth = (v: number) => Math.round(v * 100) / 100;

/** A look at `intensity` percent (0-100): every value scaled, on the sliders' whole-percent steps. */
export function lookAt(adjust: ColorAdjust, intensity: number): ColorAdjust {
  const t = Math.min(100, Math.max(0, intensity)) / 100;
  return Object.fromEntries(KEYS.map((k) => [k, hundredth(adjust[k] * t) + 0])) as ColorAdjust;
}

/**
 * Which look a clip's colour is, and how strong: the look whose values at some whole percent are exactly
 * the clip's. Nothing is stored for this; touching a slider afterwards simply makes it "no look".
 */
export function matchLook(
  color: ColorAdjust,
  looks: Look[] = LOOKS,
): { id: string; intensity: number } | null {
  if (!isGraded(color)) return null;
  for (const look of looks) {
    for (let intensity = 100; intensity >= 1; intensity--) {
      if (sameColor(lookAt(look.adjust, intensity), color)) return { id: look.id, intensity };
    }
  }
  return null;
}

/** Whether a clip can have colour (video and pictures; not sound, not text). */
export function hasColor(project: Project, clipId: string): boolean {
  return setClipColor(project, clipId, {}).ok;
}

/** Give every clip that can have colour the same settings (`null` clears them all). */
export function setColorOnAll(project: Project, color: ColorAdjust | null): EditResult {
  let next = project;
  for (const clip of project.tracks.flatMap((t) => t.clips)) {
    if (!hasColor(next, clip.id)) continue;
    // clear first, so the result is exactly `color` and not a mix with what the clip had
    const cleared = setClipColor(next, clip.id, null);
    if (!cleared.ok) return cleared;
    const set = color ? setClipColor(cleared.project, clip.id, color) : cleared;
    if (!set.ok) return set;
    next = set.project;
  }
  return { ok: true, project: next };
}

/** How many clips of the project can have colour. */
export const colourClipCount = (project: Project) =>
  project.tracks.flatMap((t) => t.clips).filter((c) => hasColor(project, c.id)).length;

export { colorOf, NO_COLOR };
