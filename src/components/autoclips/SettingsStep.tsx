import { useEffect, useState } from "react";
import { Check, Download, FileText, ShieldCheck, Timer } from "lucide-react";
import { cn } from "@/lib/utils";
import { downloadWithConsent, modelSize, SPEECH_LANGUAGES, useAiStore } from "@/store/ai";
import { usableModel, useAutoClipsStore } from "@/store/autoClips";
import { subtitleStyleOf, useTextStyleStore } from "@/store/textStyles";
import { useUiStore } from "@/store/ui";
import { formatDuration } from "@/lib/timecode";
import { useProjectStore } from "@/store/project";
import { findClip } from "@/timeline/clips";
import {
  chooseTranscript,
  findTranscriptsNear,
  type TranscriptInfo,
  clampOffset,
  durationWarning,
  OFFSET_LIMIT,
  COUNT_CHOICES,
  LENGTH_LIMITS,
  LENGTH_PRESETS,
  lengthRange,
  OUTPUTS,
  type AutoClipsSettings,
} from "@/timeline/autoClips";
import { StyleList } from "@/components/text/StyleList";
import { StylePreview } from "@/components/text/StylePreview";
import { SubtitleSize } from "./SubtitleSize";

const chip = (on: boolean) =>
  cn(
    "min-h-9 rounded-md border px-3 text-sm disabled:opacity-50 pointer-coarse:min-h-11 focus-visible:outline-accent",
    on
      ? "border-accent bg-accent-soft text-text"
      : "border-border bg-surface-2 text-text-muted hover:text-text",
  );
const fieldClass =
  "h-9 rounded-md border bg-surface-2 px-2 text-sm pointer-coarse:h-11 focus-visible:outline-accent";

function Group({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    // min-w-0: a fieldset will not shrink below its content, so a long file name pushed it over the next column
    <fieldset className={cn("min-w-0 space-y-2", className)}>
      <legend className="mb-1 text-xs font-medium text-text-muted">{title}</legend>
      {children}
    </fieldset>
  );
}

/** A planned option that is not built: visible, switched off, and says so. */
function Soon({ label }: { label: string }) {
  return (
    <span
      aria-disabled
      className="inline-flex min-h-9 items-center gap-2 rounded-md border border-dashed px-3 text-sm text-text-muted opacity-70 pointer-coarse:min-h-11"
    >
      {label}
      <span className="rounded-sm bg-surface-2 px-1.5 py-0.5 text-[10px]">Coming soon</span>
    </span>
  );
}

const minutes = (seconds: number) =>
  seconds < 90 ? `${Math.max(1, Math.round(seconds))} s` : `${Math.round(seconds / 60)} min`;

/**
 * Transcript files found in the video's own folder. They are only suggested: nothing is switched on until
 * the user presses "Use". With the file source on, the same list lets them switch between candidates.
 */
function NearbyTranscripts({ disabled }: { disabled: boolean }) {
  const source = useAutoClipsStore((s) => s.settings.source);
  const chosen = useAutoClipsStore((s) => s.settings.transcript);
  const clipId = useAutoClipsStore((s) => s.clipId);
  const patch = useAutoClipsStore((s) => s.patchSettings);
  const project = useProjectStore((s) => s.project);
  const [near, setNear] = useState<{ path: string; list: TranscriptInfo[] } | null>(null);
  const clip = clipId ? findClip(project, clipId)?.clip : undefined;
  const videoPath = clip && project.assets.find((a) => a.id === clip.assetId)?.path;

  useEffect(() => {
    if (!videoPath) return;
    let current = true;
    void findTranscriptsNear(videoPath).then((list) => current && setNear({ path: videoPath, list }));
    return () => {
      current = false;
    };
  }, [videoPath]);

  const list = near && near.path === videoPath ? near.list : [];
  if (list.length === 0) return null;
  const use = (info: TranscriptInfo) => patch({ transcript: info, source: "file" });

  if (source === "file") {
    if (list.length < 2) return null;
    return (
      <label className="flex min-w-0 items-center gap-2 text-sm">
        <span className="shrink-0 text-text-muted">Found next to the video</span>
        <select
          aria-label="Transcript files next to the video"
          className={cn(fieldClass, "min-w-0 max-w-full flex-1 truncate")}
          disabled={disabled}
          value={chosen?.path ?? ""}
          onChange={(e) => {
            const picked = list.find((i) => i.path === e.target.value);
            if (picked) use(picked);
          }}
        >
          {!list.some((i) => i.path === chosen?.path) && <option value="">Another file</option>}
          {list.map((i) => (
            <option key={i.path} value={i.path}>
              {i.name} ({i.format})
            </option>
          ))}
        </select>
      </label>
    );
  }
  const best = list[0];
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2 rounded-md border border-accent/40 bg-accent-soft px-2 py-1.5 text-xs"
    >
      <span className="min-w-0 flex-1">
        Found <strong className="break-all font-medium">{best.name}</strong> next to the video
        {list.length > 1 ? ` (and ${list.length - 1} more)` : ""}.
      </span>
      <button
        type="button"
        disabled={disabled}
        className={cn(chip(false), "shrink-0")}
        onClick={() => use(best)}
      >
        Use {best.name.length > 24 ? "it" : best.name}
      </button>
    </div>
  );
}

