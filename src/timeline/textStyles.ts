/**
 * Text styles: ready-made looks for a text clip. The presets live in `presets/text-styles.json`, which Rust
 * reads too (it draws them with the one text rasterizer, so the gallery, the preview and the export agree).
 */
import raw from "../../presets/text-styles.json";
import { StylePresetSchema, type StylePreset, type TextSpec, type TextStyle } from "@/project/model";

export type { StylePreset, TextStyle };

/** The bundled presets, checked once when the app starts (a broken presets file is a build mistake). */
export const STYLE_PRESETS: StylePreset[] = StylePresetSchema.array().parse(raw);

const STYLE_KEYS = ["color", "bold", "font", "uppercase", "outline", "shadow", "box", "highlight"] as const;

/** `spec` restyled: its words, size, alignment and place are kept, everything about its look replaced. */
export function withStyle(spec: TextSpec, style: TextStyle): TextSpec {
  const kept: TextSpec = {
    content: spec.content,
    fontSize: spec.fontSize,
    color: style.color,
    x: spec.x,
    y: spec.y,
  };
  if (spec.align !== undefined) kept.align = spec.align;
  if (spec.wrap !== undefined) kept.wrap = spec.wrap;
  // only what the style sets: an absent part means "none", and nothing undefined ends up in the file
  return {
    ...kept,
    ...Object.fromEntries(STYLE_KEYS.filter((k) => style[k] !== undefined).map((k) => [k, style[k]])),
  };
}

/** The look of a text, without its words, size or place: what "Save as style" keeps. */
export function styleOfSpec(spec: TextSpec): TextStyle {
  return {
    color: spec.color,
    ...Object.fromEntries(
      STYLE_KEYS.filter((k) => k !== "color" && spec[k] !== undefined && spec[k] !== false).map((k) => [
        k,
        spec[k],
      ]),
    ),
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** `false` and "not set" are the same look. */
const flag = (v: boolean | undefined) => v === true;

/** Whether a text currently looks exactly like a preset. */
export function matchesStyle(spec: TextSpec, style: TextStyle): boolean {
  return (
    spec.color.toLowerCase() === style.color.toLowerCase() &&
    flag(spec.bold) === flag(style.bold) &&
    flag(spec.uppercase) === flag(style.uppercase) &&
    (spec.font ?? null) === (style.font ?? null) &&
    same(spec.outline, style.outline) &&
    same(spec.shadow, style.shadow) &&
    same(spec.box, style.box) &&
    same(spec.highlight, style.highlight)
  );
}

/** Tag of the styles made for short vertical clips. */
export const CLIPPER_TAG = "clipper";
/** Tag of the styles designed around per-word timing, which CutVii does not have yet. */
export const WORD_TIMING_TAG = "word-timing";
export const hasTag = (preset: Pick<StylePreset, "tags">, tag: string) => preset.tags?.includes(tag) === true;
/** Why a style does less than its design, or null: without word times it shows plain captions. */
export const styleLimit = (preset: Pick<StylePreset, "tags">): string | null =>
  hasTag(preset, WORD_TIMING_TAG)
    ? "Word-by-word highlight is not available yet: this style shows plain captions."
    : null;

export const findStyle = (id: string) => STYLE_PRESETS.find((p) => p.id === id);
