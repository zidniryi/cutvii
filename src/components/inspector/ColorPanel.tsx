import { useEffect, useState } from "react";
import { Eye, RotateCcw } from "lucide-react";
import type { MediaAsset, TimelineClip } from "@/project/model";
import { cn } from "@/lib/utils";
import { useLutStore } from "@/store/luts";
import { useMediaDetailsStore } from "@/store/mediaDetails";
import { useUiStore } from "@/store/ui";
import { COLOR_FIELDS, colorOf, gradeKey, isGraded, lutOf, type ColorAdjust } from "@/timeline/color";
import { changeColor, report } from "@/timeline/editor";
import { LooksPanel } from "./LooksPanel";
import { LutPanel } from "./LutPanel";

/**
 * Colour sliders for a video or image clip. While a slider is dragged the preview follows; letting go is one
 * undo step. Preview and export use the same baked table, so what is seen here is what is exported.
 */
export function ColorPanel({ clip, asset }: { clip: TimelineClip; asset: MediaAsset }) {
  const stored = colorOf(clip);
  const [draft, setDraft] = useState<ColorAdjust | null>(null);
  const shown = draft ?? stored;
  const before = useUiStore((s) => s.colorBefore === clip.id);
  const { setColorDraft, setColorBefore } = useUiStore.getState();
  const lut = lutOf(clip);
  const changed = isGraded(shown) || lut !== null;
  const failed = useLutStore((s) => changed && s.entries[gradeKey(shown, lut)]?.status === "failed");
  const hdr = useMediaDetailsStore((s) => {
    const entry = s.entries[asset.path];
    return entry?.status === "ready" && entry.details.hdr === true;
  });
  useEffect(() => useMediaDetailsStore.getState().ensure(asset.path), [asset.path]);
  // leaving the panel never leaves a half-dragged slider or "before" stuck in the preview
  useEffect(
    () => () => {
      useUiStore.getState().setColorDraft(null);
      useUiStore.getState().setColorBefore(null);
    },
    [clip.id],
  );

  function preview(field: keyof ColorAdjust, percent: number) {
    const next = { ...shown, [field]: percent / 100 };
    setDraft(next);
    setColorDraft({ clipId: clip.id, adjust: next });
  }
  function commit() {
    if (!draft) return;
    const next = draft;
    setDraft(null);
    report(changeColor(clip.id, next));
    setColorDraft(null);
  }
  const holdBefore = {
    onPointerDown: () => setColorBefore(clip.id),
    onPointerUp: () => setColorBefore(null),
    onPointerLeave: () => setColorBefore(null),
    onKeyDown: (e: React.KeyboardEvent) => (e.key === " " || e.key === "Enter") && setColorBefore(clip.id),
    onKeyUp: () => setColorBefore(null),
    onBlur: () => setColorBefore(null),
  };

  return (
    <div role="group" aria-label="Colour" className="space-y-3">
      <LooksPanel clip={clip} asset={asset} />
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-text-muted">Adjust</p>
        <div className="flex gap-1">
          <button
            type="button"
            aria-pressed={before}
            disabled={!changed}
            title="Hold to see the picture without the colour changes"
            {...holdBefore}
            className={cn(
              "flex h-7 items-center gap-1 rounded-md border px-2 text-xs disabled:opacity-40 pointer-coarse:h-11 [&_svg]:size-3.5",
              before ? "border-accent bg-accent-soft text-text" : "text-text-muted hover:text-text",
            )}
          >
            <Eye />
            Before
          </button>
          <button
            type="button"
            disabled={!isGraded(stored)}
            onClick={() => report(changeColor(clip.id, null))}
            className="h-7 rounded-md border px-2 text-xs text-text-muted hover:text-text disabled:opacity-40 pointer-coarse:h-11"
          >
            Reset all
          </button>
        </div>
      </div>

      {hdr && (
        <p role="note" className="rounded-md border border-danger/50 px-2 py-1.5 text-xs text-text-muted">
          This looks like HDR or wide-colour footage. CutVii's colour tools work in standard dynamic range, so
          the colours may look washed out or shift.
        </p>
      )}

      {COLOR_FIELDS.map((field) => {
        const percent = Math.round(shown[field.id] * 100);
        return (
          <div key={field.id}>
            <div className="mb-1 flex items-center justify-between text-xs text-text-muted">
              <label htmlFor={`color-${field.id}`} title={field.hint}>
                {field.label}
              </label>
              <span className="flex items-center gap-1">
                <span className="tabular-nums">{percent > 0 ? `+${percent}` : percent}</span>
                <button
                  type="button"
                  aria-label={`Reset ${field.label}`}
                  title={`Reset ${field.label}`}
                  disabled={stored[field.id] === 0}
                  onClick={() => report(changeColor(clip.id, { [field.id]: 0 }))}
                  className="flex size-5 items-center justify-center rounded-sm hover:text-text disabled:invisible pointer-coarse:size-11 [&_svg]:size-3"
                >
                  <RotateCcw />
                </button>
              </span>
            </div>
            <input
              id={`color-${field.id}`}
              type="range"
              min={-100}
              max={100}
              step={1}
              value={percent}
              aria-valuetext={`${percent}`}
              className="w-full accent-[var(--accent)] pointer-coarse:h-11"
              onChange={(e) => preview(field.id, Number(e.target.value))}
              onPointerUp={commit}
              onKeyUp={commit}
              onBlur={commit}
            />
          </div>
        );
      })}

      <LutPanel clip={clip} adjust={shown} />

      {failed && (
        <p role="alert" className="text-xs text-danger">
          The colour preview could not be prepared. The export still applies these settings.
        </p>
      )}
    </div>
  );
}
