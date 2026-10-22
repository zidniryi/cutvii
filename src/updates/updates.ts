/**
 * Update check, the webview's half: WHEN to ask and what to show. The request itself is made by Rust
 * (`src-tauri/src/commands/update.rs`) to one fixed GitHub address; nothing is downloaded or installed.
 *
 * Rules: off in Settings = no request at all; the background check runs at most once per 24 hours and
 * fails silently; a skipped version stays hidden until a newer one exists; the popup shows at most once per
 * version per day, never during an export and never on top of another dialog (it waits instead).
 */
import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import { create } from "zustand";
import { useExportStore } from "@/store/export";
import { useUiStore } from "@/store/ui";

export const UPDATE_PREFS_KEY = "cutvii.updates.v1";
export const DAY_MS = 24 * 60 * 60 * 1000;
/** The background check starts this long after the UI is ready, so it never slows the start. */
export const START_DELAY_MS = 3000;
/** A waiting popup looks this often for a moment when nothing else is open. */
export const RETRY_MS = 15000;

const PrefsSchema = z.object({
  /** "Check for updates automatically". */
  auto: z.boolean().default(true),
  /** When the last background check was started (ms since 1970). */
  lastCheck: z.number().default(0),
  /** The version the user chose to skip. */
  skipped: z.string().nullable().default(null),
  /** The last version the popup was shown for, and on which day. */
  shown: z.object({ version: z.string(), day: z.string() }).nullable().default(null),
});
export type UpdatePrefs = z.infer<typeof PrefsSchema>;

export function readUpdatePrefs(): UpdatePrefs {
  try {
    return PrefsSchema.parse(JSON.parse(localStorage.getItem(UPDATE_PREFS_KEY) ?? "{}"));
  } catch {
    return PrefsSchema.parse({});
  }
}

export function writeUpdatePrefs(patch: Partial<UpdatePrefs>): UpdatePrefs {
  const next = { ...readUpdatePrefs(), ...patch };
  localStorage.setItem(UPDATE_PREFS_KEY, JSON.stringify(next));
  return next;
}

const StatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("placeholder") }),
  z.object({ status: z.literal("upToDate"), current: z.string() }),
  z.object({
    status: z.literal("available"),
    version: z.string().min(1).max(60),
    notes: z.string().max(2000),
    url: z.string().min(1).max(300),
  }),
]);

export interface Offer {
  version: string;
  /** Plain text. Never rendered as anything else. */
  notes: string;
  url: string;
}

/** What a manual check says when there is nothing to offer. */
export type ManualResult =
  | { kind: "checking" }
  | { kind: "upToDate"; current: string }
  | { kind: "notSet" }
  | { kind: "error"; message: string };

interface UpdateState {
  /** The popup on screen. */
  offer: Offer | null;
  /** A newer version waiting for a moment when nothing else is open. */
  pending: Offer | null;
  manual: ManualResult | null;
}

export const useUpdateStore = create<UpdateState>(() => ({ offer: null, pending: null, manual: null }));

const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);
const message = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : "Failed");

/** An export is running, or some dialog is open: not the moment for a popup. */
export function isBusy(): boolean {
  return useExportStore.getState().phase === "running" || document.querySelector('[role="dialog"]') !== null;
}

/** Show the waiting popup if nothing else is going on. */
export function tryShowUpdate(now = Date.now()): void {
  const { pending, offer } = useUpdateStore.getState();
  if (!pending || offer || isBusy()) return;
  writeUpdatePrefs({ shown: { version: pending.version, day: dayOf(now) } });
  useUpdateStore.setState({ offer: pending, pending: null });
}

/**
 * The quiet check after start-up. Makes no request when the setting is off or the last check was under
 * 24 hours ago, and says nothing when the request fails (offline, timed out, rate limited).
 */
export async function backgroundCheck(now = Date.now()): Promise<void> {
  const prefs = readUpdatePrefs();
  if (!prefs.auto || now - prefs.lastCheck < DAY_MS) return;
  writeUpdatePrefs({ lastCheck: now }); // a failed check counts too: no retry storm
  try {
    const status = StatusSchema.parse(await invoke("check_for_update"));
    if (status.status !== "available") return;
    if (status.version === prefs.skipped) return;
    if (prefs.shown?.version === status.version && prefs.shown.day === dayOf(now)) return;
    useUpdateStore.setState({ pending: { version: status.version, notes: status.notes, url: status.url } });
    tryShowUpdate(now);
  } catch {
    // silent by design
  }
}

/** "Check for updates" from the menu: always asks, and always answers (also with the error). */
export async function manualCheck(now = Date.now()): Promise<void> {
  useUpdateStore.setState({ manual: { kind: "checking" }, pending: null });
  try {
    const status = StatusSchema.parse(await invoke("check_for_update"));
    if (status.status === "available") {
      writeUpdatePrefs({ shown: { version: status.version, day: dayOf(now) } });
      useUpdateStore.setState({
        manual: null,
        offer: { version: status.version, notes: status.notes, url: status.url },
      });
    } else if (status.status === "upToDate") {
      useUpdateStore.setState({ manual: { kind: "upToDate", current: status.current } });
    } else {
      useUpdateStore.setState({ manual: { kind: "notSet" } });
    }
  } catch (e) {
    useUpdateStore.setState({ manual: { kind: "error", message: message(e) } });
  }
}

/** "Later": close the popup; it may come back another day. */
export const laterUpdate = () => useUpdateStore.setState({ offer: null });

/** "Skip this version": hidden until a newer version exists. */
export function skipUpdate(): void {
  const { offer } = useUpdateStore.getState();
  if (offer) writeUpdatePrefs({ skipped: offer.version });
  useUpdateStore.setState({ offer: null });
}

/** "Download": Rust checks the address again and opens the release page in the browser. */
export async function downloadUpdate(): Promise<void> {
  const { offer } = useUpdateStore.getState();
  if (!offer) return;
  try {
    await invoke("open_release_page", { url: offer.url });
    useUpdateStore.setState({ offer: null });
  } catch (e) {
    useUiStore.getState().setNotice(`Could not open the release page: ${message(e)}`);
  }
}

export const closeManualResult = () => useUpdateStore.setState({ manual: null });

/** Start the quiet check a few seconds after the UI is ready. Returns the stop function. */
export function startUpdateWatcher(): () => void {
  const first = window.setTimeout(() => void backgroundCheck(), START_DELAY_MS);
  const retry = window.setInterval(() => tryShowUpdate(), RETRY_MS);
  return () => {
    window.clearTimeout(first);
    window.clearInterval(retry);
  };
}
