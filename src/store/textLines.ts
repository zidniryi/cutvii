/**
 * How many lines each text really takes when drawn (Rust's own wrapping, `text_line_counts`), for the
 * "Too long" warning. Asked for in batches, remembered per text look and canvas size.
 */
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { TextSpec } from "@/project/model";

export const lineKey = (spec: TextSpec, width: number, height: number) =>
  `${width}x${height}:${JSON.stringify(spec)}`;

interface TextLinesState {
  lines: Record<string, number>;
  /** Make sure the line count of `spec` is known (or being found out). */
  want: (spec: TextSpec, width: number, height: number) => void;
}

/** Waiting to be asked, per canvas size. */
let queued = new Map<string, { width: number; height: number; specs: Map<string, TextSpec> }>();
const asked = new Set<string>();

/** Line counts of many texts at once (one Rust call per canvas size). */
export async function lineCounts(specs: TextSpec[], width: number, height: number): Promise<number[]> {
  if (specs.length === 0) return [];
  const counts = await invoke<number[]>("text_line_counts", { specs, width, height });
  const lines = { ...useTextLines.getState().lines };
  specs.forEach((s, i) => (lines[lineKey(s, width, height)] = counts[i]));
  useTextLines.setState({ lines });
  return counts;
}

function flush() {
  const batches = queued;
  queued = new Map();
  for (const { width, height, specs } of batches.values()) {
    const keys = [...specs.keys()];
    lineCounts([...specs.values()], width, height).catch(() => {
      // a text that cannot be measured simply gets no warning; it may be asked again later
      for (const k of keys) asked.delete(k);
    });
  }
}

export const useTextLines = create<TextLinesState>(() => ({
  lines: {},
  want: (spec, width, height) => {
    const key = lineKey(spec, width, height);
    if (asked.has(key)) return;
    asked.add(key);
    const size = `${width}x${height}`;
    if (queued.size === 0) queueMicrotask(flush);
    const batch = queued.get(size) ?? { width, height, specs: new Map() };
    batch.specs.set(key, spec);
    queued.set(size, batch);
  },
}));

/** For tests: forget every count. */
export function resetTextLines() {
  asked.clear();
  queued = new Map();
  useTextLines.setState({ lines: {} });
}
