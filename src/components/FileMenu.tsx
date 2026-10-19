import { useEffect, useRef, useState } from "react";
import {
  Captions,
  FilePlus2,
  FlaskConical,
  FolderOpen,
  Gift,
  Package,
  RefreshCw,
  Save,
  SaveAll,
  Settings,
} from "lucide-react";
import { manualCheck, showSampleUpdate } from "@/updates/updates";
import { useUiStore } from "@/store/ui";
import { useStylePackStore } from "@/store/stylePacks";
import { IconButton } from "@/components/IconButton";
import { cn } from "@/lib/utils";
import { newProjectFlow, openProjectFlow, saveFlow } from "@/project/fileActions";
import { useSelectionStore } from "@/store/selection";
import { exportSrt } from "@/timeline/srt";
import { importSrtFromMenu } from "@/timeline/srtImport";

const ITEMS = [
  { id: "new", label: "New project", Icon: FilePlus2, keys: "", run: () => newProjectFlow() },
  { id: "open", label: "Open…", Icon: FolderOpen, keys: "Ctrl/⌘ O", run: () => openProjectFlow() },
  { id: "save", label: "Save", Icon: Save, keys: "Ctrl/⌘ S", run: () => saveFlow(false) },
  { id: "saveAs", label: "Save as…", Icon: SaveAll, keys: "Ctrl/⌘ Shift S", run: () => saveFlow(true) },
  {
    id: "srtImport",
    label: "Import subtitles (.srt)…",
    Icon: Captions,
    keys: "",
    run: () => importSrtFromMenu(),
  },
  {
    id: "srt",
    label: "Export subtitles (.srt)…",
    Icon: Captions,
    keys: "",
    // the track of a selected text clip, otherwise every text on the timeline
    run: () => exportSrt(useSelectionStore.getState().selectedClipIds[0]),
  },
  {
    id: "packs",
    label: "Style packs…",
    Icon: Package,
    keys: "",
    run: () => useStylePackStore.getState().openDialog(),
  },
  {
    id: "updates",
    label: "Check for updates",
    Icon: RefreshCw,
    keys: "",
    run: () => manualCheck(),
  },
  {
    // development builds only (filtered out below): look at the update popup with made-up data
    id: "sample-update",
    label: "Sample update popup (dev)",
    Icon: FlaskConical,
    keys: "",
    run: () => showSampleUpdate(),
  },
  {
    id: "settings",
    label: "Settings…",
    Icon: Settings,
    keys: "Ctrl/⌘ ,",
    run: () => useUiStore.getState().setSettingsOpen(true),
  },
  {
    // narrow screens only: on wider ones this is the gift button in the top bar
    id: "support",
    label: "Support CutVii",
    Icon: Gift,
    keys: "",
    run: () => useUiStore.getState().setSupportOpen(true),
  },
] as const;

export function FileMenu() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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

  return (
    <div ref={rootRef} className="relative">
      <IconButton
        label="File menu"
        icon={<FolderOpen />}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      />
      {open && (
        <div
          role="menu"
          aria-label="File"
          className="absolute top-full left-0 z-50 mt-1 min-w-52 rounded-md border bg-popover p-1 shadow-lg"
        >
          {ITEMS.filter((item) => item.id !== "sample-update" || import.meta.env.DEV).map(
            ({ id, label, Icon, keys, run }) => (
              <button
                key={id}
                role="menuitem"
                aria-label={label}
                className={cn(
                  "flex h-9 w-full items-center gap-2 rounded-sm px-2 text-left text-sm hover:bg-accent-soft pointer-coarse:h-11",
                  id === "support" && "sm:hidden",
                )}
                onClick={() => {
                  setOpen(false);
                  void run();
                }}
              >
                <Icon className="size-4" /> {label}
                {keys && <kbd className="ml-auto pl-4 text-xs text-text-muted">{keys}</kbd>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
