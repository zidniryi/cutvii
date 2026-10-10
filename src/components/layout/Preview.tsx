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
  MAX_AUDIBLE_SPEED,
  pickLead,
  planSync,
  previewRate,
  restTimeFor,
  sourceTimeFor,
  timelineTimeFor,
  type Layer,
} from "@/playback/engine";
import { ensureReversePreviews } from "@/playback/reversePreview";
import { usePlaybackStore } from "@/store/playback";
import { reverseKey, useReverseStore, type ReversePreview } from "@/store/reverse";
import { useProjectStore } from "@/store/project";
import { clipSpeed, projectDuration } from "@/timeline/clips";

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
  // Reversed clips play from a reversed copy that Rust prepares in the background.
  const reversePreviews = useReverseStore((s) => s.previews);
  const lastSeekAt = useRef(new Map<string, number>());

  // Re-render only when the set of on-screen layers changes, not on every playhead tick.
  const keys = usePlaybackStore(useShallow((s) => layersAt(project, s.playhead).map(layerKey)));
  const layers = useMemo(
    () => layersAt(project, usePlaybackStore.getState().playhead),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `keys` is the identity of the layer set
    [project, keys],
  );

  useEffect(() => (playing ? startClock() : undefined), [playing]);

  // The element that leads playback: an audio clip if there is one, otherwise the visible video.
  useEffect(() => {
    setMediaClock(() => {
      const lead = pickLead(layers);
      if (!lead || usePlaybackStore.getState().mediaErrors[lead.asset.id]) return null;
      const el = elements.current.get(lead.clip.id);
      if (!el) return null;
      if (el.paused || el.seeking || el.readyState < 3) return "waiting";
      return { time: timelineTimeFor(lead.clip, el.currentTime) };
    });
    return () => setMediaClock(null);
  }, [layers]);

  // Imperative sync of every mounted element with the playhead (seek, play/pause, volume).
  useEffect(() => {
    const sync = () => {
      const { playhead, playing: isPlaying, setMediaError } = usePlaybackStore.getState();
      const lead = pickLead(layers);
      for (const layer of layers) {
        const el = elements.current.get(layer.clip.id);
        if (!el) continue;
        el.volume = Math.min(1, Math.max(0, layer.clip.volume)); // preview caps at 100%; export applies gain
        const speed = clipSpeed(layer.clip);
        // same rule as export: no sound above 4x
        el.muted = layer.track.muted || speed > MAX_AUDIBLE_SPEED;
        const base = previewRate(speed).rate;
        if ("preservesPitch" in el) el.preservesPitch = layer.clip.keepPitch ?? true;

        const plan = planSync({
          role: layer.role,
          playing: isPlaying,
          paused: el.paused,
          currentTime: el.currentTime,
          desired: layer.role === "active" ? sourceTimeFor(layer.clip, playhead) : restTimeFor(layer.clip),
          lead: layer === lead,
        });
        // clip speed times the small catch-up nudge
        const rate = base * (plan.rate ?? 1);
        if (el.playbackRate !== rate) el.playbackRate = rate;
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
    // also when a reversed copy becomes ready: its freshly mounted element must be put at the playhead
  }, [layers, reversePreviews]);

  useEffect(() => ensureReversePreviews(project), [project]);
  const reverseOf = (layer: Layer): ReversePreview | undefined =>
    layer.clip.reversed
      ? reversePreviews[reverseKey(layer.asset.path, layer.clip.sourceIn, layer.clip.sourceOut)]
      : undefined;
  const activeReversed = layers
    .filter((l) => l.role === "active" && l.clip.reversed)
    .map((l) => reverseOf(l));
  const preparing = activeReversed
    .filter((r): r is ReversePreview => !r || r.status === "preparing")
    .map((r) => r ?? { status: "preparing" as const, progress: 0 });
  const reverseFailed = activeReversed.filter((r): r is ReversePreview => r?.status === "failed");

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
                // a reversed clip switches to its reversed copy once that is ready: remount to load it
                key={`${layer.clip.id}:${layer.clip.reversed ? (reverseOf(layer)?.status ?? "none") : "fwd"}`}
                layer={layer}
                reverse={reverseOf(layer)}
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
            {preparing.length > 0 && (
              <div
                role="status"
                className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-1 bg-black/70 text-xs text-text-muted"
              >
                <p>
                  Preparing reverse preview… {Math.round(Math.max(...preparing.map((r) => r.progress)) * 100)}
                  %
                </p>
                <p>The export does not need this and can start right away.</p>
              </div>
            )}
            {reverseFailed.length > 0 && (
              <div
                role="alert"
                className="absolute inset-x-2 top-2 z-50 rounded-md border border-danger/60 bg-black/80 p-2 text-xs text-danger"
              >
                {reverseFailed.map((r) => (
                  <p key={r.error}>Reverse preview failed: {r.error}</p>
                ))}
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

function LayerView({
  layer,
  register,
  reverse,
}: {
  layer: Layer;
  register: (el: MediaEl | null) => void;
  reverse?: ReversePreview;
}) {
  const { asset, track, visible } = layer;
  const setMediaError = usePlaybackStore.getState().setMediaError;
  // a reversed clip has nothing to show until its reversed copy exists (never play it forwards by mistake)
  if (layer.clip.reversed && asset.type !== "image" && reverse?.status !== "ready") return null;
  const src = mediaUrl(layer.clip.reversed && reverse?.path ? reverse.path : asset.path);
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
