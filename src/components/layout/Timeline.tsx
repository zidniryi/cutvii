import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Eye, EyeOff, Magnet, Scissors, Trash2, Volume2, VolumeX, ZoomIn, ZoomOut } from "lucide-react";
import { ClipView } from "@/components/timeline/ClipView";
import { ContextMenu, type MenuState } from "@/components/timeline/ContextMenu";
import { Ruler } from "@/components/timeline/Ruler";
import { IconButton } from "@/components/IconButton";
import { Panel } from "@/components/Panel";
import { fileName } from "@/lib/media";
import { cn } from "@/lib/utils";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useTimelineViewStore } from "@/store/timelineView";
import { useUiStore } from "@/store/ui";
import { projectDuration } from "@/timeline/clips";
import {
  addAssetToTimeline,
  deleteSelected,
  report,
  splitAtPlayhead,
  toggleTrackFlag,
} from "@/timeline/editor";
import {
  contentWidth,
  HEADER_WIDTH,
  ROW_HEIGHT,
  RULER_HEIGHT,
  SNAP_PX,
  timeToX,
  visibleClips,
  xToTime,
} from "@/timeline/geometry";
import { ASSET_DRAG_TYPE } from "@/timeline/dnd";
import { snapTime } from "@/timeline/snap";
import { useTimelineDrag } from "@/timeline/useTimelineDrag";

const FALLBACK_VIEWPORT = 1000;
const BUFFER_PX = 200;
const NOTICE_MS = 4000;

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
  const selectedIds = useSelectionStore((s) => s.selectedClipIds);
  const { pps, snapping, zoomIn, zoomOut, toggleSnapping } = useTimelineViewStore();
  const notice = useUiStore((s) => s.notice);

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

  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => useUiStore.getState().setNotice(null), NOTICE_MS);
    return () => clearTimeout(id);
  }, [notice]);

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

  function onLaneDrop(e: React.DragEvent<HTMLDivElement>, trackId: string) {
    const assetId = e.dataTransfer.getData(ASSET_DRAG_TYPE);
    if (!assetId) return;
    e.preventDefault();
    const raw = xToTime(e.clientX - e.currentTarget.getBoundingClientRect().left, pps);
    const { playhead } = usePlaybackStore.getState();
    const start = snapTime(project, raw, { playhead, threshold: snapping ? SNAP_PX / pps : 0 }).time;
    report(addAssetToTimeline(assetId, { trackId, start }));
  }

  const height = RULER_HEIGHT + project.tracks.length * ROW_HEIGHT;

  return (
    <Panel
      title="Timeline"
      className="min-h-0 border-t lg:col-span-3 lg:row-start-2"
      actions={
        <div className="flex items-center">
          {notice && (
            <span role="status" aria-live="polite" className="mr-2 max-w-[40ch] truncate text-xs text-danger">
              {notice}
            </span>
          )}
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
          <IconButton label="Zoom out" icon={<ZoomOut />} onClick={zoomOut} />
          <IconButton label="Zoom in" icon={<ZoomIn />} onClick={zoomIn} />
        </div>
      }
    >
      <div className="flex min-h-0 flex-1 select-none" data-timeline-area>
        {/* track headers */}
        <div className="shrink-0 border-r bg-surface-1" style={{ width: HEADER_WIDTH }}>
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

        <div ref={scrollerRef} className="relative min-w-0 flex-1 overflow-x-auto overflow-y-hidden">
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
                  className="relative border-b bg-surface-2/40"
                  style={{ height: ROW_HEIGHT }}
                  onPointerDown={(e) => {
                    if (e.target === e.currentTarget) useSelectionStore.getState().clear();
                  }}
                  onDragOver={(e) => {
                    if (e.dataTransfer.types.includes(ASSET_DRAG_TYPE)) e.preventDefault();
                  }}
                  onDrop={(e) => onLaneDrop(e, track.id)}
                >
                  {visibleClips(track.clips, from, to).map((clip) => {
                    const asset = assets.get(clip.assetId);
                    return (
                      <ClipView
                        key={clip.id}
                        clip={clip}
                        name={asset ? fileName(asset.path) : "Missing media"}
                        type={asset?.type ?? "video"}
                        pps={pps}
                        selected={selected.has(clip.id)}
                        missing={asset ? missing.has(asset.path) : true}
                        onBodyPointerDown={onBodyPointerDown}
                        onTrimPointerDown={onTrimPointerDown}
                        onContextMenu={onContextMenu}
                        onActivate={onActivate}
                      />
                    );
                  })}
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
          onDelete={() => {
            closeMenu();
            deleteSelected();
          }}
        />
      )}
    </Panel>
  );
}
