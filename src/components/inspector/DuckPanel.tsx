import { useState } from "react";
import { ChevronsDown } from "lucide-react";
import type { TimelineClip } from "@/project/model";
import { changeDuck, report } from "@/timeline/editor";

/**
 * Ducking: this clip is turned down while the clips that do not duck make sound (music under a voice), and
 * comes back when they stop. The export does it with FFmpeg; the preview plays the clip at its full level.
 * One undo step per change.
 */
export function DuckPanel({ clip }: { clip: TimelineClip }) {
  const [draft, setDraft] = useState<number | null>(null);
  const amount = draft ?? clip.duck ?? 0;
  const percent = Math.round(amount * 100);

  function commit() {
    if (draft === null) return;
    const value = draft;
    setDraft(null);
    report(changeDuck(clip.id, value));
  }

  return (
    <div role="group" aria-label="Ducking" className="space-y-2 border-t pt-3">
      <p className="flex items-center gap-1.5 text-xs text-text-muted [&_svg]:size-3.5">
        <ChevronsDown /> Ducking
      </p>
      <div>
        <div className="mb-1 flex items-center justify-between text-xs text-text-muted">
          <label htmlFor="clip-duck">Lower under other sound</label>
          <span className="tabular-nums">{percent === 0 ? "Off" : `${percent} %`}</span>
        </div>
        <input
          id="clip-duck"
          type="range"
          min={0}
          max={100}
          step={5}
          value={percent}
          aria-valuetext={percent === 0 ? "Off" : `${percent} %`}
          className="w-full accent-[var(--accent)] pointer-coarse:h-11"
          onChange={(e) => setDraft(Number(e.target.value) / 100)}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
        />
      </div>
      <p className="text-xs text-text-muted">
        {percent === 0
          ? "For music: it is turned down while other clips make sound, such as a voice, and comes back after."
          : "Heard in the export only: the preview plays this clip at its full level. Clips that also duck do not turn it down."}
      </p>
    </div>
  );
}