/** The "Import file" part of the Transcript row: file facts, offset, and a button to choose another. */
function TranscriptFile({ disabled }: { disabled: boolean }) {
  const info = useAutoClipsStore((s) => s.settings.transcript);
  const offset = useAutoClipsStore((s) => s.settings.transcriptOffset);
  const clipId = useAutoClipsStore((s) => s.clipId);
  const patch = useAutoClipsStore((s) => s.patchSettings);
  const project = useProjectStore((s) => s.project);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const clip = clipId ? findClip(project, clipId)?.clip : undefined;
  const asset = clip && project.assets.find((a) => a.id === clip.assetId);
  const warning = info ? durationWarning(info, offset, asset?.duration) : null;

  const choose = async () => {
    setBusy(true);
    setError(null);
    try {
      const picked = await chooseTranscript();
      if (picked) patch({ transcript: picked, source: "file" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "That file could not be used.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={disabled || busy}
        className={cn(chip(false), "flex w-full items-center justify-center gap-2 [&_svg]:size-4")}
        onClick={() => void choose()}
      >
        <FileText />
        {info ? "Choose another file…" : "Choose file…"}
      </button>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      {info && (
        <dl
          className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs"
          aria-label="Transcript file"
        >
          <dt className="text-text-muted">File</dt>
          <dd className="min-w-0 truncate" title={info.name}>
            {info.name}
          </dd>
          <dt className="text-text-muted">Format</dt>
          <dd>{info.format}</dd>
          <dt className="text-text-muted">Lines</dt>
          <dd>{info.lines}</dd>
          <dt className="text-text-muted">Span</dt>
          <dd>
            {formatDuration(info.spanStart)} to {formatDuration(info.spanEnd)}
          </dd>
          <dt className="text-text-muted">Word timing</dt>
          <dd>
            {info.wordLevel
              ? "Found. Captions still follow whole lines for now."
              : `No (${info.wordReason}). Word-by-word styles show whole lines.`}
          </dd>
        </dl>
      )}
      {warning && (
        <p role="status" className="text-xs text-amber-400">
          {warning}
        </p>
      )}
      {info && (
        <label className="flex items-center gap-2 text-sm">
          <span className="text-text-muted">Offset (seconds)</span>
          <input
            type="number"
            aria-label="Offset, seconds"
            className={cn(fieldClass, "w-24")}
            min={-OFFSET_LIMIT}
            max={OFFSET_LIMIT}
            step={0.1}
            value={offset}
            disabled={disabled}
            onChange={(e) => patch({ transcriptOffset: clampOffset(e.target.valueAsNumber) })}
          />
        </label>
      )}
      {!info && (
        <p className="text-xs text-text-muted">
          Use a transcript you already have: a .json list, YouTube json3, .srt or .vtt. Nothing is uploaded.
        </p>
      )}
    </div>
  );
}

/** Step 1: what to look for. One screen, sensible defaults. */
export function SettingsStep() {
  const settings = useAutoClipsStore((s) => s.settings);
  const patch = useAutoClipsStore((s) => s.patchSettings);
  const running = useAutoClipsStore((s) => s.status === "running");
  const estimate = useAutoClipsStore((s) => s.estimate);
  const models = useAiStore((s) => s.models);
  const loaded = useAiStore((s) => s.loaded);
  const download = useAiStore((s) => s.download);
  useEffect(() => useAiStore.getState().ensure(), []);
  const mine = useTextStyleStore((s) => s.mine);
  const subtitleStyleId = useTextStyleStore((s) => s.subtitleStyleId);
  const subtitleCustom = useTextStyleStore((s) => s.subtitleCustom);
  const subtitle = subtitleStyleOf({ mine, subtitleStyleId, subtitleCustom });

  const range = lengthRange(settings);
  const modelId = usableModel(settings);
  const chosen =
    models.find((m) => m.id === (settings.model ?? modelId)) ?? models.find((m) => m.id === "base");
  const set = <K extends keyof AutoClipsSettings>(key: K, value: AutoClipsSettings[K]) =>
    patch({ [key]: value } as Partial<AutoClipsSettings>);

  return (
    <div className="mx-auto grid max-w-3xl gap-5 md:grid-cols-2">
      <Group title="Clip length">
        <div role="radiogroup" aria-label="Clip length" className="flex flex-wrap gap-1.5">
          {LENGTH_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={settings.length === p.id}
              disabled={running}
              className={chip(settings.length === p.id)}
              onClick={() => set("length", p.id)}
            >
              {p.label}
            </button>
          ))}
          <button
            type="button"
            role="radio"
            aria-checked={settings.length === "custom"}
            disabled={running}
            className={chip(settings.length === "custom")}
            onClick={() => set("length", "custom")}
          >
            Custom
          </button>
        </div>
        {settings.length === "custom" && (
          <div className="flex items-center gap-2 text-sm">
            <input
              type="number"
              aria-label="Shortest clip, seconds"
              className={cn(fieldClass, "w-20")}
              min={LENGTH_LIMITS.min}
              max={LENGTH_LIMITS.max}
              value={Number.isFinite(settings.customMin) ? settings.customMin : ""}
              disabled={running}
              onChange={(e) => set("customMin", e.target.valueAsNumber)}
            />
            <span className="text-text-muted">to</span>
            <input
              type="number"
              aria-label="Longest clip, seconds"
              className={cn(fieldClass, "w-20")}
              min={LENGTH_LIMITS.min}
              max={LENGTH_LIMITS.max}
              value={Number.isFinite(settings.customMax) ? settings.customMax : ""}
              disabled={running}
              onChange={(e) => set("customMax", e.target.valueAsNumber)}
            />
            <span className="text-text-muted">seconds</span>
          </div>
        )}
        {!range.ok && (
          <p role="alert" className="text-xs text-danger">
            {range.reason}
          </p>
        )}
      </Group>

      <Group title="Number of clips">
        <div role="radiogroup" aria-label="Number of clips" className="flex flex-wrap gap-1.5">
          {COUNT_CHOICES.map((n) => (
            <button
              key={n ?? "auto"}
              type="button"
              role="radio"
              aria-checked={settings.count === n}
              disabled={running}
              className={chip(settings.count === n)}
              onClick={() => set("count", n)}
            >
              {n ?? "Auto"}
            </button>
          ))}
        </div>
        <p className="text-xs text-text-muted">Auto suggests about one clip for every two minutes.</p>
      </Group>

      <Group title="Transcript" className="md:col-span-2">
        <div role="radiogroup" aria-label="Transcript source" className="flex flex-wrap gap-1.5">
          <button
            type="button"
            role="radio"
            aria-checked={settings.source === "whisper"}
            disabled={running}
            className={chip(settings.source === "whisper")}
            onClick={() => set("source", "whisper")}
          >
            Transcribe with Whisper
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={settings.source === "file"}
            disabled={running}
            className={chip(settings.source === "file")}
            onClick={() => set("source", "file")}
          >
            Import file
          </button>
        </div>
        <NearbyTranscripts disabled={running} />
        {settings.source === "file" && <TranscriptFile disabled={running} />}
      </Group>

      {settings.source === "whisper" && (
        <Group title="Speech">
          <select
            aria-label="Language spoken"
            className={cn(fieldClass, "w-full")}
            value={settings.language}
            disabled={running}
            onChange={(e) => set("language", e.target.value)}
          >
            {SPEECH_LANGUAGES.map((l) => (
              <option key={l.code ?? "auto"} value={l.code ?? ""}>
                {l.name}
              </option>
            ))}
          </select>
          {!loaded && <p className="text-xs text-text-muted">Checking for speech models…</p>}
          <div role="radiogroup" aria-label="Speech model" className="flex flex-wrap gap-1.5">
            {models.map((m) => (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={chosen?.id === m.id}
                aria-label={`${m.label}, ${modelSize(m.approxMb)}${m.installed ? ", downloaded" : ""}`}
                disabled={running || download !== null}
                className={cn(chip(chosen?.id === m.id), "flex items-center gap-1.5")}
                onClick={() => set("model", m.id)}
              >
                {m.label.split(" (")[0]}
                {m.installed && <Check className="size-3.5 text-success" aria-hidden />}
              </button>
            ))}
          </div>
          {chosen && !chosen.installed && (
            <button
              type="button"
              disabled={download !== null || running}
              className="flex min-h-9 w-full items-center justify-center gap-2 rounded-md border border-accent/60 bg-accent-soft px-2 text-sm hover:border-accent disabled:opacity-50 pointer-coarse:min-h-11 [&_svg]:size-4"
              onClick={() =>
                void downloadWithConsent(chosen).then((note) => {
                  if (note) useUiStore.getState().setNotice(note.text);
                })
              }
            >
              <Download />
              {download
                ? `Downloading… ${Math.round(download.received / 1048576)} MB`
                : `Download model (about ${modelSize(chosen.approxMb)})…`}
            </button>
          )}
          <p className="text-xs text-text-muted">
            A transcript made before with the same model is reused, so searching again is quick.
          </p>
        </Group>
      )}

      <Group title="Output">
        <div role="radiogroup" aria-label="Output shape" className="flex flex-wrap gap-1.5">
          {OUTPUTS.map((o) => (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={settings.output === o.id}
              title={o.hint}
              disabled={running}
              className={chip(settings.output === o.id)}
              onClick={() => set("output", o.id)}
            >
              {o.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-sm">
          <span className="text-text-muted">Reframe</span>
          <span className={chip(true)} aria-label="Reframe: Center">
            <span className="flex min-h-9 items-center pointer-coarse:min-h-11">Center</span>
          </span>
          <Soon label="Manual" />
        </div>
        <Soon label="Remove silences inside clips" />
      </Group>

      <div className="md:col-span-2">
        <Group title="Subtitles">
          <label className="flex min-h-9 items-center gap-2 text-sm pointer-coarse:min-h-11">
            <input
              type="checkbox"
              className="size-4 accent-[var(--accent)]"
              checked={settings.subtitles}
              disabled={running}
              onChange={(e) => set("subtitles", e.target.checked)}
            />
            Add subtitles to each clip
          </label>
          {settings.subtitles && <SubtitleSize disabled={running} />}
          {settings.subtitles && (
            <div className="grid gap-2 sm:grid-cols-[12rem_1fr]">
              <div>
                <StylePreview
                  style={subtitle.style}
                  label={subtitle.name}
                  className="h-16 w-full rounded-md"
                />
                <p className="mt-1 text-xs text-text-muted">{subtitle.name} (shared with Auto subtitles)</p>
              </div>
              <StyleList
                disabled={running}
                isSelected={(preset) => preset.id === subtitle.id}
                onSelect={(preset) => useTextStyleStore.getState().setSubtitleStyle(preset.id)}
              />
            </div>
          )}
        </Group>
      </div>

      <div className="space-y-2 md:col-span-2">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={!modelId || running || settings.source === "file" || estimate?.status === "running"}
            title={modelId ? undefined : "Download a speech model first"}
            className={cn(chip(false), "flex items-center gap-2 [&_svg]:size-4")}
            onClick={() => void useAutoClipsStore.getState().estimateTime()}
          >
            <Timer />
            Estimate time
          </button>
          <p role="status" className="text-xs text-text-muted">
            {estimate?.status === "running" && "Measuring a 15-second sample on this computer…"}
            {estimate?.status === "done" &&
              `About ${minutes(estimate.seconds)} for a first search, measured on a 15-second sample (it includes loading the model, so the real time is usually shorter).`}
            {estimate?.status === "failed" && `Could not measure: ${estimate.message}`}
          </p>
        </div>
        <p className="flex items-start gap-2 text-xs text-text-muted [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-success">
          <ShieldCheck />
          Everything runs on this computer. Your video and its transcript never leave it. Your original file
          is not changed.
        </p>
      </div>
    </div>
  );
}
