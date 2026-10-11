import { useEffect, useMemo, useRef, useState } from "react";
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
import { CropOverlay } from "@/components/preview/CropOverlay";
import { PositionGuides } from "@/components/preview/PositionGuides";
import { useTextDrag } from "@/components/preview/useTextDrag";
import { useTextStyleStore } from "@/store/textStyles";
import { useSelectionStore } from "@/store/selection";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/store/ui";
import { ensureReversePreviews } from "@/playback/reversePreview";
import { usePlaybackStore } from "@/store/playback";
import { reverseKey, useReverseStore, type ReversePreview } from "@/store/reverse";
import { useProjectStore } from "@/store/project";
import { clipSpeed, projectDuration } from "@/timeline/clips";
import {
  backgroundColor as fitBackgroundColor,
  backgroundOf,
  blurFraction,
  croppedSize,
  cropInnerStyle,
  cropOf,
  DEFAULT_FIT_MODE,
  isCropped,
  fitLayout,
  rectStyle,
  type Rect,
} from "@/timeline/fit";
import { useImagePreviewStore } from "@/store/imagePreviews";
import { ColorCanvas } from "@/components/preview/ColorCanvas";
import { useLutStore } from "@/store/luts";
import { fadeGain, isSoundOnly } from "@/timeline/audio";
import { colorKey, colorOf, isGraded } from "@/timeline/color";
import { transformStyle } from "@/timeline/transform";
import type { Crop, TimelineClip } from "@/project/model";

type MediaEl = HTMLVideoElement | HTMLAudioElement;
/** A share as a percentage without float noise (0.2 -> 20, not 19.999999999999996). */
const percent = (shareOfStage: number) => Number((shareOfStage * 100).toFixed(2));

