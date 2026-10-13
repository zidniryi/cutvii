import { useState } from "react";
import { Blend } from "lucide-react";
import type { TimelineClip } from "@/project/model";
import { changeTransition, report } from "@/timeline/editor";
import { DEFAULT_TRANSITION_SECONDS, TRANSITION_LIMITS, TRANSITIONS } from "@/timeline/transitions";

/**
 * The transition a clip comes in with: one of ten kinds and its length. A clip that ends right before it
 * on the same track holds its last frame underneath. One undo step per change; the export does the same.
 */
export function TransitionPanel({ clip }: { clip: TimelineClip }) {
  const current = clip.transitionIn ?? null;
  const [draft, setDraft] = useState<number | null>(null);
  const seconds = draft ?? current?.duration ?? DEFAULT_TRANSITION_SECONDS;

  function choose(kind: string) {
    if (kind === "") return void report(changeTransition(clip.id, null));
    report(changeTransition(clip.id, { kind, duration: current?.duration ?? DEFAULT_TRANSITION_SECONDS }));
  }
  function commit() {
    if (draft === null || !current) return;
    const duration = draft;
    setDraft(null);
    report(changeTransition(clip.id, { ...current, duration }));
  }

  return (
    <div role="group" aria-label="Transition" className="space-y-2 border-t pt-3">
      <label
        htmlFor="clip-transition"
        className="flex items-center gap-1.5 text-xs text-text-muted [&_svg]:size-3.5"
      >
        <Blend /> Transition in
      </label>
      <select
        id="clip-transition"
        className="h-9 w-full rounded-md border bg-surface-2 px-2 text-sm pointer-coarse:h-11 focus-visible:outline-accent"
        value={current?.kind ?? ""}
        onChange={(e) => choose(e.target.value)}
      >
        <option value="">None (cut)</option>
        {TRANSITIONS.map((k) => (
          <option key={k.id} value={k.id}>
            {k.name}
          </option>
        ))}
      </select>
      {current && (
        <div>
          <div className="mb-1 flex items-center justify-between text-xs text-text-muted">
            <label htmlFor="clip-transition-length">Length</label>
            <span className="tabular-nums">{seconds.toFixed(1)} s</span>
          </div>
          <input
            id="clip-transition-length"
            type="range"
            min={TRANSITION_LIMITS.min}
            max={TRANSITION_LIMITS.max}
            step={0.1}
            value={seconds}
            aria-valuetext={`${seconds.toFixed(1)} seconds`}
            className="w-full accent-[var(--accent)] pointer-coarse:h-11"
            onChange={(e) => setDraft(Number(e.target.value))}
            onPointerUp={commit}
            onKeyUp={commit}
            onBlur={commit}
          />
          <p className="mt-1 text-xs text-text-muted">
            Plays as this clip starts. A clip that ends right before it on the same track holds its last frame
            underneath.
          </p>
        </div>
      )}
    </div>
  );
}
