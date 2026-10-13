import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Eye,
  EyeOff,
  Magnet,
  Maximize2,
  MicVocal,
  Film,
  Scissors,
  Sparkles,
  Trash2,
  Type,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { ClipView } from "@/components/timeline/ClipView";
import { TransitionBlock } from "@/components/timeline/TransitionBlock";
import { ContextMenu, type MenuState } from "@/components/timeline/ContextMenu";
import { Ruler } from "@/components/timeline/Ruler";
import { IconButton } from "@/components/IconButton";
import { Panel } from "@/components/Panel";
import { assetName } from "@/lib/media";
import { cn } from "@/lib/utils";
import { useDragDropStore } from "@/store/dragDrop";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useTimelineViewStore } from "@/store/timelineView";
import { clipDuration, projectDuration } from "@/timeline/clips";
import { selectClipsReady, useAutoClipsStore } from "@/store/autoClips";
import { aiKindOf, openAiTools, openAutoClips, openKaraoke } from "@/timeline/ai";
import { copySelected, cutSelected } from "@/timeline/clipboard";
import { freezeFrameAtPlayhead } from "@/timeline/freeze";
import { deleteSelected, report, splitAtPlayhead, toggleTrackFlag } from "@/timeline/editor";
import { transitionOf, transitionOutOf } from "@/timeline/transitions";
import {
  contentWidth,
  HEADER_WIDTH,
  ROW_HEIGHT,
  RULER_HEIGHT,
  timeToX,
  visibleClips,
  xToTime,
} from "@/timeline/geometry";
import { addTextAtPlayhead } from "@/timeline/text";
import { waveWindow } from "@/timeline/waveform";
import { canZoomIn, canZoomOut, zoomPercent } from "@/timeline/zoom";
import { zoomStep, zoomToFit } from "@/timeline/zoomController";
import { useTimelineDrag } from "@/timeline/useTimelineDrag";

const FALLBACK_VIEWPORT = 1000;
const BUFFER_PX = 200;

function Playhead({ pps }: { pps: number }) {
  const playhead = usePlaybackStore((s) => s.playhead);
  return (
    <div
      aria-hidden
      data-testid="playhead"
      className="pointer-events-none absolute top-0 bottom-0 z-20 w-px bg-accent"
      style={{ left: timeToX(playhead, pps) }}
    >
      <div className="-ml-[5px] h-[10px] w-[11px] rounded-b-sm bg-accent" />
    </div>
  );
}

