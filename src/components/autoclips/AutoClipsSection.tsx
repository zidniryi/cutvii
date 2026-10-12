import { useEffect } from "react";
import { Scissors } from "lucide-react";
import type { TimelineClip } from "@/project/model";
import { selectClipsReady, useAutoClipsStore } from "@/store/autoClips";
import { useMediaDetailsStore } from "@/store/mediaDetails";
import { useProjectStore } from "@/store/project";
import { openAutoClips } from "@/timeline/ai";
import { autoClipsBlocker } from "@/timeline/autoClips";

/** The "Auto clips" block of the inspector's AI tab: one button, or the reason it is switched off. */
export function AutoClipsSection({ clip }: { clip: TimelineClip }) {
  const path = useProjectStore((s) => s.project.assets.find((a) => a.id === clip.assetId)?.path);
  useEffect(() => {
    if (path) useMediaDetailsStore.getState().ensure(path);
  }, [path]);
  const details = useMediaDetailsStore((s) => {
    const entry = path ? s.entries[path] : undefined;
    return entry?.status === "ready" ? entry.details : undefined;
  });
  const blocker = useProjectStore((s) => autoClipsBlocker(s.project, clip.id, details));
  const mine = useAutoClipsStore((s) => s.clipId === clip.id);
  const running = useAutoClipsStore((s) => s.status === "running");
  const found = useAutoClipsStore((s) => s.clips.length);
  const ready = useAutoClipsStore(selectClipsReady);

  return (
    <div role="group" aria-label="Auto clips" className="space-y-2 border-t pt-3">
      <p className="flex items-center gap-2 text-sm font-medium text-text [&_svg]:size-4 [&_svg]:text-accent">
        <Scissors />
        Auto clips
      </p>
      <p className="text-text-muted">
        Finds short, self-contained parts of a long talking video and lets you review them. It runs on this
        computer and never changes your video.
      </p>
      <button
        type="button"
        disabled={blocker !== null}
        onClick={() => openAutoClips(clip.id)}
        className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-accent px-2 text-sm font-medium text-black hover:bg-accent-hover disabled:opacity-40 pointer-coarse:h-11 [&_svg]:size-4"
      >
        <Scissors />
        {running && mine
          ? "Finding clips…"
          : mine && found > 0
            ? `Review ${found} clip${found === 1 ? "" : "s"}`
            : "Find clips"}
      </button>
      {blocker && <p className="text-text-muted">{blocker}</p>}
      {ready && mine && (
        <p role="status" className="text-accent">
          Clips ready
        </p>
      )}
    </div>
  );
}
