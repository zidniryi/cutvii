import { useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Ellipsis,
  Gauge,
  Maximize,
  Minimize,
  Pause,
  Play,
  Repeat,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from "lucide-react";
import { IconButton } from "@/components/IconButton";
import { SeekBar } from "@/components/preview/SeekBar";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { formatTimecode } from "@/lib/timecode";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/store/ui";
import { goToEnd, goToStart, PREVIEW_SPEEDS, stepFrames, togglePlayback } from "@/playback/controller";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { projectDuration } from "@/timeline/clips";

function Timecode() {
  const playhead = usePlaybackStore((s) => s.playhead);
  const fps = useProjectStore((s) => s.project.settings.fps);
  const duration = useProjectStore((s) => projectDuration(s.project));
  return (
    <span className="mx-1 shrink-0 font-mono text-xs tabular-nums" aria-label="Timecode">
      {formatTimecode(playhead, fps)}
      <span className="text-text-muted"> / {formatTimecode(duration, fps)}</span>
    </span>
  );
}

/** Close a popover on outside press or Escape. */
function useDismiss(open: boolean, ref: React.RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, ref, close]);
}

const speedLabel = (s: number) => `${s}×`;

function SpeedMenu() {
  const speed = usePlaybackStore((s) => s.previewSpeed);
  const setSpeed = usePlaybackStore((s) => s.setPreviewSpeed);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, ref, () => setOpen(false));
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Preview speed, ${speedLabel(speed)}`}
        title="Preview speed (does not change the project or the export)"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex h-8 items-center gap-1 rounded-md px-2 text-xs tabular-nums hover:bg-surface-2 pointer-coarse:h-11",
          speed !== 1 && "text-accent",
        )}
      >
        <Gauge className="size-4" /> {speedLabel(speed)}
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Preview speed"
          className="absolute right-0 bottom-full z-50 mb-1 min-w-40 rounded-md border bg-popover p-1 shadow-lg"
        >
          <p className="px-2 py-1 text-[11px] text-text-muted">Preview only. The export is not affected.</p>
          {PREVIEW_SPEEDS.map((s) => (
            <button
              key={s}
              role="menuitemradio"
              aria-checked={speed === s}
              onClick={() => {
                setSpeed(s);
                setOpen(false);
              }}
              className={cn(
                "flex h-9 w-full items-center justify-between rounded-sm px-2 text-sm hover:bg-accent-soft pointer-coarse:h-11",
                speed === s && "text-accent",
              )}
            >
              {speedLabel(s)}
              {s === 1 && <span className="text-xs text-text-muted">normal</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function VolumeControl() {
  const volume = usePlaybackStore((s) => s.volume);
  const muted = usePlaybackStore((s) => s.muted);
  const setVolume = usePlaybackStore((s) => s.setVolume);
  const setMuted = usePlaybackStore((s) => s.setMuted);
  const silent = muted || volume === 0;
  return (
    <div className="flex items-center gap-1">
      <IconButton
        label={silent ? "Unmute" : "Mute"}
        icon={silent ? <VolumeX /> : <Volume2 />}
        aria-pressed={silent}
        onClick={() => (volume === 0 ? setVolume(1) : setMuted(!muted))}
      />
      <input
        type="range"
        aria-label="Preview volume"
        min={0}
        max={100}
        step={1}
        value={muted ? 0 : Math.round(volume * 100)}
        onChange={(e) => setVolume(Number(e.target.value) / 100)}
        className="w-20 accent-[var(--accent)] pointer-coarse:h-11"
      />
    </div>
  );
}

function LoopToggle() {
  const loop = usePlaybackStore((s) => s.loop);
  const setLoop = usePlaybackStore((s) => s.setLoop);
  return (
    <IconButton
      label={loop ? "Loop on" : "Loop off"}
      icon={<Repeat />}
      aria-pressed={loop}
      className={cn(loop && "text-accent")}
      onClick={() => setLoop(!loop)}
    />
  );
}

/** Let the preview fill the window, and bring it back. Escape also leaves. */
function FullScreenToggle() {
  const full = useUiStore((s) => s.previewFull);
  return (
    <IconButton
      label={full ? "Exit full screen" : "Full screen"}
      icon={full ? <Minimize /> : <Maximize />}
      aria-pressed={full}
      onClick={() => useUiStore.getState().setPreviewFull(!full)}
    />
  );
}

/** Secondary controls: inline on wide screens, inside "More" on narrow ones. */
function Secondary() {
  return (
    <>
      <VolumeControl />
      <LoopToggle />
      <SpeedMenu />
      <FullScreenToggle />
    </>
  );
}

function MoreMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, ref, () => setOpen(false));
  return (
    <div ref={ref} className="relative">
      <IconButton
        label="More playback controls"
        icon={<Ellipsis />}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      />
      {open && (
        <div
          role="group"
          aria-label="More playback controls"
          className="absolute right-0 bottom-full z-40 mb-1 flex items-center gap-2 rounded-md border bg-popover p-2 shadow-lg"
        >
          <Secondary />
        </div>
      )}
    </div>
  );
}

/** Transport under the preview: seek bar on top, buttons below. One playback state for everything. */
export function TransportBar() {
  const playing = usePlaybackStore((s) => s.playing);
  const hasContent = useProjectStore((s) => projectDuration(s.project) > 0);
  const wide = useMediaQuery("(min-width: 900px)");

  return (
    <div role="group" aria-label="Playback" className="shrink-0 border-t bg-surface-1 px-3">
      <SeekBar />
      <div className="flex h-11 items-center gap-1 pb-1">
        <IconButton
          label="Go to start"
          shortcut="Home"
          icon={<SkipBack />}
          disabled={!hasContent}
          onClick={goToStart}
        />
        <IconButton
          label="Previous frame"
          shortcut=","
          icon={<ChevronLeft />}
          disabled={!hasContent}
          onClick={() => stepFrames(-1)}
        />
        <IconButton
          label={playing ? "Pause (Space)" : "Play (Space)"}
          icon={playing ? <Pause /> : <Play />}
          disabled={!hasContent}
          onClick={togglePlayback}
        />
        <IconButton
          label="Next frame"
          shortcut="."
          icon={<ChevronRight />}
          disabled={!hasContent}
          onClick={() => stepFrames(1)}
        />
        <IconButton
          label="Go to end"
          shortcut="End"
          icon={<SkipForward />}
          disabled={!hasContent}
          onClick={goToEnd}
        />
        <Timecode />
        <div className="ml-auto flex items-center gap-1">{wide ? <Secondary /> : <MoreMenu />}</div>
      </div>
    </div>
  );
}
