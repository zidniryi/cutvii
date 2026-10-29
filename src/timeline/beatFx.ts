/**
 * Beat effects on a clip (zoom pulse, shake, flash, glitch): the list the user edits. The effect maths is in
 * `src-tauri/src/export/beatfx.rs`; its numbers are in `presets/beat-effects.json`, read here for the
 * warnings. Every change is one undo step through `changeBeatFx`.
 */
import { z } from "zod";
import raw from "../../presets/beat-effects.json";
import { BEAT_LIMITS, type BeatEffect, type BeatFx, type TimelineClip } from "@/project/model";

const Pulse = z.object({ duration: z.number(), amount: z.number() });
const TableSchema = z.object({
  zoom: Pulse,
  shake: Pulse.extend({ amountY: z.number(), hz: z.number() }),
  flash: Pulse,
  glitch: Pulse,
  reduceFlashing: z.object({ maxFlashIntensity: z.number(), minGapSeconds: z.number() }),
  maxClipSeconds: z.number(),
});
export const BEAT_TABLE = TableSchema.parse(raw);

export type EffectKind = BeatEffect["kind"];
export const EFFECT_KINDS: { kind: EffectKind; label: string; hint: string }[] = [
  { kind: "zoom", label: "Zoom pulse", hint: "The picture swells on the beat and settles" },
  { kind: "shake", label: "Shake", hint: "A short shake on the beat" },
  { kind: "flash", label: "Flash", hint: "A flash of white on the beat" },
  { kind: "glitch", label: "Glitch", hint: "Red and blue slide apart on the beat" },
];
export const EVERY_NTH = [1, 2, 4, 8] as const;
export const EASINGS: { id: NonNullable<BeatEffect["easing"]>; label: string }[] = [
  { id: "out", label: "Out" },
  { id: "in-out", label: "In-out" },
  { id: "linear", label: "Linear" },
];

/** At or above this intensity the panel says the effect is strong. */
export const STRONG_INTENSITY = 0.8;

export const newEffect = (kind: EffectKind): BeatEffect => ({
  kind,
  intensity: kind === "flash" ? 0.5 : 0.7,
  everyNthBeat: 1,
  offsetMs: 0,
});

/** Whether a clip can take beat effects: a moving picture that is not reversed. */
export const takesBeatEffects = (clip: Pick<TimelineClip, "reversed">, assetType: string) =>
  assetType === "video" && !clip.reversed;

/** A short warning for an effect, or null. `reduce` is the "Reduce flashing" setting. */
export function effectWarning(e: BeatEffect, reduce: boolean): string | null {
  if (e.kind === "flash") {
    const cap = BEAT_TABLE.reduceFlashing.maxFlashIntensity;
    if (reduce && e.intensity > cap) {
      return `Reduce flashing limits this flash to ${Math.round(cap * 100)} % and at most three a second.`;
    }
    if (!reduce && e.intensity >= STRONG_INTENSITY) {
      return "Strong, fast flashes can be uncomfortable and can trigger seizures in some people.";
    }
    return null;
  }
  return e.intensity >= STRONG_INTENSITY ? "A strong effect: check it on the whole picture." : null;
}

/** Replace the clip's effect list. Returns the patch for `changeBeatFx`, or an error message. */
export function withEffects(
  clip: TimelineClip,
  edit: (effects: BeatEffect[]) => BeatEffect[],
): { effects: BeatFx["effects"] } | { error: string } {
  const effects = edit((clip.beatFx?.effects ?? []).map((e) => ({ ...e })));
  if (effects.length > BEAT_LIMITS.maxEffects) {
    return { error: `A clip can have at most ${BEAT_LIMITS.maxEffects} beat effects` };
  }
  return { effects };
}
