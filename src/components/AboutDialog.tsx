import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Gift } from "lucide-react";
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
  const go = (which: "donate" | "support") =>
    void invoke("open_support_link", { which }).catch((e: unknown) =>
      useUiStore.getState().setNotice(typeof e === "string" ? e : "Could not open the browser"),
    );
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
        {/* the same two pages as the Support popup; Rust opens them and checks the address itself */}
        <div className="mt-3 flex items-center gap-1 text-xs">
          <Button variant="ghost" size="sm" className="pointer-coarse:h-11" onClick={() => go("donate")}>
            <Gift /> Donate
          </Button>
          <span aria-hidden className="text-text-muted">
            ·
          </span>
          <Button variant="ghost" size="sm" className="pointer-coarse:h-11" onClick={() => go("support")}>
            Support CutVii
          </Button>
        </div>
        <Button ref={closeRef} variant="secondary" className="mt-1 pointer-coarse:h-11" onClick={close}>
          Close
        </Button>
      </div>
    </div>
  );
}
