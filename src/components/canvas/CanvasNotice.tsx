import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useProjectStore } from "@/store/project";
import { useUiStore } from "@/store/ui";
import { undo } from "@/timeline/editor";

/** Slim banner under the top bar. Undo is only offered while the canvas change is still the latest edit. */
export function CanvasNotice() {
  const notice = useUiStore((s) => s.canvasNotice);
  const setNotice = useUiStore((s) => s.setCanvasNotice);
  const historyLength = useProjectStore((s) => s.past.length);

  if (!notice) return null;
  const canUndo = historyLength === notice.pastLength;

  return (
    <div role="status" className="flex items-center gap-2 border-b bg-accent-soft px-3 py-1.5 text-xs">
      <span className="min-w-0 flex-1">{notice.message}</span>
      {canUndo && (
        <Button
          variant="secondary"
          size="sm"
          className="pointer-coarse:h-11"
          onClick={() => {
            undo();
            setNotice(null);
          }}
        >
          Undo
        </Button>
      )}
      <button
        aria-label="Dismiss"
        className="shrink-0 p-1 pointer-coarse:p-3"
        onClick={() => setNotice(null)}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
