import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { parseWaveform, type Waveform } from "@/timeline/waveform";

export type WaveformEntry =
  | { status: "loading" }
  | { status: "ready"; data: Waveform }
  /** The file has no audio. */
  | { status: "none" }
  | { status: "failed" };

/** Files being analysed at once; the rest wait their turn. */
export const WAVEFORM_CONCURRENCY = 2;

interface WaveformState {
  /** Keyed by the media file's path. Peaks are made and cached by Rust; the original is only read. */
  entries: Record<string, WaveformEntry>;
  /** Ask for a file's waveform once. Safe to call on every render. */
  ensure: (path: string) => void;
}

/** Rust returns the cached peak file's path (null without audio); the peaks come over the asset protocol. */
async function load(path: string): Promise<WaveformEntry> {
  const file = await invoke<string | null>("prepare_waveform", { path });
  if (typeof file !== "string") return { status: "none" };
  const response = await fetch(convertFileSrc(file));
  if (!response.ok) throw new Error(`waveform request failed: ${response.status}`);
  return { status: "ready", data: parseWaveform(await response.arrayBuffer()) };
}

export const useWaveformStore = create<WaveformState>((set, get) => {
  const waiting: string[] = [];
  let active = 0;

  const pump = () => {
    while (active < WAVEFORM_CONCURRENCY && waiting.length > 0) {
      const path = waiting.shift()!;
      active += 1;
      load(path)
        .catch((): WaveformEntry => ({ status: "failed" }))
        .then((entry) => {
          active -= 1;
          set((s) => ({ entries: { ...s.entries, [path]: entry } }));
          pump();
        });
    }
  };

  return {
    entries: {},
    ensure: (path) => {
      if (get().entries[path]) return;
      set((s) => ({ entries: { ...s.entries, [path]: { status: "loading" } } }));
      waiting.push(path);
      pump();
    },
  };
});
