import { useState } from "react";
import type { Crop } from "@/project/model";
import { changeCrop, report } from "@/timeline/editor";
import { cropOf, isCropped, MAX_CROP } from "@/timeline/fit";
import type { TimelineClip } from "@/project/model";

const SIDES: { id: keyof Crop; label: string; opposite: keyof Crop }[] = [
  { id: "left", label: "Left", opposite: "right" },
  { id: "right", label: "Right", opposite: "left" },
  { id: "top", label: "Top", opposite: "bottom" },
  { id: "bottom", label: "Bottom", opposite: "top" },
];

/** One side of the crop, in percent of the picture. Dragging moves the number; the crop applies on release. */
function SideField({
  label,
  value,
  max,
  onCommit,
}: {
  label: string;
  value: number;
  max: number;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const pct = Math.round((draft ?? value) * 100);
  function commit() {
    if (draft === null) return;
    const v = draft;
    setDraft(null);
    if (v !== value) onCommit(v);
  }
  return (
    <label className="block">
      <span className="mb-1 flex justify-between text-xs text-text-muted">
        {label} <span className="tabular-nums">{pct}%</span>
      </span>
      <input
        type="range"
        min={0}
        max={Math.round(MAX_CROP * 100)}
        step={1}
        value={pct}
        aria-valuetext={`${pct} percent`}
        className="w-full accent-[var(--accent)] pointer-coarse:h-11"
        // the two sides of an axis share what can be removed: this one stops where the other leaves off
        onChange={(e) => setDraft(Math.min(max, Number(e.target.value) / 100))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
    </label>
  );
}

/** Cut away the edges of a video or image clip. Every change is one undo step. */
export function CropPanel({ clip }: { clip: TimelineClip }) {
  const crop = cropOf(clip);
  const round = (v: number) => Math.round(v * 100) / 100;
  return (
    <div role="group" aria-label="Crop" className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs text-text-muted">Crop</p>
        <button
          type="button"
          disabled={!isCropped(crop)}
          onClick={() => report(changeCrop(clip.id, null))}
          className="h-7 rounded-md border px-2 text-xs text-text-muted hover:text-text disabled:opacity-40 pointer-coarse:h-11"
        >
          Reset crop
        </button>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-2">
        {SIDES.map((side) => (
          <SideField
            key={side.id}
            label={side.label}
            value={crop[side.id]}
            max={round(MAX_CROP - crop[side.opposite])}
            onCommit={(v) => report(changeCrop(clip.id, { ...crop, [side.id]: round(v) }))}
          />
        ))}
      </div>
    </div>
  );
}
