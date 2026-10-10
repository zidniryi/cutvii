import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { CanvasPicker } from "@/components/canvas/CanvasPicker";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { createProjectWithCanvas } from "@/project/fileActions";
import { canvasLabel } from "@/project/canvas";
import { resolveChoice, type CanvasChoice } from "@/project/canvasChoice";
import { useTemplateStore } from "@/store/canvasTemplates";
import { useUiStore } from "@/store/ui";

function Body() {
  const close = useUiStore((s) => s.setNewProjectOpen);
  const saved = useTemplateStore((s) => s.templates);
  const [choice, setChoice] = useState<CanvasChoice>({ kind: "template", id: "youtube" });
  const rootRef = useRef<HTMLDivElement>(null);
  useFocusTrap(rootRef);

  const resolved = resolveChoice(choice, saved);
  const summary = !resolved.ok
    ? null
    : resolved.pending
      ? "Canvas follows the first video you add"
      : canvasLabel(resolved.canvas);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      onKeyDown={(e) => e.key === "Escape" && close(false)}
    >
      <div
        ref={rootRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-project-title"
        className="flex max-h-full w-full max-w-md flex-col rounded-lg border bg-popover shadow-xl"
      >
        <div className="p-4 pb-2">
          <h2 id="new-project-title" className="text-sm font-semibold">
            New project
          </h2>
          <p className="mt-1 text-xs text-text-muted">
            Choose the canvas. You can change it later from the top bar.
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
          <CanvasPicker choice={choice} onChoice={setChoice} />
        </div>
        <div className="flex items-center justify-between gap-3 border-t p-4">
          <p className="min-w-0 truncate text-xs text-text-muted" aria-live="polite">
            {summary}
          </p>
          <div className="flex shrink-0 gap-2">
            <Button variant="secondary" className="pointer-coarse:h-11" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button
              className="pointer-coarse:h-11"
              disabled={!resolved.ok}
              onClick={() => resolved.ok && void createProjectWithCanvas(resolved.canvas, resolved.pending)}
            >
              Create project
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function NewProjectDialog() {
  const open = useUiStore((s) => s.newProjectOpen);
  return open ? <Body /> : null;
}
