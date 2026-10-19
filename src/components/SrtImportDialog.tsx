import { useEffect, useRef, useState } from "react";
import { Captions, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CaptionLimitsFields } from "@/components/inspector/CaptionLimitsFields";
import { SubtitleLook } from "@/components/text/SubtitleLook";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { useUiStore } from "@/store/ui";
import { importedNotice, placeSrt, shiftSubtitles, useSrtImport, type SrtFile } from "@/timeline/srtImport";

const SAMPLE = 3;
const MAX_SHIFT = 24 * 3600;

/** m:ss.t, signed: how a time or a shift reads in the dialog. */
export function clock(seconds: number): string {
  const sign = seconds < -0.05 ? "−" : "";
  const tenths = Math.round(Math.abs(seconds) * 10);
  const m = Math.floor(tenths / 600);
  const s = (tenths % 600) / 10;
  return `${sign}${m}:${s.toFixed(1).padStart(4, "0")}`;
}

/** Import subtitles: the cues of the chosen `.srt`, a time shift, the subtitle look and the caption length. */
export function SrtImportDialog() {
  const file = useSrtImport((s) => s.file);
  return file ? <Body file={file} /> : null;
}

function Body({ file }: { file: SrtFile }) {
  const width = useProjectStore((s) => s.project.settings.width);
  const height = useProjectStore((s) => s.project.settings.height);
  const [shift, setShift] = useState(0);
  const [typed, setTyped] = useState("0");
  const [stage, setStage] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const busy = stage !== null;
  const rootRef = useRef<HTMLDivElement>(null);
  useFocusTrap(rootRef);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !useUiStore.getState().dialog) useSrtImport.getState().close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const first = file.subtitles[0].start;
  const moved = shiftSubtitles(file.subtitles, shift);
  const lost = file.subtitles.length - moved.length;

  function shiftTo(seconds: number) {
    const next = Math.round(Math.min(MAX_SHIFT, Math.max(-MAX_SHIFT, seconds)) * 1000) / 1000;
    setShift(next);
    setTyped(String(next));
  }
  function commitTyped() {
    const n = Number(typed.replace(",", "."));
    if (typed.trim() !== "" && Number.isFinite(n)) shiftTo(n);
    else setTyped(String(shift));
  }
  async function run() {
    setProblem(null);
    setStage("Cutting into captions…");
    const result = await placeSrt(file.subtitles, shift, setStage);
    setStage(null);
    if (!result.ok) return setProblem(result.reason);
    useSrtImport.getState().close();
    useUiStore.getState().setNotice(importedNotice(result.added));
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-4">
      <div
        ref={rootRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="srt-import-title"
        className="flex max-h-full w-full max-w-xl flex-col border bg-surface-1 shadow-xl max-sm:rounded-t-lg sm:max-h-[90vh] sm:rounded-lg"
      >
        <header className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
          <h2
            id="srt-import-title"
            className="flex min-w-0 items-center gap-2 text-sm font-semibold [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-accent"
          >
            <Captions />
            <span className="truncate">Import subtitles · {file.name}</span>
          </h2>
          <button
            type="button"
            aria-label="Close"
            disabled={busy}
            onClick={() => useSrtImport.getState().close()}
            className="ml-auto flex size-9 shrink-0 items-center justify-center rounded-md text-text-muted hover:text-text disabled:opacity-40 pointer-coarse:size-11 focus-visible:outline-accent [&_svg]:size-4"
          >
            <X />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-xs">
          <section aria-labelledby="srt-timing" className="space-y-2">
            <h3 id="srt-timing" className="font-medium text-text-muted">
              1 · Timing
            </h3>
            <div className="flex flex-wrap items-end gap-2">
              <label className="space-y-1">
                <span className="block text-text-muted">Move all subtitles by (seconds)</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={typed}
                  disabled={busy}
                  onChange={(e) => setTyped(e.target.value)}
                  onBlur={commitTyped}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitTyped();
                  }}
                  className="h-9 w-32 rounded-md border bg-surface-2 px-2 text-sm pointer-coarse:h-11 focus-visible:outline-accent"
                />
              </label>
              <Button
                variant="secondary"
                disabled={busy}
                className="h-9 pointer-coarse:h-11"
                onClick={() => shiftTo(usePlaybackStore.getState().playhead - first)}
              >
                First subtitle at the playhead
              </Button>
              <Button
                variant="secondary"
                disabled={busy || shift === 0}
                className="h-9 pointer-coarse:h-11"
                onClick={() => shiftTo(0)}
              >
                Times as in the file
              </Button>
            </div>
            <p className="text-text-muted">
              {file.subtitles.length} subtitle{file.subtitles.length === 1 ? "" : "s"}; the first starts at{" "}
              {clock(Math.max(0, first + shift))} on the timeline
              {shift !== 0 ? ` (${shift > 0 ? "+" : ""}${clock(shift)})` : ""}.
              {lost > 0 ? ` ${lost} would fall before the start and are left out.` : ""}
            </p>
            <ol aria-label="First subtitles" className="space-y-1 rounded-md border bg-surface-2 p-2">
              {moved.slice(0, SAMPLE).map((s, i) => (
                <li key={i} className="flex gap-2">
                  <span className="shrink-0 font-mono text-text-muted">
                    {clock(s.start)}–{clock(s.start + s.duration)}
                  </span>
                  <span className="min-w-0 break-words">{s.text}</span>
                </li>
              ))}
              {moved.length > SAMPLE && (
                <li className="text-text-muted">…and {moved.length - SAMPLE} more</li>
              )}
            </ol>
          </section>

          <section aria-labelledby="srt-look" className="space-y-2">
            <h3 id="srt-look" className="font-medium text-text-muted">
              2 · Style, position and size
            </h3>
            <SubtitleLook disabled={busy} />
          </section>

          <section aria-labelledby="srt-length" className="space-y-2">
            <h3 id="srt-length" className="font-medium text-text-muted">
              3 · Caption length
            </h3>
            <p className="text-text-muted">Long subtitles are cut into captions within these limits.</p>
            <CaptionLimitsFields width={width} height={height} />
          </section>
        </div>

        <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t px-4 py-2">
          {problem && (
            <p role="alert" className="w-full text-xs text-danger">
              {problem}
            </p>
          )}
          <Button
            variant="secondary"
            disabled={busy}
            className="pointer-coarse:h-11"
            onClick={() => useSrtImport.getState().close()}
          >
            Cancel
          </Button>
          <Button
            disabled={busy || moved.length === 0}
            className="ml-auto pointer-coarse:h-11"
            onClick={() => void run()}
          >
            {stage ?? `Import ${moved.length} subtitle${moved.length === 1 ? "" : "s"}`}
          </Button>
        </footer>
      </div>
    </div>
  );
}
