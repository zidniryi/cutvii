import { useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, Sparkles } from "lucide-react";
import { AiPanel } from "@/components/inspector/AiPanel";
import { ColorPanel } from "@/components/inspector/ColorPanel";
import { CropPanel } from "@/components/inspector/CropPanel";
import { MediaInfo } from "@/components/inspector/MediaInfo";
import { CleanPanel } from "@/components/inspector/CleanPanel";
import { DuckPanel } from "@/components/inspector/DuckPanel";
import { SoundPanel } from "@/components/inspector/SoundPanel";
import { StyleGallery } from "@/components/inspector/StyleGallery";
import { TextPanel } from "@/components/inspector/TextPanel";
import { TransformPanel } from "@/components/inspector/TransformPanel";
import { TransitionPanel } from "@/components/inspector/TransitionPanel";
import { UpscalePanel } from "@/components/inspector/UpscalePanel";
import { Panel } from "@/components/Panel";
import { assetName, fileName } from "@/lib/media";
import { formatTimecode } from "@/lib/timecode";
import { cn } from "@/lib/utils";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useUiStore, type ClipKind, type InspectorTab } from "@/store/ui";
import { selectClipsReady, useAutoClipsStore } from "@/store/autoClips";
import { canvasLabel, canvasOf, formatFps } from "@/project/canvas";
import type { FitBackground, MediaAsset, Project, TimelineClip, TimelineTrack } from "@/project/model";
import { projectDuration } from "@/timeline/clips";
import { formatDuration } from "@/lib/timecode";
import { Button } from "@/components/ui/button";
import { clipDuration, clipSpeed, findClip, sourceDuration } from "@/timeline/clips";
import { MAX_SPEED, MAX_VOLUME, MIN_SPEED } from "@/timeline/edit";
import { backgroundOf, DEFAULT_FIT_MODE, showsBackground } from "@/timeline/fit";
import { chooseBackgroundImage, relinkFlow } from "@/project/fileActions";
import { thumbnailUrl } from "@/lib/media";
import { ImagePlus } from "lucide-react";
import {
  applyBackgroundToAllClips,
  changeFit,
  changeFitBackground,
  changeKeepPitch,
  changeReversed,
  changeSpeed,
  changeVolume,
  moveClipTo,
  report,
  trimClipEdge,
} from "@/timeline/editor";
import { confirmDialog } from "@/lib/dialog";
import { freezeFrameAtPlayhead } from "@/timeline/freeze";
import { reverseKey, useReverseStore } from "@/store/reverse";
import { MAX_AUDIBLE_SPEED, previewRate } from "@/playback/engine";
import type { FitMode } from "@/project/model";

const fieldClass =
  "h-9 w-full rounded-md border bg-surface-2 px-2 text-sm tabular-nums pointer-coarse:h-11 focus-visible:outline-accent";

/** Seconds field: edits are applied on Enter/blur, Escape reverts; invalid input snaps back. */
function SecondsField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? value.toFixed(3);

  function commit() {
    if (draft === null) return;
    const parsed = Number(draft);
    setDraft(null);
    if (Number.isFinite(parsed) && Math.abs(parsed - value) > 1e-6) onCommit(parsed);
  }

  return (
    <label className="block">
      <span className="mb-1 block text-xs text-text-muted">{label}</span>
      <input
        type="number"
        inputMode="decimal"
        step="0.01"
        min="0"
        className={fieldClass}
        value={shown}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setDraft(null);
        }}
      />
    </label>
  );
}

