import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";
import type { TextSpec } from "@/project/model";
import { useProjectStore } from "@/store/project";
import { lineKey, useTextLines } from "@/store/textLines";
import { useUiStore } from "@/store/ui";
import { resplitNotice, resplitTrack } from "@/timeline/resplit";
import { useCaptionLimits } from "./CaptionLimitsFields";

/**
 * The drawn line count of a text when it is more than a caption may have, else null. Asks Rust for the count
 * (the rasterizer's own wrapping) the first time a look is seen.
 */
export function useTooManyLines(spec: TextSpec | undefined): number | null {
  const width = useProjectStore((s) => s.project.settings.width);
  const height = useProjectStore((s) => s.project.settings.height);
  const limits = useCaptionLimits(width, height);
  const lines = useTextLines((s) => (spec ? s.lines[lineKey(spec, width, height)] : undefined));
  useEffect(() => {
    if (spec) useTextLines.getState().want(spec, width, height);
  }, [spec, width, height]);
  return lines !== undefined && lines > limits.maxLines ? lines : null;
}

export const tooLongLabel = (lines: number) => `Too long: ${lines} lines`;

/** In the Text tab: the "Too long" warning, and "Re-split long captions" for the clip's whole track. */
export function CaptionCheck({ clipId, spec }: { clipId: string; spec: TextSpec }) {
  const lines = useTooManyLines(spec);
  const trackId = useProjectStore(
    (s) => s.project.tracks.find((t) => t.clips.some((c) => c.id === clipId))?.id ?? null,
  );
  const [busy, setBusy] = useState(false);
  async function resplit() {
    if (!trackId) return;
    setBusy(true);
    const result = await resplitTrack(trackId);
    setBusy(false);
    useUiStore.getState().setNotice(resplitNotice(result));
  }
  return (
    <div className="space-y-1.5">
      {lines !== null && (
        <p
          role="status"
          className="flex items-center gap-1.5 rounded-md border border-danger/50 px-2 py-1 text-xs text-danger"
        >
          <TriangleAlert className="size-3.5 shrink-0" />
          {tooLongLabel(lines)}
        </p>
      )}
      <button
        type="button"
        disabled={busy || !trackId}
        onClick={() => void resplit()}
        className="h-8 w-full rounded-md border px-2 text-xs text-text hover:bg-surface-2 disabled:opacity-40 pointer-coarse:h-11"
      >
        {busy ? "Re-splitting…" : "Re-split long captions on this track"}
      </button>
    </div>
  );
}

/** On a text clip in the timeline: a small warning when the text has more lines than a caption may. */
export function TooLongBadge({ spec, left }: { spec: TextSpec; left: number }) {
  const lines = useTooManyLines(spec);
  if (lines === null) return null;
  return (
    <span
      title={tooLongLabel(lines)}
      aria-label={tooLongLabel(lines)}
      className="pointer-events-none absolute top-0 z-[13] flex items-center gap-0.5 rounded-sm bg-danger px-1 text-[10px] leading-4 text-white"
      style={{ left }}
    >
      <TriangleAlert className="size-3" aria-hidden />
      {lines}
    </span>
  );
}
