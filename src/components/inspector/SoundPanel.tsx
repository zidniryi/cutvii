import { useId, useState } from "react";
import { Unlink, Volume2, VolumeX } from "lucide-react";
import type { MediaAsset, TimelineClip } from "@/project/model";
import { cn } from "@/lib/utils";
import { useWaveformStore } from "@/store/waveforms";
import { MAX_FADE } from "@/timeline/audio";
import { clipDuration } from "@/timeline/clips";
import { changeClipSound, detachClipAudio, report } from "@/timeline/editor";
import { ResetButton } from "./ResetButton";

const fieldClass =
  "h-9 w-full rounded-md border bg-surface-2 px-2 text-sm tabular-nums pointer-coarse:h-11 focus-visible:outline-accent";
const buttonClass =
  "flex h-9 w-full items-center justify-center gap-2 rounded-md border text-xs pointer-coarse:h-11 [&_svg]:size-4 disabled:opacity-40";

/** Fade length in seconds: applied on Enter/blur, Escape reverts, kept inside 0 and `max`. */
function FadeField({
  label,
  value,
  max,
  onCommit,
}: {
  label: string;
  value: number;
  max: number;
  onCommit: (seconds: number) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  function commit() {
    if (draft === null) return;
    const parsed = Number(draft);
    setDraft(null);
    if (!Number.isFinite(parsed)) return;
    const seconds = Math.round(Math.min(max, Math.max(0, parsed)) * 100) / 100;
    if (seconds !== value) onCommit(seconds);
  }
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs text-text-muted">
        <label htmlFor={id}>{label}</label>
        <ResetButton label={label} disabled={value === 0} onReset={() => onCommit(0)} />
      </div>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        min={0}
        max={max}
        step={0.1}
        className={fieldClass}
        value={draft ?? String(value)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setDraft(null);
        }}
      />
    </div>
  );
}

/**
 * A clip's sound besides its volume: mute, fade in and out, and (for a video clip) detaching the sound
 * into its own clip. Every change is one undo step; the export does the same.
 */
export function SoundPanel({
  clip,
  asset,
  /** The clip sits on a video track and is a video: its sound can be detached. */
  detachable,
}: {
  clip: TimelineClip;
  asset: MediaAsset;
  detachable: boolean;
}) {
  const muted = clip.muted ?? false;
  const length = clipDuration(clip);
  const longest = Math.round(Math.min(MAX_FADE, length) * 100) / 100;
  // known only once the waveform has been looked at; until then detaching is allowed
  const silent = useWaveformStore((s) => s.entries[asset.path]?.status === "none");

  return (
    <div role="group" aria-label="Sound" className="space-y-3">
      <button
        type="button"
        aria-pressed={muted}
        onClick={() => report(changeClipSound(clip.id, { muted: !muted }))}
        className={cn(
          buttonClass,
          muted
            ? "border-danger/60 bg-danger/10 text-danger"
            : "border-border bg-surface-2 text-text-muted hover:text-text",
        )}
      >
        {muted ? <VolumeX /> : <Volume2 />}
        {muted ? "Muted" : "Mute this clip"}
      </button>

      <div className="grid grid-cols-2 gap-2">
        <FadeField
          label="Fade in (s)"
          value={clip.fadeIn ?? 0}
          max={longest}
          onCommit={(fadeIn) => report(changeClipSound(clip.id, { fadeIn }))}
        />
        <FadeField
          label="Fade out (s)"
          value={clip.fadeOut ?? 0}
          max={longest}
          onCommit={(fadeOut) => report(changeClipSound(clip.id, { fadeOut }))}
        />
      </div>

      {detachable && (
        <div>
          <button
            type="button"
            disabled={muted || silent}
            onClick={() => report(detachClipAudio(clip.id))}
            className={cn(buttonClass, "border-border bg-surface-2 text-text-muted hover:text-text")}
          >
            <Unlink />
            Detach audio
          </button>
          <p className="mt-1 text-xs text-text-muted">
            {silent
              ? "This video has no sound."
              : muted
                ? "This clip's sound is off (muted or already detached)."
                : "Puts the sound on an audio track as its own clip and mutes this one."}
          </p>
        </div>
      )}
    </div>
  );
}
