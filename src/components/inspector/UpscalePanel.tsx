import { useEffect, useState } from "react";
import { Check, Download, Sparkles, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { MediaAsset, TimelineClip } from "@/project/model";
import { useProjectStore } from "@/store/project";
import { useUpscaleStore } from "@/store/upscale";
import { upscaleBlocker, upscaledSize, type UpscaleFactor } from "@/timeline/upscale";

const chip = (on: boolean) =>
  cn(
    "min-h-9 rounded-md border px-3 text-xs disabled:opacity-50 pointer-coarse:min-h-11 focus-visible:outline-accent",
    on
      ? "border-accent bg-accent-soft text-text"
      : "border-border bg-surface-2 text-text-muted hover:text-text",
  );

const megabytes = (bytes: number) => (bytes / 1048576).toFixed(1);
const seconds = (s: number) => (s < 90 ? `${Math.max(1, Math.round(s))} s` : `${Math.round(s / 60)} min`);

/**
 * "Upscale with AI" for a picture clip: choose a model and 2x or 4x, download the model once (after
 * agreeing), and the clip switches to the enlarged copy as one undo step. Runs on this computer.
 */
export function UpscalePanel({ clip, asset }: { clip: TimelineClip; asset: MediaAsset }) {
  const models = useUpscaleStore((s) => s.models);
  const loaded = useUpscaleStore((s) => s.loaded);
  const download = useUpscaleStore((s) => s.download);
  const running = useUpscaleStore((s) => s.running);
  const blocker = useProjectStore((s) => upscaleBlocker(s.project, clip.id));
  const [chosen, setChosen] = useState<string | null>(null);
  const [factor, setFactor] = useState<UpscaleFactor>(2);
  const [note, setNote] = useState<{ kind: "ok" | "problem"; text: string } | null>(null);
  const [now, setNow] = useState(0);
  useEffect(() => useUpscaleStore.getState().ensure(), []);
  // while it runs, redraw once a second so the time left stays current
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  const model = models.find((m) => m.id === chosen) ?? models.find((m) => m.installed) ?? models[0];
  const busy = download !== null || running !== null;
  const mine = running?.clipId === clip.id;
  const size = upscaledSize(asset, factor);
  const store = useUpscaleStore.getState;
  // time left from how long the finished part took: measured here, never a fixed claim
  const elapsed = mine && now > running.startedAt ? (now - running.startedAt) / 1000 : 0;
  const left =
    mine && elapsed > 0 && running.fraction > 0.02
      ? (elapsed / running.fraction) * (1 - running.fraction)
      : null;

  async function run() {
    if (!model) return;
    setNote(null);
    const problem = await store().upscaleClip(clip.id, model.id, factor);
    setNote(
      problem
        ? { kind: /^Stopped/.test(problem) ? "ok" : "problem", text: problem }
        : {
            kind: "ok",
            text: "Done. The clip now uses the enlarged picture; Undo brings the original back.",
          },
    );
  }

  return (
    <div role="group" aria-label="Upscale with AI" className="space-y-2 border-t pt-3 text-xs">
      <p className="flex items-center gap-2 text-sm font-medium text-text [&_svg]:size-4 [&_svg]:text-accent">
        <Sparkles />
        Upscale with AI
      </p>
      <p className="text-text-muted">
        Makes the picture larger and sharper with a small model that runs on this computer. Your original file
        is not changed.
      </p>
      {blocker ? (
        <p className="rounded-md border border-dashed px-2 py-1.5 text-text-muted">{blocker}</p>
      ) : (
        <>
          {!loaded && <p className="text-text-muted">Checking for upscale models…</p>}
          {loaded && model && (
            <>
              <div role="radiogroup" aria-label="Upscale model" className="flex flex-wrap gap-1.5">
                {models.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    role="radio"
                    aria-checked={m.id === model.id}
                    aria-label={`${m.label}, ${m.approxMb} MB${m.installed ? ", downloaded" : ""}`}
                    disabled={busy}
                    className={cn(chip(m.id === model.id), "flex items-center gap-1.5")}
                    onClick={() => setChosen(m.id)}
                  >
                    {m.label.split(" (")[0]} · {m.approxMb} MB
                    {m.installed && <Check className="size-3.5 text-success" aria-hidden />}
                  </button>
                ))}
              </div>
              <div
                role="radiogroup"
                aria-label="How much larger"
                className="flex flex-wrap items-center gap-1.5"
              >
                {([2, 4] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    role="radio"
                    aria-checked={factor === f}
                    disabled={busy}
                    className={chip(factor === f)}
                    onClick={() => setFactor(f)}
                  >
                    {f}×
                  </button>
                ))}
                {size && asset.width && asset.height && (
                  <span className="text-text-muted tabular-nums">
                    {asset.width}×{asset.height} → {size.width}×{size.height}
                  </span>
                )}
              </div>

              {download ? (
                <div className="space-y-1.5">
                  <p role="status" className="text-text-muted">
                    Downloading… {megabytes(download.received)}
                    {download.total ? ` of ${megabytes(download.total)}` : ""} MB
                  </p>
                  <button type="button" className={chip(false)} onClick={() => store().cancel()}>
                    Cancel download
                  </button>
                </div>
              ) : !model.installed ? (
                <div className="space-y-1">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void store().downloadWithConsent(model.id).then(setNote)}
                    className="flex h-9 w-full items-center justify-center gap-2 rounded-md border border-accent/60 bg-accent-soft px-2 text-text hover:border-accent disabled:opacity-40 pointer-coarse:h-11 [&_svg]:size-4"
                  >
                    <Download />
                    Download model (about {model.approxMb} MB)…
                  </button>
                  <p className="text-text-muted">You are asked before anything is downloaded.</p>
                </div>
              ) : mine ? (
                <div className="space-y-1.5">
                  <p role="status" className="text-text-muted">
                    Enlarging… {Math.round(running.fraction * 100)}%
                    {left !== null ? ` · about ${seconds(left)} left` : ""}
                  </p>
                  <div
                    role="progressbar"
                    aria-label="Upscale"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(running.fraction * 100)}
                    className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2"
                  >
                    <div
                      className="h-full bg-accent transition-[width]"
                      style={{ width: `${running.fraction * 100}%` }}
                    />
                  </div>
                  <button type="button" className={chip(false)} onClick={() => store().cancel()}>
                    Stop
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run()}
                    className="flex h-10 flex-1 items-center justify-center gap-2 rounded-md bg-accent px-2 text-sm font-medium text-black hover:bg-accent-hover disabled:opacity-40 pointer-coarse:h-11 [&_svg]:size-4"
                  >
                    <Sparkles />
                    Upscale {factor}×
                  </button>
                  <button
                    type="button"
                    aria-label="Remove this model from this computer"
                    title="Remove this model from this computer"
                    disabled={busy}
                    onClick={() => void store().remove(model.id)}
                    className="flex size-10 shrink-0 items-center justify-center rounded-md border text-text-muted hover:text-danger disabled:opacity-40 pointer-coarse:size-11 [&_svg]:size-4"
                  >
                    <Trash2 />
                  </button>
                </div>
              )}
              <p className="text-text-muted">
                A large picture can take a while on the processor; the time left is shown once it starts.
                Transparent areas become opaque.
              </p>
            </>
          )}
        </>
      )}
      {note && (
        <p
          role={note.kind === "problem" ? "alert" : "status"}
          className={cn(
            "rounded-md border px-2 py-1.5",
            note.kind === "problem" ? "border-danger/50 text-danger" : "border-border text-text-muted",
          )}
        >
          {note.text}
        </p>
      )}
    </div>
  );
}