export function Preview() {
  const project = useProjectStore((s) => s.project);
  const playing = usePlaybackStore((s) => s.playing);
  const full = useUiStore((s) => s.previewFull);
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") useUiStore.getState().setPreviewFull(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full]);
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
        // ... and the clip's fades, which follow the playhead
        el.volume =
          Math.min(1, Math.max(0, layer.clip.volume)) * monitor.volume * fadeGain(layer.clip, playhead);
        const speed = clipSpeed(layer.clip);
        // same rule as export: no sound above 4x
        el.muted =
          monitor.muted || layer.track.muted || (layer.clip.muted ?? false) || speed > MAX_AUDIBLE_SPEED;
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
  const textDrag = useTextDrag(layers, project.settings);
  const safeMargin = useTextStyleStore((s) => s.safeMargin);

  // Crop box in the preview: only while its clip is selected and under the playhead.
  const cropEdit = useUiStore((s) => s.cropEdit);
  const cropLock = useUiStore((s) => s.cropLock);
  const cropSelected = useSelectionStore((s) =>
    Boolean(cropEdit && s.selectedClipIds.includes(cropEdit.clipId)),
  );
  const cropLayer =
    cropEdit && cropSelected
      ? layers.find(
          (l) =>
            l.clip.id === cropEdit.clipId && l.role === "active" && l.asset.type !== "audio" && !l.asset.text,
        )
      : undefined;
  useEffect(() => {
    if (cropEdit && !cropLayer) useUiStore.getState().setCropEdit(null);
  }, [cropEdit, cropLayer]);
  const activeErrors = layers
    .filter((l) => l.role === "active" && mediaErrors[l.asset.id])
    .map((l) => `${assetName(l.asset)} ${mediaErrors[l.asset.id]}`);
  const anyActive = layers.some((l) => l.role === "active");
  const empty = projectDuration(project) === 0;

  return (
    <section
      aria-label="Preview"
      data-full={full || undefined}
      className={cn(
        "flex min-h-0 min-w-0 flex-col bg-bg",
        full ? "fixed inset-0 z-50" : "lg:col-start-2 lg:row-start-1",
      )}
    >
      <div className="min-h-0 flex-1 p-3" style={{ containerType: "size" }}>
        <div className="flex h-full w-full items-center justify-center">
          <div
            data-testid="preview-stage"
            className="relative touch-none overflow-hidden rounded-md border"
            {...textDrag.handlers}
            style={{
              aspectRatio: ratio,
              width: `min(100cqw, calc(100cqh * ${ratio}))`,
              backgroundColor,
              containerType: "size",
              cursor: textDrag.cursor,
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
                shift={textDrag.shiftOf(layer.clip.id)}
                onTextShown={() => textDrag.settled(layer.clip.id)}
                register={(el) => {
                  if (el) elements.current.set(layer.clip.id, el);
                  else elements.current.delete(layer.clip.id);
                }}
              />
            ))}

            {textDrag.guides && <PositionGuides safe={safeMargin} {...textDrag.guides} />}

            {cropLayer && (
              <CropOverlay
                key={cropLayer.clip.id}
                clip={cropLayer.clip}
                asset={cropLayer.asset}
                canvas={{ width, height }}
                video={() => {
                  const el = elements.current.get(cropLayer.clip.id);
                  return el instanceof HTMLVideoElement ? el : undefined;
                }}
                lockRatio={cropLock?.clipId === cropLayer.clip.id ? cropLock.ratio : null}
                onDone={() => useUiStore.getState().setCropEdit(null)}
              />
            )}
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

/**
 * A text picture that never blinks: when the text is redrawn, the previous picture stays on screen until
 * the new one has been decoded, and only then are they swapped.
 */
function TextPicture({
  src,
  zIndex,
  shift,
  placed,
  clip,
  onLoad,
  onError,
  onShown,
}: {
  src: string;
  zIndex: number;
  /** The text clip: its fade in and out follow the playhead. */
  clip: TimelineClip;
  shift?: { dx: number; dy: number } | null;
  /** The clip's own transform (applied after the drag shift). */
  placed?: { transform?: string; opacity?: number };
  onLoad: () => void;
  onError: () => void;
  onShown?: () => void;
}) {
  const [shown, setShown] = useState(src);
  const shownCallback = useRef(onShown);
  useEffect(() => {
    shownCallback.current = onShown;
  });
  useEffect(() => {
    if (src === shown) return;
    let live = true;
    const next = new Image();
    next.src = src;
    const swap = () => {
      if (!live) return;
      setShown(src);
      shownCallback.current?.();
    };
    // a picture that cannot be decoded is swapped in too, so its error is reported as usual
    Promise.resolve()
      .then(() => next.decode?.())
      .then(swap, swap);
    return () => {
      live = false;
    };
  }, [src, shown]);

  // A fading text gets more or less see-through as the playhead moves through it: straight-line ramps over
  // the clip's fade in and out, the same ones the export applies to the picture's transparency.
  const imgRef = useRef<HTMLImageElement>(null);
  const fades = (clip.fadeIn ?? 0) > 0 || (clip.fadeOut ?? 0) > 0;
  const base = placed?.opacity ?? 1;
  useEffect(() => {
    const el = imgRef.current;
    if (!el || !fades) return;
    const apply = () => {
      el.style.opacity = String(base * fadeGain(clip, usePlaybackStore.getState().playhead));
    };
    apply();
    return usePlaybackStore.subscribe(apply);
  }, [fades, base, clip]);

  return (
    <img
      ref={imgRef}
      src={shown}
      alt=""
      data-testid="text-layer"
      onLoad={onLoad}
      onError={onError}
      draggable={false}
      className="pointer-events-none absolute inset-0 h-full w-full object-contain"
      style={{
        zIndex,
        // while it fades, the effect above owns the opacity
        opacity: fades ? undefined : placed?.opacity,
        transform:
          [shift ? `translate(${percent(shift.dx)}%, ${percent(shift.dy)}%)` : "", placed?.transform ?? ""]
            .filter(Boolean)
            .join(" ") || undefined,
      }}
    />
  );
}

function LayerView({
  layer,
  register,
  reverse,
  canvas,
  backgroundImage,
  shift,
  onTextShown,
}: {
  layer: Layer;
  register: (el: MediaEl | null) => void;
  reverse?: ReversePreview;
  canvas: { width: number; height: number };
  /** File to show behind the picture when the clip's background is an image (already a preview copy). */
  backgroundImage?: string;
  /** A text being dragged: how far its picture is shifted, in shares of the stage. */
  shift?: { dx: number; dy: number } | null;
  /** A redrawn text picture has replaced the previous one on screen. */
  onTextShown?: () => void;
}) {
  const { asset, track, visible } = layer;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const setMediaError = usePlaybackStore.getState().setMediaError;
  // Colour: the values being dragged if any, otherwise the clip's own; none while "Before" is held.
  const colorDraft = useUiStore((s) => (s.colorDraft?.clipId === layer.clip.id ? s.colorDraft.adjust : null));
  const colorBefore = useUiStore((s) => s.colorBefore === layer.clip.id);
  const adjust = colorDraft ?? colorOf(layer.clip);
  const graded = isGraded(adjust) && !asset.text && asset.type !== "audio" && track.type === "video";
  // The table for these values; while a newer one is on its way (a slider being dragged) the clip keeps
  // the last one it had, so the picture never flashes back to ungraded.
  const lut = useLutStore((s) => {
    if (!graded || colorBefore) return null;
    const entry = s.entries[colorKey(adjust)];
    return entry?.status === "ready" ? entry.lut : (s.held[layer.clip.id] ?? null);
  });
  useEffect(() => {
    if (graded) useLutStore.getState().ensure(adjust, layer.clip.id);
  });
  // a shader may only read media loaded with CORS; the asset protocol allows it
  const crossOrigin = graded ? ("anonymous" as const) : undefined;
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

  // an audio file, or a video's detached sound on an audio track: heard, never shown
  if (isSoundOnly(track, asset)) {
    return <audio ref={register} aria-hidden {...common} />;
  }
  const mode = layer.clip.fitMode ?? DEFAULT_FIT_MODE;
  // Same geometry as the export: computed from the real picture size, never the native pixel size.
  // Position, scale, rotation, mirroring and opacity of the whole layer (the export does the same).
  const placed = transformStyle(layer.clip);
  // A cropped clip is laid out by what is left of its picture, exactly as the export scales it after cropping.
  const crop = cropOf(layer.clip);
  const kept = croppedSize(asset.width ?? 0, asset.height ?? 0, crop);
  const layout = fitLayout(kept.width, kept.height, canvas.width, canvas.height, mode);
  /** Put a picture at `rect`. Cropped: a clipping frame goes there and the picture is enlarged inside it. */
  const framed = (
    rect: Rect,
    extra: React.CSSProperties,
    picture: (style: React.CSSProperties) => React.ReactNode,
  ) =>
    isCropped(crop) ? (
      <div
        data-role="crop-frame"
        className="absolute overflow-hidden"
        style={{ ...rectStyle(rect), ...extra }}
      >
        {picture(cropInnerStyle(crop))}
      </div>
    ) : (
      picture({ ...rectStyle(rect), ...extra })
    );
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
      <TextPicture
        src={src}
        zIndex={track.order}
        shift={shift}
        placed={placed}
        clip={layer.clip}
        onLoad={() => setMediaError(asset.id, null)}
        onError={() => setMediaError(asset.id, mediaErrorMessage(4))}
        onShown={onTextShown}
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
        style={{ zIndex: track.order, backgroundColor: fitBackgroundColor(background), ...placed }}
      >
        {backdropImage}
        {layout.backdrop &&
          framed(layout.backdrop, blur, (style) => (
            <img src={src} alt="" aria-hidden className="absolute max-w-none" style={style} />
          ))}
        {framed(layout.picture, {}, (style) => (
          <img
            ref={imageRef}
            src={src}
            alt=""
            crossOrigin={crossOrigin}
            data-role="picture"
            onLoad={() => setMediaError(asset.id, null)}
            onError={() => setMediaError(asset.id, mediaErrorMessage(4))}
            className="absolute max-w-none"
            style={style}
          />
        ))}
        {lut &&
          framed(layout.picture, {}, (style) => (
            <ColorCanvas
              source={() => imageRef.current}
              lut={lut}
              live={false}
              className="absolute max-w-none"
              style={style}
            />
          ))}
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
        zIndex: track.order,
        backgroundColor: fitBackgroundColor(background),
        ...placed,
        opacity: visible ? (placed.opacity ?? 1) : 0,
      }}
    >
      {visible && backdropImage}
      {layout.backdrop && visible && (
        <VideoBackdrop source={videoRef} rect={layout.backdrop} style={blur} crop={crop} />
      )}
      {framed(layout.picture, {}, (style) => (
        <video
          ref={(el) => {
            videoRef.current = el;
            register(el);
          }}
          {...common}
          crossOrigin={crossOrigin}
          aria-hidden
          playsInline
          data-role="picture"
          className="absolute max-w-none object-fill"
          style={style}
        />
      ))}
      {lut &&
        visible &&
        framed(layout.picture, {}, (style) => (
          <ColorCanvas
            source={() => videoRef.current}
            lut={lut}
            live
            className="absolute max-w-none"
            style={style}
          />
        ))}
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
  crop,
}: {
  source: React.RefObject<HTMLVideoElement | null>;
  rect: Rect;
  style: React.CSSProperties;
  /** Only the kept part of the frame is copied. */
  crop: Crop;
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
        const part = croppedSize(video.videoWidth, video.videoHeight, crop);
        const w = 160;
        const h = Math.max(2, Math.round((w * part.height) / part.width));
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
        ctx.drawImage(
          video,
          video.videoWidth * crop.left,
          video.videoHeight * crop.top,
          part.width,
          part.height,
          0,
          0,
          w,
          h,
        );
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [source, crop]);
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
