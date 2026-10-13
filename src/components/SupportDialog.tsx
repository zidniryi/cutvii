import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Gift } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { useUiStore } from "@/store/ui";
import { supportText } from "@/support/config";

/**
 * "Support CutVii": opened only by the gift button (or its menu item on narrow screens), never by itself.
 * Plain text from `config/support.json`; the two buttons ask Rust to open the page in the browser.
 */
export function SupportDialog() {
  const open = useUiStore((s) => s.supportOpen);
  return open ? <SupportBody /> : null;
}

function SupportBody() {
  const close = () => useUiStore.getState().setSupportOpen(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLButtonElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const text = supportText(navigator.language);
  useFocusTrap(rootRef, firstRef);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function go(which: "donate" | "support") {
    setProblem(null);
    try {
      await invoke("open_support_link", { which });
    } catch (e) {
      setProblem(typeof e === "string" ? e : e instanceof Error ? e.message : "Could not open the browser");
    }
  }

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
        aria-labelledby="support-title"
        className="flex max-h-[90dvh] w-full flex-col gap-3 overflow-y-auto rounded-t-lg border bg-popover px-5 py-5 shadow-xl sm:max-w-md sm:rounded-lg"
      >
        <h2 id="support-title" className="flex items-center gap-2 text-base font-semibold">
          <Gift className="size-4 text-text-muted" /> {text.title}
        </h2>
        <p className="text-sm leading-relaxed text-text">{text.message}</p>
        <Button ref={firstRef} className="h-11" onClick={() => void go("donate")}>
          {text.donate}
        </Button>
        <div>
          <Button variant="secondary" className="h-11 w-full" onClick={() => void go("support")}>
            {text.other}
          </Button>
          <p className="mt-1.5 text-xs text-text-muted">{text.otherLine}</p>
        </div>
        {problem && (
          <p role="alert" className="text-xs text-danger">
            {problem}
          </p>
        )}
        <p className="text-center text-xs text-text-muted">{text.footer}</p>
        <Button variant="ghost" className="h-11 self-center" onClick={close}>
          Close
        </Button>
      </div>
    </div>
  );
}
