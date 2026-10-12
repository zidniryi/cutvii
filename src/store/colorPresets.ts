/**
 * The user's own colour presets: saved sets of the Adjust values. Kept in local preferences (never in the
 * project), read back as untrusted input, and usable on any clip like a built-in look.
 */
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { ColorAdjust } from "@/project/model";
import { z } from "zod";
import { isGraded, sameColor } from "@/timeline/color";
import { LookSchema, LOOKS, type Look } from "@/timeline/looks";

export const COLOR_PRESETS_KEY = "cutvii.color-presets.v1";
export const MAX_OWN_PRESETS = 200;
export const MAX_PRESET_NAME = 40;

const BUILT_IN = new Set(LOOKS.map((l) => l.id));
export const isOwnPreset = (id: string) => !BUILT_IN.has(id);

function read(): Look[] {
  try {
    const text = typeof localStorage === "undefined" ? null : localStorage.getItem(COLOR_PRESETS_KEY);
    if (!text || text.length > 1_000_000) return [];
    const parsed = LookSchema.array().max(MAX_OWN_PRESETS).safeParse(JSON.parse(text));
    if (!parsed.success) return [];
    // one of the user's can never take the place of a built-in look, or of another of theirs
    const seen = new Set(BUILT_IN);
    return parsed.data.filter((p) => !seen.has(p.id) && seen.add(p.id) && isGraded(p.adjust));
  } catch {
    return [];
  }
}

function write(mine: Look[]) {
  try {
    localStorage.setItem(COLOR_PRESETS_KEY, JSON.stringify(mine));
  } catch {
    /* storage full or unavailable: the presets still work for this session */
  }
}

export interface ImportSummary {
  added: string[];
  /** Already there with the same name and values. */
  skipped: string[];
  /** File name (or preset name) and why it was refused. */
  problems: { file: string; message: string }[];
}

const ImportSchema = z.object({
  presets: z.array(z.object({ name: z.string(), adjust: z.unknown() })).max(50),
  problems: z.array(z.tuple([z.string().max(300), z.string().max(300)])).max(50),
});

interface PresetState {
  mine: Look[];
  /** Save colour values as a new preset. Returns its id, or a message saying why not. */
  save: (name: string, adjust: ColorAdjust) => { id: string } | { problem: string };
  /** Returns a message when the name cannot be used. */
  rename: (id: string, name: string) => string | null;
  duplicate: (id: string) => string | null;
  remove: (id: string) => void;
  /** Write a preset to a `.cutviipreset` file the user picks. Resolves to the path, or null if cancelled. */
  exportFile: (id: string) => Promise<string | null>;
  /**
   * Pick `.cutviipreset` files (native dialog, in Rust) and add what is in them to the user's presets. Rust
   * checks every file as untrusted input, and each preset is checked again here. A name that is taken gets
   * a number; a preset the user already has, name and values, is not added twice.
   */
  importFiles: () => Promise<ImportSummary>;
  /** For tests: forget everything and read the stored presets again. */
  reset: () => void;
}

const message = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : "Failed");

export const useColorPresetStore = create<PresetState>((set, get) => {
  const keep = (mine: Look[]) => {
    set({ mine });
    write(mine);
  };
  const taken = (except?: string) =>
    new Set([...LOOKS, ...get().mine].filter((p) => p.id !== except).map((p) => p.name.toLowerCase()));
  const nameProblem = (name: string, except?: string): string | null => {
    if (!name) return "Give the preset a name.";
    if (name.length > MAX_PRESET_NAME) return `A name can be ${MAX_PRESET_NAME} characters at most.`;
    if (taken(except).has(name.toLowerCase())) return "Another look already has that name.";
    return null;
  };
  const freeName = (wanted: string) => {
    const names = taken();
    const base = wanted.trim().slice(0, MAX_PRESET_NAME - 4) || "My preset";
    if (!names.has(base.toLowerCase())) return base;
    for (let n = 2; ; n++) if (!names.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
  };
  return {
    mine: read(),
    save: (rawName, adjust) => {
      const name = rawName.trim();
      const problem = nameProblem(name);
      if (problem) return { problem };
      if (!isGraded(adjust)) return { problem: "Change a colour slider first: there is nothing to save." };
      if (get().mine.length >= MAX_OWN_PRESETS) return { problem: "You have the most presets CutVii keeps." };
      const id = `my-${crypto.randomUUID()}`;
      keep([...get().mine, { id, name, adjust: { ...adjust } }]);
      return { id };
    },
    rename: (id, rawName) => {
      const name = rawName.trim();
      if (!get().mine.some((p) => p.id === id)) return "Built-in looks cannot be renamed.";
      const problem = nameProblem(name, id);
      if (problem) return problem;
      keep(get().mine.map((p) => (p.id === id ? { ...p, name } : p)));
      return null;
    },
    duplicate: (id) => {
      const from = [...LOOKS, ...get().mine].find((p) => p.id === id);
      if (!from || get().mine.length >= MAX_OWN_PRESETS) return null;
      const copy = {
        id: `my-${crypto.randomUUID()}`,
        name: freeName(`${from.name} copy`),
        adjust: from.adjust,
      };
      keep([...get().mine, copy]);
      return copy.id;
    },
    remove: (id) => keep(get().mine.filter((p) => p.id !== id)),
    exportFile: async (id) => {
      const preset = get().mine.find((p) => p.id === id);
      if (!preset) throw new Error("Only your own presets can be exported.");
      try {
        return (
          (await invoke<string | null>("export_color_preset", {
            name: preset.name,
            adjust: preset.adjust,
          })) ?? null
        );
      } catch (e) {
        throw new Error(message(e), { cause: e });
      }
    },
    importFiles: async () => {
      let raw: unknown;
      try {
        raw = await invoke("import_color_presets");
      } catch (e) {
        throw new Error(message(e), { cause: e });
      }
      const found = ImportSchema.safeParse(raw);
      if (!found.success) throw new Error("The import returned something unexpected.");
      const summary: ImportSummary = {
        added: [],
        skipped: [],
        problems: found.data.problems.map(([file, text]) => ({ file, message: text })),
      };
      for (const item of found.data.presets) {
        const name = item.name.trim().slice(0, MAX_PRESET_NAME);
        const parsed = LookSchema.safeParse({
          id: `my-${crypto.randomUUID()}`,
          name: name || "Preset",
          adjust: item.adjust,
        });
        if (!parsed.success || !isGraded(parsed.data.adjust)) {
          summary.problems.push({ file: name || "preset", message: "not a valid colour preset" });
          continue;
        }
        const same = [...LOOKS, ...get().mine].find(
          (p) =>
            p.name.toLowerCase() === parsed.data.name.toLowerCase() &&
            sameColor(p.adjust, parsed.data.adjust),
        );
        if (same) {
          summary.skipped.push(same.name);
          continue;
        }
        if (get().mine.length >= MAX_OWN_PRESETS) {
          summary.problems.push({
            file: parsed.data.name,
            message: "you have the most presets CutVii keeps",
          });
          continue;
        }
        // keep both: a taken name gets a number, nothing of the user's or built in is replaced
        const preset = { ...parsed.data, name: freeName(parsed.data.name) };
        keep([...get().mine, preset]);
        summary.added.push(preset.name);
      }
      return summary;
    },
    reset: () => set({ mine: read() }),
  };
});
