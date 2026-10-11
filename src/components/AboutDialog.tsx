import { useEffect, useRef } from "react";
import pkg from "../../package.json";
import { LogoMark } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { useUiStore } from "@/store/ui";

export const TAGLINE = "Creative editing. Flexible workflow. On-device AI.";

/** CutVii's own About window (opened from the app menu): mark, name, version and the tagline, centred. */
export function AboutDialog() {
  const open = useUiStore((s) => s.aboutOpen);
  return open ? <AboutBody /> : null;
}

function AboutBody() {
  const close = () => useUiStore.getState().setAboutOpen(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
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
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={rootRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-title"
        className="flex w-full max-w-xs flex-col items-center gap-1 rounded-lg border bg-popover px-6 py-6 text-center shadow-xl"
      >
        <LogoMark size={56} />
        <h2 id="about-title" className="mt-3 text-lg font-semibold tracking-tight">
          Cut<span className="text-accent">Vii</span>
        </h2>
        <p className="text-xs text-text-muted tabular-nums">Version {pkg.version}</p>
        <p className="mt-3 text-sm text-text">{TAGLINE}</p>
        <p className="mt-3 text-xs text-text-muted">© CutVii contributors</p>
        <Button ref={closeRef} variant="secondary" className="mt-4 pointer-coarse:h-11" onClick={close}>
          Close
        </Button>
      </div>
    </div>
  );
}
