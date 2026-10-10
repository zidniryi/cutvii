import { useState } from "react";
import { AlertTriangle, SlidersHorizontal } from "lucide-react";
import { EmptyState, Panel } from "@/components/Panel";
import { fileName } from "@/lib/media";
import { formatTimecode } from "@/lib/timecode";
import { cn } from "@/lib/utils";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useUiStore } from "@/store/ui";
import { clipDuration, findClip } from "@/timeline/clips";
import { MAX_VOLUME } from "@/timeline/edit";
import { changeFit, changeVolume, moveClipTo, report, trimClipEdge } from "@/timeline/editor";
import type { FitMode } from "@/project/model";

const fieldClass =
  "h-9 w-full rounded-md border bg-surface-2 px-2 text-sm tabular-nums pointer-coarse:h-11 focus-visible:outline-accent";

/** Seconds field: edits are applied on Enter/blur, Escape reverts; invalid input snaps back. */
function SecondsField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? value.toFixed(3);

  function commit() {
    if (draft === null) return;
    const parsed = Number(draft);
    setDraft(null);
    if (Number.isFinite(parsed) && Math.abs(parsed - value) > 1e-6) onCommit(parsed);
  }

  return (
    <label className="block">
      <span className="mb-1 block text-xs text-text-muted">{label}</span>
      <input
        type="number"
        inputMode="decimal"
        step="0.01"
        min="0"
        className={fieldClass}
        value={shown}
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

/** Volume in percent. Dragging only previews; the change is one undo step, committed on release. */
function VolumeField({ volume, onCommit }: { volume: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState<number | null>(null);
  const pct = Math.round((draft ?? volume) * 100);

  function commit() {
    if (draft === null) return;
    const v = draft;
    setDraft(null);
    if (v !== volume) onCommit(v);
  }
  const set = (percent: number) => setDraft(Math.min(MAX_VOLUME, Math.max(0, percent / 100)));

  return (
    <div>
      <label htmlFor="inspector-volume" className="mb-1 block text-xs text-text-muted">
        Volume
      </label>
      <div className="flex items-center gap-2">
        <input
          id="inspector-volume"
          type="range"
          min={0}
          max={MAX_VOLUME * 100}
          step={1}
          value={pct}
          aria-valuetext={`${pct} percent`}
          className="min-w-0 flex-1 accent-[var(--accent)] pointer-coarse:h-11"
          onChange={(e) => set(Number(e.target.value))}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
        />
        <div className="relative w-20 shrink-0">
          <input
            type="number"
            aria-label="Volume percent"
            min={0}
            max={MAX_VOLUME * 100}
            className={cn(fieldClass, "pr-6")}
            value={pct}
            onChange={(e) => set(Number(e.target.value))}
            onBlur={commit}
            onKeyDown={(e) => e.key === "Enter" && commit()}
          />
          <span
            aria-hidden
            className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-xs text-text-muted"
          >
            %
          </span>
        </div>
      </div>
      {pct > 100 && (
        <p className="mt-1 text-xs text-text-muted">
          Above 100 % is applied in export; the preview plays at 100 %.
        </p>
      )}
    </div>
  );
}

export function Inspector() {
  const active = useUiStore((s) => s.sidePanel === "inspector");
  const project = useProjectStore((s) => s.project);
  const missingPaths = useProjectStore((s) => s.missingPaths);
  const selectedIds = useSelectionStore((s) => s.selectedClipIds);
  const fps = project.settings.fps;

  const panelClass = cn(active ? "flex" : "hidden", "min-h-0 border-l lg:col-start-3 lg:row-start-1 lg:flex");

  if (selectedIds.length === 0) {
    return (
      <Panel title="Inspector" className={panelClass}>
        <EmptyState
          icon={<SlidersHorizontal />}
          title="Nothing selected"
          hint="Select a clip on the timeline to see its properties."
        />
      </Panel>
    );
  }
  if (selectedIds.length > 1) {
    return (
      <Panel title="Inspector" className={panelClass}>
        <EmptyState
          icon={<SlidersHorizontal />}
          title={`${selectedIds.length} clips selected`}
          hint="Select a single clip to edit its properties. Press Delete to remove the selection."
        />
      </Panel>
    );
  }

  const found = findClip(project, selectedIds[0]);
  const asset = found && project.assets.find((a) => a.id === found.clip.assetId);
  if (!found || !asset) {
    return (
      <Panel title="Inspector" className={panelClass}>
        <EmptyState icon={<SlidersHorizontal />} title="Nothing selected" />
      </Panel>
    );
  }
  const { clip, track } = found;
  const missing = missingPaths.includes(asset.path);

  return (
    <Panel title="Inspector" className={panelClass}>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        <div>
          <p className="truncate text-sm font-medium" title={asset.path}>
            {fileName(asset.path)}
          </p>
          <p className="text-xs text-text-muted">
            {asset.type[0].toUpperCase() + asset.type.slice(1)} · {track.name}
          </p>
          {missing && (
            <p className="mt-2 flex items-start gap-1 text-xs text-danger">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              The file is missing. Relink it from the Media panel.
            </p>
          )}
        </div>

        {/* keyed by clip so a different selection never inherits half-typed text */}
        <div key={clip.id} className="grid grid-cols-2 gap-3">
          <SecondsField
            label="Start (s)"
            value={clip.timelineStart}
            onCommit={(v) => report(moveClipTo(clip.id, v))}
          />
          <SecondsField
            label="Duration (s)"
            value={clipDuration(clip)}
            onCommit={(v) => report(trimClipEdge(clip.id, "end", clip.timelineStart + v))}
          />
        </div>

        <dl className="grid grid-cols-2 gap-3 text-xs">
          <div>
            <dt className="text-text-muted">Source in</dt>
            <dd className="font-mono tabular-nums">{formatTimecode(clip.sourceIn, fps)}</dd>
          </div>
          <div>
            <dt className="text-text-muted">Source out</dt>
            <dd className="font-mono tabular-nums">{formatTimecode(clip.sourceOut, fps)}</dd>
          </div>
        </dl>

        {asset.type === "image" && (
          <label className="block">
            <span className="mb-1 block text-xs text-text-muted">Image fit</span>
            <select
              className={fieldClass}
              value={clip.fit ?? "fit"}
              onChange={(e) => report(changeFit(clip.id, e.target.value as FitMode))}
            >
              <option value="fit">Fit — whole image, background bars</option>
              <option value="fill">Fill — cover the canvas, crop the rest</option>
              <option value="blur">Blur — whole image over a blurred copy</option>
            </select>
          </label>
        )}

        {asset.type !== "image" && (
          <VolumeField
            key={`${clip.id}-vol`}
            volume={clip.volume}
            onCommit={(v) => report(changeVolume(clip.id, v))}
          />
        )}
      </div>
    </Panel>
  );
}
