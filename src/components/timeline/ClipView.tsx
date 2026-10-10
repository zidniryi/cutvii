import { memo } from "react";
import { Film, Image as ImageIcon, Music } from "lucide-react";
import type { MediaType, TimelineClip } from "@/project/model";
import { clipDuration } from "@/timeline/clips";
import { timeToX } from "@/timeline/geometry";
import { cn } from "@/lib/utils";

const COLOR: Record<MediaType, string> = {
  video: "bg-clip-video",
  audio: "bg-clip-audio",
  image: "bg-clip-image",
};
const ICON = { video: Film, audio: Music, image: ImageIcon } as const;

interface Props {
  clip: TimelineClip;
  name: string;
  type: MediaType;
  pps: number;
  selected: boolean;
  /** Source file not found: drawn dashed/dim so it is obvious before playback fails. */
  missing?: boolean;
  onBodyPointerDown: (e: React.PointerEvent, clip: TimelineClip) => void;
  onTrimPointerDown: (e: React.PointerEvent, clip: TimelineClip, edge: "start" | "end") => void;
  onContextMenu: (e: React.MouseEvent, clip: TimelineClip) => void;
  onActivate: (clip: TimelineClip, additive: boolean) => void;
}

/** One clip on a lane. Edge handles are wider on touch screens; the body is the move handle. */
export const ClipView = memo(function ClipView({
  clip,
  name,
  type,
  pps,
  selected,
  missing = false,
  onBodyPointerDown,
  onTrimPointerDown,
  onContextMenu,
  onActivate,
}: Props) {
  const Icon = ICON[type];
  const width = Math.max(2, timeToX(clipDuration(clip), pps));
  const handle =
    "absolute top-0 bottom-0 z-10 w-2 cursor-ew-resize touch-none pointer-coarse:w-4 hover:bg-white/25";
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`${name} clip`}
      title={missing ? `${name} — file not found` : name}
      aria-pressed={selected}
      data-clip-id={clip.id}
      onPointerDown={(e) => onBodyPointerDown(e, clip)}
      onContextMenu={(e) => onContextMenu(e, clip)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onActivate(clip, e.shiftKey);
      }}
      className={cn(
        "absolute top-1 bottom-1 flex cursor-grab touch-none items-center gap-1 overflow-hidden rounded-md px-2 text-xs text-text select-none",
        COLOR[type],
        selected
          ? "ring-2 ring-accent"
          : missing
            ? "ring-2 ring-danger/70 ring-offset-0"
            : "ring-1 ring-black/40",
        missing && "opacity-60",
      )}
      style={{ left: timeToX(clip.timelineStart, pps), width }}
    >
      <div
        data-testid="trim-start"
        className={cn(handle, "left-0")}
        onPointerDown={(e) => {
          e.stopPropagation();
          onTrimPointerDown(e, clip, "start");
        }}
      />
      <Icon className="size-3.5 shrink-0 opacity-80" />
      <span className="truncate">{name}</span>
      <div
        data-testid="trim-end"
        className={cn(handle, "right-0")}
        onPointerDown={(e) => {
          e.stopPropagation();
          onTrimPointerDown(e, clip, "end");
        }}
      />
    </div>
  );
});
