import { useState } from "react";
import { cn } from "@/lib/utils";
import type { TextSpec } from "@/project/model";
import { useProjectStore } from "@/store/project";
import { useTextStyleStore } from "@/store/textStyles";
import { editText } from "@/timeline/text";
import {
  anchorOf,
  anchorPosition,
  ANCHORS,
  DEFAULT_TEXT_POSITION,
  movedOnTheirOwn,
  moveTrackTexts,
  resetTrackPositions,
  samePosition,
  trackPosition,
  trackTexts,
  type Canvas,
  type Position,
} from "@/timeline/textPosition";

const small =
  "h-9 rounded-md border bg-surface-2 px-2 text-xs text-text-muted hover:text-text disabled:opacity-40 pointer-coarse:h-11";

/** A position in percent, typed in. Applied on Enter or when the field is left. */
function Percent({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (share: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = Math.round(value * 1000) / 10;
  function commit() {
    if (draft === null) return;
    const parsed = Number(draft);
    setDraft(null);
    if (!Number.isFinite(parsed)) return;
    const share = Math.min(100, Math.max(0, parsed)) / 100;
    if (Math.abs(share - value) > 0.0005) onCommit(share);
  }
  return (
    <label className="block flex-1 text-xs text-text-muted">
      <span className="mb-1 block">{label}</span>
      <input
        type="number"
        inputMode="decimal"
        min={0}
        max={100}
        step={1}
        aria-label={label}
        className="h-9 w-full rounded-md border bg-surface-2 px-2 text-sm text-text focus-visible:outline-accent pointer-coarse:h-11"
        value={draft ?? shown}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setDraft(null);
        }}
      />
    </label>
  );
}

export interface PositionProps {
  /** The text being placed: its `x` / `y` are the position, the rest tells how big it is. */
  spec: TextSpec;
  canvas: Canvas;
  onChange: (to: Position) => void;
  /** Where "Reset position" goes. */
  resetTo: Position;
}

/**
 * The ONE position control, used for a text clip in the inspector and for subtitles in the style editor:
 * a 3×3 anchor grid, X / Y in percent, the Safe margin switch and Reset position. It only ever produces an
 * `x` / `y`; how the words are aligned is a separate control.
 */
export function PositionControl({ spec, canvas, onChange, resetTo }: PositionProps) {
  const safe = useTextStyleStore((s) => s.safeMargin);
  const anchor = anchorOf(spec, canvas, safe);
  return (
    <fieldset role="group" aria-label="Position" className="space-y-2 rounded-md border p-2">
      <legend className="px-1 text-xs text-text-muted">Position</legend>
      <div className="flex items-start gap-3">
        <div role="radiogroup" aria-label="Anchor" className="grid shrink-0 grid-cols-3 gap-1">
          {ANCHORS.map((a) => (
            <button
              key={a.id}
              type="button"
              role="radio"
              aria-checked={anchor === a.id}
              aria-label={a.label}
              title={a.label}
              onClick={() => onChange(anchorPosition(a.id, spec, canvas, safe))}
              className={cn(
                "flex size-9 items-center justify-center rounded-md border pointer-coarse:size-11",
                anchor === a.id
                  ? "border-accent bg-accent-soft"
                  : "border-border bg-surface-2 hover:border-text-muted",
              )}
            >
              <span className={cn("size-2 rounded-full", anchor === a.id ? "bg-accent" : "bg-text-muted")} />
            </button>
          ))}
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex gap-2">
            <Percent label="X (%)" value={spec.x} onCommit={(x) => onChange({ x, y: spec.y })} />
            <Percent label="Y (%)" value={spec.y} onCommit={(y) => onChange({ x: spec.x, y })} />
          </div>
          <label className="flex min-h-6 cursor-pointer items-center gap-2 text-xs text-text pointer-coarse:min-h-11">
            <input
              type="checkbox"
              className="size-4 accent-[var(--accent)]"
              checked={safe}
              onChange={(e) => useTextStyleStore.getState().setSafeMargin(e.target.checked)}
            />
            Safe margin
          </label>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-text-muted">
          {anchor ? ANCHORS.find((a) => a.id === anchor)!.label : "Custom position"}
        </p>
        <button
          type="button"
          className={small}
          disabled={samePosition(spec, resetTo)}
          onClick={() => onChange(resetTo)}
        >
          Reset position
        </button>
      </div>
    </fieldset>
  );
}

/**
 * The position of a text clip. On a track with several texts (subtitles), "Move all" moves the whole track
 * in one undo step; a text moved on its own keeps its place until "Reset to style".
 */
export function ClipPosition({
  clipId,
  spec,
  onProblem,
}: {
  clipId: string;
  spec: TextSpec;
  onProblem: (problem: string | null) => void;
}) {
  const project = useProjectStore((s) => s.project);
  const [together, setTogether] = useState(false);
  const texts = trackTexts(project, clipId);
  const base = trackPosition(texts);
  const moved = movedOnTheirOwn(texts);
  const several = texts.length > 1;
  // a text moved on its own goes back to its track's position; otherwise to the middle
  const resetTo = several && base && !samePosition(spec, base) ? base : DEFAULT_TEXT_POSITION;
  const { width, height } = project.settings;

  return (
    <div className="space-y-2">
      <PositionControl
        spec={spec}
        canvas={{ width, height }}
        resetTo={resetTo}
        onChange={(to) =>
          void (several && together ? moveTrackTexts(clipId, to) : editText(clipId, to)).then(onProblem)
        }
      />
      {several && (
        <div className="space-y-2 text-xs">
          <label className="flex min-h-6 cursor-pointer items-center gap-2 text-text pointer-coarse:min-h-11">
            <input
              type="checkbox"
              className="size-4 accent-[var(--accent)]"
              checked={together}
              onChange={(e) => setTogether(e.target.checked)}
            />
            Move all {texts.length} texts on this track
          </label>
          {moved.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-text-muted">
                {moved.length} moved on {moved.length === 1 ? "its" : "their"} own
              </p>
              <button
                type="button"
                className={small}
                onClick={() => void resetTrackPositions(clipId).then(onProblem)}
              >
                Reset to style
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
