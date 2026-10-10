import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { useUiStore } from "@/store/ui";

/** Modal for confirm/message prompts. Escape cancels; focus starts on the safe (cancel/OK) button. */
export function AppDialog() {
  const dialog = useUiStore((s) => s.dialog);
  return dialog ? <AppDialogBody key={dialog.title + dialog.lines.join("|")} /> : null;
}

function AppDialogBody() {
  const dialog = useUiStore((s) => s.dialog)!;
  const close = useUiStore((s) => s.closeDialog);
  const safeRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  useFocusTrap(rootRef, safeRef);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
      <div
        ref={rootRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="app-dialog-title"
        className="w-full max-w-md rounded-lg border bg-popover p-4 shadow-xl"
      >
        <h2 id="app-dialog-title" className="text-sm font-semibold">
          {dialog.title}
        </h2>
        <div className="mt-2 space-y-1 text-sm text-text-muted">
          {dialog.lines.map((l, i) => (
            <p key={i} className="break-words">
              {l}
            </p>
          ))}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          {dialog.cancelLabel ? (
            <>
              <Button
                ref={safeRef}
                variant="secondary"
                className="pointer-coarse:h-11"
                onClick={() => close(false)}
              >
                {dialog.cancelLabel}
              </Button>
              <Button variant="destructive" className="pointer-coarse:h-11" onClick={() => close(true)}>
                {dialog.confirmLabel}
              </Button>
            </>
          ) : (
            <Button ref={safeRef} className="pointer-coarse:h-11" onClick={() => close(true)}>
              {dialog.confirmLabel}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
