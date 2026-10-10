import { useEffect, useMemo, useRef } from "react";
import { MonitorPlay, Pause, Play, SkipBack } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { IconButton } from "@/components/IconButton";
import { fileName, mediaUrl } from "@/lib/media";
import { formatTimecode } from "@/lib/timecode";
import { goToStart, setMediaClock, startClock, togglePlayback } from "@/playback/controller";
import {
  layerKey,
  layersAt,
  mediaErrorMessage,
  planSync,
  sourceTimeFor,
  type Layer,
} from "@/playback/engine";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { projectDuration } from "@/timeline/clips";

type MediaEl = HTMLVideoElement | HTMLAudioElement;

function Timecode() {
  const playhead = usePlaybackStore((s) => s.playhead);
  const fps = useProjectStore((s) => s.project.settings.fps);
  const duration = useProjectStore((s) => projectDuration(s.project));
  return (
    <span className="mx-2 font-mono text-xs tabular-nums" aria-label="Timecode">
      {formatTimecode(playhead, fps)}
      <span className="text-text-muted"> / {formatTimecode(duration, fps)}</span>
    </span>
  );
}

function Controls() {
  const playing = usePlaybackStore((s) => s.playing);
  const hasContent = useProjectStore((s) => projectDuration(s.project) > 0);
  return (
    <div className="flex h-12 shrink-0 items-center justify-center gap-1 border-t bg-surface-1 px-2">
      <IconButton label="Go to start (Home)" icon={<SkipBack />} onClick={goToStart} />
      <IconButton
        label={playing ? "Pause (Space)" : "Play (Space)"}
        icon={playing ? <Pause /> : <Play />}
        disabled={!hasContent}
        onClick={togglePlayback}
      />
      <Timecode />
    </div>
  );
}

