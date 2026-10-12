import { useEffect } from "react";
import { Info, X } from "lucide-react";
import { useUiStore } from "@/store/ui";

/** How long a notice stays before it goes away on its own. */
export const NOTICE_MS = 5000;

/**
 * Short messages about what just happened or could not happen ("would overlap", "select a clip first"),
 * shown as a toast over the editor: the whole text, never cut off, gone after a few seconds or on Dismiss.
 */
export function NoticeToast() {
  const notice = useUiStore((s) => s.notice);
  const action = useUiStore((s) => s.noticeAction);
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => useUiStore.getState().setNotice(null), NOTICE_MS);
    return () => clearTimeout(id);
  }, [notice]);
  if (!notice) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-14 z-[70] flex justify-center px-4">
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-auto flex max-w-xl items-start gap-2 rounded-lg border bg-popover py-2 pr-1 pl-3 text-sm text-text shadow-xl shadow-black/50"
      >
        <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-accent" />
        <p className="min-w-0 flex-1 break-words">{notice}</p>
        {action && (
          <button
            type="button"
            onClick={() => {
              useUiStore.getState().setNotice(null);
              action.run();
            }}
            className="shrink-0 rounded-md bg-accent px-2 py-1 text-xs font-medium text-black hover:bg-accent-hover pointer-coarse:min-h-11"
          >
            {action.label}
          </button>
        )}
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => useUiStore.getState().setNotice(null)}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-text-muted hover:text-text pointer-coarse:size-11 [&_svg]:size-3.5"
        >
          <X />
        </button>
      </div>
    </div>
  );
}
