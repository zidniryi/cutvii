/**
 * Colour adjustment of a clip. The values are baked into one 3D lookup table by Rust
 * (`src-tauri/src/media/color.rs`); the preview applies that table in a shader and the export with FFmpeg,
 * so both show the same colours.
 */
import type { ColorAdjust, Project } from "@/project/model";
import { findClip } from "./clips";
import type { EditResult } from "./edit";

export type { ColorAdjust };

export const NO_COLOR: ColorAdjust = {
  exposure: 0,
  contrast: 0,
  saturation: 0,
  vibrance: 0,
  temperature: 0,
  tint: 0,
  highlights: 0,
  shadows: 0,
};

/** The sliders, in the order they are shown. */
export const COLOR_FIELDS: { id: keyof ColorAdjust; label: string; hint: string }[] = [
  { id: "exposure", label: "Exposure", hint: "Brighter or darker, like opening or closing the lens" },
  { id: "contrast", label: "Contrast", hint: "Pushes tones away from, or towards, middle grey" },
  { id: "highlights", label: "Highlights", hint: "Lifts or lowers the bright parts" },
  { id: "shadows", label: "Shadows", hint: "Lifts or lowers the dark parts" },
  { id: "saturation", label: "Saturation", hint: "More or less colour everywhere" },
  { id: "vibrance", label: "Vibrance", hint: "More or less colour, mostly in the muted areas" },
  { id: "temperature", label: "Temperature", hint: "Cooler (blue) or warmer (orange)" },
  { id: "tint", label: "Tint", hint: "Greener or more magenta" },
];

const KEYS = COLOR_FIELDS.map((f) => f.id);

export const colorOf = (clip: { color?: ColorAdjust }): ColorAdjust => clip.color ?? NO_COLOR;
export const isGraded = (a: ColorAdjust) => KEYS.some((k) => a[k] !== 0);
export const sameColor = (a: ColorAdjust, b: ColorAdjust) => KEYS.every((k) => a[k] === b[k]);
/** Identity of a setting, for caching its table. */
export const colorKey = (a: ColorAdjust) => KEYS.map((k) => a[k]).join("|");

/** Change some colour values of a clip, or put them all back with `null`. Not for sound or text. */
export function setClipColor(
  project: Project,
  clipId: string,
  patch: Partial<ColorAdjust> | null,
): EditResult {
  const found = findClip(project, clipId);
  if (!found) return { ok: false, error: { code: "unknown-clip", message: `Unknown clip ${clipId}` } };
  const asset = project.assets.find((a) => a.id === found.clip.assetId);
  if (!asset || asset.type === "audio" || asset.text || found.track.type === "audio") {
    return {
      ok: false,
      error: { code: "incompatible-track", message: "Only video and image clips have colour" },
    };
  }
  const current = colorOf(found.clip);
  const next = patch ? { ...current, ...patch } : NO_COLOR;
  if (KEYS.some((k) => !(next[k] >= -1 && next[k] <= 1))) {
    return { ok: false, error: { code: "out-of-range", message: "Colour values run from -100 to 100" } };
  }
  if (sameColor(current, next) && (found.clip.color !== undefined) === isGraded(next)) {
    return { ok: true, project };
  }
  return {
    ok: true,
    project: {
      ...project,
      tracks: project.tracks.map((t) =>
        t.id === found.track.id
          ? {
              ...t,
              clips: t.clips.map((c) => {
                if (c.id !== clipId) return c;
                const out = { ...c };
                // nothing set is not stored at all
                if (isGraded(next)) out.color = next;
                else delete out.color;
                return out;
              }),
            }
          : t,
      ),
    },
  };
}

export interface Lut {
  /** Points per side. */
  size: number;
  /** `size^3` RGB triples, red changing fastest. */
  table: Float32Array;
}

/** Parse the binary table Rust writes (`CVLT`, version, size, then f32 RGB triples). Throws on anything else. */
export function parseLut(buffer: ArrayBuffer): Lut {
  const view = new DataView(buffer);
  const magic = buffer.byteLength >= 12 ? String.fromCharCode(...new Uint8Array(buffer, 0, 4)) : "";
  if (magic !== "CVLT" || view.getUint32(4, true) !== 1) throw new Error("not a colour table");
  const size = view.getUint32(8, true);
  if (size < 2 || size > 129 || buffer.byteLength !== 12 + size ** 3 * 12) {
    throw new Error("colour table has the wrong size");
  }
  // copied, so the table is aligned whatever the buffer's offset
  return { size, table: new Float32Array(buffer.slice(12)) };
}
