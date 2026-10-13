import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, Play, Square } from "lucide-react";
import { mediaUrl } from "@/lib/media";
import { cn } from "@/lib/utils";
import type { MediaAsset, TimelineClip } from "@/project/model";
import { usePlaybackStore } from "@/store/playback";
import { cleanOf } from "@/timeline/audio";
import { clipEnd } from "@/timeline/clips";
import { sourceTimeAt } from "@/timeline/edit";
import { changeClean, report } from "@/timeline/editor";

const buttonClass =
  "flex h-9 w-full items-center justify-center gap-2 rounded-md border text-xs pointer-coarse:h-11 [&_svg]:size-4 disabled:opacity-40";

/** Seconds of sound in a sample (`SAMPLE_SECONDS` in `src-tauri/src/media/clean.rs`). */
const SAMPLE_SECONDS = 6;

/**
 * Clean-up of a clip's sound: lower steady background noise and remove low rumble. The export applies it
 * with FFmpeg; the preview plays the original sound, so "Listen" plays a few seconds made by the same
 * filters. Every change is one undo step.
 */
export function CleanPanel({ clip, asset }: { clip: TimelineClip; asset: MediaAsset }) {
  const stored = cleanOf(clip);
  const [draft, setDraft] = useState<number | null>(null);
  const [state, setState] = useState<"idle" | "making" | "playing">("idle");
  const [problem, setProblem] = useState<string | null>(null);
  const player = useRef<HTMLAudioElement | null>(null);
  const request = useRef(0);
  const noise = draft ?? stored.noise;
  const percent = Math.round(noise * 100);
  const active = noise > 0 || stored.rumble;

  function stop() {
    request.current += 1;
    player.current?.pause();
    player.current = null;
    setState("idle");
  }
  useEffect(
    () => () => {
      request.current += 1;
      player.current?.pause();
    },
    [],
  );

  function commit() {
    if (draft === null) return;
    const value = draft;
    setDraft(null);
    report(changeClean(clip.id, { noise: value }));
  }

  async function listen() {
    stop();
    const mine = request.current;
    setProblem(null);
    setState("making");
    const playhead = usePlaybackStore.getState().playhead;
    const inside = playhead >= clip.timelineStart && playhead < clipEnd(clip);
    const start = inside ? sourceTimeAt(clip, playhead) : clip.sourceIn;
    try {
      const path = await invoke<string>("audio_clean_sample", {
        path: asset.path,
        start,
        clean: { noise, rumble: stored.rumble },
      });
      if (mine !== request.current) return;
      const audio = new Audio(mediaUrl(path));
      player.current = audio;
      audio.onended = () => mine === request.current && stop();
      await audio.play();
      if (mine === request.current) setState("playing");
    } catch (e) {
      if (mine !== request.current) return;
      stop();
      setProblem(
        typeof e === "string" ? e : e instanceof Error ? e.message : "The sample could not be played",
      );
    }
  }

  return (
    <div role="group" aria-label="Clean up sound" className="space-y-3">
      <div>
        <div className="mb-1 flex items-center justify-between text-xs text-text-muted">
          <label htmlFor="clip-clean-noise">Reduce noise</label>
          <span className="tabular-nums">{percent === 0 ? "Off" : `${percent} %`}</span>
        </div>
        <input
          id="clip-clean-noise"
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
      <button
        type="button"
        aria-pressed={stored.rumble}
        onClick={() => report(changeClean(clip.id, { rumble: !stored.rumble }))}
        className={cn(
          buttonClass,
          stored.rumble
            ? "border-accent/60 bg-accent-soft text-text"
            : "border-border bg-surface-2 text-text-muted hover:text-text",
        )}
      >
        {stored.rumble ? "Rumble removed (below 80 Hz)" : "Remove rumble and hum"}
      </button>
      <button
        type="button"
        disabled={!active || state === "making"}
        onClick={() => (state === "playing" ? stop() : void listen())}
        className={cn(buttonClass, "border-border bg-surface-2 text-text-muted hover:text-text")}
      >
        {state === "making" ? (
          <Loader2 className="animate-spin" />
        ) : state === "playing" ? (
          <Square />
        ) : (
          <Play />
        )}
        {state === "making"
          ? "Making a sample…"
          : state === "playing"
            ? "Stop"
            : `Listen to ${SAMPLE_SECONDS} s`}
      </button>
      {problem && (
        <p role="alert" className="text-xs text-danger">
          {problem}
        </p>
      )}
      <p className="text-xs text-text-muted">
        {active
          ? "The preview plays the original sound; the export is cleaned. Listen plays a cleaned sample from the playhead."
          : "Lowers steady noise such as hiss or a fan. Strong settings make voices sound thin."}
      </p>
    </div>
  );
}
