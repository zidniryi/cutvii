import { ClipPosition } from "@/components/text/PositionControl";
import { CaptionCheck } from "./CaptionCheck";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlignCenter, AlignLeft, AlignRight, Bold } from "lucide-react";
import { FontPicker } from "@/components/inspector/FontPicker";
import type { TextSpec } from "@/project/model";
import { cn } from "@/lib/utils";
import { DEFAULT_FONT, useFontStore } from "@/store/fonts";
import { changeTextFade, report } from "@/timeline/editor";
import { editText, MAX_TEXT_FADE, TEXT_FONT_LIMITS } from "@/timeline/text";

const fieldClass =
  "h-9 w-full rounded-md border bg-surface-2 px-2 text-sm tabular-nums pointer-coarse:h-11 focus-visible:outline-accent";
const chipClass = (selected: boolean) =>
  cn(
    "flex h-9 items-center justify-center rounded-md border text-xs pointer-coarse:h-11 [&_svg]:size-4",
    selected
      ? "border-accent bg-accent-soft text-text"
      : "border-border bg-surface-2 text-text-muted hover:text-text",
  );

/**
 * While typing, the text is redrawn this long after the last keystroke. Long enough that a redraw (and the
 * update of the whole project that follows it) does not land between two keystrokes of normal typing.
 */
export const TYPING_DELAY_MS = 250;

const ALIGNS = [
  { id: "left", label: "Align left", icon: AlignLeft },
  { id: "center", label: "Align centre", icon: AlignCenter },
  { id: "right", label: "Align right", icon: AlignRight },
] as const;

