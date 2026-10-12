import { useEffect, useRef, useState } from "react";
import { Captions, Scissors, Sparkles } from "lucide-react";
import { selectClipsReady, useAutoClipsStore } from "@/store/autoClips";
import { openAiTools, openAutoClips } from "@/timeline/ai";

/** Top bar "AI" menu: the same tools as the inspector's AI tab, reachable from anywhere. */
export function AiMenu() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const ready = useAutoClipsStore(selectClipsReady);
  const running = useAutoClipsStore((s) => s.status === "running");
  const reviewing = useAutoClipsStore((s) => s.clips.length > 0);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const item =
    "flex h-9 w-full items-center gap-2 rounded-sm px-2 text-left text-sm hover:bg-accent-soft pointer-coarse:h-11";
  const run = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label={ready ? "AI menu, clips ready" : "AI menu"}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="relative flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-text-muted hover:text-text focus-visible:outline-accent pointer-coarse:h-11 [&_svg]:size-4 [&_svg]:text-accent"
      >
        <Sparkles />
        AI
        {ready && <span aria-hidden className="absolute top-1 right-0.5 size-2 rounded-full bg-accent" />}
      </button>
      {open && (
        <div
          role="menu"
          aria-label="AI"
          className="absolute top-full left-0 z-50 mt-1 min-w-56 rounded-md border bg-popover p-1 shadow-lg"
        >
          <button role="menuitem" className={item} onClick={run(() => openAiTools())}>
            <Captions className="size-4" /> Subtitles from speech…
          </button>
          <button role="menuitem" className={item} onClick={run(() => openAutoClips())}>
            <Scissors className="size-4" />
            {running ? "Finding clips…" : reviewing ? "Review found clips…" : "Find short clips…"}
            {ready && <span className="ml-auto pl-3 text-xs text-accent">Clips ready</span>}
          </button>
        </div>
      )}
    </div>
  );
}
