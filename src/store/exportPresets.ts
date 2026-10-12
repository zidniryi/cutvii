import { create } from "zustand";
import type { ExportOptions } from "@/export/options";
import {
  ExportOptionsSchema,
  ExportPresetSchema,
  MAX_EXPORT_PRESET_NAME,
  MAX_EXPORT_PRESETS,
  type ExportPreset,
} from "@/export/presets";

export const EXPORT_PRESETS_KEY = "cutvii.export-presets.v1";

/** Read back as untrusted input: anything that does not fit, or a second preset with the same id, is dropped. */
function read(): ExportPreset[] {
  try {
    const text = typeof localStorage === "undefined" ? null : localStorage.getItem(EXPORT_PRESETS_KEY);
    if (!text || text.length > 500_000) return [];
    const raw: unknown = JSON.parse(text);
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    return raw
      .slice(0, MAX_EXPORT_PRESETS)
      .map((item) => ExportPresetSchema.safeParse(item))
      .flatMap((r) => (r.success && !seen.has(r.data.id) && seen.add(r.data.id) ? [r.data] : []));
  } catch {
    return [];
  }
}

function write(mine: ExportPreset[]) {
  try {
    localStorage.setItem(EXPORT_PRESETS_KEY, JSON.stringify(mine));
  } catch {
    /* storage full or unavailable: the presets still work for this session */
  }
}

interface ExportPresetState {
  mine: ExportPreset[];
  /** Save export options under a name. Returns the new id, or why it could not be saved. */
  save: (name: string, options: ExportOptions) => { id: string } | { problem: string };
  /** Returns a message when the name cannot be used. */
  rename: (id: string, name: string) => string | null;
  remove: (id: string) => void;
  /** Replace the whole list (a pack import). Each preset is checked; bad ones are dropped. */
  setMine: (mine: ExportPreset[]) => void;
  /** For tests: read the stored presets again. */
  reset: () => void;
}

export const useExportPresetStore = create<ExportPresetState>((set, get) => {
  const keep = (mine: ExportPreset[]) => {
    set({ mine });
    write(mine);
  };
  const nameProblem = (name: string, except?: string): string | null => {
    if (!name) return "Give the preset a name.";
    if (name.length > MAX_EXPORT_PRESET_NAME)
      return `A name can be ${MAX_EXPORT_PRESET_NAME} characters at most.`;
    if (get().mine.some((p) => p.id !== except && p.name.toLowerCase() === name.toLowerCase()))
      return "Another preset already has that name.";
    return null;
  };
  return {
    mine: read(),
    save: (rawName, options) => {
      const name = rawName.trim();
      const problem = nameProblem(name);
      if (problem) return { problem };
      const checked = ExportOptionsSchema.safeParse(options);
      if (!checked.success) return { problem: "These export settings cannot be saved as a preset." };
      if (get().mine.length >= MAX_EXPORT_PRESETS)
        return { problem: "You have the most presets CutVii keeps." };
      const id = `my-${crypto.randomUUID()}`;
      keep([...get().mine, { id, name, options: checked.data }]);
      return { id };
    },
    rename: (id, rawName) => {
      const name = rawName.trim();
      if (!get().mine.some((p) => p.id === id)) return "That preset no longer exists.";
      const problem = nameProblem(name, id);
      if (problem) return problem;
      keep(get().mine.map((p) => (p.id === id ? { ...p, name } : p)));
      return null;
    },
    remove: (id) => keep(get().mine.filter((p) => p.id !== id)),
    setMine: (list) => {
      const seen = new Set<string>();
      keep(
        list.slice(0, MAX_EXPORT_PRESETS).flatMap((p) => {
          const r = ExportPresetSchema.safeParse(p);
          return r.success && !seen.has(r.data.id) && seen.add(r.data.id) ? [r.data] : [];
        }),
      );
    },
    reset: () => set({ mine: read() }),
  };
});
