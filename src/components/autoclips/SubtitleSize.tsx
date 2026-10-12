import { useAutoClipsStore } from "@/store/autoClips";
import { CLIP_SUBTITLE_SIZE } from "@/timeline/autoClips";

/** How big the clips' subtitles are. Its own setting: it does not follow the size used for Auto subtitles. */
export function SubtitleSize({ disabled = false }: { disabled?: boolean }) {
  const size = useAutoClipsStore((s) => s.settings.subtitleSize);
  const percent = Math.round(size * 1000) / 10;
  return (
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
  );
}
