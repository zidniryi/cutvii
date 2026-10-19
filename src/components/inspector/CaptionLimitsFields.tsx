import { useState } from "react";
import { useTextStyleStore } from "@/store/textStyles";
import {
  CAPTION_RANGES,
  CaptionLimitsSchema,
  canvasShape,
  DEFAULT_CAPTION_LIMITS,
  type CaptionLimits,
} from "@/timeline/captionRules";

const FIELDS: { key: keyof CaptionLimits; label: string; step: number; unit?: string }[] = [
  { key: "maxLines", label: "Lines at most", step: 1 },
  { key: "maxChars", label: "Characters a line", step: 1 },
  { key: "maxWords", label: "Words at most", step: 1 },
  { key: "maxSeconds", label: "Longest", step: 0.5, unit: "s" },
  { key: "minSeconds", label: "Shortest", step: 0.1, unit: "s" },
  { key: "maxCps", label: "Reading speed", step: 1, unit: "chars/s" },
];

const SHAPE_NAME = { landscape: "wide", square: "square", vertical: "tall" } as const;

/** The caption limits for the project's canvas shape, the user's own when kept, else the starting ones. */
export function useCaptionLimits(width: number, height: number): CaptionLimits {
  const shape = canvasShape(width, height);
  return useTextStyleStore((s) => s.captionLimits[shape]) ?? DEFAULT_CAPTION_LIMITS[shape];
}

/**
 * How long one subtitle may be: lines, characters a line, words, time and reading speed. Kept per canvas
 * shape on this computer. A value outside its range is shown but not kept.
 */
export function CaptionLimitsFields({ width, height }: { width: number; height: number }) {
  const shape = canvasShape(width, height);
  const limits = useCaptionLimits(width, height);
  const own = useTextStyleStore((s) => s.captionLimits[shape]) !== undefined;
  const [problem, setProblem] = useState<string | null>(null);

  function change(key: keyof CaptionLimits, text: string) {
    const value = key === "maxWords" && text.trim() === "" ? null : Number(text);
    const next = CaptionLimitsSchema.safeParse({ ...limits, [key]: value });
    if (!next.success) {
      const [lo, hi] = CAPTION_RANGES[key];
      setProblem(next.error.issues[0]?.path.length ? `Use ${lo} to ${hi}.` : next.error.issues[0]?.message);
      return;
    }
    setProblem(null);
    useTextStyleStore.getState().setCaptionLimits(shape, next.data);
  }

  return (
    <details className="mb-2 rounded-md border px-2 py-1.5">
      <summary className="cursor-pointer text-text-muted">
        Caption length: {limits.maxLines} line{limits.maxLines === 1 ? "" : "s"} of {limits.maxChars}{" "}
        characters
      </summary>
      <p className="mt-1 text-text-muted">
        Long sentences are cut into captions of this size ({SHAPE_NAME[shape]} canvas). The words stay as they
        are.
      </p>
      <div className="mt-1.5 grid grid-cols-2 gap-1.5">
        {FIELDS.map((f) => (
          <label key={f.key} className="flex flex-col gap-0.5">
            <span className="text-text-muted">
              {f.label}
              {f.unit ? ` (${f.unit})` : ""}
            </span>
            <input
              key={`${shape}-${String(limits[f.key])}`}
              type="number"
              inputMode="decimal"
              min={CAPTION_RANGES[f.key][0]}
              max={CAPTION_RANGES[f.key][1]}
              step={f.step}
              defaultValue={limits[f.key] ?? ""}
              placeholder={f.key === "maxWords" ? "No limit" : undefined}
              onBlur={(e) => change(f.key, e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") change(f.key, e.currentTarget.value);
              }}
              className="h-8 rounded-md border bg-surface-2 px-1.5 text-text pointer-coarse:h-11"
            />
          </label>
        ))}
      </div>
      {problem && (
        <p role="alert" className="mt-1 text-danger">
          {problem}
        </p>
      )}
      {own && (
        <button
          type="button"
          className="mt-1.5 text-text-muted underline"
          onClick={() => {
            setProblem(null);
            useTextStyleStore.getState().setCaptionLimits(shape, null);
          }}
        >
          Reset to the starting limits
        </button>
      )}
    </details>
  );
}
