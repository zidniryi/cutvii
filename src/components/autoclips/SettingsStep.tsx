import { useEffect } from "react";
import { Check, Download, ShieldCheck, Timer } from "lucide-react";
import { cn } from "@/lib/utils";
import { downloadWithConsent, SPEECH_LANGUAGES, useAiStore } from "@/store/ai";
import { usableModel, useAutoClipsStore } from "@/store/autoClips";
import { subtitleStyleOf, useTextStyleStore } from "@/store/textStyles";
import { useUiStore } from "@/store/ui";
import {
  COUNT_CHOICES,
  LENGTH_LIMITS,
  LENGTH_PRESETS,
  lengthRange,
  OUTPUTS,
  type AutoClipsSettings,
} from "@/timeline/autoClips";
import { StyleList } from "@/components/text/StyleList";
import { StylePreview } from "@/components/text/StylePreview";

const chip = (on: boolean) =>
  cn(
    "min-h-9 rounded-md border px-3 text-sm disabled:opacity-50 pointer-coarse:min-h-11 focus-visible:outline-accent",
    on
      ? "border-accent bg-accent-soft text-text"
      : "border-border bg-surface-2 text-text-muted hover:text-text",
  );
const fieldClass =
  "h-9 rounded-md border bg-surface-2 px-2 text-sm pointer-coarse:h-11 focus-visible:outline-accent";

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="space-y-2">
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
              aria-label={`${m.label}, ${m.approxMb} MB${m.installed ? ", downloaded" : ""}`}
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
              : `Download model (about ${chosen.approxMb} MB)…`}
          </button>
        )}
        <p className="text-xs text-text-muted">
          A transcript made before with the same model is reused, so searching again is quick.
        </p>
      </Group>

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
            disabled={!modelId || running || estimate?.status === "running"}
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
