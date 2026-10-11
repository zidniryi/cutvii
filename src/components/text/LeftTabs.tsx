import { cn } from "@/lib/utils";
import { useUiStore } from "@/store/ui";

const TABS = [
  { id: "library", label: "Media" },
  { id: "text", label: "Text" },
] as const;

/** Media / Text switch of the left panel on wide screens (narrow screens use the side-panel tabs). */
export function LeftTabs() {
  const left = useUiStore((s) => s.leftPanel);
  return (
    <div role="tablist" aria-label="Left panel" className="hidden gap-1 lg:flex">
      {TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={left === t.id}
          onClick={() => useUiStore.getState().setSidePanel(t.id)}
          className={cn(
            "h-7 rounded-md px-2 text-xs",
            left === t.id ? "bg-accent-soft text-text" : "text-text-muted hover:text-text",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
