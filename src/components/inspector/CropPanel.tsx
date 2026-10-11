import { useState } from "react";
import { Crop as CropIcon } from "lucide-react";
import type { Crop, MediaAsset, TimelineClip } from "@/project/model";
import { cn } from "@/lib/utils";
import { usePlaybackStore } from "@/store/playback";
import { useUiStore } from "@/store/ui";
import { clipEnd, EPS } from "@/timeline/clips";
import { CROP_PRESETS, cropForAspect } from "@/timeline/crop";
import { changeCrop, report } from "@/timeline/editor";
import { cropOf, isCropped, MAX_CROP } from "@/timeline/fit";

const SIDES: { id: keyof Crop; label: string; opposite: keyof Crop }[] = [
  { id: "left", label: "Left", opposite: "right" },
  { id: "right", label: "Right", opposite: "left" },
  { id: "top", label: "Top", opposite: "bottom" },
  { id: "bottom", label: "Bottom", opposite: "top" },
];

const chipClass = (selected: boolean) =>
  cn(
    "h-8 rounded-md border px-1 text-xs tabular-nums pointer-coarse:h-11",
    selected
      ? "border-accent bg-accent-soft text-text"
      : "border-border bg-surface-2 text-text-muted hover:text-text",
  );

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

/**
 * Cut away the edges of a video or image clip: by dragging a box in the preview, by picking a shape, or
 * side by side with the sliders. Every change is one undo step.
 */
export function CropPanel({ clip, asset }: { clip: TimelineClip; asset: MediaAsset }) {
  const crop = cropOf(clip);
  const round = (v: number) => Math.round(v * 100) / 100;
  const editing = useUiStore((s) => s.cropEdit?.clipId === clip.id);
  const lock = useUiStore((s) => (s.cropLock?.clipId === clip.id ? s.cropLock.ratio : null));
  const { setCropEdit, setCropLock } = useUiStore.getState();
  const sized = (asset.width ?? 0) > 0 && (asset.height ?? 0) > 0;

  function toggleEditing() {
    if (editing) return setCropEdit(null);
    // the box is drawn on the clip's own picture, so the playhead has to be on the clip
    const playback = usePlaybackStore.getState();
    playback.pause();
    if (playback.playhead < clip.timelineStart - EPS || playback.playhead >= clipEnd(clip) - EPS) {
      playback.setPlayhead(clip.timelineStart);
    }
    setCropEdit({ clipId: clip.id });
  }
  function choose(ratio: number | null) {
    if (ratio === null) return setCropLock(null);
    setCropLock({ clipId: clip.id, ratio });
    report(changeCrop(clip.id, cropForAspect(asset.width ?? 0, asset.height ?? 0, ratio)));
  }

  return (
    <div role="group" aria-label="Crop" className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs text-text-muted">Crop</p>
        <button
          type="button"
          disabled={!isCropped(crop)}
          onClick={() => {
            setCropLock(null);
            report(changeCrop(clip.id, null));
          }}
          className="h-7 rounded-md border px-2 text-xs text-text-muted hover:text-text disabled:opacity-40 pointer-coarse:h-11"
        >
          Reset crop
        </button>
      </div>

      <button
        type="button"
        aria-pressed={editing}
        onClick={toggleEditing}
        className={cn(
          "flex h-9 w-full items-center justify-center gap-2 rounded-md border text-xs pointer-coarse:h-11 [&_svg]:size-4",
          editing
            ? "border-accent bg-accent-soft text-text"
            : "border-border bg-surface-2 text-text-muted hover:text-text",
        )}
      >
        <CropIcon />
        {editing ? "Done cropping" : "Crop in the preview"}
      </button>

      <div role="radiogroup" aria-label="Crop shape" className="grid grid-cols-6 gap-1">
        <button
          type="button"
          role="radio"
          aria-checked={lock === null}
          onClick={() => choose(null)}
          className={chipClass(lock === null)}
        >
          Free
        </button>
        {CROP_PRESETS.map((preset) => {
          const selected = lock !== null && Math.abs(lock - preset.ratio) < 1e-9;
          return (
            <button
              key={preset.id}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={!sized}
              title={sized ? `Crop to ${preset.id}` : "The size of this media is not known"}
              onClick={() => choose(preset.ratio)}
              className={cn(chipClass(selected), "disabled:opacity-40")}
            >
              {preset.id}
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-2">
        {SIDES.map((side) => (
          <SideField
            key={side.id}
            label={side.label}
            value={crop[side.id]}
            max={round(MAX_CROP - crop[side.opposite])}
            onCommit={(v) => {
              setCropLock(null); // a single side changes the shape
              report(changeCrop(clip.id, { ...crop, [side.id]: round(v) }));
            }}
          />
        ))}
      </div>
    </div>
  );
}
