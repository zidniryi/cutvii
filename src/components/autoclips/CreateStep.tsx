import { Download, FolderOpen, ListPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { QUALITIES, type Quality } from "@/export/options";
import { revealLastExport } from "@/lib/exportApi";
import { formatDuration } from "@/lib/timecode";
import { cn } from "@/lib/utils";
import { useAutoClipsStore } from "@/store/autoClips";
import { useClipOutputStore } from "@/store/clipOutput";
import { useProjectStore } from "@/store/project";
import { OUTPUTS } from "@/timeline/autoClips";
import { EXPORT_SIZES, exportCanvas } from "@/timeline/createClips";
import { SubtitleSize } from "./SubtitleSize";

const fieldClass =
  "h-9 rounded-md border bg-surface-2 px-2 text-sm pointer-coarse:h-11 focus-visible:outline-accent";
/** A file whose measured length is further than this from the clip's is flagged. */
const DURATION_TOLERANCE = 0.15;
const SHAPE: Record<string, number | null> = { vertical: 9 / 16, square: 1, keep: null };

function Card({
  icon,
  title,
  text,
  primary = false,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  text: string;
  primary?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className={cn(
        "flex flex-col gap-3 rounded-lg border p-4",
        primary ? "border-accent/50 bg-accent-soft" : "border-border bg-surface-2",
      )}
    >
      <h3 className="flex items-center gap-2 text-sm font-semibold [&_svg]:size-4 [&_svg]:text-accent">
        {icon}
        {title}
      </h3>
      <p className="text-xs text-text-muted">{text}</p>
      {children}
    </section>
  );
}

/**
 * Step 3: two separate things to do with the chosen clips. Save them as video files (asks for a folder
 * first, then renders), or add them to this project's timeline. One at a time; either can be done after
 * the other.
 */
export function CreateStep() {
  const count = useAutoClipsStore((s) => s.clips.filter((c) => c.included).length);
  const settings = useAutoClipsStore((s) => s.settings);
  const video = useAutoClipsStore((s) => s.context?.video ?? true);
  const width = useProjectStore((s) => s.project.settings.width);
  const height = useProjectStore((s) => s.project.settings.height);
  const out = useClipOutputStore();
  const shape = video ? settings.output : "keep";
  const output = OUTPUTS.find((o) => o.id === settings.output)!;
  const canvas = exportCanvas(shape, out.size, { width, height });
  const wanted = SHAPE[settings.output];
  const canvasDiffers = video && wanted !== null && Math.abs(width / height - wanted) > 0.01;
  const clips = `${count} clip${count === 1 ? "" : "s"}`;
  const written = out.done?.report.files.filter((f) => f.report).length ?? 0;
  const p = out.progress;

  return (
    <div className="mx-auto max-w-4xl space-y-4 text-sm">
      <p>
        {clips} selected · {video ? output.label : "Sound only"} ·{" "}
        {settings.subtitles ? "with subtitles" : "no subtitles"}
      </p>
      {settings.subtitles && <SubtitleSize disabled={out.busy !== null} />}
      <div className="grid gap-4 md:grid-cols-2">
        <Card
          primary
          icon={<Download />}
          title="Save as video files"
          text={`One ${video ? `MP4 (${canvas.width}×${canvas.height})` : "M4A"} per clip, named after its title. You choose the folder first; nothing in it is overwritten. Your project is not changed.`}
        >
          <div className="flex flex-wrap items-center gap-2">
            {video && (
              <select
                aria-label="Export size"
                className={fieldClass}
                value={out.size}
                disabled={out.busy !== null}
                onChange={(e) => out.setSize(Number(e.target.value) === 720 ? 720 : 1080)}
              >
                {EXPORT_SIZES.map((s) => {
                  const c = exportCanvas(shape, s, { width, height });
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
              value={out.quality}
              disabled={out.busy !== null}
              onChange={(e) => out.setQuality(e.target.value as Quality)}
            >
              {QUALITIES.map((q) => (
                <option key={q.id} value={q.id} title={q.hint}>
                  {q.label} quality
                </option>
              ))}
            </select>
          </div>
          {out.busy === "export" ? (
            <div className="space-y-2">
              <p role="status">
                {p ? `Saving clip ${p.index + 1} of ${p.total}… ${Math.round(p.fraction * 100)}%` : out.stage}
              </p>
              <div
                role="progressbar"
                aria-label="Saving clips"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={p ? Math.round(((p.index + p.fraction) / p.total) * 100) : undefined}
                className="h-1.5 w-full overflow-hidden rounded-full bg-surface-1"
              >
                <div
                  className={
                    p ? "h-full bg-accent transition-[width]" : "h-full w-1/3 animate-pulse bg-accent"
                  }
                  style={p ? { width: `${((p.index + p.fraction) / p.total) * 100}%` } : undefined}
                />
              </div>
              {p && (
                <Button variant="secondary" className="pointer-coarse:h-11" onClick={out.stopExport}>
                  Stop
                </Button>
              )}
              <p className="text-xs text-text-muted">
                You can close this window; saving continues. The normal Export is unavailable until it is
                done.
              </p>
            </div>
          ) : (
            <Button
              disabled={count === 0 || out.busy !== null}
              className="pointer-coarse:h-11"
              onClick={() => void out.exportFiles()}
            >
              <FolderOpen /> Choose folder and save {clips}
            </Button>
          )}
          {out.done && (
            <div role="status" className="space-y-1 rounded-md border bg-surface-1 px-3 py-2 text-xs">
              <p className="text-sm">
                {out.done.report.cancelled ? "Stopped. " : ""}
                {written} of {out.done.expected.length} saved in{" "}
                <span className="break-all text-text-muted">{out.done.report.folder}</span>
              </p>
              <ul className="space-y-0.5">
                {out.done.report.files.map((f, i) => {
                  const expected = out.done!.expected[i];
                  const off = f.report && Math.abs(f.report.duration - expected) > DURATION_TOLERANCE;
                  return (
                    <li key={i} className={f.error || off ? "text-danger" : "text-text-muted"}>
                      {f.title || "Clip"}:{" "}
                      {f.report
                        ? `${formatDuration(f.report.duration)}${off ? ` (expected ${formatDuration(expected)})` : ""}`
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
                  onClick={() => void revealLastExport().catch(() => undefined)}
                >
                  <FolderOpen /> Show in folder
                </Button>
              )}
            </div>
          )}
        </Card>

        <Card
          icon={<ListPlus />}
          title="Add to the timeline"
          text="Puts the clips on new tracks, one after another, after everything already in this project, so you can keep editing them. Nothing existing is moved. One Undo removes them all."
        >
          {canvasDiffers && (
            <p className="rounded-md border border-border px-3 py-2 text-xs text-text-muted">
              This project is {width}×{height}, not {output.label}: on the timeline the clips fill that
              canvas. Change the canvas from the top bar if you want {output.label} here too.
            </p>
          )}
          {out.busy === "create" ? (
            <p role="status" className="text-text-muted">
              {out.stage}
            </p>
          ) : (
            <Button
              variant="secondary"
              disabled={count === 0 || out.busy !== null}
              className="pointer-coarse:h-11"
              onClick={() => void out.addToTimeline()}
            >
              <ListPlus /> Add {clips} to the timeline
            </Button>
          )}
          <p aria-disabled className="flex items-center gap-2 text-xs text-text-muted opacity-70">
            New project per clip
            <span className="rounded-sm bg-surface-1 px-1.5 py-0.5 text-[10px]">Coming soon</span>
          </p>
        </Card>
      </div>
      {out.problem && (
        <p role="alert" className="rounded-md border border-danger/50 px-3 py-2 text-danger">
          {out.problem}
        </p>
      )}
    </div>
  );
}
