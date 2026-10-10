import { useEffect, useMemo, useRef, useState } from "react";
import {
  AudioLines,
  CheckCircle2,
  Clapperboard,
  FolderOpen,
  Loader2,
  TriangleAlert,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cancelRunningExport, startExport } from "@/export/flow";
import {
  defaultOptions,
  FORMATS,
  fpsChoices,
  isAudioFormat,
  QUALITIES,
  resolutionPresets,
  type ExportOptions,
} from "@/export/options";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { revealLastExport } from "@/lib/exportApi";
import { formatDuration } from "@/lib/timecode";
import { cn } from "@/lib/utils";
import { useExportStore } from "@/store/export";
import { useProjectStore } from "@/store/project";
import { projectDuration } from "@/timeline/clips";

function megabytes(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A row of choices: our own radio "pills" instead of the OS select, so it looks the same everywhere. */
function Choices<T extends string | number>({
  label,
  value,
  options,
  onChange,
  columns,
}: {
  label: string;
  value: T;
  options: { value: T; title: string; detail?: string }[];
  onChange: (v: T) => void;
  columns: number;
}) {
  return (
    <div role="radiogroup" aria-label={label}>
      <p className="mb-1.5 text-xs font-medium text-text-muted">{label}</p>
      <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
        {options.map((o) => {
          const selected = o.value === value;
          return (
            <button
              key={String(o.value)}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={o.detail ? `${o.title}, ${o.detail}` : o.title}
              onClick={() => onChange(o.value)}
              className={cn(
                "flex min-h-11 flex-col items-start justify-center rounded-md border px-2.5 py-1.5 text-left transition-colors",
                selected
                  ? "border-accent bg-accent-soft text-text"
                  : "border-border bg-surface-2 text-text-muted hover:border-text-muted hover:text-text",
              )}
            >
              <span className="text-sm leading-tight font-medium">{o.title}</span>
              {o.detail && <span className="mt-0.5 text-[11px] leading-tight opacity-80">{o.detail}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Mounted only while open; remounted per session, so options reset on open but survive a cancel. */
function ExportDialogBody() {
  const phase = useExportStore((s) => s.phase);
  const progress = useExportStore((s) => s.progress);
  const report = useExportStore((s) => s.report);
  const error = useExportStore((s) => s.error);
  const cancelling = useExportStore((s) => s.cancelling);
  const close = useExportStore((s) => s.close);
  const open = useExportStore((s) => s.open);
  const project = useProjectStore((s) => s.project);

  const presets = useMemo(() => resolutionPresets(project), [project]);
  const fpsList = useMemo(() => {
    const list = fpsChoices(project);
    const own = project.settings.fps;
    return list.includes(own) ? list : [...list, own].sort((a, b) => a - b);
  }, [project]);
  const [options, setOptions] = useState<ExportOptions>(() => defaultOptions(project));
  const rootRef = useRef<HTMLDivElement>(null);
  const [revealError, setRevealError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && phase !== "running") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, close]);

  useFocusTrap(rootRef);

  const duration = projectDuration(project);
  const audioOnly = isAudioFormat(options.format);
  const format = FORMATS.find((f) => f.id === options.format)!;
  const presetId =
    presets.find((p) => p.width === options.width && p.height === options.height)?.id ?? "project";
  const pct = Math.round(progress * 100);
  const fpsLabel = (f: number) => (Number.isInteger(f) ? String(f) : String(Math.round(f * 100) / 100));

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 backdrop-blur-[2px]">
      <div
        ref={rootRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-title"
        className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-xl border bg-popover shadow-2xl"
      >
        <header className="flex items-center gap-3 border-b px-5 py-4">
          <span className="flex size-9 items-center justify-center rounded-lg bg-accent-soft text-accent">
            {audioOnly ? <AudioLines className="size-5" /> : <Clapperboard className="size-5" />}
          </span>
          <div className="min-w-0">
            <h2 id="export-title" className="text-sm font-semibold">
              Export
            </h2>
            <p className="truncate text-xs text-text-muted">
              {project.name} · {formatDuration(duration)}
            </p>
          </div>
        </header>

        {phase === "settings" && (
          <>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
              <Choices
                label="Format"
                columns={3}
                value={options.format}
                onChange={(f) => setOptions((o) => ({ ...o, format: f }))}
                options={FORMATS.map((f) => ({ value: f.id, title: f.label, detail: f.detail }))}
              />

              {!audioOnly && (
                <>
                  <Choices
                    label="Resolution"
                    columns={Math.min(presets.length, 3)}
                    value={presetId}
                    onChange={(id) => {
                      const p = presets.find((r) => r.id === id)!;
                      setOptions((o) => ({ ...o, width: p.width, height: p.height }));
                    }}
                    options={presets.map((p) => ({
                      value: p.id,
                      title: p.label,
                      detail: `${p.width}×${p.height}`,
                    }))}
                  />
                  <Choices
                    label="Frame rate"
                    columns={Math.min(fpsList.length, 6)}
                    value={options.fps}
                    onChange={(f) => setOptions((o) => ({ ...o, fps: f }))}
                    options={fpsList.map((f) => ({
                      value: f,
                      title: `${fpsLabel(f)} fps`,
                      detail: f === project.settings.fps ? "project" : undefined,
                    }))}
                  />
                  <Choices
                    label="Quality"
                    columns={3}
                    value={options.quality}
                    onChange={(q) => setOptions((o) => ({ ...o, quality: q }))}
                    options={QUALITIES.map((q) => ({ value: q.id, title: q.label, detail: q.hint }))}
                  />
                </>
              )}
              {audioOnly && (
                <p className="rounded-md border border-dashed px-3 py-2 text-xs text-text-muted">
                  Exports the sound of the whole timeline as one file: clip audio and audio tracks, mixed
                  exactly as in the video export. Muted tracks are left out.
                </p>
              )}
            </div>

            <footer className="flex items-center justify-between gap-3 border-t bg-surface-1 px-5 py-3">
              <p
                className="min-w-0 truncate text-xs text-text-muted"
                aria-live="polite"
                data-testid="export-summary"
              >
                {audioOnly
                  ? `${format.detail} · ${formatDuration(duration)}`
                  : `${format.detail} · ${options.width}×${options.height} · ${fpsLabel(options.fps)} fps`}
              </p>
              <div className="flex shrink-0 gap-2">
                <Button variant="secondary" className="pointer-coarse:h-11" onClick={close}>
                  Cancel
                </Button>
                <Button className="pointer-coarse:h-11" onClick={() => void startExport(options)}>
                  <Upload /> Export…
                </Button>
              </div>
            </footer>
          </>
        )}

        {phase === "running" && (
          <div className="px-5 py-5">
            <div className="flex items-baseline justify-between text-xs text-text-muted">
              <span className="flex items-center gap-2">
                <Loader2 className="size-3.5 animate-spin" />
                {cancelling ? "Cancelling…" : progress > 0 ? `Rendering… ${pct}%` : "Preparing…"}
              </span>
              <span className="tabular-nums">{pct}%</span>
            </div>
            <div
              role="progressbar"
              aria-label="Export progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
              className="mt-2 h-2 overflow-hidden rounded-full bg-surface-2"
            >
              <div
                className="h-full rounded-full bg-accent transition-[width]"
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="mt-5 flex justify-end">
              <Button
                variant="secondary"
                className="pointer-coarse:h-11"
                disabled={cancelling}
                onClick={() => void cancelRunningExport()}
              >
                Cancel export
              </Button>
            </div>
          </div>
        )}

        {phase === "done" && report && (
          <div className="px-5 py-5">
            <div className="flex items-start gap-3 text-sm">
              <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" />
              <div className="min-w-0">
                <p className="font-medium">Export complete and verified.</p>
                <p className="mt-1 text-xs break-all text-text-muted">{report.path}</p>
                <p className="mt-1 text-xs text-text-muted">
                  {report.width > 0 ? `${report.width}×${report.height} · ` : "Audio · "}
                  {formatDuration(report.duration)} · {megabytes(report.sizeBytes)} · {report.encoder}
                </p>
              </div>
            </div>
            {report.warnings && report.warnings.length > 0 && (
              <ul
                className="mt-3 space-y-1 rounded-md border border-dashed px-3 py-2 text-xs text-text-muted"
                aria-label="Export notes"
              >
                {report.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
            {revealError && (
              <p role="alert" className="mt-3 text-xs text-danger">
                {revealError}
              </p>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <Button
                variant="secondary"
                className="pointer-coarse:h-11"
                onClick={() => {
                  setRevealError(null);
                  revealLastExport().catch((e: unknown) =>
                    setRevealError(e instanceof Error ? e.message : String(e)),
                  );
                }}
              >
                <FolderOpen /> Open folder
              </Button>
              <Button className="pointer-coarse:h-11" onClick={close}>
                Done
              </Button>
            </div>
          </div>
        )}

        {phase === "error" && (
          <div className="px-5 py-5">
            <div role="alert" className="flex items-start gap-3 text-sm">
              <TriangleAlert className="mt-0.5 size-5 shrink-0 text-danger" />
              <div className="min-w-0">
                <p className="font-medium">The export did not finish.</p>
                <p className="mt-1 text-xs break-words text-danger">{error}</p>
                <p className="mt-1 text-xs text-text-muted">
                  Any earlier file at that location was left untouched.
                </p>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="secondary" className="pointer-coarse:h-11" onClick={close}>
                Close
              </Button>
              <Button className="pointer-coarse:h-11" onClick={open}>
                Back to settings
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function ExportDialog() {
  const open = useExportStore((s) => s.phase !== "closed");
  const session = useExportStore((s) => s.session);
  return open ? <ExportDialogBody key={session} /> : null;
}
