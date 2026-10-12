import { useAutoClipsStore } from "@/store/autoClips";
import { cn } from "@/lib/utils";
import { CLIP_SUBTITLE_SIZE, SUBTITLE_PLACES } from "@/timeline/autoClips";

/** How big the clips' subtitles are. Its own setting: it does not follow the size used for Auto subtitles. */
export function SubtitleSize({ disabled = false }: { disabled?: boolean }) {
  const size = useAutoClipsStore((s) => s.settings.subtitleSize);
  const percent = Math.round(size * 1000) / 10;
  const place = useAutoClipsStore((s) => s.settings.subtitlePlace);
  return (
    <div className="space-y-1">
      <div
        role="radiogroup"
        aria-label="Subtitle position"
        className="flex flex-wrap items-center gap-1.5 text-sm"
      >
        <span className="mr-1 text-text-muted">Subtitle position</span>
        {SUBTITLE_PLACES.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={place === p.id}
            disabled={disabled}
            onClick={() => useAutoClipsStore.getState().patchSettings({ subtitlePlace: p.id })}
            className={cn(
              "min-h-9 rounded-md border px-3 text-sm disabled:opacity-50 pointer-coarse:min-h-11 focus-visible:outline-accent",
              place === p.id
                ? "border-accent bg-accent-soft text-text"
                : "border-border bg-surface-2 text-text-muted hover:text-text",
            )}
          >
            {p.label}
          </button>
        ))}
      </div>
      <label className="flex min-h-9 flex-wrap items-center gap-2 text-sm pointer-coarse:min-h-11">
        <span className="text-text-muted">Subtitle size</span>
        <input
          type="range"
          aria-label="Subtitle size"
          className="h-9 min-w-32 flex-1 accent-[var(--accent)] pointer-coarse:h-11"
          min={CLIP_SUBTITLE_SIZE.min * 1000}
          max={CLIP_SUBTITLE_SIZE.max * 1000}
          step={1}
          value={Math.round(size * 1000)}
          disabled={disabled}
          onChange={(e) =>
            useAutoClipsStore.getState().patchSettings({ subtitleSize: Number(e.target.value) / 1000 })
          }
        />
        <span className="w-40 text-xs text-text-muted tabular-nums">
          {percent}% of the height (about {Math.round(size * 1920)} px on 1080×1920)
        </span>
        <button
          type="button"
          disabled={disabled || size === CLIP_SUBTITLE_SIZE.default}
          onClick={() =>
            useAutoClipsStore.getState().patchSettings({ subtitleSize: CLIP_SUBTITLE_SIZE.default })
          }
          className="h-9 rounded-md border px-2 text-xs text-text-muted hover:text-text disabled:opacity-40 pointer-coarse:h-11"
        >
          Reset
        </button>
      </label>
    </div>
  );
}
