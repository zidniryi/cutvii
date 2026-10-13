import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import {
  closeManualResult,
  downloadUpdate,
  laterUpdate,
  skipUpdate,
  useUpdateStore,
  type ManualResult,
  type Offer,
} from "@/updates/updates";

const backdrop = "fixed inset-0 z-[60] flex items-end justify-center bg-black/60 sm:items-center sm:p-4";
const sheet =
  "flex max-h-[90dvh] w-full flex-col gap-3 overflow-y-auto rounded-t-lg border bg-popover px-5 py-5 shadow-xl sm:max-w-md sm:rounded-lg";

/** A newer version exists (popup), or the answer of a manual "Check for updates". */
export function UpdateDialog() {
  const offer = useUpdateStore((s) => s.offer);
  const manual = useUpdateStore((s) => s.manual);
  if (offer) return <OfferBody offer={offer} />;
  return manual ? <ManualBody result={manual} /> : null;
}

function useEscape(run: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") run();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [run]);
}

function OfferBody({ offer }: { offer: Offer }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLButtonElement>(null);
  useFocusTrap(rootRef, firstRef);
  useEscape(laterUpdate); // Esc = Later
  return (
    <div className={backdrop}>
      <div ref={rootRef} role="dialog" aria-modal="true" aria-labelledby="update-title" className={sheet}>
        <h2 id="update-title" className="text-base font-semibold">
          CutVii {offer.version} is available
        </h2>
        {/* release notes come from GitHub: shown as the plain characters they are, never as markup or links */}
        {offer.notes && (
          <p data-testid="update-notes" className="text-sm whitespace-pre-line text-text-muted">
            {offer.notes}
          </p>
        )}
        <p className="text-xs text-text-muted">
          Download opens the release page in your browser. Nothing is installed by CutVii.
        </p>
        <Button ref={firstRef} className="h-11" onClick={() => void downloadUpdate()}>
          Download
        </Button>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" className="h-11" onClick={laterUpdate}>
            Later
          </Button>
          <Button variant="ghost" className="h-11" onClick={skipUpdate}>
            Skip this version
          </Button>
        </div>
      </div>
    </div>
  );
}

function ManualBody({ result }: { result: ManualResult }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useFocusTrap(rootRef, closeRef);
  useEscape(closeManualResult);
  const text =
    result.kind === "checking"
      ? "Checking for updates…"
      : result.kind === "upToDate"
        ? `You are up to date. This is CutVii ${result.current}.`
        : result.kind === "notSet"
          ? "Update checks are not set up in this build, so nothing was asked."
          : `The update check failed: ${result.message}`;
  return (
    <div className={backdrop}>
      <div
        ref={rootRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-check-title"
        className={sheet}
      >
        <h2 id="update-check-title" className="text-base font-semibold">
          Check for updates
        </h2>
        <p role={result.kind === "error" ? "alert" : "status"} className="text-sm text-text">
          {text}
        </p>
        <Button ref={closeRef} variant="secondary" className="h-11" onClick={closeManualResult}>
          Close
        </Button>
      </div>
    </div>
  );
}
