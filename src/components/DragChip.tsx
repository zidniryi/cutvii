import { useDragDropStore } from "@/store/dragDrop";

/** Small label that follows the pointer while a media card is dragged. */
export function DragChip() {
  const dragging = useDragDropStore((s) => s.dragging);
  const overTimeline = useDragDropStore((s) => s.preview !== null);
  if (!dragging || dragging.source !== "library") return null;
  return (
    <div
      aria-hidden
      data-testid="drag-chip"
      className="pointer-events-none fixed z-[70] max-w-56 truncate rounded-md border bg-popover px-2 py-1 text-xs shadow-lg"
      style={{ left: dragging.x + 12, top: dragging.y + 12, opacity: overTimeline ? 0.6 : 1 }}
    >
      {dragging.label}
    </div>
  );
}
