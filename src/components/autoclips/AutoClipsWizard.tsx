import { useEffect, useRef, useState } from "react";
import { Check, Scissors, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { cn } from "@/lib/utils";
import { useAutoClipsStore, usableModel, type WizardStep } from "@/store/autoClips";
import { useAiStore } from "@/store/ai";
import { useProjectStore } from "@/store/project";
import { useUiStore } from "@/store/ui";
import { createClipsInProject } from "@/timeline/createClips";
import { lengthRange, OUTPUTS } from "@/timeline/autoClips";
import { ReviewStep } from "./ReviewStep";
import { SettingsStep } from "./SettingsStep";

const STEPS: { n: WizardStep; title: string }[] = [
  { n: 1, title: "Settings" },
  { n: 2, title: "Review" },
  { n: 3, title: "Create" },
];

function Progress() {
  const percent = useAutoClipsStore((s) => s.percent);
  return (
    <div className="mx-auto max-w-md space-y-3 py-10 text-center">
      <p className="text-sm">
        {percent === null ? "Getting ready…" : `Listening to the speech… ${percent}%`}
      </p>
      <div
        role="progressbar"
        aria-label="Finding clips"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2"
      >
        <div
          className={
            percent === null ? "h-full w-1/3 animate-pulse bg-accent" : "h-full bg-accent transition-[width]"
          }
          style={percent === null ? undefined : { width: `${percent}%` }}
        />
      </div>
      <p className="text-xs text-text-muted">
        You can close this window and keep editing. The AI tab shows “Clips ready” when it is done.
      </p>
    </div>
  );
}

const SHAPE: Record<string, number | null> = { vertical: 9 / 16, square: 1, keep: null };

/** Step 3: put the chosen clips on the timeline, as one step that can be undone. */
function CreateStep() {
  const count = useAutoClipsStore((s) => s.clips.filter((c) => c.included).length);
  const settings = useAutoClipsStore((s) => s.settings);
  const width = useProjectStore((s) => s.project.settings.width);
  const height = useProjectStore((s) => s.project.settings.height);
  const [stage, setStage] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const output = OUTPUTS.find((o) => o.id === settings.output)!;
  const wanted = SHAPE[settings.output];
  const canvasDiffers = wanted !== null && Math.abs(width / height - wanted) > 0.01;

  async function create() {
    setProblem(null);
    setStage("Preparing…");
    const result = await createClipsInProject(setStage);
    setStage(null);
    if (!result.ok) return setProblem(result.reason);
    const n = result.clipIds.length;
    useAutoClipsStore.getState().hide();
    useUiStore
      .getState()
      .setNotice(
        `Created ${n} clip${n === 1 ? "" : "s"} at the end of the timeline${result.subtitles > 0 ? `, with ${result.subtitles} subtitles` : ""}. They are selected; Undo removes them all.`,
      );
  }

  return (
    <div className="mx-auto max-w-md space-y-4 py-6 text-sm">
      <p>
        {count} clip{count === 1 ? "" : "s"} selected · {output.label} ·{" "}
        {settings.subtitles ? "with subtitles" : "no subtitles"}
      </p>
      <fieldset className="space-y-2">
        <legend className="mb-1 text-xs font-medium text-text-muted">Where</legend>
        <label className="flex min-h-9 items-start gap-2 pointer-coarse:min-h-11">
          <input type="radio" className="mt-1 accent-[var(--accent)]" checked readOnly />
          <span>
            Add to this project
            <span className="block text-xs text-text-muted">
              On new tracks, one after another, after everything already on the timeline. Nothing existing is
              moved and your original video is not changed.
            </span>
          </span>
        </label>
        <p aria-disabled className="flex items-center gap-2 pl-6 text-text-muted opacity-70">
          New project per clip
          <span className="rounded-sm bg-surface-2 px-1.5 py-0.5 text-[10px]">Coming soon</span>
        </p>
      </fieldset>
      {canvasDiffers && (
        <p className="rounded-md border border-border px-3 py-2 text-xs text-text-muted">
          This project's canvas is {width}×{height}, not {output.label}. The clips fill the canvas as it is;
          to get {output.label}, change the canvas from the top bar (before or after creating).
        </p>
      )}
      {stage ? (
        <p role="status" className="text-text-muted">
          {stage}
        </p>
      ) : (
        <Button disabled={count === 0} className="pointer-coarse:h-11" onClick={() => void create()}>
          Create {count} clip{count === 1 ? "" : "s"}
        </Button>
      )}
      {problem && (
        <p role="alert" className="rounded-md border border-danger/50 px-3 py-2 text-danger">
          {problem}
        </p>
      )}
      <p className="text-xs text-text-muted">One step: Undo (Ctrl/⌘ Z) removes all the created clips.</p>
    </div>
  );
}

/** Full-height wizard: 1 Settings, 2 Review, 3 Create. Closing it never stops a running search. */
export function AutoClipsWizard() {
  const open = useAutoClipsStore((s) => s.open);
  return open ? <WizardBody /> : null;
}

function WizardBody() {
  const step = useAutoClipsStore((s) => s.step);
  const status = useAutoClipsStore((s) => s.status);
  const error = useAutoClipsStore((s) => s.error);
  const settings = useAutoClipsStore((s) => s.settings);
  const clips = useAutoClipsStore((s) => s.clips);
  // re-read when models change (a download finishing enables the search)
  useAiStore((s) => s.models);
  const dialogOnTop = useUiStore((s) => s.dialog !== null);
  const rootRef = useRef<HTMLDivElement>(null);
  useFocusTrap(rootRef);
  const store = useAutoClipsStore.getState;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // a confirm dialog on top handles its own Escape
      if (e.key === "Escape" && !useUiStore.getState().dialog) store().hide();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store]);

  const running = status === "running";
  const range = lengthRange(settings);
  const canSearch = range.ok && usableModel(settings) !== null && !running;
  const included = clips.filter((c) => c.included).length;
  const reachable = (n: WizardStep) => n === 1 || (clips.length > 0 && !running && (n === 2 || included > 0));

  return (
    <div
      className="fixed inset-0 z-50 flex justify-center bg-black/60 sm:p-4"
      aria-hidden={dialogOnTop || undefined}
    >
      <div
        ref={rootRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="auto-clips-title"
        className="flex h-full w-full max-w-5xl flex-col border bg-surface-1 shadow-xl sm:rounded-lg"
      >
        <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2">
          <h2
            id="auto-clips-title"
            className="flex items-center gap-2 text-sm font-semibold [&_svg]:size-4 [&_svg]:text-accent"
          >
            <Scissors />
            Auto clips
          </h2>
          <ol aria-label="Steps" className="flex items-center gap-1 text-xs">
            {STEPS.map(({ n, title }) => (
              <li key={n}>
                <button
                  type="button"
                  aria-current={step === n ? "step" : undefined}
                  disabled={!reachable(n)}
                  onClick={() => store().setStep(n)}
                  className={cn(
                    "flex min-h-9 items-center gap-1.5 rounded-md px-2 disabled:opacity-40 pointer-coarse:min-h-11 focus-visible:outline-accent",
                    step === n ? "bg-accent-soft text-text" : "text-text-muted hover:text-text",
                  )}
                >
                  <span className="flex size-5 items-center justify-center rounded-full bg-surface-2 text-[10px] [&_svg]:size-3">
                    {n < step ? <Check /> : n}
                  </span>
                  {title}
                </button>
              </li>
            ))}
          </ol>
          <button
            type="button"
            aria-label="Close (a running search continues)"
            title="Close. A running search continues in the background."
            onClick={() => store().hide()}
            className="ml-auto flex size-9 items-center justify-center rounded-md text-text-muted hover:text-text pointer-coarse:size-11 focus-visible:outline-accent [&_svg]:size-4"
          >
            <X />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {running ? (
            <Progress />
          ) : step === 1 ? (
            <SettingsStep />
          ) : step === 2 ? (
            <ReviewStep />
          ) : (
            <CreateStep />
          )}
          {error && !running && step === 1 && (
            <p
              role="alert"
              className="mx-auto mt-4 max-w-3xl rounded-md border border-danger/50 px-3 py-2 text-sm text-danger"
            >
              {error}
            </p>
          )}
        </div>

        <footer className="flex shrink-0 items-center gap-2 border-t px-4 py-2">
          <Button
            variant="secondary"
            className="pointer-coarse:h-11"
            onClick={() => (running ? store().cancel() : store().hide())}
          >
            {running ? "Stop search" : "Cancel"}
          </Button>
          <div className="ml-auto flex items-center gap-2">
            {step > 1 && !running && (
              <Button
                variant="secondary"
                className="pointer-coarse:h-11"
                onClick={() => store().setStep((step - 1) as WizardStep)}
              >
                Back
              </Button>
            )}
            {step === 1 && !running && (
              <>
                {clips.length > 0 && (
                  <Button
                    variant="secondary"
                    className="pointer-coarse:h-11"
                    onClick={() => store().setStep(2)}
                  >
                    Back to review
                  </Button>
                )}
                <Button
                  disabled={!canSearch}
                  title={canSearch ? undefined : range.ok ? "Download a speech model first" : range.reason}
                  className="pointer-coarse:h-11"
                  onClick={() => void store().start()}
                >
                  {clips.length > 0 ? "Search again" : "Find clips"}
                </Button>
              </>
            )}
            {step === 2 && (
              <Button
                disabled={included === 0}
                title={included === 0 ? "Select at least one clip" : undefined}
                className="pointer-coarse:h-11"
                onClick={() => store().setStep(3)}
              >
                Next
              </Button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
