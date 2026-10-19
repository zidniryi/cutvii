import { useState } from "react";
import { cn } from "@/lib/utils";
import { useProjectStore } from "@/store/project";
import { DEFAULT_STYLE, subtitleStyleOf, useTextStyleStore } from "@/store/textStyles";
import { DEFAULT_SUBTITLE_POSITION } from "@/timeline/textPosition";
import { SUBTITLE_FONT_SHARE, SUBTITLE_SIZE_LIMITS, subtitleSpec } from "@/timeline/subtitles";
import { StyleEditor } from "./StyleEditor";
import { StyleList } from "./StyleList";
import { StylePreview } from "./StylePreview";

/** What subtitles are drawn with: the chosen style (with the user's changes), place and size. */
export function useSubtitleLook() {
  const mine = useTextStyleStore((s) => s.mine);
  const subtitleStyleId = useTextStyleStore((s) => s.subtitleStyleId);
  const subtitleCustom = useTextStyleStore((s) => s.subtitleCustom);
  const subtitle = subtitleStyleOf({ mine, subtitleStyleId, subtitleCustom });
  const at = useTextStyleStore((s) => s.subtitlePosition) ?? DEFAULT_SUBTITLE_POSITION;
  const size = useTextStyleStore((s) => s.subtitleSize) ?? SUBTITLE_FONT_SHARE;
  return {
    subtitle,
    at,
    size,
    // the uncustomised default is drawn the way subtitles always were
    look:
      subtitle.id === DEFAULT_STYLE && !subtitle.customised
        ? undefined
        : { style: subtitle.style, fade: subtitle.fade },
  };
}

/**
 * The subtitle look: sample, Default / Customize / Reset changes, the editor (style, size, position) and the
 * style list. Shared by auto subtitles and the .srt import, so both use and remember the same choice.
 */
export function SubtitleLook({ disabled = false }: { disabled?: boolean }) {
  const { subtitle, at, size } = useSubtitleLook();
  const [customising, setCustomising] = useState(false);
  const width = useProjectStore((s) => s.project.settings.width);
  const height = useProjectStore((s) => s.project.settings.height);
  const canvas = { width, height };
  return (
    <div className="space-y-2">
      <div role="group" aria-label="Subtitle look" className="space-y-1">
        <StylePreview style={subtitle.style} label={subtitle.name} className="h-16 w-full rounded-md" />
        <p className="text-text-muted">
          {subtitle.name}
          {subtitle.customised ? " (customized)" : ""}: the subtitles will look like this.
        </p>
      </div>
      <div className="flex flex-wrap gap-1">
        <button
          type="button"
          aria-pressed={subtitle.id === DEFAULT_STYLE}
          disabled={disabled}
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
          disabled={disabled}
          onClick={() => setCustomising((open) => !open)}
          className="h-9 rounded-md border bg-surface-2 px-3 text-text-muted hover:text-text disabled:opacity-60 pointer-coarse:h-11"
        >
          Customize
        </button>
        {subtitle.customised && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => useTextStyleStore.getState().setSubtitleCustom(subtitle.id, null)}
            className="h-9 rounded-md border bg-surface-2 px-3 text-text-muted hover:text-text disabled:opacity-60 pointer-coarse:h-11"
          >
            Reset changes
          </button>
        )}
      </div>
      {customising && !disabled && (
        <div className="rounded-md border p-2">
          <StyleEditor
            value={subtitle.fade ? { style: subtitle.style, fade: subtitle.fade } : { style: subtitle.style }}
            label={subtitle.name}
            onChange={(next) => useTextStyleStore.getState().setSubtitleCustom(subtitle.id, next)}
            size={{
              value: size,
              ...SUBTITLE_SIZE_LIMITS,
              canvasHeight: canvas.height,
              onChange: (share) => useTextStyleStore.getState().setSubtitleSize(share),
            }}
            position={{
              // a typical line, to know how much room a subtitle takes
              spec: subtitleSpec("A line of subtitles", canvas.height, at, size),
              canvas,
              resetTo: DEFAULT_SUBTITLE_POSITION,
              onChange: (to) => useTextStyleStore.getState().setSubtitlePosition(to),
            }}
          />
        </div>
      )}
      <StyleList
        disabled={disabled}
        isSelected={(preset) => preset.id === subtitle.id}
        onSelect={(preset) => useTextStyleStore.getState().setSubtitleStyle(preset.id)}
        hint="Changes made here are kept for subtitles only; the style itself stays as it is."
      />
    </div>
  );
}
