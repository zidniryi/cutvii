import { useId, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useSectionStore } from "@/store/inspectorSections";

/** A part of the inspector that folds away under its title. It stays as it was left, for every clip. */
export function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  const open = useSectionStore((s) => !s.closed[id]);
  const bodyId = useId();
  return (
    <section className="border-t pt-2 first:border-t-0 first:pt-0">
      <h3>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => useSectionStore.getState().toggle(id)}
          className="flex h-8 w-full items-center gap-1 rounded-sm text-left text-xs font-medium text-text-muted hover:text-text pointer-coarse:h-11 [&_svg]:size-3.5"
        >
          {open ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
          {title}
        </button>
      </h3>
      {open && (
        <div id={bodyId} className="space-y-4 pt-1">
          {children}
        </div>
      )}
    </section>
  );
}
