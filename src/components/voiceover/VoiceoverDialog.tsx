import { useEffect, useRef, useState } from "react";
import { AudioLines, Check, Download, Loader2, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { cn } from "@/lib/utils";
import { chosenModel, megabytes, useVoiceoverStore } from "@/store/voiceover";

const fieldClass =
  "h-9 w-full rounded-md border bg-surface-2 px-2 text-sm pointer-coarse:h-11 focus-visible:outline-accent";

/** Sizes that are planned but not offered: shown so the choice is visible, never as a working control. */
const PLANNED = [
  { title: "Tiny", size: "About 60 MB", languages: "English only: no Indonesian" },
  { title: "Expressive", size: "About 5 GB", languages: "Indonesian, English + 28 more" },
];

/** Voice-over: type words, pick a voice, and the speech lands on the timeline. Made on this computer. */
export function VoiceoverDialog() {
  const open = useVoiceoverStore((s) => s.open);
  return open ? <Body /> : null;
}

function Bar({ fraction, label }: { fraction: number; label: string }) {
  const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2"
    >
      <div className="h-full bg-accent transition-[width]" style={{ width: `${percent}%` }} />
    </div>
  );
}

function Body() {
  const { status, download, running, note, language, voice, speed } = useVoiceoverStore();
  const model = useVoiceoverStore((s) => (s.status ? chosenModel(s.status, s.model) : undefined));
  const { hide, setPrefs, downloadWithConsent, remove, create, cancel } = useVoiceoverStore.getState();
  const [text, setText] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  useFocusTrap(rootRef);
  const busy = download !== null || running !== null;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // the consent question sits on top and takes Escape first
      if (e.key === "Escape" && document.querySelectorAll('[role="dialog"]').length === 1) hide();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hide]);

  const shownSpeed = speed ?? status?.defaultSpeed ?? 1;
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-4"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && !busy) hide();
      }}
    >
      <div
        ref={rootRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="voiceover-title"
        className="flex max-h-[90dvh] w-full max-w-lg flex-col rounded-t-lg border bg-popover shadow-xl sm:rounded-lg"
      >
        <header className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
          <h2
            id="voiceover-title"
            className="flex flex-1 items-center gap-2 text-sm font-semibold [&_svg]:size-4 [&_svg]:text-accent"
          >
            <AudioLines />
            Voice-over
          </h2>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close"
            className="pointer-coarse:size-11"
            onClick={hide}
          >
            <X />
          </Button>
        </header>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-sm">
          {!status ? (
            <p className="flex items-center gap-2 text-xs text-text-muted [&_svg]:size-4">
              <Loader2 className="animate-spin" /> Looking for the voice model…
            </p>
          ) : (
            <>
              <div role="radiogroup" aria-label="Voice model" className="grid grid-cols-2 gap-1.5 text-xs">
                {status.models.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    role="radio"
                    aria-checked={m.id === model?.id}
                    aria-label={`${m.label}, ${megabytes(m.bytes)} MB${m.installed ? ", downloaded" : ""}`}
                    title={m.hint}
                    disabled={busy}
                    onClick={() => setPrefs({ model: m.id })}
                    className={cn(
                      "relative flex flex-col items-start rounded-md border px-2 py-1.5 text-left disabled:opacity-60 pointer-coarse:min-h-11",
                      m.id === model?.id
                        ? "border-accent bg-accent-soft text-text"
                        : "border-border bg-surface-2 text-text-muted hover:text-text",
                    )}
                  >
                    <span className="text-sm text-text">{m.label}</span>
                    <span className="tabular-nums">{megabytes(m.bytes)} MB</span>
                    <span>Indonesian, English + 29 more</span>
                    {m.installed && (
                      <span className="absolute top-1.5 right-1.5 text-success [&_svg]:size-3.5" aria-hidden>
                        <Check />
                      </span>
                    )}
                  </button>
                ))}
                {PLANNED.map((planned) => (
                  <div
                    key={planned.title}
                    aria-disabled
                    className="relative flex flex-col items-start rounded-md border border-dashed px-2 py-1.5 opacity-70"
                  >
                    <span className="text-sm text-text">{planned.title}</span>
                    <span>{planned.size}</span>
                    <span>{planned.languages}</span>
                    <span className="absolute top-1.5 right-1.5 rounded-sm bg-surface-2 px-1.5 py-0.5 text-[10px] text-text-muted">
                      Coming soon
                    </span>
                  </div>
                ))}
              </div>
              {model && <p className="text-xs text-text-muted">{model.hint}</p>}
              {model && !model.installed && (
                <div className="space-y-3">
                  <p className="text-text-muted">
                    Turn typed words into a spoken voice-over. The voice model is downloaded once (about{" "}
                    {megabytes(model.bytes)} MB) and then works without the internet.
                  </p>
                  {download ? (
                    <div className="space-y-2">
                      <Bar
                        label="Downloading the voice model"
                        fraction={download.received / (download.total ?? model.bytes)}
                      />
                      <div className="flex items-center justify-between text-xs text-text-muted tabular-nums">
                        <span>
                          {megabytes(download.received)} of {megabytes(download.total ?? model.bytes)} MB
                        </span>
                        <Button variant="outline" size="sm" className="pointer-coarse:h-11" onClick={cancel}>
                          Stop
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button
                      className="pointer-coarse:h-11"
                      onClick={() => void downloadWithConsent(model.id)}
                    >
                      <Download /> Download the voice model…
                    </Button>
                  )}
                </div>
              )}
              {model?.installed && (
                <>
                  <div>
                    <div className="mb-1 flex items-center justify-between text-xs text-text-muted">
                      <label htmlFor="voiceover-text">Words to speak</label>
                      <span className="tabular-nums">
                        {text.length} / {status.maxChars}
                      </span>
                    </div>
                    <textarea
                      id="voiceover-text"
                      rows={5}
                      maxLength={status.maxChars}
                      value={text}
                      disabled={busy}
                      placeholder="Halo, selamat datang di video saya…"
                      className="w-full resize-y rounded-md border bg-surface-2 p-2 text-sm focus-visible:outline-accent"
                      onChange={(e) => setText(e.target.value)}
                    />
                    <p className="mt-1 text-xs text-text-muted">
                      Prices, dates and symbols are read best when written out as words.
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="block text-xs text-text-muted">
                      <span className="mb-1 block">Language</span>
                      <select
                        className={fieldClass}
                        value={language}
                        disabled={busy}
                        onChange={(e) => setPrefs({ language: e.target.value })}
                      >
                        {status.languages.map((l) => (
                          <option key={l.id} value={l.id}>
                            {l.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block text-xs text-text-muted">
                      <span className="mb-1 block">Voice</span>
                      <select
                        className={fieldClass}
                        value={voice}
                        disabled={busy}
                        onChange={(e) => setPrefs({ voice: e.target.value })}
                      >
                        {status.voices.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div>
                    <div className="mb-1 flex items-center justify-between text-xs text-text-muted">
                      <label htmlFor="voiceover-speed">Speed</label>
                      <span className="tabular-nums">{shownSpeed.toFixed(2)}×</span>
                    </div>
                    <input
                      id="voiceover-speed"
                      type="range"
                      min={status.minSpeed}
                      max={status.maxSpeed}
                      step={0.05}
                      value={shownSpeed}
                      disabled={busy}
                      aria-valuetext={`${shownSpeed.toFixed(2)} times`}
                      className="w-full accent-[var(--accent)] pointer-coarse:h-11"
                      onChange={(e) => setPrefs({ speed: Number(e.target.value) })}
                    />
                  </div>
                  {running !== null && <Bar label="Making the voice-over" fraction={running} />}
                </>
              )}
            </>
          )}
          {note && (
            <p
              role={note.kind === "problem" ? "alert" : "status"}
              className={note.kind === "problem" ? "text-xs text-danger" : "text-xs text-text-muted"}
            >
              {note.text}
            </p>
          )}
        </div>

        {model?.installed && (
          <footer className="flex shrink-0 items-center gap-2 border-t px-4 py-2">
            <Button
              variant="ghost"
              size="sm"
              className="text-text-muted pointer-coarse:h-11"
              disabled={busy}
              title={`Remove the downloaded ${model.label} voice model from this computer`}
              onClick={() => void remove(model.id)}
            >
              <Trash2 /> Remove model
            </Button>
            <span className="flex-1" />
            {running !== null ? (
              <Button variant="outline" className="pointer-coarse:h-11" onClick={cancel}>
                Stop
              </Button>
            ) : (
              <Button
                className="pointer-coarse:h-11"
                disabled={!text.trim()}
                onClick={() => void create(text)}
              >
                <AudioLines /> Add voice-over at playhead
              </Button>
            )}
          </footer>
        )}
      </div>
    </div>
  );
}
