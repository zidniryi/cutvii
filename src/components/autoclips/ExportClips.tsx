import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { FolderOpen, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { QUALITIES, type Quality } from "@/export/options";
import { cancelExport, revealLastExport } from "@/lib/exportApi";
import { formatDuration } from "@/lib/timecode";
import { useAutoClipsStore } from "@/store/autoClips";
import { useProjectStore } from "@/store/project";
import {
  EXPORT_SIZES,
  exportCanvas,
  exportSelectedClips,
  type BatchReport,
  type ExportSize,
} from "@/timeline/createClips";

const fieldClass =
  "h-9 rounded-md border bg-surface-2 px-2 text-sm pointer-coarse:h-11 focus-visible:outline-accent";
/** A file whose measured length is further than this from the clip's is flagged. */
const DURATION_TOLERANCE = 0.15;

/** Export each selected clip as its own file, straight from the review: the open project is not changed. */
export function ExportClips() {
  const count = useAutoClipsStore((s) => s.clips.filter((c) => c.included).length);
  const output = useAutoClipsStore((s) => (s.context?.video ? s.settings.output : "keep"));
  const video = useAutoClipsStore((s) => s.context?.video ?? true);
  const width = useProjectStore((s) => s.project.settings.width);
  const height = useProjectStore((s) => s.project.settings.height);
  const [size, setSize] = useState<ExportSize>(1080);
  const [quality, setQuality] = useState<Quality>("standard");
  const [stage, setStage] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ index: number; total: number; fraction: number } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<{ report: BatchReport; expected: number[] } | null>(null);

  useEffect(() => {
    const stop = listen<{ index: number; total: number; fraction: number }>("export-clips-progress", (e) =>
      setProgress(e.payload),
    );
    return () => void Promise.resolve(stop).then((off) => off?.());
  }, []);

  async function run() {
    setProblem(null);
    setDone(null);
    setProgress(null);
    setStage("Preparing…");
    const result = await exportSelectedClips(size, quality, setStage);
    setStage(null);
    setProgress(null);
    if (!result.ok) return setProblem(result.reason);
    if (result.report) setDone({ report: result.report, expected: result.expected });
  }

  const canvas = exportCanvas(output, size, { width, height });
  const written = done?.report.files.filter((f) => f.report).length ?? 0;
  return (
    <fieldset className="space-y-2 border-t pt-4">
      <legend className="mb-1 text-xs font-medium text-text-muted">
        Or export each clip as its own file
      </legend>
      <div className="flex flex-wrap items-center gap-2">
        {video && (
          <select
            aria-label="Export size"
            className={fieldClass}
            value={size}
            disabled={stage !== null}
            onChange={(e) => setSize(Number(e.target.value) === 720 ? 720 : 1080)}
          >
            {EXPORT_SIZES.map((s) => {
              const c = exportCanvas(output, s, { width, height });
              return (
                <option key={s} value={s}>
                  {c.width}×{c.height}
                </option>
              );
            })}
          </select>
        )}
        <select
          aria-label="Export quality"
          className={fieldClass}
          value={quality}
          disabled={stage !== null}
          onChange={(e) => setQuality(e.target.value as Quality)}
        >
          {QUALITIES.map((q) => (
            <option key={q.id} value={q.id} title={q.hint}>
              {q.label}
            </option>
          ))}
        </select>
      </div>
      <p className="text-xs text-text-muted">
        {video ? `MP4, ${canvas.width}×${canvas.height}` : "M4A sound"}, one file per clip, named after its
        title. You choose the folder once; nothing in it is overwritten. This does not change your project.
      </p>
      {stage ? (
        <div className="space-y-2">
          <p role="status" className="text-text-muted">
            {progress
              ? `Exporting clip ${progress.index + 1} of ${progress.total}… ${Math.round(progress.fraction * 100)}%`
              : stage}
          </p>
          {progress && (
            <div
              role="progressbar"
              aria-label="Export clips"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(((progress.index + progress.fraction) / progress.total) * 100)}
              className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2"
            >
              <div
                className="h-full bg-accent transition-[width]"
                style={{ width: `${((progress.index + progress.fraction) / progress.total) * 100}%` }}
              />
            </div>
          )}
          {progress && (
            <Button variant="secondary" className="pointer-coarse:h-11" onClick={() => void cancelExport()}>
              Stop export
            </Button>
          )}
        </div>
      ) : (
        <Button
          variant="secondary"
          disabled={count === 0}
          className="pointer-coarse:h-11"
          onClick={() => void run()}
        >
          <Upload /> Export {count} clip{count === 1 ? "" : "s"}…
        </Button>
      )}
      {problem && (
        <p role="alert" className="rounded-md border border-danger/50 px-3 py-2 text-danger">
          {problem}
        </p>
      )}
      {done && (
        <div role="status" className="space-y-1 rounded-md border px-3 py-2 text-xs">
          <p className="text-sm">
            {done.report.cancelled ? "Stopped. " : ""}
            {written} of {done.expected.length} file{done.expected.length === 1 ? "" : "s"} written to{" "}
            <span className="break-all text-text-muted">{done.report.folder}</span>
          </p>
          <ul className="space-y-0.5">
            {done.report.files.map((f, i) => {
              const off = f.report && Math.abs(f.report.duration - done.expected[i]) > DURATION_TOLERANCE;
              return (
                <li key={i} className={f.error || off ? "text-danger" : "text-text-muted"}>
                  {f.title || "Clip"}:{" "}
                  {f.report
                    ? `${formatDuration(f.report.duration)}${off ? ` (expected ${formatDuration(done.expected[i])})` : ""}`
                    : `failed: ${f.error}`}
                </li>
              );
            })}
          </ul>
          {written > 0 && (
            <Button
              variant="secondary"
              size="sm"
              className="pointer-coarse:h-11"
              onClick={() => void revealLastExport().catch((e: Error) => setProblem(e.message))}
            >
              <FolderOpen /> Show in folder
            </Button>
          )}
        </div>
      )}
    </fieldset>
  );
}
