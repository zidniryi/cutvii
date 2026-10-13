import { useEffect } from "react";
import { Captions, ClipboardCopy, Copy, Film, Scissors, Snowflake, Sparkles, Trash2 } from "lucide-react";

export interface MenuState {
  x: number;
  y: number;
  clipId: string;
}

interface Props {
  menu: MenuState;
  onSplit: () => void;
  onDelete: () => void;
  onCut: () => void;
  onCopy: () => void;
  onFreeze: () => void;
  /** Present when the clip can use the AI tools (it has sound). */
  onAi?: () => void;
  /** Present with `onAi`: open Auto clips for this clip (it explains itself when the clip is too short). */
  onClips?: () => void;
  /** Present for a text clip: save the texts of its track as a `.srt` file. */
  onSrt?: () => void;
  onClose: () => void;
}

export function ContextMenu({
  menu,
  onSplit,
  onDelete,
  onCut,
  onCopy,
  onFreeze,
  onAi,
  onClips,
  onSrt,
  onClose,
}: Props) {
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!(e.target as HTMLElement | null)?.closest("[data-context-menu]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const item =
    "flex h-9 w-full items-center gap-2 rounded-sm px-2 text-left text-sm hover:bg-accent-soft pointer-coarse:h-11";
  return (
    <div
      role="menu"
      data-context-menu
      aria-label="Clip actions"
      className="fixed z-50 min-w-44 rounded-md border bg-popover p-1 shadow-lg"
      style={{ left: menu.x, top: menu.y }}
    >
      <button role="menuitem" className={item} onClick={onSplit}>
        <Scissors className="size-4" /> Split at playhead
        <kbd className="ml-auto text-xs text-text-muted">S</kbd>
      </button>
      <button role="menuitem" className={item} onClick={onFreeze}>
        <Snowflake className="size-4" /> Freeze frame
        <kbd className="ml-auto text-xs text-text-muted">Shift F</kbd>
      </button>
      <button role="menuitem" className={item} onClick={onCut}>
        <ClipboardCopy className="size-4" /> Cut
        <kbd className="ml-auto text-xs text-text-muted">Ctrl/⌘ X</kbd>
      </button>
      <button role="menuitem" className={item} onClick={onCopy}>
        <Copy className="size-4" /> Copy
        <kbd className="ml-auto text-xs text-text-muted">Ctrl/⌘ C</kbd>
      </button>
      {onAi && (
        <button role="menuitem" className={item} onClick={onAi}>
          <Sparkles className="size-4 text-accent" /> Subtitles with AI…
        </button>
      )}
      {onClips && (
        <button role="menuitem" className={item} onClick={onClips}>
          <Film className="size-4 text-accent" /> Find short clips…
        </button>
      )}
      {onSrt && (
        <button role="menuitem" className={item} onClick={onSrt}>
          <Captions className="size-4" /> Export subtitles (.srt)…
        </button>
      )}
      <button role="menuitem" className={item} onClick={onDelete}>
        <Trash2 className="size-4" /> Delete
        <kbd className="ml-auto text-xs text-text-muted">Del</kbd>
      </button>
    </div>
  );
}