export function Timeline() {
  const project = useProjectStore((s) => s.project);
  const clipsReady = useAutoClipsStore(selectClipsReady);
  const selectedIds = useSelectionStore((s) => s.selectedClipIds);
  const pps = useTimelineViewStore((s) => s.pps);
  const snapping = useTimelineViewStore((s) => s.snapping);
  const toggleSnapping = useTimelineViewStore((s) => s.toggleSnapping);
  const scrollTarget = useTimelineViewStore((s) => s.scrollTarget);
  const dropPreview = useDragDropStore((s) => s.preview);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ left: 0, width: 0 });
  const [menu, setMenu] = useState<MenuState | null>(null);
  const { drag, begin } = useTimelineDrag(lanesRef);

  // Track scroll position and size so only visible ticks/clips are rendered.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const measure = () => setViewport({ left: el.scrollLeft, width: el.clientWidth });
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      ro?.disconnect();
    };
  }, []);

  // After a zoom, put the scroll where the zoom math says so the anchor (playhead or cursor) stays put.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el || !scrollTarget) return;
    el.scrollLeft = scrollTarget.left;
    setViewport({ left: el.scrollLeft, width: el.clientWidth });
  }, [scrollTarget]);

  const view = drag?.preview ?? project;
  const assets = useMemo(() => new Map(project.assets.map((a) => [a.id, a])), [project.assets]);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const missingPaths = useProjectStore((s) => s.missingPaths);
  const missing = useMemo(() => new Set(missingPaths), [missingPaths]);
  const vw = viewport.width || FALLBACK_VIEWPORT;
  const from = xToTime(viewport.left - BUFFER_PX, pps);
  const to = xToTime(viewport.left + vw + BUFFER_PX, pps);
  const width = contentWidth(projectDuration(view), vw, pps);

  const onBodyPointerDown = useCallback(
    (e: React.PointerEvent, clip: { id: string }) => {
      const additive = e.shiftKey || e.metaKey || e.ctrlKey;
      const sel = useSelectionStore.getState();
      if (additive) sel.select(clip.id, true);
      else if (!sel.selectedClipIds.includes(clip.id)) sel.select(clip.id);
      if (!additive) begin(e, clip.id, "move");
    },
    [begin],
  );
  const onTrimPointerDown = useCallback(
    (e: React.PointerEvent, clip: { id: string }, edge: "start" | "end") => {
      useSelectionStore.getState().select(clip.id);
      begin(e, clip.id, { trim: edge });
    },
    [begin],
  );
  const onContextMenu = useCallback((e: React.MouseEvent, clip: { id: string }) => {
    e.preventDefault();
    const sel = useSelectionStore.getState();
    if (!sel.selectedClipIds.includes(clip.id)) sel.select(clip.id);
    setMenu({ x: e.clientX, y: e.clientY, clipId: clip.id });
  }, []);
  const onActivate = useCallback((clip: { id: string }, additive: boolean) => {
    useSelectionStore.getState().select(clip.id, additive);
  }, []);
  const closeMenu = useCallback(() => setMenu(null), []);

  // while a drop would create a track, draw the row it will occupy
  const newTrackRow = dropPreview && dropPreview.trackId === null;
  const height = RULER_HEIGHT + (project.tracks.length + (newTrackRow ? 1 : 0)) * ROW_HEIGHT;
  const ghost = dropPreview && (
    <div
      data-testid="drop-ghost"
      className="pointer-events-none absolute top-1 bottom-1 z-10 flex items-center overflow-hidden rounded-md border-2 border-dashed border-accent bg-accent-soft px-2 text-xs text-text"
      style={{
        left: timeToX(dropPreview.start, pps),
        width: Math.max(24, timeToX(dropPreview.duration, pps)),
      }}
    >
      <span className="truncate">{dropPreview.hint ?? dropPreview.label}</span>
    </div>
  );

  return (
    <Panel
      title="Timeline"
      className="min-h-0 border-t lg:col-span-3 lg:row-start-2"
      actions={
        <div className="flex items-center">
          <button
            type="button"
            aria-label="AI tools"
            title="AI tools for the selected clip (auto subtitles)"
            onClick={() => openAiTools()}
            className="mr-1 flex h-8 items-center gap-1.5 rounded-md border border-accent/50 bg-accent-soft px-2.5 text-xs font-medium text-text hover:border-accent focus-visible:outline-accent pointer-coarse:h-11 [&_svg]:size-3.5 [&_svg]:text-accent"
          >
            <Sparkles />
            AI
          </button>
          <button
            type="button"
            aria-label="Auto clips"
            title="Auto clips: find short clips in a long video"
            onClick={() => openAutoClips()}
            className="relative mr-1 flex h-8 items-center gap-1.5 rounded-md bg-accent px-2.5 text-xs font-medium text-black hover:bg-accent-hover focus-visible:outline-accent pointer-coarse:h-11 [&_svg]:size-3.5"
          >
            <Film />
            Auto clips
            {clipsReady && (
              <span
                aria-hidden
                className="absolute -top-1 -right-1 size-2.5 rounded-full border border-black bg-success"
              />
            )}
          </button>
          <button
            type="button"
            aria-label="Karaoke Maker"
            title="Karaoke Maker: put a song's lyrics on screen, line by line"
            onClick={() => openKaraoke()}
            className="mr-1 flex h-8 items-center gap-1.5 rounded-md border border-accent/60 bg-accent-soft px-2.5 text-xs font-medium text-text hover:border-accent focus-visible:outline-accent pointer-coarse:h-11 [&_svg]:size-3.5 [&_svg]:text-accent"
          >
            <MicVocal />
            Karaoke
          </button>
          <IconButton label="Add text at playhead" icon={<Type />} onClick={() => void addTextAtPlayhead()} />
          <IconButton
            label="Split at playhead (S)"
            icon={<Scissors />}
            onClick={() => report(splitAtPlayhead())}
          />
          <IconButton
            label="Delete selected (Del)"
            icon={<Trash2 />}
            disabled={selectedIds.length === 0}
            onClick={() => deleteSelected()}
          />
          <IconButton
            label={snapping ? "Snapping on" : "Snapping off"}
            icon={<Magnet />}
            aria-pressed={snapping}
            className={cn(snapping && "text-accent")}
            onClick={toggleSnapping}
          />
          <IconButton
            label="Zoom out"
            shortcut="Ctrl/⌘ −"
            icon={<ZoomOut />}
            disabled={!canZoomOut(pps)}
            onClick={() => zoomStep(-1)}
          />
          <span
            className="w-12 text-center text-xs text-text-muted tabular-nums"
            aria-label="Zoom level"
            aria-live="off"
          >
            {zoomPercent(pps)}%
          </span>
          <IconButton
            label="Zoom in"
            shortcut="Ctrl/⌘ +"
            icon={<ZoomIn />}
            disabled={!canZoomIn(pps)}
            onClick={() => zoomStep(1)}
          />
          <IconButton label="Fit project" shortcut="Ctrl/⌘ 0" icon={<Maximize2 />} onClick={zoomToFit} />
        </div>
      }
    >
      {/* more tracks than fit: the headers and the lanes scroll up and down together */}
      <div className="flex min-h-0 flex-1 items-start overflow-y-auto select-none" data-timeline-area>
        {/* track headers */}
        <div className="min-h-full shrink-0 border-r bg-surface-1" style={{ width: HEADER_WIDTH }}>
          <div style={{ height: RULER_HEIGHT }} className="border-b" />
          {project.tracks.map((t) => (
            <div
              key={t.id}
              style={{ height: ROW_HEIGHT }}
              className="flex flex-col justify-center gap-0.5 border-b px-1.5"
            >
              <span className="truncate px-0.5 text-xs text-text-muted">{t.name}</span>
              <div className="flex">
                <IconButton
                  label={t.muted ? `Unmute ${t.name}` : `Mute ${t.name}`}
                  icon={t.muted ? <VolumeX /> : <Volume2 />}
                  size="icon-sm"
                  aria-pressed={t.muted}
                  className={cn("pointer-coarse:size-11", t.muted && "text-danger")}
                  onClick={() => toggleTrackFlag(t.id, "muted")}
                />
                {t.type === "video" && (
                  <IconButton
                    label={t.hidden ? `Show ${t.name}` : `Hide ${t.name}`}
                    icon={t.hidden ? <EyeOff /> : <Eye />}
                    size="icon-sm"
                    aria-pressed={t.hidden}
                    className={cn("pointer-coarse:size-11", t.hidden && "text-danger")}
                    onClick={() => toggleTrackFlag(t.id, "hidden")}
                  />
                )}
              </div>
            </div>
          ))}
        </div>

        <div
          ref={scrollerRef}
          data-timeline-scroller
          className="relative min-h-full min-w-0 flex-1 overflow-x-auto overflow-y-hidden"
        >
          <div className="relative" style={{ width, height: Math.max(height, 0) }}>
            <Ruler pps={pps} from={from} to={to} />

            <div
              ref={lanesRef}
              data-timeline-lanes
              className="absolute inset-x-0"
              style={{ top: RULER_HEIGHT }}
            >
              {view.tracks.map((track) => (
                <div
                  key={track.id}
                  role="group"
                  aria-label={`${track.name} lane`}
                  data-track-id={track.id}
                  className={cn(
                    "relative border-b bg-surface-2/40",
                    dropPreview?.trackId === track.id &&
                      "bg-accent-soft outline outline-1 -outline-offset-1 outline-accent",
                  )}
                  data-drop-active={dropPreview?.trackId === track.id || undefined}
                  style={{ height: ROW_HEIGHT }}
                  onPointerDown={(e) => {
                    if (e.target === e.currentTarget) useSelectionStore.getState().clear();
                  }}
                >
                  {visibleClips(track.clips, from, to).map((clip) => {
                    const asset = assets.get(clip.assetId);
                    const hasWave = asset && asset.type !== "image" && !missing.has(asset.path);
                    const wave = hasWave
                      ? waveWindow(
                          timeToX(clip.timelineStart, pps),
                          timeToX(clipDuration(clip), pps),
                          viewport.left - BUFFER_PX,
                          viewport.left + vw + BUFFER_PX,
                        )
                      : null;
                    const coming = transitionOf(clip);
                    const going = transitionOutOf(clip);
                    return (
                      <Fragment key={clip.id}>
                        <ClipView
                          clip={clip}
                          name={asset ? assetName(asset) : "Missing media"}
                          // a video's detached sound looks like the audio it is
                          type={track.type === "audio" ? "audio" : (asset?.type ?? "video")}
                          pps={pps}
                          selected={selected.has(clip.id)}
                          missing={asset ? missing.has(asset.path) : true}
                          wavePath={wave ? asset?.path : undefined}
                          waveFrom={wave?.from}
                          waveTo={wave?.to}
                          muted={track.muted || (clip.muted ?? false)}
                          onBodyPointerDown={onBodyPointerDown}
                          onTrimPointerDown={onTrimPointerDown}
                          onContextMenu={onContextMenu}
                          onActivate={onActivate}
                        />
                        {/* a transition is a block of its own over its end of the clip, not part of the clip */}
                        {coming && clip.transitionIn && (
                          <TransitionBlock clip={clip} way="in" seconds={coming.seconds} pps={pps} />
                        )}
                        {going && clip.transitionOut && (
                          <TransitionBlock clip={clip} way="out" seconds={going.seconds} pps={pps} />
                        )}
                      </Fragment>
                    );
                  })}
                  {dropPreview?.trackId === track.id && ghost}
                  {/* ghost for a rejected move, so the user sees where it would have landed */}
                  {drag?.kind === "move" && !drag.valid && drag.trackId === track.id && (
                    <div
                      data-testid="drag-ghost"
                      className="pointer-events-none absolute top-1 bottom-1 rounded-md border-2 border-dashed border-danger bg-danger/10"
                      style={{ left: timeToX(drag.start, pps), width: timeToX(drag.duration, pps) }}
                    />
                  )}
                </div>
              ))}
              {newTrackRow && (
                <div
                  data-testid="new-track-row"
                  className="relative border-b border-dashed border-accent bg-accent-soft"
                  style={{ height: ROW_HEIGHT }}
                >
                  <span className="pointer-events-none absolute top-1 right-2 text-[10px] text-text-muted">
                    New {dropPreview.trackType} track
                  </span>
                  {ghost}
                </div>
              )}
            </div>

            {project.tracks.every((t) => t.clips.length === 0) && (
              <p
                className="pointer-events-none absolute right-0 left-0 z-0 px-4 text-center text-xs text-text-muted"
                style={{ top: RULER_HEIGHT + ROW_HEIGHT * project.tracks.length + 12 }}
              >
                Drag media from the library onto a track, or use the “Add to timeline” button on a file.
              </p>
            )}
            {drag?.guide != null && (
              <div
                aria-hidden
                data-testid="snap-guide"
                className="pointer-events-none absolute top-0 bottom-0 z-10 w-px bg-accent-hover"
                style={{ left: timeToX(drag.guide, pps) }}
              />
            )}
            <Playhead pps={pps} />
          </div>
        </div>
      </div>

      {menu && (
        <ContextMenu
          menu={menu}
          onClose={closeMenu}
          onSplit={() => {
            closeMenu();
            report(splitAtPlayhead());
          }}
          onFreeze={() => {
            closeMenu();
            void freezeFrameAtPlayhead();
          }}
          onCut={() => {
            closeMenu();
            cutSelected();
          }}
          onCopy={() => {
            closeMenu();
            copySelected();
          }}
          onDelete={() => {
            closeMenu();
            deleteSelected();
          }}
          onAi={
            aiKindOf(project, menu.clipId)
              ? () => {
                  closeMenu();
                  openAiTools(menu.clipId);
                }
              : undefined
          }
          onClips={
            aiKindOf(project, menu.clipId)
              ? () => {
                  closeMenu();
                  openAutoClips(menu.clipId);
                }
              : undefined
          }
        />
      )}
    </Panel>
  );
}
