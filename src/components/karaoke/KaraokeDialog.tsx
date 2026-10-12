import { useEffect, useRef } from "react";
import { AlertTriangle, FileText, MicVocal, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { formatDuration } from "@/lib/timecode";
import { cn } from "@/lib/utils";
import { downloadWithConsent, modelSize, SPEECH_LANGUAGES, useAiStore } from "@/store/ai";
import { karaokeModel, karaokeStyle, useKaraokeStore, type KaraokeSource } from "@/store/karaoke";
import { useTextStyleStore } from "@/store/textStyles";
import { StyleList } from "@/components/text/StyleList";
import { StylePreview } from "@/components/text/StylePreview";
import { useUiStore } from "@/store/ui";
import { MAX_LINE_CHARS } from "@/timeline/karaoke";

const SOURCES: { id: KaraokeSource; label: string; hint: string }[] = [
  { id: "listen", label: "Recognise from the song", hint: "CutVii listens and writes the words down." },
  {
    id: "paste",
    label: "Paste the lyrics",
    hint: "You give the words; CutVii finds when each line is sung.",
  },
  { id: "file", label: "Open a lyrics file", hint: "An .lrc or .srt file already has the times." },
];
const chip = (on: boolean) =>
  cn(
    "min-h-9 rounded-md border px-3 text-sm disabled:opacity-50 pointer-coarse:min-h-11 focus-visible:outline-accent",
    on
      ? "border-accent bg-accent-soft text-text"
      : "border-border bg-surface-2 text-text-muted hover:text-text",
  );
const small =
  "flex size-9 shrink-0 items-center justify-center rounded-md border border-border text-xs text-text-muted hover:text-text disabled:opacity-40 pointer-coarse:size-11 focus-visible:outline-accent [&_svg]:size-4";

/** Karaoke Maker: get the lyric lines, check them, add them over the song. */
export function KaraokeDialog() {
  const open = useKaraokeStore((s) => s.open);
  return open ? <Body /> : null;
}

function Body() {
  const s = useKaraokeStore();
  const listening = useAiStore((a) => a.listening);
  // re-read when a model finishes downloading
  useAiStore((a) => a.models);
  const dialogOnTop = useUiStore((u) => u.dialog !== null);
  const rootRef = useRef<HTMLDivElement>(null);
  useFocusTrap(rootRef);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !useUiStore.getState().dialog) useKaraokeStore.getState().hide();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const model = karaokeModel();
  const models = useAiStore((a) => a.models);
  // re-read when the styles of the user change
  useTextStyleStore((t) => t.mine);
  const look = karaokeStyle(s.styleId);
  const download = useAiStore((a) => a.download);
  // what the picker shows: the chosen model even when it is not downloaded yet
  const picked = models.find((m) => m.id === s.model) ?? models.find((m) => m.id === model) ?? models[0];
  const busy = s.busy !== null;
  const low = s.lines.filter((l) => l.low).length;
  const hearing = busy && listening && listening.clipId === s.clipId ? ` ${listening.percent}%` : "";

  return (
    <div
      className="fixed inset-0 z-50 flex justify-center bg-black/60 sm:p-4"
      aria-hidden={dialogOnTop || undefined}
    >
      <div
        ref={rootRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="karaoke-title"
        className="flex h-full w-full max-w-3xl flex-col border bg-surface-1 shadow-xl sm:rounded-lg"
      >
        <header className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
          <h2
            id="karaoke-title"
            className="flex items-center gap-2 text-sm font-semibold [&_svg]:size-4 [&_svg]:text-accent"
          >
            <MicVocal />
            Karaoke Maker
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={s.hide}
            className="ml-auto flex size-9 items-center justify-center rounded-md text-text-muted hover:text-text pointer-coarse:size-11 focus-visible:outline-accent [&_svg]:size-4"
          >
            <X />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-sm">
          <fieldset className="space-y-2">
            <legend className="mb-1 text-xs font-medium text-text-muted">
              1 · Where the lyrics come from
            </legend>
            <div role="radiogroup" aria-label="Lyrics source" className="flex flex-wrap gap-1.5">
              {SOURCES.map((source) => (
                <button
                  key={source.id}
                  type="button"
                  role="radio"
                  aria-checked={s.source === source.id}
                  title={source.hint}
                  disabled={busy}
                  className={chip(s.source === source.id)}
                  onClick={() => s.setSource(source.id)}
                >
                  {source.label}
                </button>
              ))}
            </div>
            <p className="text-xs text-text-muted">{SOURCES.find((x) => x.id === s.source)!.hint}</p>

            {s.source !== "file" && (
              <label className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
                Language sung
                <select
                  aria-label="Language sung"
                  className="h-9 rounded-md border bg-surface-2 px-2 text-sm text-text pointer-coarse:h-11 focus-visible:outline-accent"
                  value={s.language}
                  disabled={busy}
                  onChange={(e) => s.setLanguage(e.target.value)}
                >
                  {SPEECH_LANGUAGES.map((l) => (
                    <option key={l.code ?? "auto"} value={l.code ?? ""}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {s.source !== "file" && picked && (
              <div className="space-y-1">
                <label className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
                  Speech model
                  <select
                    aria-label="Speech model"
                    className="h-9 rounded-md border bg-surface-2 px-2 text-sm text-text pointer-coarse:h-11 focus-visible:outline-accent"
                    value={picked.id}
                    disabled={busy || download !== null}
                    onChange={(e) => s.setModel(e.target.value)}
                  >
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label.split(" (")[0]} · {modelSize(m.approxMb)}
                        {m.installed ? "" : " · not downloaded"}
                      </option>
                    ))}
                  </select>
                  <span>Larger models hear singing better and take longer.</span>
                </label>
                {!picked.installed && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="secondary"
                      disabled={busy || download !== null}
                      className="pointer-coarse:h-11"
                      onClick={() =>
                        void downloadWithConsent(picked).then((note) => {
                          if (note) useUiStore.getState().setNotice(note.text);
                        })
                      }
                    >
                      {download
                        ? `Downloading… ${modelSize(Math.round(download.received / 1048576))}${download.total ? ` of ${modelSize(Math.round(download.total / 1048576))}` : ""}`
                        : `Download ${picked.label.split(" (")[0]} (about ${modelSize(picked.approxMb)})…`}
                    </Button>
                    {download && (
                      <Button
                        variant="secondary"
                        className="pointer-coarse:h-11"
                        onClick={() => useAiStore.getState().cancel()}
                      >
                        Cancel download
                      </Button>
                    )}
                    <span className="text-xs text-text-muted">
                      Not on this computer yet. You are asked before anything is downloaded.
                    </span>
                  </div>
                )}
              </div>
            )}
            {s.source === "paste" && (
              <textarea
                aria-label="Lyrics"
                placeholder={
                  "Paste the lyrics here, one line per line.\nSection labels like [Chorus] are skipped."
                }
                value={s.pasted}
                disabled={busy}
                onChange={(e) => s.setPasted(e.target.value)}
                className="h-40 w-full resize-y rounded-md border bg-surface-2 p-2 text-sm focus-visible:outline-accent"
              />
            )}
            {s.source !== "file" && !model && (
              <p className="rounded-md border border-border px-3 py-2 text-xs text-text-muted">
                A speech model is needed to listen to the song. Download one in the AI tab (Auto subtitles,
                step 1), then come back.
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {s.source === "file" ? (
                <Button disabled={busy} className="pointer-coarse:h-11" onClick={() => void s.openFile()}>
                  <FileText /> Open a lyrics file…
                </Button>
              ) : (
                <Button
                  disabled={busy || !model}
                  className="pointer-coarse:h-11"
                  onClick={() => void s.findLines()}
                >
                  {s.source === "listen" ? "Listen and write the lyrics" : "Find the lines in the song"}
                </Button>
              )}
              {busy && (
                <>
                  <span role="status" className="text-xs text-text-muted">
                    {s.busy}
                    {hearing}
                  </span>
                  <Button
                    variant="secondary"
                    className="pointer-coarse:h-11"
                    onClick={() => useAiStore.getState().cancel()}
                  >
                    Stop
                  </Button>
                </>
              )}
            </div>
            <p className="text-xs text-text-muted">
              Everything runs on this computer. The song is heard with its music (voice and music are not
              separated yet), and each lyric lights up a line at a time, not word by word.
            </p>
          </fieldset>

          {s.problem && (
            <p role="alert" className="rounded-md border border-danger/50 px-3 py-2 text-danger">
              {s.problem}
            </p>
          )}
          {s.note && (
            <p role="status" className="rounded-md border border-border px-3 py-2 text-xs text-text-muted">
              {s.note}
            </p>
          )}

          <fieldset className="space-y-2">
            <legend className="mb-1 text-xs font-medium text-text-muted">Lyric style</legend>
            <div className="grid gap-2 sm:grid-cols-[12rem_1fr]">
              <div>
                <StylePreview style={look.style} label={look.name} className="h-16 w-full rounded-md" />
                <p className="mt-1 text-xs text-text-muted">
                  {look.name}. Lines fade in and out so they do not pop on screen.
                </p>
              </div>
              <StyleList
                disabled={busy}
                isSelected={(preset) => preset.id === look.id}
                onSelect={(preset) => s.setStyle(preset.id)}
              />
            </div>
          </fieldset>

          {s.lines.length > 0 && (
            <fieldset className="space-y-2">
              <legend className="mb-1 text-xs font-medium text-text-muted">
                2 · Check the lines ({s.lines.length}
                {low > 0 ? `, ${low} to check` : ""})
              </legend>
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-text-muted">
                All lines:
                {[-0.5, -0.1, 0.1, 0.5].map((step) => (
                  <button
                    key={step}
                    type="button"
                    disabled={busy}
                    aria-label={`Move all lines ${Math.abs(step)} seconds ${step < 0 ? "earlier" : "later"}`}
                    className="h-9 rounded-md border border-border px-2 hover:text-text disabled:opacity-40 pointer-coarse:h-11"
                    onClick={() => s.shiftAll(step)}
                  >
                    {step > 0 ? "+" : "−"}
                    {Math.abs(step)} s
                  </button>
                ))}
                <button
                  type="button"
                  disabled={busy}
                  className="ml-auto h-9 rounded-md border border-border px-2 hover:text-text disabled:opacity-40 pointer-coarse:h-11"
                  onClick={s.clearLines}
                >
                  Clear all
                </button>
              </div>
              <ul aria-label="Lyric lines" className="space-y-1">
                {s.lines.map((line, i) => (
                  <li
                    key={i}
                    className={cn(
                      "flex items-center gap-1.5 rounded-md border px-1.5 py-1",
                      line.low ? "border-danger/50" : "border-border",
                    )}
                  >
                    <button
                      type="button"
                      aria-label={`Line ${i + 1} earlier`}
                      disabled={busy}
                      className={small}
                      onClick={() => s.editLine(i, { start: line.start - 0.1, end: line.end - 0.1 })}
                    >
                      −
                    </button>
                    <span className="w-12 shrink-0 text-center text-xs text-text-muted tabular-nums">
                      {formatDuration(line.start)}
                    </span>
                    <button
                      type="button"
                      aria-label={`Line ${i + 1} later`}
                      disabled={busy}
                      className={small}
                      onClick={() => s.editLine(i, { start: line.start + 0.1, end: line.end + 0.1 })}
                    >
                      +
                    </button>
                    <input
                      aria-label={`Line ${i + 1} words`}
                      value={line.text}
                      maxLength={MAX_LINE_CHARS}
                      disabled={busy}
                      onChange={(e) => s.editLine(i, { text: e.target.value })}
                      className="h-9 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1 text-sm hover:border-border focus:border-border focus:bg-surface-2 pointer-coarse:h-11 focus-visible:outline-accent"
                    />
                    {line.low && (
                      <span
                        role="img"
                        aria-label="Timing is a guess: check it"
                        title="This line was not found in the song. Its time is a guess: check it."
                        className="shrink-0 text-danger [&_svg]:size-4"
                      >
                        <AlertTriangle />
                      </span>
                    )}
                    <button
                      type="button"
                      aria-label={`Delete line ${i + 1}`}
                      disabled={busy}
                      className={cn(small, "hover:text-danger")}
                      onClick={() => s.removeLine(i)}
                    >
                      <Trash2 />
                    </button>
                  </li>
                ))}
              </ul>
            </fieldset>
          )}
        </div>

        <footer className="flex shrink-0 items-center gap-2 border-t px-4 py-2">
          <Button variant="secondary" className="pointer-coarse:h-11" onClick={s.hide}>
            Close
          </Button>
          <label
            className="ml-auto flex min-h-9 items-center gap-2 text-xs text-text-muted pointer-coarse:min-h-11"
            title="Makes a copy of the song where what is in the middle of the stereo picture (usually the singer) is lowered while lyrics are sung. An estimate: some voice or echo can remain, and it needs a stereo recording. The original clip is muted, not changed."
          >
            <input
              type="checkbox"
              className="size-4 accent-[var(--accent)]"
              checked={s.lowerVoice}
              disabled={busy}
              onChange={(e) => s.setLowerVoice(e.target.checked)}
            />
            Lower the singer's voice (estimate)
          </label>
          <Button
            disabled={busy || s.lines.length === 0}
            title={s.lines.length === 0 ? "Get the lyric lines first" : undefined}
            className="pointer-coarse:h-11"
            onClick={() => void s.create()}
          >
            Add {s.lines.length > 0 ? `${s.lines.length} ` : ""}lines to the timeline
          </Button>
        </footer>
      </div>
    </div>
  );
}
