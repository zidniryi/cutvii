import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";

/** A speech model on offer (see `src-tauri/src/media/whisper.rs`). Models are never bundled. */
export interface SpeechModel {
  id: string;
  label: string;
  approxMb: number;
  /** Where it is downloaded from; shown before the user agrees. */
  source: string;
  installed: boolean;
}

export interface Download {
  id: string;
  received: number;
  total?: number;
}

interface AiState {
  models: SpeechModel[];
  loaded: boolean;
  /** The model being downloaded right now, if any. */
  download: Download | null;
  /** Clip being transcribed and how far it is (0..100), if any. */
  listening: { clipId: string; percent: number } | null;
  /** Ask Rust which models are on this machine. */
  refresh: () => Promise<void>;
  ensure: () => void;
  /**
   * Download a model. Call this only after the user agreed to the download.
   * Rejects with a readable message (including when the user cancels).
   */
  downloadModel: (id: string) => Promise<void>;
  removeModel: (id: string) => Promise<void>;
  cancel: () => void;
  setListening: (listening: AiState["listening"]) => void;
}

const message = (e: unknown) =>
  typeof e === "string" ? e : e instanceof Error ? e.message : "unknown error";

let listening: Promise<unknown> | null = null;

export const useAiStore = create<AiState>((set, get) => {
  /** Progress events from Rust, attached once. */
  const attach = () => {
    listening ??= Promise.all([
      listen<Download>("ai-download", (e) => {
        if (get().download?.id === e.payload.id) set({ download: e.payload });
      }),
      listen<{ percent: number }>("ai-transcribe", (e) => {
        const current = get().listening;
        if (current) set({ listening: { ...current, percent: e.payload.percent } });
      }),
    ]).catch(() => null);
  };
  return {
    models: [],
    loaded: false,
    download: null,
    listening: null,
    refresh: async () => {
      const models = await invoke<SpeechModel[]>("whisper_models");
      if (Array.isArray(models)) set({ models, loaded: true });
    },
    ensure: () => {
      if (get().loaded) return;
      attach();
      get()
        .refresh()
        .catch(() => undefined);
    },
    downloadModel: async (id) => {
      attach();
      set({ download: { id, received: 0 } });
      try {
        await invoke("download_whisper_model", { id });
      } catch (e) {
        throw new Error(message(e), { cause: e });
      } finally {
        set({ download: null });
        await get()
          .refresh()
          .catch(() => undefined);
      }
    },
    removeModel: async (id) => {
      try {
        await invoke("delete_whisper_model", { id });
      } catch (e) {
        throw new Error(message(e), { cause: e });
      } finally {
        await get()
          .refresh()
          .catch(() => undefined);
      }
    },
    cancel: () => void Promise.resolve(invoke("cancel_ai_job")).catch(() => undefined),
    setListening: (value) => {
      attach();
      set({ listening: value });
    },
  };
});

/** Languages offered for speech recognition, as Whisper's codes. The first entry lets the model decide. */
export const SPEECH_LANGUAGES: { code: string | null; name: string }[] = [
  { code: null, name: "Detect automatically" },
  { code: "id", name: "Indonesian" },
  { code: "en", name: "English" },
  { code: "ms", name: "Malay" },
  { code: "jv", name: "Javanese" },
  { code: "su", name: "Sundanese" },
  { code: "ar", name: "Arabic" },
  { code: "zh", name: "Chinese" },
  { code: "nl", name: "Dutch" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "hi", name: "Hindi" },
  { code: "it", name: "Italian" },
  { code: "ja", name: "Japanese" },
  { code: "ko", name: "Korean" },
  { code: "pt", name: "Portuguese" },
  { code: "ru", name: "Russian" },
  { code: "es", name: "Spanish" },
  { code: "th", name: "Thai" },
  { code: "tr", name: "Turkish" },
  { code: "vi", name: "Vietnamese" },
];
