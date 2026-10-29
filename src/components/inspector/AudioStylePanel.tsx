import { useState } from "react";
import { cn } from "@/lib/utils";
import { confirmDialog } from "@/lib/dialog";
import { AUDIO_STYLE_LIMITS, type TimelineClip } from "@/project/model";
import {
  currentChoice,
  STYLE_PRESETS,
  TEMPO_LIMITS,
  type StyleChoice,
  type StylePreset,
} from "@/timeline/audioStyle";
import { changeAudioStyle, report } from "@/timeline/editor";

const NOTICE_KEY = "cutvii.audio-style-notice.v1";
const buttonClass = "flex h-9 items-center justify-center rounded-md border px-2 text-xs pointer-coarse:h-11";
const plain = "border-border bg-surface-2 text-text-muted hover:text-text";
const pressed = "border-accent/60 bg-accent-soft text-text";

const noticeSeen = () => {
  try {
    return localStorage.getItem(NOTICE_KEY) === "1";
  } catch {
    return false;
  }
};

/** The copyright note, asked once. Returns whether the user went on. */
async function copyrightNotice(): Promise<boolean> {
  if (noticeSeen()) return true;
  const go = await confirmDialog({
    title: "Before you change the sound",
    lines: [
      "Changing the tempo, pitch or bass of a song does not remove its copyright. Platforms can still claim or block a video that uses it.",
      "Use music you own, are licensed to use, or that is royalty-free. CutVii has no music library and downloads nothing.",
    ],
    confirmLabel: "I understand",
  });
  if (go) {
    try {
      localStorage.setItem(NOTICE_KEY, "1");
    } catch {
      /* it is then asked again next time */
    }
  }
  return go;
}

async function apply(clipId: string, choice: StyleChoice | null) {
  if (choice && !(await copyrightNotice())) return;
  const first = changeAudioStyle(clipId, choice);
  if (first.ok) return;
  if (first.error.code !== "needs-ripple") return void report(first);
  const move = await confirmDialog({
    title: "Move the following clips?",
    lines: [
      "At this tempo the clip becomes longer and would overlap the clips after it on the same track.",
      "Move those clips later to make room, or cancel to keep the sound as it is.",
    ],
    confirmLabel: "Move clips",
  });
  if (move) report(changeAudioStyle(clipId, choice, true));
}

/**
 * Sound style of a sound clip: Off, Sped up, Slowed + reverb, Bass boost or Custom (tempo, pitch, reverb, bass).
 * The tempo is the clip's speed, so the clip gets shorter or longer by the speed formula. The export draws the
 * pitch, reverb and bass with FFmpeg and keeps loud results from clipping; the preview plays the tempo only.
 */
export function AudioStylePanel({ clip }: { clip: TimelineClip }) {
  const choice = currentChoice(clip);
  const [custom, setCustom] = useState<StyleChoice>(
    () => choice ?? { preset: "custom", tempo: 100, pitch: 100, reverb: 0, bass: 0 },
  );
  const shown = choice ?? custom;
  const active: StylePreset | "off" = choice?.preset ?? "off";

  const commit = (next: StyleChoice) => {
    setCustom(next);
    void apply(clip.id, next);
  };

  return (
    <div role="group" aria-label="Sound style" className="space-y-3">
      <div role="radiogroup" aria-label="Style" className="grid grid-cols-2 gap-1">
        <button
          type="button"
          role="radio"
          aria-checked={active === "off"}
          onClick={() => void apply(clip.id, null)}
          className={cn(buttonClass, active === "off" ? pressed : plain)}
        >
          Off
        </button>
        {Object.values(STYLE_PRESETS).map((p) => (
          <button
            key={p.preset}
            type="button"
            role="radio"
            aria-checked={active === p.preset}
            onClick={() => commit({ ...p })}
            className={cn(buttonClass, active === p.preset ? pressed : plain)}
          >
            {p.label}
          </button>
        ))}
        <button
          type="button"
          role="radio"
          aria-checked={active === "custom"}
          onClick={() => commit({ ...shown, preset: "custom" })}
          className={cn(buttonClass, active === "custom" ? pressed : plain, "col-span-2")}
        >
          Custom
        </button>
      </div>
      {choice && (
        <div className="space-y-2">
          <Slider
            id="style-tempo"
            label="Tempo"
            value={choice.tempo}
            min={TEMPO_LIMITS.min}
            max={TEMPO_LIMITS.max}
            step={5}
            text={`${choice.tempo} %`}
            onCommit={(v) => commit({ ...choice, preset: "custom", tempo: v })}
          />
          <Slider
            id="style-pitch"
            label="Pitch"
            value={choice.pitch}
            min={AUDIO_STYLE_LIMITS.minPitch}
            max={AUDIO_STYLE_LIMITS.maxPitch}
            step={5}
            text={`${choice.pitch} %`}
            onCommit={(v) => commit({ ...choice, preset: "custom", pitch: v })}
          />
          <Slider
            id="style-reverb"
            label="Reverb"
            value={Math.round(choice.reverb * 100)}
            min={0}
            max={100}
            step={5}
            text={`${Math.round(choice.reverb * 100)} %`}
            onCommit={(v) => commit({ ...choice, preset: "custom", reverb: v / 100 })}
          />
          <Slider
            id="style-bass"
            label="Bass"
            value={choice.bass}
            min={0}
            max={AUDIO_STYLE_LIMITS.maxBass}
            step={1}
            text={`+${choice.bass} dB`}
            onCommit={(v) => commit({ ...choice, preset: "custom", bass: v })}
          />
          <p className="text-xs text-text-muted">
            The export draws this sound. The preview plays the new tempo but not the pitch, reverb or bass,
            and a reverb tail is cut at the end of the clip.
          </p>
        </div>
      )}
    </div>
  );
}

function Slider({
  id,
  label,
  value,
  min,
  max,
  step,
  text,
  onCommit,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  text: string;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const done = () => {
    if (draft === null) return;
    const v = draft;
    setDraft(null);
    if (v !== value) onCommit(v);
  };
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs text-text-muted">
        <label htmlFor={id}>{label}</label>
        <span className="tabular-nums">{draft === null ? text : `${draft}`}</span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={draft ?? value}
        className="w-full accent-[var(--accent)] pointer-coarse:h-11"
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={done}
        onKeyUp={done}
      />
    </div>
  );
}
