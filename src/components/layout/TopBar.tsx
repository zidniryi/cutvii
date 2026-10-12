import { Redo2, Undo2, Upload } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { AiMenu } from "@/components/autoclips/AiMenu";
import { FileMenu } from "@/components/FileMenu";
import { IconButton } from "@/components/IconButton";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { useExportStore } from "@/store/export";
import { projectDuration } from "@/timeline/clips";
import { fileName } from "@/lib/media";
import { canvasLabel, canvasOf } from "@/project/canvas";
import { useUiStore } from "@/store/ui";
import { selectCanRedo, selectCanUndo, selectIsDirty, useProjectStore } from "@/store/project";
import { redo, undo } from "@/timeline/editor";

export function TopBar() {
  const name = useProjectStore((s) => s.project.name);
  const canUndo = useProjectStore(selectCanUndo);
  const dirty = useProjectStore(selectIsDirty);
  const canvas = useProjectStore(useShallow((s) => canvasOf(s.project)));
  const canvasPending = useProjectStore((s) => s.project.settings.canvasPending === true);
  const openCanvas = useUiStore((s) => s.setCanvasDialogOpen);
  const saving = useUiStore((s) => s.saving);
  const hasContent = useProjectStore((s) => projectDuration(s.project) > 0);
  const openExport = useExportStore((s) => s.open);
  const filePath = useProjectStore((s) => s.filePath);
  const canRedo = useProjectStore(selectCanRedo);
  const undoLabel = useProjectStore((s) => s.past[s.past.length - 1]?.label);
  const redoLabel = useProjectStore((s) => s.future[s.future.length - 1]?.label);
  return (
    <header className="flex h-12 shrink-0 items-center gap-1 border-b bg-surface-1 px-2 sm:px-3">
      <Logo />
      <span className="mx-2 hidden truncate text-sm text-text-muted sm:inline">{name}</span>
      <FileMenu />
      <AiMenu />
      <IconButton
        label={undoLabel ? `Undo ${undoLabel}` : "Undo"}
        icon={<Undo2 />}
        shortcut="Ctrl/⌘ Z"
        disabled={!canUndo}
        onClick={undo}
      />
      <IconButton
        label={redoLabel ? `Redo ${redoLabel}` : "Redo"}
        icon={<Redo2 />}
        shortcut="Ctrl/⌘ Shift Z"
        disabled={!canRedo}
        onClick={redo}
      />
      <Button
        variant="ghost"
        size="sm"
        className="max-w-[16rem] truncate pointer-coarse:h-11"
        aria-label={`Canvas: ${canvasPending ? "Original, set by the first video" : canvasLabel(canvas)}`}
        title="Change canvas"
        onClick={() => openCanvas(true)}
      >
        {canvasPending ? "Canvas: Original" : canvasLabel(canvas)}
      </Button>
      <div className="ml-auto flex items-center gap-3">
        <span className="hidden text-xs text-text-muted sm:inline" title={filePath ?? undefined}>
          {saving
            ? "Saving…"
            : dirty
              ? "Unsaved changes"
              : filePath
                ? `Saved · ${fileName(filePath)}`
                : "New project"}
        </span>
        <Button
          disabled={!hasContent}
          title={hasContent ? "Export video" : "Add clips to the timeline to export"}
          className="pointer-coarse:h-11"
          onClick={openExport}
        >
          <Upload /> Export
        </Button>
      </div>
    </header>
  );
}
