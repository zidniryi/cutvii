import { useEffect, useMemo, useRef } from "react";
import { MonitorPlay } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { assetName, mediaUrl } from "@/lib/media";
import { setMediaClock, startClock } from "@/playback/controller";
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
import { TransportBar } from "@/components/preview/TransportBar";
import { ensureReversePreviews } from "@/playback/reversePreview";
import { usePlaybackStore } from "@/store/playback";
import { reverseKey, useReverseStore, type ReversePreview } from "@/store/reverse";
import { useProjectStore } from "@/store/project";
import { clipSpeed, projectDuration } from "@/timeline/clips";
import {
  backgroundColor as fitBackgroundColor,
  backgroundOf,
  blurFraction,
  DEFAULT_FIT_MODE,
  fitLayout,
  rectStyle,
  type Rect,
} from "@/timeline/fit";
import { useImagePreviewStore } from "@/store/imagePreviews";

type MediaEl = HTMLVideoElement | HTMLAudioElement;

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
      const monitor = usePlaybackStore.getState();
      const { playhead, playing: isPlaying, setMediaError } = monitor;
      const lead = pickLead(layers);
      for (const layer of layers) {
        const el = elements.current.get(layer.clip.id);
        if (!el) continue;
        // clip volume (capped at 100% in the preview; export applies gain) times the monitor volume
        el.volume = Math.min(1, Math.max(0, layer.clip.volume)) * monitor.volume;
        const speed = clipSpeed(layer.clip);
        // same rule as export: no sound above 4x
        el.muted = monitor.muted || layer.track.muted || speed > MAX_AUDIBLE_SPEED;
        const base = previewRate(speed * monitor.previewSpeed).rate; // preview speed is monitor-only
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

  // Image backgrounds use a downscaled cached copy (the thumbnail until that is ready).
  const imagePreviews = useImagePreviewStore((s) => s.previews);
  const backgroundImageOf = (layer: Layer): string | undefined => {
    const bg = layer.clip.fitBackground;
    if (bg?.kind !== "image") return undefined;
    const image = project.assets.find((a) => a.id === bg.assetId);
    if (!image) return undefined;
    return imagePreviews[image.path] ?? image.thumbnailPath;
  };
  useEffect(() => {
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        const id = clip.fitBackground?.kind === "image" ? clip.fitBackground.assetId : undefined;
        const image = id && project.assets.find((a) => a.id === id);
        if (image) useImagePreviewStore.getState().ensure(image.path);
      }
    }
  }, [project]);

  const { width, height, backgroundColor } = project.settings;
  const ratio = width / height;
  const activeErrors = layers
    .filter((l) => l.role === "active" && mediaErrors[l.asset.id])
    .map((l) => `${assetName(l.asset)} ${mediaErrors[l.asset.id]}`);
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
                canvas={{ width, height }}
                backgroundImage={backgroundImageOf(layer)}
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
      <TransportBar />
    </section>
  );
}

function LayerView({
  layer,
  register,
  reverse,
  canvas,
  backgroundImage,
}: {
  layer: Layer;
  register: (el: MediaEl | null) => void;
  reverse?: ReversePreview;
  canvas: { width: number; height: number };
  /** File to show behind the picture when the clip's background is an image (already a preview copy). */
  backgroundImage?: string;
}) {
  const { asset, track, visible } = layer;
  const videoRef = useRef<HTMLVideoElement | null>(null);
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
  const mode = layer.clip.fitMode ?? DEFAULT_FIT_MODE;
  // Same geometry as the export: computed from the real picture size, never the native pixel size.
  const layout = fitLayout(asset.width ?? 0, asset.height ?? 0, canvas.width, canvas.height, mode);
  // Behind the picture: the clip's background colour or image (same choice the export uses).
  const background = backgroundOf(layer.clip);
  const fraction = blurFraction(background.blur);
  const blur = fraction > 0 ? { filter: `blur(${fraction * 100}cqh)` } : {};
  const backdropImage = backgroundImage && (
    <img
      src={mediaUrl(backgroundImage)}
      alt=""
      aria-hidden
      data-role="background"
      className="absolute inset-0 h-full w-full object-cover"
    />
  );

  if (asset.type === "image" && asset.text) {
    // A text picture is the size of the canvas and transparent: it sits over the layers below, with no
    // background of its own (the export overlays the same file).
    if (!visible) return null;
    return (
      <img
        src={src}
        alt=""
        data-testid="text-layer"
        onLoad={() => setMediaError(asset.id, null)}
        onError={() => setMediaError(asset.id, mediaErrorMessage(4))}
        className="pointer-events-none absolute inset-0 h-full w-full object-contain"
        style={{ zIndex: track.order }}
      />
    );
  }
  if (asset.type === "image") {
    // Images need no sync; only the visible one is shown.
    if (!visible) return null;
    return (
      <div
        data-testid="image-layer"
        data-fit={mode}
        className="absolute inset-0 overflow-hidden"
        style={{ zIndex: track.order, backgroundColor: fitBackgroundColor(background) }}
      >
        {backdropImage}
        {layout.backdrop && (
          <img
            src={src}
            alt=""
            aria-hidden
            className="absolute max-w-none"
            style={{ ...rectStyle(layout.backdrop), ...blur }}
          />
        )}
        <img
          src={src}
          alt=""
          data-role="picture"
          onLoad={() => setMediaError(asset.id, null)}
          onError={() => setMediaError(asset.id, mediaErrorMessage(4))}
          className="absolute max-w-none"
          style={rectStyle(layout.picture)}
        />
      </div>
    );
  }
  // Non-visible video layers stay mounted (opacity 0) so their audio keeps playing underneath.
  return (
    <div
      data-testid="video-layer"
      data-fit={mode}
      className="pointer-events-none absolute inset-0 overflow-hidden"
      style={{
        opacity: visible ? 1 : 0,
        zIndex: track.order,
        backgroundColor: fitBackgroundColor(background),
      }}
    >
      {visible && backdropImage}
      {layout.backdrop && visible && <VideoBackdrop source={videoRef} rect={layout.backdrop} style={blur} />}
      <video
        ref={(el) => {
          videoRef.current = el;
          register(el);
        }}
        {...common}
        aria-hidden
        playsInline
        data-role="picture"
        className="absolute max-w-none object-fill"
        style={rectStyle(layout.picture)}
      />
    </div>
  );
}

/**
 * Blurred backdrop for "blur-bg" video: copies the frames of the one playing <video> onto a small canvas,
 * so the clip is decoded once (a second <video> would need its own decoder and its own sync).
 */
function VideoBackdrop({
  source,
  rect,
  style,
}: {
  source: React.RefObject<HTMLVideoElement | null>;
  rect: Rect;
  style: React.CSSProperties;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const video = source.current;
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext?.("2d");
      if (video && canvas && ctx && video.videoWidth > 0) {
        // a small copy is plenty: it is blurred anyway
        const w = 160;
        const h = Math.max(2, Math.round((w * video.videoHeight) / video.videoWidth));
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
        ctx.drawImage(video, 0, 0, w, h);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [source]);
  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      data-role="backdrop"
      className="absolute max-w-none"
      style={{ ...rectStyle(rect), ...style }}
    />
  );
}
