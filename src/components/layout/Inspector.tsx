import { useState } from "react";
import { AlertTriangle, SlidersHorizontal } from "lucide-react";
import { EmptyState, Panel } from "@/components/Panel";
import { fileName } from "@/lib/media";
import { formatTimecode } from "@/lib/timecode";
import { cn } from "@/lib/utils";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useUiStore } from "@/store/ui";
import { clipDuration, clipSpeed, findClip, sourceDuration } from "@/timeline/clips";
import { MAX_SPEED, MAX_VOLUME, MIN_SPEED } from "@/timeline/edit";
import {
  changeFit,
  changeKeepPitch,
  changeReversed,
  changeSpeed,
  changeVolume,
  moveClipTo,
  report,
  trimClipEdge,
} from "@/timeline/editor";
import { confirmDialog } from "@/lib/dialog";
import { freezeFrameAtPlayhead } from "@/timeline/freeze";
import { reverseKey, useReverseStore } from "@/store/reverse";
import { MAX_AUDIBLE_SPEED, previewRate } from "@/playback/engine";
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

const SPEED_PRESETS = [0.25, 0.5, 1, 2, 4];
const seconds = (v: number) => `${v.toFixed(2)} s`;
const times = (v: number) => `${Math.round(v * 100) / 100}×`;

/** Change speed; when later clips are in the way, ask whether to move them (ripple) or cancel. */
async function applySpeed(clipId: string, speed: number) {
  const first = changeSpeed(clipId, speed);
  if (first.ok) return;
  if (first.error.code !== "needs-ripple") {
    report(first);
    return;
  }
  const move = await confirmDialog({
    title: "Move the following clips?",
    lines: [
      "At this speed the clip becomes longer and would overlap the clips after it on the same track.",
      "Move those clips later to make room, or cancel to keep the current speed.",
    ],
    confirmLabel: "Move clips",
  });
  if (move) report(changeSpeed(clipId, speed, true));
}

/** Reversing longer than this is slow and needs temporary disk space (same threshold as the export warning). */
const LONG_REVERSE_SECONDS = 60;

function SpeedPanel({
  clipId,
  speed,
  keepPitch,
  source,
  reversed,
  reverseId,
  isVideo,
}: {
  clipId: string;
  speed: number;
  keepPitch: boolean;
  source: number;
  reversed: boolean;
  /** Key of this clip's reversed preview copy. */
  reverseId: string;
  isVideo: boolean;
}) {
  const reverse = useReverseStore((s) => (reversed ? s.previews[reverseId] : undefined));
  const [draft, setDraft] = useState<string | null>(null);
  const typed = draft === null ? null : Number(draft);
  const shown = typed !== null && Number.isFinite(typed) && typed > 0 ? typed : speed;
  const invalid = typed !== null && !(Number.isFinite(typed) && typed >= MIN_SPEED && typed <= MAX_SPEED);
  const preview = previewRate(shown);

  function commit() {
    if (draft === null) return;
    const v = Number(draft);
    setDraft(null);
    if (Number.isFinite(v) && v >= MIN_SPEED && v <= MAX_SPEED && Math.abs(v - speed) > 1e-9)
      void applySpeed(clipId, v);
  }

  return (
    <section aria-label="Speed" className="space-y-2">
      <p className="text-xs text-text-muted">Speed</p>
      <div role="group" aria-label="Speed presets" className="grid grid-cols-5 gap-1">
        {SPEED_PRESETS.map((p) => {
          const active = Math.abs(speed - p) < 1e-9 && draft === null;
          return (
            <button
              key={p}
              type="button"
              aria-pressed={active}
              onClick={() => {
                setDraft(null);
                void applySpeed(clipId, p);
              }}
              className={cn(
                "h-9 rounded-md border text-xs tabular-nums pointer-coarse:h-11",
                active
                  ? "border-accent bg-accent-soft text-text"
                  : "border-border bg-surface-2 text-text-muted hover:text-text",
              )}
            >
              {times(p)}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <label htmlFor="inspector-speed" className="text-xs text-text-muted">
          Custom
        </label>
        <div className="relative w-24">
          <input
            id="inspector-speed"
            type="number"
            inputMode="decimal"
            min={MIN_SPEED}
            max={MAX_SPEED}
            step={0.05}
            aria-invalid={invalid}
            className={cn(fieldClass, "pr-6 aria-[invalid=true]:border-danger")}
            value={draft ?? String(Math.round(speed * 1000) / 1000)}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") setDraft(null);
            }}
          />
          <span
            aria-hidden
            className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-xs text-text-muted"
          >
            ×
          </span>
        </div>
        <label className="ml-auto flex min-h-9 items-center gap-1.5 text-xs pointer-coarse:min-h-11">
          <input
            type="checkbox"
            className="size-4 accent-[var(--accent)]"
            checked={keepPitch}
            onChange={(e) => report(changeKeepPitch(clipId, e.target.checked))}
          />
          Keep pitch
        </label>
      </div>
      {invalid && (
        <p role="alert" className="text-xs text-danger">
          Speed must be between {MIN_SPEED}× and {MAX_SPEED}×
        </p>
      )}
      <p className="text-xs text-text-muted tabular-nums" data-testid="speed-duration">
        Duration: {seconds(source)} → {seconds(source / shown)}
      </p>
      {shown > MAX_AUDIBLE_SPEED && (
        <p className="text-xs text-text-muted">
          Sound is muted above {MAX_AUDIBLE_SPEED}×, in the preview and the export.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          type="button"
          aria-pressed={reversed}
          onClick={() => report(changeReversed(clipId, !reversed))}
          className={cn(
            "h-9 rounded-md border px-3 text-xs pointer-coarse:h-11",
            reversed
              ? "border-accent bg-accent-soft text-text"
              : "border-border bg-surface-2 text-text-muted hover:text-text",
          )}
        >
          Reverse
        </button>
        {isVideo && (
          <button
            type="button"
            title="Hold the frame under the playhead for 2 seconds (Shift+F)"
            onClick={() => void freezeFrameAtPlayhead()}
            className="h-9 rounded-md border border-border bg-surface-2 px-3 text-xs text-text-muted hover:text-text pointer-coarse:h-11"
          >
            Freeze frame
          </button>
        )}
      </div>
      {reversed && (!reverse || reverse.status === "preparing") && (
        <p role="status" className="text-xs text-text-muted">
          Preparing reverse preview… {Math.round((reverse?.progress ?? 0) * 100)}%
        </p>
      )}
      {reversed && reverse?.status === "failed" && (
        <p role="alert" className="text-xs text-danger">
          Reverse preview failed: {reverse.error}
        </p>
      )}
      {reversed && source > LONG_REVERSE_SECONDS && (
        <p className="text-xs text-text-muted">
          Reversing {Math.round(source)} s is slow and needs temporary disk space when exporting.
        </p>
      )}
      {!preview.exact && !invalid && (
        <p className="text-xs text-text-muted">
          The preview can only play at {times(preview.rate)} here; the export uses the real {times(shown)}.
        </p>
      )}
    </section>
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
          <SpeedPanel
            key={`${clip.id}-speed`}
            clipId={clip.id}
            speed={clipSpeed(clip)}
            keepPitch={clip.keepPitch ?? true}
            source={sourceDuration(clip)}
            reversed={clip.reversed ?? false}
            reverseId={reverseKey(asset.path, clip.sourceIn, clip.sourceOut)}
            isVideo={asset.type === "video"}
          />
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