export function Preview() {
  const project = useProjectStore((s) => s.project);
  const playing = usePlaybackStore((s) => s.playing);
  const mediaErrors = usePlaybackStore((s) => s.mediaErrors);
  const elements = useRef(new Map<string, MediaEl>());
  const lastSeekAt = useRef(new Map<string, number>());

  // Re-render only when the set of on-screen layers changes, not on every playhead tick.
  const keys = usePlaybackStore(useShallow((s) => layersAt(project, s.playhead).map(layerKey)));
  const layers = useMemo(
    () => layersAt(project, usePlaybackStore.getState().playhead),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `keys` is the identity of the layer set
    [project, keys],
  );

  useEffect(() => (playing ? startClock() : undefined), [playing]);

  // The element that leads playback: the visible video, otherwise the first audible clip.
  useEffect(() => {
    setMediaClock(() => {
      const active = layers.filter((l) => l.role === "active" && l.asset.type !== "image");
      const lead = active.find((l) => l.visible) ?? active[0];
      if (!lead || usePlaybackStore.getState().mediaErrors[lead.asset.id]) return null;
      const el = elements.current.get(lead.clip.id);
      if (!el) return null;
      if (el.paused || el.seeking || el.readyState < 3) return "waiting";
      return { time: lead.clip.timelineStart + (el.currentTime - lead.clip.sourceIn) };
    });
    return () => setMediaClock(null);
  }, [layers]);

  // Imperative sync of every mounted element with the playhead (seek, play/pause, volume).
  useEffect(() => {
    const sync = () => {
      const { playhead, playing: isPlaying, setMediaError } = usePlaybackStore.getState();
      for (const layer of layers) {
        const el = elements.current.get(layer.clip.id);
        if (!el) continue;
        el.volume = Math.min(1, Math.max(0, layer.clip.volume)); // preview caps at 100%; export applies gain
        el.muted = layer.track.muted;

        const plan = planSync({
          role: layer.role,
          playing: isPlaying,
          paused: el.paused,
          currentTime: el.currentTime,
          desired: layer.role === "active" ? sourceTimeFor(layer.clip, playhead) : layer.clip.sourceIn,
        });
        if (plan.seekTo !== undefined) {
          // while playing, never re-seek the same element more than once a second (a seek costs frames)
          const nowMs = performance.now();
          const lastSeek = lastSeekAt.current.get(layer.clip.id) ?? -Infinity;
          if (!isPlaying || layer.role !== "active" || nowMs - lastSeek > 1000) {
            lastSeekAt.current.set(layer.clip.id, nowMs);
            el.currentTime = plan.seekTo;
          }
        }
        if (plan.pause) el.pause();
        if (plan.play) {
          el.play().catch((e: unknown) => {
            // Interrupted by a seek/pause is normal; anything else is a real playback problem.
            if (e instanceof DOMException && e.name === "AbortError") return;
            setMediaError(layer.asset.id, "Playback was blocked or failed");
          });
        }
      }
    };
    sync();
    return usePlaybackStore.subscribe(sync);
  }, [layers]);

  const { width, height, backgroundColor } = project.settings;
  const ratio = width / height;
  const activeErrors = layers
    .filter((l) => l.role === "active" && mediaErrors[l.asset.id])
    .map((l) => `${fileName(l.asset.path)} ${mediaErrors[l.asset.id]}`);
  const anyActive = layers.some((l) => l.role === "active");
  const empty = projectDuration(project) === 0;

  return (
    <section
      aria-label="Preview"
      className="flex min-h-0 min-w-0 flex-col bg-bg lg:col-start-2 lg:row-start-1"
    >
      <div className="min-h-0 flex-1 p-3" style={{ containerType: "size" }}>
        <div className="flex h-full w-full items-center justify-center">
          <div
            data-testid="preview-stage"
            className="relative overflow-hidden rounded-md border"
            style={{
              aspectRatio: ratio,
              width: `min(100cqw, calc(100cqh * ${ratio}))`,
              backgroundColor,
              containerType: "size",
            }}
          >
            {layers.map((layer) => (
              <LayerView
                key={layer.clip.id}
                layer={layer}
                register={(el) => {
                  if (el) elements.current.set(layer.clip.id, el);
                  else elements.current.delete(layer.clip.id);
                }}
              />
            ))}

            {!anyActive && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-text-muted [&_svg]:size-8">
                <MonitorPlay />
                <p className="text-xs">{empty ? "Preview is empty" : "No clip at playhead"}</p>
              </div>
            )}
            {activeErrors.length > 0 && (
              <div
                role="alert"
                className="absolute inset-x-2 bottom-2 z-50 rounded-md border border-danger/60 bg-black/80 p-2 text-xs text-danger"
              >
                {activeErrors.map((m) => (
                  <p key={m}>{m}</p>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      <Controls />
    </section>
  );
}

function LayerView({ layer, register }: { layer: Layer; register: (el: MediaEl | null) => void }) {
  const { asset, track, visible } = layer;
  const setMediaError = usePlaybackStore.getState().setMediaError;
  const src = mediaUrl(asset.path);
  const common = {
    src,
    preload: "auto" as const,
    onLoadedData: () => setMediaError(asset.id, null),
    onError: (e: React.SyntheticEvent<MediaEl>) =>
      setMediaError(asset.id, mediaErrorMessage(e.currentTarget.error?.code)),
  };

  if (asset.type === "audio") {
    return <audio ref={register} aria-hidden {...common} />;
  }
  if (asset.type === "image") {
    // Images need no sync; only the visible one is shown. Fit modes mirror the export filter graph.
    if (!visible) return null;
    const fit = layer.clip.fit ?? "fit";
    return (
      <div
        data-testid="image-layer"
        data-fit={fit}
        className="absolute inset-0 overflow-hidden"
        style={{ zIndex: track.order }}
      >
        {fit === "blur" && (
          // same blur as export: sigma = 3% of the canvas height
          <img
            src={src}
            alt=""
            aria-hidden
            className="absolute inset-0 h-full w-full object-cover"
            style={{ filter: "blur(3cqh)" }}
          />
        )}
        <img
          src={src}
          alt=""
          onLoad={() => setMediaError(asset.id, null)}
          onError={() => setMediaError(asset.id, mediaErrorMessage(4))}
          className={
            fit === "fill"
              ? "absolute inset-0 h-full w-full object-cover"
              : "absolute inset-0 h-full w-full object-contain"
          }
        />
      </div>
    );
  }
  // Non-visible video layers stay mounted (opacity 0) so their audio keeps playing underneath.
  return (
    <video
      ref={register}
      {...common}
      aria-hidden
      playsInline
      className="pointer-events-none absolute inset-0 h-full w-full object-contain"
      style={{ opacity: visible ? 1 : 0, zIndex: track.order }}
    />
  );
}
