import { useEffect, useRef, useState } from "react";
import { AudioLines, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { cn } from "@/lib/utils";
import { useAutoMatch } from "@/store/autoMatch";
import { useBeatStore } from "@/store/beats";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useUiStore } from "@/store/ui";
import type { TimelineClip } from "@/project/model";
import { CUT_EVERY, planAutoMatch, type BeatGrid, type CutEvery } from "@/timeline/beats";
import { autoMatchClips } from "@/timeline/editor";

const choice = "flex h-9 items-center justify-center rounded-md border px-2 text-xs pointer-coarse:h-11";

/**
 * Auto-match: the media picked in the library is put one after another on a new track, each as long as a
 * few beats of the selected clip's beat grid. Opened from the library's "Match to beat" button.
 */
export function AutoMatchDialog() {
  const assetIds = useAutoMatch((s) => s.assetIds);
  return assetIds ? <Body assetIds={assetIds} /> : null;
}

function Body({ assetIds }: { assetIds: string[] }) {
  const project = useProjectStore((s) => s.project);
  const grids = useBeatStore((s) => s.grids);
  const selected = useSelectionStore((s) => s.selectedClipIds);
  const [every, setEvery] = useState<CutEvery>(1);
  const [repeat, setRepeat] = useState(false);
  const [keepSound, setKeepSound] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  useFocusTrap(rootRef);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !useUiStore.getState().dialog) useAutoMatch.getState().close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // the beats come from the first selected clip whose grid is loaded (cheap enough to work out on each render)
  const clips = project.tracks.flatMap((t) => t.clips);
  let source: { clip: TimelineClip; grid: BeatGrid } | null = null;
  for (const id of selected) {
    const clip = clips.find((c) => c.id === id);
    const grid = clip?.beatFx?.gridId ? grids[clip.beatFx.gridId] : undefined;
    if (clip && grid) {
      source = { clip, grid };
      break;
    }
  }
  const plan = source
    ? planAutoMatch(project, source.clip, source.grid, assetIds, { beatsPerClip: every, repeat, keepSound })
    : null;
  const shorter = plan?.ok ? plan.placements.filter((p) => p.short).length : 0;

  function place() {
    if (!source) return;
    const result = autoMatchClips(source.clip.id, source.grid, assetIds, {
      beatsPerClip: every,
      repeat,
      keepSound,
    });
    if (result.ok) useAutoMatch.getState().close();
    else setProblem(result.error.message);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-4">
      <div
        ref={rootRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="auto-match-title"
        className="flex max-h-full w-full max-w-md flex-col border bg-surface-1 shadow-xl max-sm:rounded-t-lg sm:max-h-[90vh] sm:rounded-lg"
      >
        <header className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
          <h2
            id="auto-match-title"
            className="flex min-w-0 items-center gap-2 text-sm font-semibold [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-accent"
          >
            <AudioLines aria-hidden />
            <span className="truncate">Match to the beat</span>
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={() => useAutoMatch.getState().close()}
            className="ml-auto flex size-9 shrink-0 items-center justify-center rounded-md text-text-muted hover:text-text pointer-coarse:size-11 focus-visible:outline-accent [&_svg]:size-4"
          >
            <X />
          </button>
        </header>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-xs">
          {!source ? (
            <p role="status" className="text-text-muted">
              Select a clip on the timeline whose beats are found first (Audio tab, Beats, Detect beats). Its
              beats set where each of the {assetIds.length} picked file{assetIds.length === 1 ? "" : "s"}{" "}
              starts and ends.
            </p>
          ) : (
            <>
              <p className="text-text-muted">
                {assetIds.length} file{assetIds.length === 1 ? "" : "s"} go one after another from the first
                beat of the selected clip, on a new track.
              </p>
              <div role="radiogroup" aria-label="Beats per clip" className="space-y-1">
                <div className="text-text-muted">Each clip lasts</div>
                <div className="grid grid-cols-4 gap-1">
                  {CUT_EVERY.map((n) => (
                    <button
                      key={n}
                      type="button"
                      role="radio"
                      aria-checked={every === n}
                      onClick={() => setEvery(n)}
                      className={cn(
                        choice,
                        every === n
                          ? "border-accent/60 bg-accent-soft text-text"
                          : "border-border bg-surface-2 text-text-muted hover:text-text",
                      )}
                    >
                      {n === 1 ? "1 beat" : `${n} beats`}
                    </button>
                  ))}
                </div>
              </div>
              <label className="flex items-center gap-2 text-text-muted">
                <input
                  type="checkbox"
                  checked={repeat}
                  onChange={(e) => setRepeat(e.target.checked)}
                  className="size-4 accent-[var(--accent)]"
                />
                Go round the list again until the beats run out
              </label>
              <label className="flex items-center gap-2 text-text-muted">
                <input
                  type="checkbox"
                  checked={keepSound}
                  onChange={(e) => setKeepSound(e.target.checked)}
                  className="size-4 accent-[var(--accent)]"
                />
                Keep the sound of the videos (otherwise they are muted)
              </label>
              {plan?.ok ? (
                <p role="status">
                  {plan.placements.length} clip{plan.placements.length === 1 ? "" : "s"} will be placed.
                  {shorter > 0 &&
                    ` ${shorter} ${shorter === 1 ? "is" : "are"} shorter than their beats, so a gap follows.`}
                  {plan.skipped > 0 &&
                    ` ${plan.skipped} sound file${plan.skipped === 1 ? " is" : "s are"} left out.`}
                </p>
              ) : (
                <p role="status" className="text-danger">
                  {plan?.message}
                </p>
              )}
            </>
          )}
          {problem && (
            <p role="alert" className="text-danger">
              {problem}
            </p>
          )}
        </div>
        <footer className="flex shrink-0 justify-end gap-2 border-t px-4 py-2">
          <Button
            variant="secondary"
            className="h-9 pointer-coarse:h-11"
            onClick={() => useAutoMatch.getState().close()}
          >
            Cancel
          </Button>
          <Button className="h-9 pointer-coarse:h-11" disabled={!plan?.ok} onClick={place}>
            Place clips
          </Button>
        </footer>
      </div>
    </div>
  );
}
