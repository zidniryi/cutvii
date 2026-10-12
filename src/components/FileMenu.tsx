import { useEffect, useRef, useState } from "react";
import { FilePlus2, FolderOpen, Package, Save, SaveAll } from "lucide-react";
import { useStylePackStore } from "@/store/stylePacks";
import { IconButton } from "@/components/IconButton";
import { newProjectFlow, openProjectFlow, saveFlow } from "@/project/fileActions";

const ITEMS = [
  { id: "new", label: "New project", Icon: FilePlus2, keys: "", run: () => newProjectFlow() },
  { id: "open", label: "Open…", Icon: FolderOpen, keys: "Ctrl/⌘ O", run: () => openProjectFlow() },
  { id: "save", label: "Save", Icon: Save, keys: "Ctrl/⌘ S", run: () => saveFlow(false) },
  { id: "saveAs", label: "Save as…", Icon: SaveAll, keys: "Ctrl/⌘ Shift S", run: () => saveFlow(true) },
  {
    id: "packs",
    label: "Style packs…",
    Icon: Package,
    keys: "",
    run: () => useStylePackStore.getState().openDialog(),
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
          {ITEMS.map(({ id, label, Icon, keys, run }) => (
            <button
              key={id}
              role="menuitem"
              aria-label={label}
              className="flex h-9 w-full items-center gap-2 rounded-sm px-2 text-left text-sm hover:bg-accent-soft pointer-coarse:h-11"
              onClick={() => {
                setOpen(false);
                void run();
              }}
            >
              <Icon className="size-4" /> {label}
              {keys && <kbd className="ml-auto pl-4 text-xs text-text-muted">{keys}</kbd>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