/** Volume in percent. Dragging only previews; the change is one undo step, committed on release. */
function VolumeField({ volume, onCommit }: { volume: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState<number | null>(null);
  const pct = Math.round((draft ?? volume) * 100);

  function commit() {
    if (draft === null) return;
    const v = draft;
    setDraft(null);
    if (v !== volume) onCommit(v);
  }
  const set = (percent: number) => setDraft(Math.min(MAX_VOLUME, Math.max(0, percent / 100)));

  return (
    <div>
      <label htmlFor="inspector-volume" className="mb-1 block text-xs text-text-muted">
        Volume
      </label>
      <div className="flex items-center gap-2">
        <input
          id="inspector-volume"
          type="range"
          min={0}
          max={MAX_VOLUME * 100}
          step={1}
          value={pct}
          aria-valuetext={`${pct} percent`}
          className="min-w-0 flex-1 accent-[var(--accent)] pointer-coarse:h-11"
          onChange={(e) => set(Number(e.target.value))}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
        />
        <div className="relative w-20 shrink-0">
          <input
            type="number"
            aria-label="Volume percent"
            min={0}
            max={MAX_VOLUME * 100}
            className={cn(fieldClass, "pr-6")}
            value={pct}
            onChange={(e) => set(Number(e.target.value))}
            onBlur={commit}
            onKeyDown={(e) => e.key === "Enter" && commit()}
          />
          <span
            aria-hidden
            className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-xs text-text-muted"
          >
            %
          </span>
        </div>
      </div>
      {pct > 100 && (
        <p className="mt-1 text-xs text-text-muted">
          Above 100 % is applied in export; the preview plays at 100 %.
        </p>
      )}
    </div>
  );
}

const FIT_CHIPS: { id: FitMode; label: string; hint: string }[] = [
  { id: "fill", label: "Fill", hint: "Cover the canvas; the overflow is cropped" },
  { id: "fit", label: "Fit", hint: "Show the whole picture with background bars" },
  { id: "blur-bg", label: "Blur", hint: "Show the whole picture over a blurred copy of itself" },
];

const SPEED_PRESETS = [0.25, 0.5, 1, 2, 4];
const seconds = (v: number) => `${v.toFixed(2)} s`;
const times = (v: number) => `${Math.round(v * 100) / 100}×`;

/** Change speed; when later clips are in the way, ask whether to move them (ripple) or cancel. */
async function applySpeed(clipId: string, speed: number) {
  const first = changeSpeed(clipId, speed);
  if (first.ok) return;
  if (first.error.code !== "needs-ripple") {
    report(first);
    return;
  }
  const move = await confirmDialog({
    title: "Move the following clips?",
    lines: [
      "At this speed the clip becomes longer and would overlap the clips after it on the same track.",
      "Move those clips later to make room, or cancel to keep the current speed.",
    ],
    confirmLabel: "Move clips",
  });
  if (move) report(changeSpeed(clipId, speed, true));
}

/** Reversing longer than this is slow and needs temporary disk space (same threshold as the export warning). */
const LONG_REVERSE_SECONDS = 60;

function SpeedPanel({
  clipId,
  speed,
  keepPitch,
  source,
  reversed,
  reverseId,
  isVideo,
}: {
  clipId: string;
  speed: number;
  keepPitch: boolean;
  source: number;
  reversed: boolean;
  /** Key of this clip's reversed preview copy. */
  reverseId: string;
  isVideo: boolean;
}) {
  const reverse = useReverseStore((s) => (reversed ? s.previews[reverseId] : undefined));
  const [draft, setDraft] = useState<string | null>(null);
  const typed = draft === null ? null : Number(draft);
  const shown = typed !== null && Number.isFinite(typed) && typed > 0 ? typed : speed;
  const invalid = typed !== null && !(Number.isFinite(typed) && typed >= MIN_SPEED && typed <= MAX_SPEED);
  const preview = previewRate(shown);

  function commit() {
    if (draft === null) return;
    const v = Number(draft);
    setDraft(null);
    if (Number.isFinite(v) && v >= MIN_SPEED && v <= MAX_SPEED && Math.abs(v - speed) > 1e-9)
      void applySpeed(clipId, v);
  }

  return (
    <section aria-label="Speed" className="space-y-2">
      <p className="text-xs text-text-muted">Speed</p>
      <div role="group" aria-label="Speed presets" className="grid grid-cols-5 gap-1">
        {SPEED_PRESETS.map((p) => {
          const active = Math.abs(speed - p) < 1e-9 && draft === null;
          return (
            <button
              key={p}
              type="button"
              aria-pressed={active}
              onClick={() => {
                setDraft(null);
                void applySpeed(clipId, p);
              }}
              className={cn(
                "h-9 rounded-md border text-xs tabular-nums pointer-coarse:h-11",
                active
                  ? "border-accent bg-accent-soft text-text"
                  : "border-border bg-surface-2 text-text-muted hover:text-text",
              )}
            >
              {times(p)}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <label htmlFor="inspector-speed" className="text-xs text-text-muted">
          Custom
        </label>
        <div className="relative w-24">
          <input
            id="inspector-speed"
            type="number"
            inputMode="decimal"
            min={MIN_SPEED}
            max={MAX_SPEED}
            step={0.05}
            aria-invalid={invalid}
            className={cn(fieldClass, "pr-6 aria-[invalid=true]:border-danger")}
            value={draft ?? String(Math.round(speed * 1000) / 1000)}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") setDraft(null);
            }}
          />
          <span
            aria-hidden
            className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-xs text-text-muted"
          >
            ×
          </span>
        </div>
        <label className="ml-auto flex min-h-9 items-center gap-1.5 text-xs pointer-coarse:min-h-11">
          <input
            type="checkbox"
            className="size-4 accent-[var(--accent)]"
            checked={keepPitch}
            onChange={(e) => report(changeKeepPitch(clipId, e.target.checked))}
          />
          Keep pitch
        </label>
      </div>
      {invalid && (
        <p role="alert" className="text-xs text-danger">
          Speed must be between {MIN_SPEED}× and {MAX_SPEED}×
        </p>
      )}
      <p className="text-xs text-text-muted tabular-nums" data-testid="speed-duration">
        Duration: {seconds(source)} → {seconds(source / shown)}
      </p>
      {shown > MAX_AUDIBLE_SPEED && (
        <p className="text-xs text-text-muted">
          Sound is muted above {MAX_AUDIBLE_SPEED}×, in the preview and the export.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          type="button"
          aria-pressed={reversed}
          onClick={() => report(changeReversed(clipId, !reversed))}
          className={cn(
            "h-9 rounded-md border px-3 text-xs pointer-coarse:h-11",
            reversed
              ? "border-accent bg-accent-soft text-text"
              : "border-border bg-surface-2 text-text-muted hover:text-text",
          )}
        >
          Reverse
        </button>
        {isVideo && (
          <button
            type="button"
            title="Hold the frame under the playhead for 2 seconds (Shift+F)"
            onClick={() => void freezeFrameAtPlayhead()}
            className="h-9 rounded-md border border-border bg-surface-2 px-3 text-xs text-text-muted hover:text-text pointer-coarse:h-11"
          >
            Freeze frame
          </button>
        )}
      </div>
      {reversed && (!reverse || reverse.status === "preparing") && (
        <p role="status" className="text-xs text-text-muted">
          Preparing reverse preview… {Math.round((reverse?.progress ?? 0) * 100)}%
        </p>
      )}
      {reversed && reverse?.status === "failed" && (
        <p role="alert" className="text-xs text-danger">
          Reverse preview failed: {reverse.error}
        </p>
      )}
      {reversed && source > LONG_REVERSE_SECONDS && (
        <p className="text-xs text-text-muted">
          Reversing {Math.round(source)} s is slow and needs temporary disk space when exporting.
        </p>
      )}
      {!preview.exact && !invalid && (
        <p className="text-xs text-text-muted">
          The preview can only play at {times(preview.rate)} here; the export uses the real {times(shown)}.
        </p>
      )}
    </section>
  );
}

/** Tabs that have working controls for each kind of clip, in display order. The first one is the default. */
export const TABS_FOR: Record<ClipKind, InspectorTab[]> = {
  video: ["video", "color", "audio", "ai", "speed", "info"],
  audio: ["audio", "ai", "speed", "info"],
  image: ["video", "color", "info"], // stills have no sound and no speed
};
const TEXT_TABS: InspectorTab[] = ["text", "info"];
const TAB_LABEL: Record<InspectorTab, string> = {
  video: "Video",
  audio: "Audio",
  speed: "Speed",
  info: "Info",
  text: "Text",
  ai: "AI",
  color: "Color",
};

function FitChips({ clip }: { clip: TimelineClip }) {
  return (
    <div role="radiogroup" aria-label="Fit to canvas">
      <p className="mb-1 text-xs text-text-muted">Fit to canvas</p>
      <div className="grid grid-cols-3 gap-1">
        {FIT_CHIPS.map((chip) => {
          const selected = (clip.fitMode ?? DEFAULT_FIT_MODE) === chip.id;
          return (
            <button
              key={chip.id}
              type="button"
              role="radio"
              aria-checked={selected}
              title={chip.hint}
              onClick={() => report(changeFit(clip.id, chip.id))}
              className={cn(
                "h-9 rounded-md border text-xs pointer-coarse:h-11",
                selected
                  ? "border-accent bg-accent-soft text-text"
                  : "border-border bg-surface-2 text-text-muted hover:text-text",
              )}
            >
              {chip.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const BACKGROUND_KINDS: { id: FitBackground["kind"]; label: string }[] = [
  { id: "black", label: "Black" },
  { id: "color", label: "Color" },
  { id: "image", label: "Image" },
];

/** What shows behind a fitted (or transparent) picture. Every change is one undo step. */
function BackgroundRow({
  clip,
  blurMode,
  opaque,
}: {
  clip: TimelineClip;
  blurMode: boolean;
  /** The picture has no transparency (video): in Blur mode nothing behind the blurred copy can show. */
  opaque: boolean;
}) {
  const images = useProjectStore((s) => s.project.assets).filter((a) => a.type === "image" && !a.text);
  const missingPaths = useProjectStore((s) => s.missingPaths);
  const current = backgroundOf(clip);
  const [colorDraft, setColorDraft] = useState<string | null>(null);
  const [blurDraft, setBlurDraft] = useState<number | null>(null);
  // keep the blur amount when the kind changes; never store the default explicitly
  const withBlur = (bg: FitBackground): FitBackground =>
    clip.fitBackground?.blur !== undefined ? { ...bg, blur: clip.fitBackground.blur } : bg;
  const set = (bg: FitBackground) => report(changeFitBackground(clip.id, withBlur(bg)));
  const stored: FitBackground = clip.fitBackground ?? { kind: "black" };

  function choose(kind: FitBackground["kind"]) {
    if (kind === "black") set({ kind: "black" });
    else if (kind === "color") set({ kind: "color", color: current.color ?? "#202020" });
    else if (images.length > 0) set({ kind: "image", assetId: current.assetId ?? images[0].id });
    else void chooseBackgroundImage(clip.id); // nothing in the library yet: go straight to the file picker
  }
  function commitColor() {
    if (colorDraft === null) return;
    const value = colorDraft;
    setColorDraft(null);
    if (/^#[0-9a-fA-F]{6}$/.test(value)) set({ kind: "color", color: value });
  }
  function commitBlur() {
    if (blurDraft === null) return;
    const value = blurDraft;
    setBlurDraft(null);
    report(changeFitBackground(clip.id, { ...stored, blur: value }));
  }
  const image = current.kind === "image" ? images.find((a) => a.id === current.assetId) : undefined;
  const imageMissing = image ? missingPaths.includes(image.path) : false;
  const blurShown = blurDraft ?? current.blur;
  const showKinds = !(blurMode && opaque);

  return (
    <div className="space-y-2">
      {showKinds && (
        <div role="radiogroup" aria-label="Background">
          <p className="mb-1 text-xs text-text-muted">Background</p>
          <div className="grid grid-cols-3 gap-1">
            {BACKGROUND_KINDS.map((k) => {
              const selected = current.kind === k.id;
              return (
                <button
                  key={k.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => choose(k.id)}
                  className={cn(
                    "h-9 rounded-md border text-xs pointer-coarse:h-11",
                    selected
                      ? "border-accent bg-accent-soft text-text"
                      : "border-border bg-surface-2 text-text-muted hover:text-text",
                  )}
                >
                  {k.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {showKinds && current.kind === "color" && (
        <div className="flex items-center gap-2">
          <input
            type="color"
            aria-label="Background colour"
            className="h-9 w-12 cursor-pointer rounded-md border bg-surface-2 pointer-coarse:h-11"
            value={colorDraft ?? current.color ?? "#000000"}
            onChange={(e) => setColorDraft(e.target.value)}
            onBlur={commitColor}
          />
          <input
            aria-label="Background colour (hex)"
            className={cn(fieldClass, "w-28 font-mono")}
            value={colorDraft ?? current.color ?? ""}
            onChange={(e) => setColorDraft(e.target.value)}
            onBlur={commitColor}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitColor();
              if (e.key === "Escape") setColorDraft(null);
            }}
          />
        </div>
      )}

      {showKinds && current.kind === "image" && (
        <div className="space-y-2">
          {images.length > 0 && (
            <div role="radiogroup" aria-label="Background image" className="grid grid-cols-3 gap-1.5">
              {images.map((a) => {
                const selected = a.id === current.assetId;
                return (
                  <button
                    key={a.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={fileName(a.path)}
                    title={fileName(a.path)}
                    onClick={() => set({ kind: "image", assetId: a.id })}
                    className={cn(
                      "flex h-14 items-center justify-center overflow-hidden rounded-md border bg-black",
                      selected ? "border-accent ring-1 ring-accent" : "border-border hover:border-text-muted",
                    )}
                  >
                    {a.thumbnailPath ? (
                      <img
                        src={thumbnailUrl(a.thumbnailPath)}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <span className="truncate px-1 text-[10px] text-text-muted">{fileName(a.path)}</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
          <Button
            variant="secondary"
            size="sm"
            className="pointer-coarse:h-11"
            onClick={() => void chooseBackgroundImage(clip.id)}
          >
            <ImagePlus /> Choose image…
          </Button>
          <p className="text-xs text-text-muted">
            {image ? `${fileName(image.path)} · scaled` : "The image is scaled"} to cover the canvas behind
            the clip.
          </p>
          {imageMissing && image && (
            <p role="alert" className="flex flex-wrap items-center gap-2 text-xs text-danger">
              The background image file is missing.
              <button type="button" className="underline" onClick={() => void relinkFlow(image.id)}>
                Relink
              </button>
            </p>
          )}
        </div>
      )}

      {blurMode && (
        <div>
          <label htmlFor="inspector-blur" className="mb-1 block text-xs text-text-muted">
            Blur amount
          </label>
          <div className="flex items-center gap-2">
            <input
              id="inspector-blur"
              type="range"
              min={0}
              max={100}
              step={1}
              value={blurShown}
              className="min-w-0 flex-1 accent-[var(--accent)] pointer-coarse:h-11"
              onChange={(e) => setBlurDraft(Number(e.target.value))}
              onPointerUp={commitBlur}
              onKeyUp={commitBlur}
              onBlur={commitBlur}
            />
            <span className="w-8 text-right text-xs text-text-muted tabular-nums">{blurShown}</span>
          </div>
          {showKinds && (
            <p className="mt-1 text-xs text-text-muted">
              The colour or image above only shows through transparent parts of the picture.
            </p>
          )}
        </div>
      )}

      <Button
        variant="secondary"
        size="sm"
        className="pointer-coarse:h-11"
        onClick={() => report(applyBackgroundToAllClips(stored))}
      >
        Apply to all clips
      </Button>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-text-muted">{label}</dt>
      <dd className="break-words tabular-nums">{children}</dd>
    </div>
  );
}

function InfoTab({ clip, asset, fps }: { clip: TimelineClip; asset: MediaAsset; fps: number }) {
  const missing = useProjectStore((s) => s.missingPaths.includes(asset.path));
  return (
    <dl className="grid grid-cols-2 gap-3 text-xs">
      <Row label="Source in">
        <span className="font-mono">{formatTimecode(clip.sourceIn, fps)}</span>
      </Row>
      <Row label="Source out">
        <span className="font-mono">{formatTimecode(clip.sourceOut, fps)}</span>
      </Row>
      {asset.width && asset.height && (
        <Row label="Resolution">
          {asset.width}×{asset.height}
        </Row>
      )}
      {asset.fpsNum && asset.fpsDen && (
        <Row label="Frame rate">{formatFps(asset.fpsNum / asset.fpsDen)} fps</Row>
      )}
      {asset.duration !== undefined && <Row label="File length">{formatDuration(asset.duration)}</Row>}
      {asset.text ? (
        <div className="col-span-2">
          <Row label="Text">
            <span className="whitespace-pre-wrap">{asset.text.content}</span>
          </Row>
        </div>
      ) : (
        <MediaInfo asset={asset} missing={missing} />
      )}
    </dl>
  );
}

/** Tabs for one clip. The chosen tab is remembered per kind of clip. */
function ClipTabs({ clip, asset, fps }: { clip: TimelineClip; asset: MediaAsset; fps: number }) {
  const onAudioTrack = useProjectStore(
    (s) => s.project.tracks.find((t) => t.id === clip.trackId)?.type === "audio",
  );
  // a video's detached sound is an audio clip in every way that matters here
  const kind: ClipKind = onAudioTrack ? "audio" : asset.type;
  // a text picture has no fit, background, sound or speed: its own editor instead
  const tabs = asset.text ? TEXT_TABS : TABS_FOR[kind];
  const remembered = useUiStore((s) => s.inspectorTab[kind]);
  const setTab = useUiStore((s) => s.setInspectorTab);
  const active = remembered && tabs.includes(remembered) ? remembered : tabs[0];
  const uid = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  // a tab always opens at its top, not wherever the previous tab had been scrolled to
  useEffect(() => {
    if (panelRef.current) panelRef.current.scrollTop = 0;
  }, [active, clip.id]);
  // something outside (the AI button, the clip menu) asked for a tab: put the keyboard focus on it
  const focusRequest = useUiStore((s) => s.inspectorFocus);
  const clipsReady = useAutoClipsStore(selectClipsReady);
  useEffect(() => {
    if (!focusRequest || focusRequest.tab !== active) return;
    document.getElementById(`${uid}-tab-${active}`)?.focus();
    if (panelRef.current) panelRef.current.scrollTop = 0;
  }, [focusRequest, active, uid]);

  function onKeyDown(e: React.KeyboardEvent) {
    const i = tabs.indexOf(active);
    const next =
      e.key === "ArrowRight"
        ? tabs[(i + 1) % tabs.length]
        : e.key === "ArrowLeft"
          ? tabs[(i - 1 + tabs.length) % tabs.length]
          : e.key === "Home"
            ? tabs[0]
            : e.key === "End"
              ? tabs[tabs.length - 1]
              : null;
    if (!next) return;
    e.preventDefault();
    e.stopPropagation(); // arrows here change tab, they do not move the playhead
    setTab(kind, next);
    document.getElementById(`${uid}-tab-${next}`)?.focus();
  }

  return (
    <>
      <div
        role="tablist"
        aria-label="Clip properties"
        onKeyDown={onKeyDown}
        className="flex shrink-0 border-b px-1"
      >
        {tabs.map((t) => (
          <button
            key={t}
            id={`${uid}-tab-${t}`}
            role="tab"
            type="button"
            aria-selected={active === t}
            aria-controls={`${uid}-panel`}
            tabIndex={active === t ? 0 : -1}
            onClick={() => setTab(kind, t)}
            className={cn(
              "flex h-11 flex-1 items-center justify-center gap-1 border-b-2 text-xs [&_svg]:size-3.5",
              active === t ? "border-accent text-text" : "border-transparent text-text-muted hover:text-text",
              // the AI tab keeps a touch of the accent so it is easy to find
              t === "ai" && "[&_svg]:text-accent",
            )}
          >
            {t === "ai" && <Sparkles aria-hidden />}
            {TAB_LABEL[t]}
            {t === "ai" && clipsReady && (
              <span className="rounded-sm bg-accent-soft px-1 text-[10px] text-accent">Clips ready</span>
            )}
          </button>
        ))}
      </div>
      <div
        id={`${uid}-panel`}
        ref={panelRef}
        role="tabpanel"
        aria-labelledby={`${uid}-tab-${active}`}
        tabIndex={0}
        className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3"
      >
        {active === "video" && <FitChips clip={clip} />}
        {active === "video" && showsBackground(clip.fitMode ?? DEFAULT_FIT_MODE) && (
          <BackgroundRow
            key={`${clip.id}-bg`}
            clip={clip}
            blurMode={clip.fitMode === "blur-bg"}
            opaque={asset.type === "video"}
          />
        )}
        {active === "video" && <TransformPanel key={`${clip.id}-transform`} clip={clip} />}
        {active === "video" && <CropPanel key={`${clip.id}-crop`} clip={clip} asset={asset} />}
        {active === "video" && <TransitionPanel key={`${clip.id}-transition`} clip={clip} />}
        {active === "video" && asset.type === "image" && !asset.text && (
          <UpscalePanel key={`${clip.id}-upscale`} clip={clip} asset={asset} />
        )}
        {active === "audio" && (
          <VolumeField
            key={`${clip.id}-vol`}
            volume={clip.volume}
            onCommit={(v) => report(changeVolume(clip.id, v))}
          />
        )}
        {active === "audio" && (
          <SoundPanel
            key={`${clip.id}-sound`}
            clip={clip}
            asset={asset}
            detachable={asset.type === "video" && !onAudioTrack}
          />
        )}
        {active === "audio" && <CleanPanel key={`${clip.id}-clean`} clip={clip} asset={asset} />}
        {active === "audio" && <DuckPanel key={`${clip.id}-duck`} clip={clip} />}
        {active === "speed" && (
          <SpeedPanel
            key={`${clip.id}-speed`}
            clipId={clip.id}
            speed={clipSpeed(clip)}
            keepPitch={clip.keepPitch ?? true}
            source={sourceDuration(clip)}
            reversed={clip.reversed ?? false}
            reverseId={reverseKey(asset.path, clip.sourceIn, clip.sourceOut)}
            isVideo={asset.type === "video" && !onAudioTrack}
          />
        )}
        {active === "text" && asset.text && (
          <TextPanel
            key={`${clip.id}-text`}
            clipId={clip.id}
            spec={asset.text}
            fade={Math.max(clip.fadeIn ?? 0, clip.fadeOut ?? 0)}
            styles={
              <StyleGallery
                clipId={clip.id}
                spec={asset.text}
                fade={Math.max(clip.fadeIn ?? 0, clip.fadeOut ?? 0)}
              />
            }
          />
        )}
        {active === "text" && asset.text && (
          <TransformPanel key={`${clip.id}-transform`} clip={clip} position={false} />
        )}
        {active === "color" && <ColorPanel key={`${clip.id}-color`} clip={clip} asset={asset} />}
        {active === "ai" && <AiPanel key={`${clip.id}-ai`} clip={clip} />}
        {active === "info" && <InfoTab clip={clip} asset={asset} fps={fps} />}
      </div>
    </>
  );
}

/** Nothing selected: the project itself. */
function ProjectSummary({ project }: { project: Project }) {
  const openCanvas = useUiStore((s) => s.setCanvasDialogOpen);
  const clips = project.tracks.reduce((n, t) => n + t.clips.length, 0);
  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
      <div>
        <p className="truncate text-sm font-medium">{project.name}</p>
        <p className="text-xs text-text-muted">Nothing selected</p>
      </div>
      <dl className="grid grid-cols-2 gap-3 text-xs" aria-label="Project settings">
        <Row label="Canvas">
          {project.settings.canvasPending
            ? "Original (set by the first video)"
            : canvasLabel(canvasOf(project))}
        </Row>
        <Row label="Background">
          <span className="inline-flex items-center gap-1.5">
            <span
              className="inline-block size-3 rounded-sm border"
              style={{ backgroundColor: project.settings.backgroundColor }}
            />
            {project.settings.backgroundColor.toUpperCase()}
          </span>
        </Row>
        <Row label="Length">{formatDuration(projectDuration(project))}</Row>
        <Row label="Tracks / clips">
          {project.tracks.length} / {clips}
        </Row>
        <Row label="Media files">{project.assets.length}</Row>
      </dl>
      <Button variant="secondary" className="pointer-coarse:h-11" onClick={() => openCanvas(true)}>
        Change canvas…
      </Button>
      <p className="text-xs text-text-muted">Select a clip on the timeline to see its properties.</p>
    </div>
  );
}

/** One value when every clip agrees, otherwise "Mixed". */
export function commonValue<T>(values: T[], format: (v: T) => string): string {
  if (values.length === 0) return "—";
  return values.every((v) => v === values[0]) ? format(values[0]) : "Mixed";
}

function MultiSummary({ items }: { items: { clip: TimelineClip; asset: MediaAsset }[] }) {
  const clips = items.map((i) => i.clip);
  const withSound = items.filter((i) => i.asset.type !== "image").map((i) => i.clip);
  const withPicture = items.filter((i) => i.asset.type !== "audio").map((i) => i.clip);
  const round = (v: number) => Math.round(v * 1000) / 1000;
  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
      <div>
        <p className="text-sm font-medium">{items.length} clips selected</p>
        <p className="text-xs text-text-muted">
          {commonValue(
            items.map((i) => i.asset.type),
            (t) => `All ${t}`,
          )}
        </p>
      </div>
      <dl className="grid grid-cols-2 gap-3 text-xs" aria-label="Shared properties">
        <Row label="Start">
          {commonValue(
            clips.map((c) => round(c.timelineStart)),
            (v) => `${v.toFixed(3)} s`,
          )}
        </Row>
        <Row label="Duration">
          {commonValue(
            clips.map((c) => round(clipDuration(c))),
            (v) => `${v.toFixed(3)} s`,
          )}
        </Row>
        {withSound.length > 0 && (
          <Row label="Volume">
            {commonValue(
              withSound.map((c) => Math.round(c.volume * 100)),
              (v) => `${v} %`,
            )}
          </Row>
        )}
        {withSound.length > 0 && (
          <Row label="Speed">
            {commonValue(
              withSound.map((c) => clipSpeed(c)),
              (v) => `${v}×`,
            )}
          </Row>
        )}
        {withPicture.length > 0 && (
          <Row label="Fit to canvas">
            {commonValue(
              withPicture.map((c) => c.fitMode ?? DEFAULT_FIT_MODE),
              (m) => FIT_CHIPS.find((f) => f.id === m)!.label,
            )}
          </Row>
        )}
      </dl>
      <p className="text-xs text-text-muted">
        Select a single clip to edit its properties. Press Delete to remove the selection.
      </p>
    </div>
  );
}

export function Inspector() {
  const active = useUiStore((s) => s.sidePanel === "inspector");
  const project = useProjectStore((s) => s.project);
  const missingPaths = useProjectStore((s) => s.missingPaths);
  const selectedIds = useSelectionStore((s) => s.selectedClipIds);
  const fps = project.settings.fps;
  const panelClass = cn(active ? "flex" : "hidden", "min-h-0 border-l lg:col-start-3 lg:row-start-1 lg:flex");

  const items = selectedIds.flatMap((id) => {
    const found = findClip(project, id);
    const asset = found && project.assets.find((a) => a.id === found.clip.assetId);
    return found && asset ? [{ clip: found.clip, track: found.track as TimelineTrack, asset }] : [];
  });

  if (items.length === 0) {
    return (
      <Panel title="Inspector" className={panelClass}>
        <ProjectSummary project={project} />
      </Panel>
    );
  }
  if (items.length > 1) {
    return (
      <Panel title="Inspector" className={panelClass}>
        <MultiSummary items={items} />
      </Panel>
    );
  }

  const { clip, track, asset } = items[0];
  const missing = missingPaths.includes(asset.path);
  return (
    <Panel title="Inspector" className={panelClass}>
      {/* always visible: what is selected and where it sits */}
      <div className="shrink-0 space-y-2 border-b p-3" data-testid="inspector-header">
        <div>
          <p className="truncate text-sm font-medium" title={asset.path}>
            {assetName(asset)}
          </p>
          <p className="text-xs text-text-muted">
            {asset.type[0].toUpperCase() + asset.type.slice(1)} · {track.name}
          </p>
          {missing && (
            <p className="mt-2 flex items-start gap-1 text-xs text-danger">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              The file is missing. Relink it from the Media panel.
            </p>
          )}
        </div>
        {/* keyed by clip so a different selection never inherits half-typed text */}
        <div key={clip.id} className="grid grid-cols-2 gap-3">
          <SecondsField
            label="Start (s)"
            value={clip.timelineStart}
            onCommit={(v) => report(moveClipTo(clip.id, v))}
          />
          <SecondsField
            label="Duration (s)"
            value={clipDuration(clip)}
            onCommit={(v) => report(trimClipEdge(clip.id, "end", clip.timelineStart + v))}
          />
        </div>
      </div>
      <ClipTabs clip={clip} asset={asset} fps={fps} />
    </Panel>
  );
}
