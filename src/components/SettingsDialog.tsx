import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { useUiStore } from "@/store/ui";
import { manualCheck, readUpdatePrefs, writeUpdatePrefs } from "@/updates/updates";

/** Settings. For now one setting: whether CutVii looks for a newer version by itself. */
export function SettingsDialog() {
  const open = useUiStore((s) => s.settingsOpen);
  return open ? <SettingsBody /> : null;
}

function SettingsBody() {
  const close = () => useUiStore.getState().setSettingsOpen(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [auto, setAuto] = useState(() => readUpdatePrefs().auto);
  useFocusTrap(rootRef, closeRef);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 sm:items-center sm:p-4"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={rootRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="flex w-full flex-col gap-3 rounded-t-lg border bg-popover px-5 py-5 shadow-xl sm:max-w-md sm:rounded-lg"
      >
        <h2 id="settings-title" className="text-base font-semibold">
          Settings
        </h2>
        <label className="flex min-h-11 items-start gap-3 text-sm">
          <input
            type="checkbox"
            className="mt-1 size-4 accent-[var(--accent)]"
            checked={auto}
            onChange={(e) => {
              setAuto(e.target.checked);
              writeUpdatePrefs({ auto: e.target.checked });
            }}
          />
          <span>
            Check for updates automatically
            <span className="mt-0.5 block text-xs text-text-muted">
              At most once a day CutVii asks GitHub whether a newer version exists. Nothing is downloaded or
              installed. Off means no request at all.
            </span>
          </span>
        </label>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            className="h-11 flex-1"
            onClick={() => {
              close();
              void manualCheck();
            }}
          >
            Check for updates now
          </Button>
          <Button ref={closeRef} className="h-11 flex-1" onClick={close}>
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}
