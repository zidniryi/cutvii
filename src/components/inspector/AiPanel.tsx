import { useEffect, useState } from "react";
import { Captions, Check, Download, Eraser, Layers, ScanFace, Sparkles, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TimelineClip } from "@/project/model";
import { downloadWithConsent, SPEECH_LANGUAGES, useAiStore, type SpeechModel } from "@/store/ai";
import { DEFAULT_STYLE, subtitleStyleOf, useTextStyleStore } from "@/store/textStyles";
import { useProjectStore } from "@/store/project";
import {
  generateSubtitles,
  SUBTITLE_FONT_SHARE,
  SUBTITLE_SIZE_LIMITS,
  subtitleSpec,
} from "@/timeline/subtitles";
import { DEFAULT_SUBTITLE_POSITION } from "@/timeline/textPosition";
import { StyleEditor } from "@/components/text/StyleEditor";
import { StyleList } from "@/components/text/StyleList";
import { StylePreview } from "@/components/text/StylePreview";
import { AutoClipsSection } from "@/components/autoclips/AutoClipsSection";

const fieldClass =
  "h-9 w-full rounded-md border bg-surface-2 px-2 text-sm pointer-coarse:h-11 focus-visible:outline-accent";
const quietButton =
  "flex h-9 w-full items-center justify-center gap-2 rounded-md border border-border bg-surface-2 px-2 text-xs text-text-muted hover:text-text disabled:opacity-40 pointer-coarse:h-11 [&_svg]:size-4";

function Bar({ value, label }: { value: number | null; label: string }) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value ?? undefined}
      className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2"
    >
      <div
        className={
          value === null ? "h-full w-1/3 animate-pulse bg-accent" : "h-full bg-accent transition-[width]"
        }
        style={value === null ? undefined : { width: `${value}%` }}
      />
    </div>
  );
}

/** A numbered step heading, ticked once the step is taken care of. */
function Step({ n, title, done }: { n: number; title: string; done: boolean }) {
  return (
    <p className="mb-1.5 flex items-center gap-2 text-xs text-text-muted">
      <span
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-medium [&_svg]:size-3",
          done ? "bg-success/20 text-success" : "bg-surface-2 text-text-muted",
        )}
      >
        {done ? <Check /> : n}
      </span>
      {title}
    </p>
  );
}

const megabytes = (bytes: number) => Math.round(bytes / (1024 * 1024));
/** "Base (fast, good for clear speech)" -> ["Base", "fast, good for clear speech"]. */
const nameAndHint = (label: string): [string, string] => {
  const [name, rest = ""] = label.split(" (");
  return [name, rest.replace(/\)$/, "")];
};

/** AI tools that are planned but not built: shown so the tab says where it is going, clearly switched off. */
const COMING: { icon: typeof Eraser; title: string; text: string }[] = [
  { icon: Eraser, title: "Remove background", text: "Cut the subject out of its background." },
  { icon: Layers, title: "Blur background", text: "Keep the subject sharp and soften what is behind it." },
  {
    icon: ScanFace,
    title: "Text behind subject",
    text: "Slide a title between the subject and the background.",
  },
];

function ModelTile({
  model,
  selected,
  disabled,
  onSelect,
}: {
  model: SpeechModel;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const [name, hint] = nameAndHint(model.label);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={`${name}, ${model.approxMb} MB${model.installed ? ", downloaded" : ""}`}
      title={hint}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "relative flex flex-col items-start rounded-md border px-2 py-1.5 text-left disabled:opacity-60 pointer-coarse:min-h-11",
        selected
          ? "border-accent bg-accent-soft text-text"
          : "border-border bg-surface-2 text-text-muted hover:text-text",
      )}
    >
      <span className="text-sm text-text">{name}</span>
      <span className="text-[11px] tabular-nums">{model.approxMb} MB</span>
      {model.installed && (
        <span className="absolute top-1.5 right-1.5 text-success [&_svg]:size-3.5" aria-hidden>
          <Check />
        </span>
      )}
    </button>
  );
}

