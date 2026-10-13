import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { confirmDialog } from "@/lib/dialog";
import { addVoiceover, type Spoken } from "@/timeline/voiceover";
import { usePlaybackStore } from "./playback";
import { useProjectStore } from "./project";
import { useSelectionStore } from "./selection";

interface Choice {
  id: string;
  label: string;
}

/** One size of the voice model (see `src-tauri/src/media/tts.rs`). Models are never bundled. */
export interface TtsModel {
  id: string;
  label: string;
  hint: string;
  bytes: number;
  /** The pages its files are downloaded from. */
  hosts: string[];
  installed: boolean;
}

/** The voice models on offer and what they speak. */
export interface TtsStatus {
  models: TtsModel[];
  source: string;
  voices: Choice[];
  languages: Choice[];
  maxChars: number;
  minSpeed: number;
  defaultSpeed: number;
  maxSpeed: number;
}

/** What the user last chose. Kept on this computer, not in the project. */
interface Prefs {
  /** The model size chosen; null until the user picks one. */
  model: string | null;
  language: string;
  voice: string;
  speed: number | null;
}

const PREFS_KEY = "cutvii.voiceover.v1";
const DEFAULT_PREFS: Prefs = { model: null, language: "id", voice: "F1", speed: null };

function loadPrefs(): Prefs {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(PREFS_KEY);
    const p = raw ? (JSON.parse(raw) as Partial<Prefs>) : {};
    return {
      model: typeof p.model === "string" ? p.model : null,
      language: typeof p.language === "string" ? p.language : DEFAULT_PREFS.language,
      voice: typeof p.voice === "string" ? p.voice : DEFAULT_PREFS.voice,
      speed: typeof p.speed === "number" && Number.isFinite(p.speed) ? p.speed : null,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

type Note = { kind: "ok" | "problem"; text: string };

interface VoiceoverState extends Prefs {
  open: boolean;
  status: TtsStatus | null;
  /** The model being downloaded and the bytes that have arrived. */
  download: { id: string; received: number; total?: number } | null;
  /** How far the voice-over being made is (0..1), if one is. */
  running: number | null;
  note: Note | null;
  show: () => void;
  hide: () => void;
  refresh: () => Promise<void>;
  setPrefs: (prefs: Partial<Prefs>) => void;
  /** Ask the user, then download that model. */
  downloadWithConsent: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** Speak `text` and put the sound on the timeline at the playhead (one undo step). */
  create: (text: string) => Promise<boolean>;
  cancel: () => void;
}

const message = (e: unknown) =>
  (typeof e === "string" ? e : e instanceof Error ? e.message : "unknown error").replace(
    /^invalid input: /,
    "",
  );

export const megabytes = (bytes: number) => Math.round(bytes / 1_000_000);

/** The model the dialog works with: the one chosen, else one that is downloaded, else the first. */
export function chosenModel(status: TtsStatus, chosen: string | null): TtsModel | undefined {
  return (
    status.models.find((m) => m.id === chosen) ?? status.models.find((m) => m.installed) ?? status.models[0]
  );
}

let attached: Promise<unknown> | null = null;

export const useVoiceoverStore = create<VoiceoverState>((set, get) => {
  const attach = () => {
    attached ??= Promise.all([
      listen<{ id: string; received: number; total?: number }>("ai-download", (e) => {
        const current = get().download;
        if (current && e.payload.id === "tts") {
          set({ download: { id: current.id, received: e.payload.received, total: e.payload.total } });
        }
      }),
      listen<{ fraction: number }>("tts-progress", (e) => {
        if (get().running !== null) set({ running: e.payload.fraction });
      }),
    ]).catch(() => null);
  };
  return {
    ...loadPrefs(),
    open: false,
    status: null,
    download: null,
    running: null,
    note: null,
    show: () => {
      set({ open: true, note: null });
      attach();
      get()
        .refresh()
        .catch(() => undefined);
    },
    hide: () => set({ open: false }),
    refresh: async () => {
      const status = await invoke<TtsStatus>("tts_status");
      if (status && Array.isArray(status.models) && Array.isArray(status.voices)) set({ status });
    },
    setPrefs: (prefs) => {
      set(prefs);
      const { model, language, voice, speed } = get();
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify({ model, language, voice, speed }));
      } catch {
        // no storage: the choice lasts until the app closes
      }
    },
    downloadWithConsent: async (id) => {
      const model = get().status?.models.find((m) => m.id === id);
      if (!model || get().download) return;
      const agreed = await confirmDialog({
        title: "Download the voice model?",
        lines: [
          `Supertonic 3 by Supertone (${model.label}): about ${megabytes(model.bytes)} MB, downloaded once from ${model.hosts.join(" and ")}.`,
          ...(model.hosts.length > 1
            ? [
                "This size uses a smaller copy of two of the model's files made by the sherpa-onnx project, not by Supertone.",
              ]
            : []),
          "Licence: OpenRAIL-M. You may use the voice in what you make, also commercially, but not to impersonate a person without their consent, to deceive, or for anything unlawful. Its makers do not say which recordings it was trained on.",
          "It is kept on this computer. The text you type is never uploaded: the voice is made here.",
        ],
        confirmLabel: "Download",
      });
      if (!agreed) return;
      attach();
      set({ download: { id, received: 0, total: model.bytes }, note: null });
      try {
        await invoke("download_tts_model", { id });
        set({ note: { kind: "ok", text: "The voice model is ready." } });
      } catch (e) {
        const reason = message(e);
        set({
          note: /cancel/i.test(reason)
            ? { kind: "ok", text: "The download was stopped. What arrived is kept for next time." }
            : { kind: "problem", text: `Could not download the voice model: ${reason}` },
        });
      } finally {
        set({ download: null });
        await get()
          .refresh()
          .catch(() => undefined);
      }
    },
    remove: async (id) => {
      await Promise.resolve(invoke("delete_tts_model", { id })).catch(() => undefined);
      await get()
        .refresh()
        .catch(() => undefined);
    },
    create: async (text) => {
      const { status, language, voice, speed } = get();
      const model = status && chosenModel(status, get().model);
      if (!status || !model?.installed || get().running !== null) return false;
      if (!text.trim()) {
        set({ note: { kind: "problem", text: "Type the words to speak first." } });
        return false;
      }
      attach();
      set({ running: 0, note: null });
      let made: Spoken;
      try {
        made = await invoke<Spoken>("speak_text", {
          modelId: model.id,
          text,
          language,
          voice,
          speed: speed ?? status.defaultSpeed,
        });
      } catch (e) {
        const reason = message(e);
        set({
          note: /cancel/i.test(reason)
            ? { kind: "ok", text: "Stopped. Nothing was added." }
            : { kind: "problem", text: `The voice-over could not be made: ${reason}` },
        });
        return false;
      } finally {
        set({ running: null });
      }
      if (!made || typeof made.path !== "string" || !(made.duration > 0)) {
        set({ note: { kind: "problem", text: "The voice-over could not be made." } });
        return false;
      }
      const ids = { asset: crypto.randomUUID(), track: crypto.randomUUID(), clip: crypto.randomUUID() };
      const done = useProjectStore.getState().execute({
        label: "Add voice-over",
        apply: (p) => addVoiceover(p, made, usePlaybackStore.getState().playhead, ids),
      });
      if (!done.ok) {
        set({ note: { kind: "problem", text: done.error.message } });
        return false;
      }
      useSelectionStore.getState().select(ids.clip);
      set({
        note: { kind: "ok", text: `Added ${made.duration.toFixed(1)} s of voice-over at the playhead.` },
      });
      return true;
    },
    cancel: () => void Promise.resolve(invoke("cancel_ai_job")).catch(() => undefined),
  };
});