/** Editor for a text clip. Every committed change redraws the text and is one undo step. */
export function TextPanel({
  clipId,
  spec,
  /** Seconds the clip fades in and out over (0 for none). */
  fade = 0,
  styles,
}: {
  clipId: string;
  spec: TextSpec;
  fade?: number;
  /** The styles gallery, shown right under the words. */
  styles?: ReactNode;
}) {
  const [fadeDraft, setFadeDraft] = useState<string | null>(null);
  function commitFade() {
    if (fadeDraft === null) return;
    const parsed = Number(fadeDraft);
    setFadeDraft(null);
    if (!Number.isFinite(parsed)) return;
    const seconds = Math.round(Math.min(MAX_TEXT_FADE, Math.max(0, parsed)) * 100) / 100;
    if (seconds !== fade) report(changeTextFade(clipId, seconds));
  }
  const [content, setContent] = useState<string | null>(null);
  const [size, setSize] = useState<string | null>(null);
  const [color, setColor] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const apply = (patch: Partial<TextSpec>) => void editText(clipId, patch).then(setProblem);

  // Typing: the box always shows what was typed (it is never put back to the older text while a redraw is
  // on its way), one redraw runs at a time, and whatever was typed meanwhile is drawn right after it.
  const drawing = useRef(false);
  const waiting = useRef<string | null>(null);
  async function draw(value: string): Promise<void> {
    if (drawing.current) {
      waiting.current = value;
      return;
    }
    drawing.current = true;
    try {
      setProblem(await editText(clipId, { content: value }));
    } finally {
      drawing.current = false;
    }
    const next = waiting.current;
    waiting.current = null;
    if (next !== null && next !== value) await draw(next);
  }
  /** Redraw with the typed words. `done` (leaving the box) also lets the box follow the clip again. */
  function commitContent(value: string | null, done = false) {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (value === null) return;
    if (value.trim() === "") {
      setProblem("Text must not be empty");
      if (done) setContent(null);
      return;
    }
    const finish = () => done && setContent((now) => (now === value ? null : now));
    if (value === spec.content && !drawing.current) {
      setProblem(null);
      finish();
      return;
    }
    void draw(value).then(finish);
  }
  function typeContent(value: string) {
    setContent(value);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => commitContent(value), TYPING_DELAY_MS);
  }
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function commitSize() {
    if (size === null) return;
    const parsed = Number(size);
    setSize(null);
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.min(TEXT_FONT_LIMITS.max, Math.max(TEXT_FONT_LIMITS.min, Math.round(parsed)));
    if (clamped !== spec.fontSize) apply({ fontSize: clamped });
  }
  function commitColor() {
    if (color === null) return;
    const value = color;
    setColor(null);
    if (/^#[0-9a-fA-F]{6}$/.test(value) && value.toLowerCase() !== spec.color.toLowerCase())
      apply({ color: value.toUpperCase() });
  }
  const align = spec.align ?? "center";

  const fonts = useFontStore((s) => s.fonts);
  useEffect(() => useFontStore.getState().ensure(), []);
  const font = spec.font ?? DEFAULT_FONT;
  const installed = fonts.some((f) => f.family === font);
  function importFont() {
    useFontStore
      .getState()
      .importFont()
      .then(
        // use the imported font straight away
        (families) => families.length > 0 && apply({ font: families[0] }),
        (e: Error) => setProblem(`Could not import the font: ${e.message}`),
      );
  }

  return (
    <div className="space-y-3">
      <label className="block">
        <span className="mb-1 block text-xs text-text-muted">Text</span>
        <textarea
          rows={3}
          maxLength={2000}
          className={cn(fieldClass, "h-auto resize-y py-1.5 leading-snug pointer-coarse:h-auto")}
          value={content ?? spec.content}
          onChange={(e) => typeContent(e.target.value)}
          onBlur={() => commitContent(content, true)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              if (timer.current) clearTimeout(timer.current);
              setContent(null);
              setProblem(null);
            }
          }}
        />
      </label>
      {problem && (
        <p role="alert" className="text-xs text-danger">
          {problem}
        </p>
      )}
      {styles}

      <div>
        <p className="mb-1 text-xs text-text-muted">Font</p>
        <FontPicker
          fonts={fonts}
          value={font}
          onChange={(family) => apply({ font: family })}
          onImport={importFont}
        />
        {!installed && (
          <p className="mt-1 text-xs text-text-muted">
            “{font}” is not installed here, so the text is drawn in {DEFAULT_FONT}.
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="mb-1 block text-xs text-text-muted">Size (px)</span>
          <input
            type="number"
            inputMode="numeric"
            min={TEXT_FONT_LIMITS.min}
            max={TEXT_FONT_LIMITS.max}
            className={fieldClass}
            value={size ?? String(spec.fontSize)}
            onChange={(e) => setSize(e.target.value)}
            onBlur={commitSize}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitSize();
              if (e.key === "Escape") setSize(null);
            }}
          />
        </label>
        <div>
          <span className="mb-1 block text-xs text-text-muted">Colour</span>
          <div className="flex items-center gap-1">
            <input
              type="color"
              aria-label="Text colour"
              className="h-9 w-10 shrink-0 cursor-pointer rounded-md border bg-surface-2 pointer-coarse:h-11"
              value={(color && /^#[0-9a-fA-F]{6}$/.test(color) ? color : spec.color).toLowerCase()}
              onChange={(e) => setColor(e.target.value)}
              onBlur={commitColor}
            />
            <input
              aria-label="Text colour (hex)"
              className={cn(fieldClass, "min-w-0 font-mono")}
              value={color ?? spec.color}
              onChange={(e) => setColor(e.target.value)}
              onBlur={commitColor}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitColor();
                if (e.key === "Escape") setColor(null);
              }}
            />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-1">
        <button
          type="button"
          aria-label="Bold"
          title="Bold"
          aria-pressed={spec.bold ?? false}
          onClick={() => apply({ bold: !(spec.bold ?? false) })}
          className={chipClass(spec.bold ?? false)}
        >
          <Bold />
        </button>
        <div role="radiogroup" aria-label="Alignment" className="col-span-3 grid grid-cols-3 gap-1">
          {ALIGNS.map((a) => (
            <button
              key={a.id}
              type="button"
              role="radio"
              aria-checked={align === a.id}
              aria-label={a.label}
              title={a.label}
              onClick={() => align !== a.id && apply({ align: a.id })}
              className={chipClass(align === a.id)}
            >
              <a.icon />
            </button>
          ))}
        </div>
      </div>

      <CaptionCheck clipId={clipId} spec={spec} />

      <ClipPosition clipId={clipId} spec={spec} onProblem={setProblem} />

      <label className="block">
        <span className="mb-1 block text-xs text-text-muted">Fade in and out (s)</span>
        <input
          type="number"
          inputMode="decimal"
          min={0}
          max={MAX_TEXT_FADE}
          step={0.1}
          className={fieldClass}
          value={fadeDraft ?? String(fade)}
          onChange={(e) => setFadeDraft(e.target.value)}
          onBlur={commitFade}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitFade();
            if (e.key === "Escape") setFadeDraft(null);
          }}
        />
      </label>
    </div>
  );
}