/**
 * AI tools for a clip. Today: subtitles from speech (Whisper), running on this computer. The speech model
 * is not part of CutVii: it is downloaded once, and only after the user agrees.
 */
export function AiPanel({ clip }: { clip: TimelineClip }) {
  const models = useAiStore((s) => s.models);
  const loaded = useAiStore((s) => s.loaded);
  const download = useAiStore((s) => s.download);
  const listening = useAiStore((s) => s.listening);
  const [chosen, setChosen] = useState<string | null>(null);
  const [language, setLanguage] = useState("");
  const [stage, setStage] = useState<string | null>(null);
  const [note, setNote] = useState<{ kind: "ok" | "problem"; text: string } | null>(null);
  useEffect(() => useAiStore.getState().ensure(), []);
  // the style for the subtitles is remembered while the app is open, whichever clip is selected
  const ownStyles = useTextStyleStore((s) => s.mine);
  const subtitleStyleId = useTextStyleStore((s) => s.subtitleStyleId);
  const subtitleCustom = useTextStyleStore((s) => s.subtitleCustom);
  const subtitle = subtitleStyleOf({ mine: ownStyles, subtitleStyleId, subtitleCustom });
  const [customising, setCustomising] = useState(false);
  const subtitleAt = useTextStyleStore((s) => s.subtitlePosition) ?? DEFAULT_SUBTITLE_POSITION;
  const subtitleSize = useTextStyleStore((s) => s.subtitleSize) ?? SUBTITLE_FONT_SHARE;
  const canvasWidth = useProjectStore((s) => s.project.settings.width);
  const canvasHeight = useProjectStore((s) => s.project.settings.height);
  const canvas = { width: canvasWidth, height: canvasHeight };

  // default to a model that is already here, otherwise the middle one
  const model =
    models.find((m) => m.id === chosen) ??
    models.find((m) => m.installed) ??
    models.find((m) => m.id === "base") ??
    models[0];
  const busy = download !== null || listening !== null || stage !== null;
  const mine = listening?.clipId === clip.id;
  const hint = model ? nameAndHint(model.label)[1] : "";

  async function downloadChosen() {
    if (!model) return;
    setNote(null);
    setNote(await downloadWithConsent(model));
  }
  async function removeChosen() {
    if (!model) return;
    setNote(null);
    await useAiStore
      .getState()
      .removeModel(model.id)
      .catch((e: Error) => setNote({ kind: "problem", text: e.message }));
  }
  async function generate() {
    if (!model) return;
    setNote(null);
    setStage("Listening…");
    // exactly what the sample in step 3 shows
    const look =
      subtitle.id === DEFAULT_STYLE && !subtitle.customised
        ? undefined
        : { style: subtitle.style, fade: subtitle.fade };
    const result = await generateSubtitles(
      clip.id,
      model.id,
      language || null,
      setStage,
      look,
      subtitleAt,
      subtitleSize,
    );
    setStage(null);
    setNote(
      result.ok
        ? {
            kind: "ok",
            text: `Added ${result.added} subtitle${result.added === 1 ? "" : "s"} on a new track. Each one is a text clip you can edit.`,
          }
        : /cancel/i.test(result.reason)
          ? { kind: "ok", text: "Stopped. Nothing was added." }
          : { kind: "problem", text: result.reason },
    );
  }

  return (
    <div className="space-y-4 text-xs">
      <div role="group" aria-label="Subtitles from speech" className="space-y-3">
        <div className="rounded-lg border border-accent/30 bg-accent-soft p-3">
          <p className="flex items-center gap-2 text-sm font-medium text-text [&_svg]:size-4 [&_svg]:text-accent">
            <Sparkles />
            Auto subtitles
          </p>
          <p className="mt-1 text-text-muted">
            Turns what is said in this clip into subtitle text you can edit. It runs on this computer; nothing
            is uploaded.
          </p>
        </div>

        {!loaded && <p className="text-text-muted">Checking for speech models…</p>}
        {loaded && model && (
          <>
            <div>
              <Step n={1} title="Speech model" done={model.installed} />
              <div role="radiogroup" aria-label="Speech model" className="grid grid-cols-3 gap-1">
                {models.map((m) => (
                  <ModelTile
                    key={m.id}
                    model={m}
                    selected={m.id === model.id}
                    disabled={busy}
                    onSelect={() => setChosen(m.id)}
                  />
                ))}
              </div>
              <p className="mt-1 text-text-muted first-letter:uppercase">{hint}.</p>

              <div className="mt-2">
                {download ? (
                  <div className="space-y-2">
                    <p className="text-text-muted">
                      Downloading… {megabytes(download.received)}
                      {download.total ? ` of ${megabytes(download.total)}` : ""} MB
                    </p>
                    <Bar
                      label="Download"
                      value={download.total ? Math.round((download.received / download.total) * 100) : null}
                    />
                    <button
                      type="button"
                      className={quietButton}
                      onClick={() => useAiStore.getState().cancel()}
                    >
                      Cancel download
                    </button>
                  </div>
                ) : model.installed ? (
                  <div className="flex items-center justify-between gap-2">
                    <p className="flex items-center gap-1.5 text-success [&_svg]:size-3.5">
                      <Check />
                      This model is on this computer.
                    </p>
                    <button
                      type="button"
                      aria-label="Remove this model from this computer"
                      title="Remove this model from this computer"
                      disabled={busy}
                      onClick={() => void removeChosen()}
                      className="flex size-8 shrink-0 items-center justify-center rounded-md border text-text-muted hover:text-danger disabled:opacity-40 pointer-coarse:size-11 [&_svg]:size-4"
                    >
                      <Trash2 />
                    </button>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void downloadChosen()}
                      className="flex h-9 w-full items-center justify-center gap-2 rounded-md border border-accent/60 bg-accent-soft px-2 text-xs text-text hover:border-accent disabled:opacity-40 pointer-coarse:h-11 [&_svg]:size-4"
                    >
                      <Download />
                      Download model (about {model.approxMb} MB)…
                    </button>
                    <p className="text-text-muted">
                      A speech model is needed first. You will be asked before anything is downloaded.
                    </p>
                  </div>
                )}
              </div>
            </div>

            <div>
              <Step n={2} title="Language spoken" done={language !== ""} />
              <select
                aria-label="Language spoken"
                className={fieldClass}
                value={language}
                disabled={busy}
                onChange={(e) => setLanguage(e.target.value)}
              >
                {SPEECH_LANGUAGES.map((l) => (
                  <option key={l.code ?? "auto"} value={l.code ?? ""}>
                    {l.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <Step n={3} title="Subtitle style" done />
              <div className="space-y-2">
                <div role="group" aria-label="Subtitle look" className="space-y-1">
                  <StylePreview
                    style={subtitle.style}
                    label={subtitle.name}
                    className="h-16 w-full rounded-md"
                  />
                  <p className="text-text-muted">
                    {subtitle.name}
                    {subtitle.customised ? " (customized)" : ""}: the subtitles will look like this.
                  </p>
                </div>
                <div className="flex flex-wrap gap-1">
                  <button
                    type="button"
                    aria-pressed={subtitle.id === DEFAULT_STYLE}
                    disabled={busy}
                    onClick={() => useTextStyleStore.getState().setSubtitleStyle(null)}
                    className={cn(
                      "h-9 rounded-md border px-3 disabled:opacity-60 pointer-coarse:h-11",
                      subtitle.id === DEFAULT_STYLE
                        ? "border-accent bg-accent-soft text-text"
                        : "bg-surface-2 text-text-muted hover:text-text",
                    )}
                  >
                    Default
                  </button>
                  <button
                    type="button"
                    aria-expanded={customising}
                    disabled={busy}
                    onClick={() => setCustomising((open) => !open)}
                    className="h-9 rounded-md border bg-surface-2 px-3 text-text-muted hover:text-text disabled:opacity-60 pointer-coarse:h-11"
                  >
                    Customize
                  </button>
                  {subtitle.customised && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => useTextStyleStore.getState().setSubtitleCustom(subtitle.id, null)}
                      className="h-9 rounded-md border bg-surface-2 px-3 text-text-muted hover:text-text disabled:opacity-60 pointer-coarse:h-11"
                    >
                      Reset changes
                    </button>
                  )}
                </div>
                {customising && !busy && (
                  <div className="rounded-md border p-2">
                    <StyleEditor
                      value={
                        subtitle.fade
                          ? { style: subtitle.style, fade: subtitle.fade }
                          : { style: subtitle.style }
                      }
                      label={subtitle.name}
                      onChange={(next) => useTextStyleStore.getState().setSubtitleCustom(subtitle.id, next)}
                      size={{
                        value: subtitleSize,
                        ...SUBTITLE_SIZE_LIMITS,
                        canvasHeight: canvas.height,
                        onChange: (share) => useTextStyleStore.getState().setSubtitleSize(share),
                      }}
                      position={{
                        // a typical line, to know how much room a subtitle takes
                        spec: subtitleSpec("A line of subtitles", canvas.height, subtitleAt, subtitleSize),
                        canvas,
                        resetTo: DEFAULT_SUBTITLE_POSITION,
                        onChange: (to) => useTextStyleStore.getState().setSubtitlePosition(to),
                      }}
                    />
                  </div>
                )}
                <StyleList
                  disabled={busy}
                  isSelected={(preset) => preset.id === subtitle.id}
                  onSelect={(preset) => useTextStyleStore.getState().setSubtitleStyle(preset.id)}
                  hint="Changes made here are kept for subtitles only; the style itself stays as it is."
                />
              </div>
            </div>

            <div>
              <Step n={4} title="Make the subtitles" done={false} />
              {stage ? (
                <div className="space-y-2">
                  <p className="text-text-muted">
                    {mine && stage === "Listening…" ? `Listening… ${listening.percent}%` : stage}
                  </p>
                  <Bar label="Subtitles" value={mine && stage === "Listening…" ? listening.percent : null} />
                  <button
                    type="button"
                    className={quietButton}
                    onClick={() => useAiStore.getState().cancel()}
                  >
                    Stop
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={!model.installed || busy || Boolean(clip.reversed)}
                  onClick={() => void generate()}
                  className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-accent px-2 text-sm font-medium text-black hover:bg-accent-hover disabled:opacity-40 pointer-coarse:h-11 [&_svg]:size-4"
                >
                  <Captions />
                  Generate subtitles
                </button>
              )}
              {clip.reversed && <p className="mt-1 text-text-muted">Reversed clips cannot be subtitled.</p>}
            </div>
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

      <AutoClipsSection clip={clip} />

      <div role="group" aria-label="More AI tools" className="space-y-1.5 border-t pt-3">
        <p className="text-text-muted">More AI tools</p>
        {COMING.map((tool) => (
          <div
            key={tool.title}
            aria-disabled
            className="flex items-center gap-2 rounded-md border border-dashed px-2 py-1.5 opacity-70"
          >
            <tool.icon className="size-4 shrink-0 text-text-muted" />
            <div className="min-w-0 flex-1">
              <p className="text-text">{tool.title}</p>
              <p className="text-text-muted">{tool.text}</p>
            </div>
            <span className="shrink-0 rounded-sm bg-surface-2 px-1.5 py-0.5 text-[10px] text-text-muted">
              Coming soon
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
