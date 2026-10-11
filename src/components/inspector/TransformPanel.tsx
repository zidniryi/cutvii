import { useState } from "react";
import { FlipHorizontal, FlipVertical } from "lucide-react";
import type { TimelineClip } from "@/project/model";
import { cn } from "@/lib/utils";
import { changeTransform, report } from "@/timeline/editor";
import { isTransformed, transformOf, type Transform } from "@/timeline/transform";

/** A slider that shows its value. Dragging only moves the number; the clip changes on release. */
function Slider({
  label,
  value,
  min,
  max,
  unit,
  onCommit,
}: {
  label: string;
  /** In the unit shown (percent or degrees). */
  value: number;
  min: number;
  max: number;
  unit: string;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? value;
  function commit() {
    if (draft === null) return;
    const v = draft;
    setDraft(null);
    if (v !== value) onCommit(v);
  }
  return (
    <label className="block">
      <span className="mb-1 flex justify-between text-xs text-text-muted">
        {label}
        <span className="tabular-nums">
          {shown}
          {unit}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={Math.min(max, Math.max(min, shown))}
        aria-valuetext={`${shown}${unit === "°" ? " degrees" : " percent"}`}
        className="w-full accent-[var(--accent)] pointer-coarse:h-11"
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        // double-click puts a slider back where it started
        onDoubleClick={() => setDraft(null)}
      />
    </label>
  );
}

const toggleClass = (on: boolean) =>
  cn(
    "flex h-9 items-center justify-center gap-2 rounded-md border text-xs pointer-coarse:h-11 [&_svg]:size-4",
    on
      ? "border-accent bg-accent-soft text-text"
      : "border-border bg-surface-2 text-text-muted hover:text-text",
  );

/**
 * Move, scale, turn, mirror and fade a clip's picture. Smaller or moved pictures let the tracks below show
 * around them (picture-in-picture). Every change is one undo step, and the export does exactly the same.
 */
export function TransformPanel({
  clip,
  /** Text has its own position (in the Text section), so only the rest is offered. */
  position = true,
}: {
  clip: TimelineClip;
  position?: boolean;
}) {
  const t = transformOf(clip);
  const pct = (v: number) => Math.round(v * 100);
  const set = (patch: Partial<Transform>) => report(changeTransform(clip.id, patch));

  return (
    <div role="group" aria-label="Transform" className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs text-text-muted">Transform</p>
        <button
          type="button"
          disabled={!isTransformed(clip)}
          onClick={() => report(changeTransform(clip.id, null))}
          className="h-7 rounded-md border px-2 text-xs text-text-muted hover:text-text disabled:opacity-40 pointer-coarse:h-11"
        >
          Reset transform
        </button>
      </div>

      <Slider
        label="Scale"
        value={pct(t.scale)}
        min={5}
        max={400}
        unit="%"
        onCommit={(v) => set({ scale: v / 100 })}
      />
      {position && (
        <div className="grid grid-cols-2 gap-x-3">
          <Slider
            label="Move across"
            value={pct(t.x)}
            min={-100}
            max={100}
            unit="%"
            onCommit={(v) => set({ x: v / 100 })}
          />
          <Slider
            label="Move down"
            value={pct(t.y)}
            min={-100}
            max={100}
            unit="%"
            onCommit={(v) => set({ y: v / 100 })}
          />
        </div>
      )}
      <Slider
        label="Rotation"
        value={Math.round(t.rotation)}
        min={-180}
        max={180}
        unit="°"
        onCommit={(v) => set({ rotation: v })}
      />
      <Slider
        label="Opacity"
        value={pct(t.opacity)}
        min={0}
        max={100}
        unit="%"
        onCommit={(v) => set({ opacity: v / 100 })}
      />

      <div className="grid grid-cols-2 gap-1">
        <button
          type="button"
          aria-pressed={t.flipH}
          onClick={() => set({ flipH: !t.flipH })}
          className={toggleClass(t.flipH)}
        >
          <FlipHorizontal />
          Flip across
        </button>
        <button
          type="button"
          aria-pressed={t.flipV}
          onClick={() => set({ flipV: !t.flipV })}
          className={toggleClass(t.flipV)}
        >
          <FlipVertical />
          Flip down
        </button>
      </div>
    </div>
  );
}
