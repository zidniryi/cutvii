import { Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { BEAT_LIMITS, type BeatEffect, type TimelineClip } from "@/project/model";
import { useBeatSafety } from "@/store/beatSafety";
import { useBeatStore } from "@/store/beats";
import {
  EASINGS,
  EFFECT_KINDS,
  effectWarning,
  EVERY_NTH,
  newEffect,
  withEffects,
  type EffectKind,
} from "@/timeline/beatFx";
import { changeBeatFx, report } from "@/timeline/editor";
import { useUiStore } from "@/store/ui";

const buttonClass =
  "flex h-9 items-center justify-center gap-2 rounded-md border px-2 text-xs pointer-coarse:h-11 [&_svg]:size-4 disabled:opacity-40";
const plain = "border-border bg-surface-2 text-text-muted hover:text-text";
const pressed = "border-accent/60 bg-accent-soft text-text";

/**
 * Beat effects: pulses drawn on the beat grid found in the Audio tab (zoom pulse, shake, flash, glitch). Each
 * effect has its strength, how often it fires (every 1, 2, 4 or 8 beats), a delay and an easing. The export
 * draws them with FFmpeg after crop and colour. Every change is one undo step.
 */
export function BeatEffectsPanel({ clip }: { clip: TimelineClip }) {
  const fx = clip.beatFx;
  const effects = fx?.effects ?? [];
  const hasGrid = !!fx?.gridId;
  const grid = useBeatStore((s) => (fx?.gridId ? s.grids[fx.gridId] : undefined));
  const reduce = useBeatSafety((s) => s.reduceFlashing);
  const preview = useUiStore((s) => s.beatPreview);

  function change(label: string, edit: (list: BeatEffect[]) => BeatEffect[]) {
    const patch = withEffects(clip, edit);
    if ("error" in patch) return void useUiStore.getState().setNotice(patch.error);
    report(changeBeatFx(clip.id, patch, label));
  }
  const set = (i: number, part: Partial<BeatEffect>, label: string) =>
    change(label, (list) => list.map((e, j) => (j === i ? { ...e, ...part } : e)));

  return (
    <div role="group" aria-label="Beat effects" className="space-y-3">
      {!hasGrid && (
        <p className="text-xs text-text-muted">
          Effects follow the beat of this clip&apos;s sound. Open the Audio tab and press Detect beats first.
        </p>
      )}
      {hasGrid && grid && !grid.clear && (
        <p className="text-xs text-accent" role="status">
          No clear beat was found, so the effects may not land well. Set the tempo by hand in the Audio tab.
        </p>
      )}
      {effects.map((e, i) => {
        const warning = effectWarning(e, reduce);
        const name = EFFECT_KINDS.find((k) => k.kind === e.kind)?.label ?? e.kind;
        return (
          <div
            key={i}
            role="group"
            aria-label={`${name} ${i + 1}`}
            className="space-y-2 rounded-md border border-border p-2"
          >
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-text">{name}</span>
              <button
                type="button"
                aria-label={`Remove ${name}`}
                title="Remove"
                onClick={() => change("Remove beat effect", (list) => list.filter((_, j) => j !== i))}
                className="flex size-8 items-center justify-center rounded-md text-text-muted hover:text-text pointer-coarse:size-11 [&_svg]:size-4"
              >
                <Trash2 />
              </button>
            </div>
            <div>
              <div className="mb-1 flex justify-between text-xs text-text-muted">
                <label htmlFor={`bfx-int-${i}`}>Strength</label>
                <span className="tabular-nums">{Math.round(e.intensity * 100)} %</span>
              </div>
              <input
                id={`bfx-int-${i}`}
                type="range"
                min={0}
                max={100}
                step={5}
                value={Math.round(e.intensity * 100)}
                className="w-full accent-[var(--accent)] pointer-coarse:h-11"
                onChange={(ev) =>
                  set(i, { intensity: Number(ev.target.value) / 100 }, "Beat effect strength")
                }
              />
            </div>
            {warning && (
              <p role="status" className="text-xs text-accent">
                {warning}
              </p>
            )}
            <div role="radiogroup" aria-label="Fires every" className="grid grid-cols-4 gap-1">
              {EVERY_NTH.map((n) => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={e.everyNthBeat === n}
                  onClick={() => set(i, { everyNthBeat: n }, "Beat effect rate")}
                  className={cn(buttonClass, e.everyNthBeat === n ? pressed : plain)}
                >
                  {n === 1 ? "Each" : `${n}th`}
                </button>
              ))}
            </div>
            <div role="radiogroup" aria-label="Easing" className="grid grid-cols-3 gap-1">
              {EASINGS.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  role="radio"
                  aria-checked={(e.easing ?? "out") === o.id}
                  onClick={() => set(i, { easing: o.id === "out" ? undefined : o.id }, "Beat effect easing")}
                  className={cn(buttonClass, (e.easing ?? "out") === o.id ? pressed : plain)}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <label className="block text-xs text-text-muted">
              Delay (ms)
              <input
                type="number"
                inputMode="numeric"
                min={-BEAT_LIMITS.maxEffectOffsetMs}
                max={BEAT_LIMITS.maxEffectOffsetMs}
                step={10}
                value={e.offsetMs}
                onChange={(ev) => {
                  const v = Math.round(Number(ev.target.value));
                  if (!Number.isFinite(v)) return;
                  set(
                    i,
                    {
                      offsetMs: Math.max(
                        -BEAT_LIMITS.maxEffectOffsetMs,
                        Math.min(BEAT_LIMITS.maxEffectOffsetMs, v),
                      ),
                    },
                    "Beat effect delay",
                  );
                }}
                className="mt-1 h-9 w-full rounded-md border border-border bg-surface-2 px-2 text-text tabular-nums pointer-coarse:h-11"
              />
            </label>
          </div>
        );
      })}
      <div className="grid grid-cols-2 gap-1">
        {EFFECT_KINDS.map((k) => (
          <button
            key={k.kind}
            type="button"
            title={k.hint}
            disabled={effects.length >= BEAT_LIMITS.maxEffects}
            onClick={() => change("Add beat effect", (list) => [...list, newEffect(k.kind as EffectKind)])}
            className={cn(buttonClass, plain)}
          >
            <Plus /> {k.label}
          </button>
        ))}
      </div>
      {effects.length > 0 && (
        <>
          <button
            type="button"
            aria-pressed={preview}
            onClick={() => useUiStore.getState().setBeatPreview(!preview)}
            className={cn(buttonClass, preview ? pressed : plain, "w-full")}
          >
            Preview on canvas
          </button>
          <p className="text-xs text-text-muted">
            {reduce ? "Reduce flashing is on." : "Reduce flashing is off (Settings)."} The preview and the
            export draw the same numbers; the preview&apos;s colour split is approximate at the picture&apos;s
            edges.
          </p>
        </>
      )}
    </div>
  );
}
