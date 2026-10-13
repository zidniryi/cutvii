import { useId, useState } from "react";
import { Diamond, FlipHorizontal, FlipVertical } from "lucide-react";
import type { TimelineClip } from "@/project/model";
import { cn } from "@/lib/utils";
import { usePlaybackStore } from "@/store/playback";
import { changeKey, changeTransform, deleteKey, report } from "@/timeline/editor";
import { keyAt, keysOf } from "@/timeline/keyframes";
import {
  isTransformed,
  keyTime,
  transformAt,
  transformOf,
  type KeyProp,
  type Transform,
} from "@/timeline/transform";

/** The keyframe button of one property. */
interface Keyed {
  /** The property has keyframes. */
  any: boolean;
  /** One of them is at the playhead. */
  here: boolean;
  toggle: () => void;
}

/** A slider that shows its value. Dragging only moves the number; the clip changes on release. */
function Slider({
  label,
  value,
  min,
  max,
  unit,
  keyed,
  onCommit,
}: {
  label: string;
  /** In the unit shown (percent or degrees). */
  value: number;
  min: number;
  max: number;
  unit: string;
  keyed?: Keyed;
  onCommit: (v: number) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? value;
  function commit() {
    if (draft === null) return;
    const v = draft;
    setDraft(null);
    if (v !== value) onCommit(v);
  }
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs text-text-muted">
        <label htmlFor={id}>{label}</label>
        <span className="flex items-center gap-1 tabular-nums">
          {shown}
          {unit}
          {keyed && (
            <button
              type="button"
              aria-pressed={keyed.here}
              aria-label={`${keyed.here ? "Remove keyframe" : "Add keyframe"} for ${label}`}
              title={keyed.here ? "Remove the keyframe at the playhead" : "Add a keyframe at the playhead"}
              onClick={keyed.toggle}
              className={cn(
                "flex size-6 items-center justify-center rounded pointer-coarse:size-11 [&_svg]:size-3.5",
                keyed.here
                  ? "text-accent [&_svg]:fill-current"
                  : keyed.any
                    ? "text-accent"
                    : "text-text-muted hover:text-text",
              )}
            >
              <Diamond />
            </button>
          )}
        </span>
      </div>
      <input
        id={id}
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
    </div>
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
 *
 * Keyframes: the diamond next to a value adds a keyframe at the playhead. A value that has keyframes shows
 * what it is at the playhead, and changing it there sets (or adds) the keyframe at that moment.
 */
export function TransformPanel({
  clip,
  /** Text has its own position (in the Text section), so only the rest is offered. */
  position = true,
}: {
  clip: TimelineClip;
  position?: boolean;
}) {
  // only a clip with keyframes follows the playhead
  const playhead = usePlaybackStore((s) => (clip.keyframes ? s.playhead : -1));
  const t = clip.keyframes ? transformAt(clip, playhead) : transformOf(clip);
  const pct = (v: number) => Math.round(v * 100);
  const set = (patch: Partial<Transform>) => report(changeTransform(clip.id, patch));
  const now = () => keyTime(clip, usePlaybackStore.getState().playhead);
  /** Change a value: at the playhead's keyframe when the property is animated, otherwise for the whole clip. */
  const change = (prop: KeyProp, v: number) =>
    keysOf(clip, prop).length > 0 ? report(changeKey(clip.id, prop, now(), v)) : set({ [prop]: v });
  const keyed = (prop: KeyProp): Keyed => ({
    any: keysOf(clip, prop).length > 0,
    here: keyAt(clip, prop, keyTime(clip, playhead)) !== undefined,
    toggle: () => {
      const at = now();
      if (keyAt(clip, prop, at)) return void report(deleteKey(clip.id, prop, at));
      const value = transformAt(clip, usePlaybackStore.getState().playhead)[prop];
      report(changeKey(clip.id, prop, at, value));
    },
  });

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
        keyed={keyed("scale")}
        onCommit={(v) => change("scale", v / 100)}
      />
      {position && (
        <div className="grid grid-cols-2 gap-x-3">
          <Slider
            label="Move across"
            value={pct(t.x)}
            min={-100}
            max={100}
            unit="%"
            keyed={keyed("x")}
            onCommit={(v) => change("x", v / 100)}
          />
          <Slider
            label="Move down"
            value={pct(t.y)}
            min={-100}
            max={100}
            unit="%"
            keyed={keyed("y")}
            onCommit={(v) => change("y", v / 100)}
          />
        </div>
      )}
      <Slider
        label="Rotation"
        value={Math.round(t.rotation)}
        min={-180}
        max={180}
        unit="°"
        keyed={keyed("rotation")}
        onCommit={(v) => change("rotation", v)}
      />
      <Slider
        label="Opacity"
        value={pct(t.opacity)}
        min={0}
        max={100}
        unit="%"
        keyed={keyed("opacity")}
        onCommit={(v) => change("opacity", v / 100)}
      />

      {clip.keyframes && (
        <p className="text-xs text-text-muted">
          Animated: move the playhead and change a value to add another keyframe. Reset transform removes them
          all.
        </p>
      )}
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
