import { useId, useState } from "react";
import { Link2, Link2Off, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { canvasLabel, lockedSide, PLATFORM_TEMPLATES, toNumber, type CanvasErrors } from "@/project/canvas";
import type { CanvasChoice } from "@/project/canvasChoice";
import { resolveChoice } from "@/project/canvasChoice";
import type { Project } from "@/project/model";
import { useTemplateStore } from "@/store/canvasTemplates";
import { cn } from "@/lib/utils";

interface Props {
  choice: CanvasChoice;
  onChoice: (c: CanvasChoice) => void;
  /** Present when changing an existing project; "Original" then follows its first video. */
  project?: Project;
}

const input =
  "h-9 w-full rounded-md border bg-surface-2 px-2 text-sm tabular-nums pointer-coarse:h-11 aria-[invalid=true]:border-danger";

function Option({
  selected,
  title,
  detail,
  onSelect,
  children,
}: {
  selected: boolean;
  title: string;
  detail: string;
  onSelect: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className={cn("rounded-md border", selected ? "border-accent bg-accent-soft" : "border-border")}>
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        onClick={onSelect}
        className="flex min-h-11 w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm"
      >
        <span>{title}</span>
        <span className="text-xs text-text-muted">{detail}</span>
      </button>
      {children}
    </div>
  );
}

export function CanvasPicker({ choice, onChoice, project }: Props) {
  const saved = useTemplateStore((s) => s.templates);
  const saveTemplate = useTemplateStore((s) => s.save);
  const removeTemplate = useTemplateStore((s) => s.remove);
  const [lock, setLock] = useState(false);
  const [ratio, setRatio] = useState(16 / 9);
  const [templateName, setTemplateName] = useState("");
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const uid = useId();

  const custom =
    choice.kind === "custom" ? choice : { kind: "custom" as const, width: "1920", height: "1080", fps: "30" };
  const resolved = choice.kind === "custom" ? resolveChoice(choice, saved) : null;
  const errors: CanvasErrors = resolved && !resolved.ok ? resolved.errors : {};

  const originalDetail = !project
    ? "Matches the first video you add"
    : project.assets.some((a) => a.type === "video")
      ? "Matches the first video in this project"
      : project.assets.length === 0
        ? "Matches the first video you add"
        : "No video yet: uses 1920×1080 · 30 fps";

  function edit(field: "width" | "height" | "fps", text: string) {
    const next = { ...custom, [field]: text };
    if (lock && (field === "width" || field === "height")) {
      const n = toNumber(text);
      if (Number.isFinite(n) && n > 0) {
        const other = field === "width" ? "height" : "width";
        next[other] = String(lockedSide(n, ratio, field));
      }
    }
    onChoice(next);
    setSavedMessage(null);
  }

  function toggleLock() {
    if (!lock) {
      const w = toNumber(custom.width);
      const h = toNumber(custom.height);
      if (w > 0 && h > 0) setRatio(w / h);
    }
    setLock((l) => !l);
  }

  function onSave() {
    if (!resolved?.ok) return setTemplateError("Fix the canvas values first");
    const { width, height, fps } = resolved.canvas;
    const err = saveTemplate(templateName, { width, height, fps });
    setTemplateError(err);
    if (!err) {
      setSavedMessage(`Saved “${templateName.trim()}”`);
      setTemplateName("");
    }
  }

  const field = (name: "width" | "height" | "fps", label: string, unit: string) => (
    <div>
      <label htmlFor={`${uid}-${name}`} className="mb-1 block text-xs text-text-muted">
        {label}
      </label>
      <div className="relative">
        <input
          id={`${uid}-${name}`}
          inputMode="decimal"
          className={cn(input, "pr-9")}
          value={custom[name]}
          aria-invalid={Boolean(errors[name])}
          aria-describedby={errors[name] ? `${uid}-${name}-err` : undefined}
          onChange={(e) => edit(name, e.target.value)}
        />
        <span
          aria-hidden
          className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-xs text-text-muted"
        >
          {unit}
        </span>
      </div>
      {errors[name] && (
        <p id={`${uid}-${name}-err`} role="alert" className="mt-1 text-xs text-danger">
          {errors[name]}
        </p>
      )}
    </div>
  );

  return (
    <div role="radiogroup" aria-label="Canvas" className="space-y-2">
      <p className="text-xs font-medium text-text-muted">Platform</p>
      {PLATFORM_TEMPLATES.map((t) => (
        <Option
          key={t.id}
          selected={choice.kind === "template" && choice.id === t.id}
          title={t.name}
          detail={`${t.ratio} · ${t.width}×${t.height}`}
          onSelect={() => onChoice({ kind: "template", id: t.id })}
        />
      ))}

      {saved.length > 0 && <p className="pt-1 text-xs font-medium text-text-muted">Your templates</p>}
      {saved.map((t) => (
        <div key={t.id} className="flex items-stretch gap-1">
          <div className="min-w-0 flex-1">
            <Option
              selected={choice.kind === "saved" && choice.id === t.id}
              title={t.name}
              detail={canvasLabel(t)}
              onSelect={() => onChoice({ kind: "saved", id: t.id })}
            />
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Delete template ${t.name}`}
            className="pointer-coarse:size-11"
            onClick={() => {
              removeTemplate(t.id);
              if (choice.kind === "saved" && choice.id === t.id)
                onChoice({ kind: "template", id: "youtube" });
            }}
          >
            <Trash2 />
          </Button>
        </div>
      ))}

      <p className="pt-1 text-xs font-medium text-text-muted">Other</p>
      <Option
        selected={choice.kind === "original"}
        title="Original"
        detail={originalDetail}
        onSelect={() => onChoice({ kind: "original" })}
      />

      <Option
        selected={choice.kind === "custom"}
        title="Custom"
        detail={choice.kind === "custom" ? "" : "Set width, height and frame rate"}
        onSelect={() => choice.kind !== "custom" && onChoice(custom)}
      >
        {choice.kind === "custom" && (
          <div className="space-y-3 border-t p-3">
            <div className="grid grid-cols-[1fr_auto_1fr] items-start gap-2">
              {field("width", "Width", "px")}
              <Button
                variant={lock ? "secondary" : "ghost"}
                size="icon"
                aria-label="Lock aspect ratio"
                aria-pressed={lock}
                className={cn("mt-[22px] pointer-coarse:size-11", lock && "text-accent")}
                onClick={toggleLock}
              >
                {lock ? <Link2 /> : <Link2Off />}
              </Button>
              {field("height", "Height", "px")}
            </div>
            <div className="max-w-40">{field("fps", "Frame rate", "fps")}</div>
            <p className="text-xs text-text-muted">Even numbers, 16–8192 px per side, 1–120 fps.</p>

            <div className="border-t pt-3">
              <label htmlFor={`${uid}-tpl`} className="mb-1 block text-xs text-text-muted">
                Save as template
              </label>
              <div className="flex gap-2">
                <input
                  id={`${uid}-tpl`}
                  className={input}
                  placeholder="Template name"
                  value={templateName}
                  onChange={(e) => {
                    setTemplateName(e.target.value);
                    setTemplateError(null);
                    setSavedMessage(null);
                  }}
                  onKeyDown={(e) => e.key === "Enter" && onSave()}
                />
                <Button
                  variant="secondary"
                  className="pointer-coarse:h-11"
                  disabled={!resolved?.ok || !templateName.trim()}
                  onClick={onSave}
                >
                  Save
                </Button>
              </div>
              {templateError && (
                <p role="alert" className="mt-1 text-xs text-danger">
                  {templateError}
                </p>
              )}
              {savedMessage && (
                <p role="status" className="mt-1 text-xs text-success">
                  {savedMessage}
                </p>
              )}
            </div>
          </div>
        )}
      </Option>
    </div>
  );
}
