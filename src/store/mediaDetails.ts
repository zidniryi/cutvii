import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

/** Facts about a media file read by FFprobe in Rust (absent ones are left out). Never saved in the project. */
export interface MediaDetails {
  videoCodec?: string;
  audioCodec?: string;
  audioChannels?: number;
  /** Hz. */
  sampleRate?: number;
  /** Bits per second for the whole file. */
  bitRate?: number;
  container?: string;
  /** HDR or wide-colour footage (the colour tools assume standard dynamic range). */
  hdr?: boolean;
  sizeBytes: number;
}

export type DetailsEntry =
  { status: "loading" } | { status: "ready"; details: MediaDetails } | { status: "failed" };

interface DetailsState {
  /** Keyed by the media file's path. */
  entries: Record<string, DetailsEntry>;
  /** Ask for a file's details once. Safe to call on every render. */
  ensure: (path: string) => void;
  /** Forget a file (after it was replaced), so it is read again next time. */
  forget: (path: string) => void;
}

export const useMediaDetailsStore = create<DetailsState>((set, get) => ({
  entries: {},
  ensure: (path) => {
    if (get().entries[path]) return;
    const put = (entry: DetailsEntry) => set((s) => ({ entries: { ...s.entries, [path]: entry } }));
    put({ status: "loading" });
    Promise.resolve(invoke<MediaDetails>("media_details", { path })).then(
      (details) =>
        put(
          details && typeof details.sizeBytes === "number"
            ? { status: "ready", details }
            : { status: "failed" },
        ),
      () => put({ status: "failed" }),
    );
  },
  forget: (path) =>
    set((s) => {
      const entries = { ...s.entries };
      delete entries[path];
      return { entries };
    }),
}));

/** 1536 -> "1.5 KB", 3_400_000 -> "3.2 MB". Binary units, one decimal below 100. */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 || value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** 8_123_456 -> "8.1 Mbit/s", 128_000 -> "128 kbit/s". */
export function formatBitRate(bitsPerSecond: number): string {
  return bitsPerSecond >= 1_000_000
    ? `${(bitsPerSecond / 1_000_000).toFixed(1)} Mbit/s`
    : `${Math.round(bitsPerSecond / 1000)} kbit/s`;
}

const CHANNELS: Record<number, string> = { 1: "mono", 2: "stereo", 6: "5.1", 8: "7.1" };
export const channelLabel = (channels: number) => CHANNELS[channels] ?? `${channels} channels`;
