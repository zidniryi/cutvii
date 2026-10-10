import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { CanvasPicker } from "@/components/canvas/CanvasPicker";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { canvasLabel, canvasOf, withCanvas } from "@/project/canvas";
import { resolveChoice, type CanvasChoice } from "@/project/canvasChoice";
import { useTemplateStore } from "@/store/canvasTemplates";
import { useProjectStore } from "@/store/project";
import { useUiStore } from "@/store/ui";

function Body() {
  const setOpen = useUiStore((s) => s.setCanvasDialogOpen);
  const project = useProjectStore((s) => s.project);
  const saved = useTemplateStore((s) => s.templates);
  const current = canvasOf(project);
  const [choice, setChoice] = useState<CanvasChoice>({
    kind: "custom",
    width: String(current.width),
    height: String(current.height),
    fps: String(Math.round(current.fps * 1000) / 1000),
  });
  const rootRef = useRef<HTMLDivElement>(null);
  useFocusTrap(rootRef);
  const resolved = resolveChoice(choice, saved, project);

  function apply() {
    if (!resolved.ok) return;
    // one undoable step, whatever the choice
    useProjectStore.getState().execute({
      label: "Change canvas",
      apply: (p) => ({ ok: true, project: withCanvas(p, resolved.canvas, resolved.pending) }),
    });
    if (resolved.note) {
      useUiStore
        .getState()
        .setCanvasNotice({ message: resolved.note, pastLength: useProjectStore.getState().past.length });
    }
    setOpen(false);
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
    >
      <div
        ref={rootRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="canvas-title"
        className="flex max-h-full w-full max-w-md flex-col rounded-lg border bg-popover shadow-xl"
      >
        <div className="p-4 pb-2">
          <h2 id="canvas-title" className="text-sm font-semibold">
            Canvas
          </h2>
          <p className="mt-1 text-xs text-text-muted">
            Current:{" "}
            {project.settings.canvasPending ? "Original (waiting for the first video)" : canvasLabel(current)}
            . Clips keep their place; they are fitted inside the new canvas.
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
          <CanvasPicker choice={choice} onChoice={setChoice} project={project} />
        </div>
        <div className="flex justify-end gap-2 border-t p-4">
          <Button variant="secondary" className="pointer-coarse:h-11" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button className="pointer-coarse:h-11" disabled={!resolved.ok} onClick={apply}>
            Apply
          </Button>
        </div>
      </div>
    </div>
  );
}

export function CanvasDialog() {
  const open = useUiStore((s) => s.canvasDialogOpen);
  return open ? <Body /> : null;
}
