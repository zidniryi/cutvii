/**
 * The ONE place text styles live: the built-in presets, the user's own ("My styles"), the order they are
 * listed in (most recently used first) and what was last chosen for subtitles. Every place that offers
 * styles (the Text panel, the subtitle step, the inspector) reads and changes this store, so they always
 * agree. The user's part is a local UI preference of this machine: it is never written into a project.
 */
import { z } from "zod";
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { StylePresetSchema, TextStyleSchema, type StylePreset, type TextStyle } from "@/project/model";
import { STYLE_PRESETS } from "@/timeline/textStyles";

export const PREFS_KEY = "cutvii.text-styles.v1";
export const MAX_OWN_STYLES = 200;
export const MAX_STYLE_NAME = 40;
/** The key under which a customised "Default" subtitle look is kept. */
export const DEFAULT_STYLE = "default";

const CustomSchema = z.object({ style: TextStyleSchema, fade: z.number().min(0).max(5).optional() }).strict();
export type CustomStyle = z.infer<typeof CustomSchema>;

/** What is kept between sessions. Read back as untrusted input: anything that does not fit is dropped. */
const PrefsSchema = z
  .object({
    mine: StylePresetSchema.array().max(MAX_OWN_STYLES),
    order: z.string().max(80).array().max(500),
    subtitleStyleId: z.string().max(80).nullable(),
    subtitleCustom: z.record(z.string().max(80), CustomSchema),
    /** Where subtitles are put (shares of the canvas); null for the usual place. */
    subtitlePosition: z
      .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
      .strict()
      .nullable()
      .default(null),
    /** Subtitle font size as a share of the canvas height; null for the usual size. */
    subtitleSize: z.number().min(0.02).max(0.2).nullable().default(null),
    /** Anchors and guides keep texts inside the safe margin. */
    safeMargin: z.boolean().default(true),
  })
  .strict();
type Prefs = z.infer<typeof PrefsSchema>;

const EMPTY: Prefs = {
  mine: [],
  order: [],
  subtitleStyleId: null,
  subtitleCustom: {},
  subtitlePosition: null,
  subtitleSize: null,
  safeMargin: true,
};
const BUILT_IN = new Set(STYLE_PRESETS.map((p) => p.id));

function readPrefs(): Prefs {
  try {
    const text = typeof localStorage === "undefined" ? null : localStorage.getItem(PREFS_KEY);
    if (!text || text.length > 2_000_000) return EMPTY;
    const parsed = PrefsSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return EMPTY;
    // a style of the user's can never take the place of a built-in one, or of another of theirs
    const seen = new Set(BUILT_IN);
    const mine = parsed.data.mine.filter(
      (p) => !seen.has(p.id) && seen.add(p.id) && p.name.length <= MAX_STYLE_NAME,
    );
    return { ...parsed.data, mine };
  } catch {
    return EMPTY;
  }
}

function writePrefs(prefs: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* storage full or unavailable: the styles still work for this session */
  }
}

export interface StyleImportSummary {
  added: string[];
  skipped: string[];
  problems: { file: string; message: string }[];
  missingFonts: string[];
}

const StyleImportSchema = z.object({
  styles: z
    .array(z.object({ name: z.string(), style: z.unknown(), fade: z.number().optional() }).passthrough())
    .max(50),
  problems: z.array(z.tuple([z.string().max(300), z.string().max(300)])).max(50),
});

interface StyleState extends Prefs {
  /** The style being edited in the editor sheet (always one of the user's own), if any. */
  editingId: string | null;
  setEditing: (id: string | null) => void;
  /** A style was chosen somewhere: it moves to the front of every list. */
  use: (id: string) => void;
  resetOrder: () => void;
  /** Make a new style of the user's, starting from `from` (or a plain one). Returns its id. */
  create: (from?: StylePreset) => string | null;
  /** Save a look under a name as one of the user's styles. Returns its id, or why it could not be saved. */
  saveAs: (name: string, style: TextStyle, fade?: number) => { id: string } | { problem: string };
  rename: (id: string, name: string) => string | null;
  update: (id: string, change: CustomStyle) => void;
  remove: (id: string) => void;
  setSubtitleStyle: (id: string | null) => void;
  /** Keep (or with `null` drop) the user's changes to a style as used for subtitles. */
  setSubtitleCustom: (id: string, custom: CustomStyle | null) => void;
  setSubtitlePosition: (at: { x: number; y: number } | null) => void;
  setSubtitleSize: (share: number | null) => void;
  setSafeMargin: (on: boolean) => void;
  /** Replace the whole list of the user's styles (a pack import). Each one is checked; bad ones are dropped. */
  setMine: (mine: StylePreset[]) => void;
  /** Write one of the user's styles to a `.cutvii-textstyle` file they pick. Path, or null if cancelled. */
  exportFile: (id: string) => Promise<string | null>;
  /**
   * Pick `.cutvii-textstyle` files (native dialog, in Rust) and add them to My styles. Rust checks every
   * file as untrusted input and each style is checked again here. A taken name gets a number; a style the
   * user already has, name and look, is not added twice. Fonts are never in the file: `missingFonts` names
   * the ones this computer does not have (those texts are drawn in the default font until it is installed).
   */
  importFiles: (installedFonts: string[]) => Promise<StyleImportSummary>;
  /** For tests: forget everything of the user's. */
  reset: () => void;
}

const prefsOf = (s: Prefs): Prefs => ({
  mine: s.mine,
  order: s.order,
  subtitleStyleId: s.subtitleStyleId,
  subtitleCustom: s.subtitleCustom,
  subtitlePosition: s.subtitlePosition,
  subtitleSize: s.subtitleSize,
  safeMargin: s.safeMargin,
});

export const useTextStyleStore = create<StyleState>((set, get) => {
  /** Change the kept part and save it. */
  const keep = (change: (s: Prefs) => Partial<Prefs>) => {
    set((s) => change(s));
    writePrefs(prefsOf(get()));
  };
  const freeName = (wanted: string) => {
    const taken = new Set([...STYLE_PRESETS, ...get().mine].map((p) => p.name.toLowerCase()));
    const base = wanted.trim().slice(0, MAX_STYLE_NAME - 4) || "My style";
    if (!taken.has(base.toLowerCase())) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
  };
  return {
    ...readPrefs(),
    editingId: null,
    setEditing: (editingId) => set({ editingId }),
    use: (id) => keep((s) => ({ order: [id, ...s.order.filter((x) => x !== id)].slice(0, 500) })),
    resetOrder: () => keep(() => ({ order: [] })),
    create: (from) => {
      if (get().mine.length >= MAX_OWN_STYLES) return null;
      const id = `my-${crypto.randomUUID()}`;
      const style: StylePreset = from
        ? {
            id,
            name: freeName(`${from.name} copy`),
            style: from.style,
            ...(from.fade ? { fade: from.fade } : {}),
          }
        : { id, name: freeName("My style"), style: { color: "#FFFFFF", bold: true } };
      keep((s) => ({ mine: [...s.mine, style], order: [id, ...s.order] }));
      return id;
    },
    saveAs: (name, style, fade) => {
      const wanted = name.trim();
      if (!wanted) return { problem: "A style needs a name" };
      if (wanted.length > MAX_STYLE_NAME)
        return { problem: `A name can be ${MAX_STYLE_NAME} characters at most` };
      if ([...STYLE_PRESETS, ...get().mine].some((p) => p.name.toLowerCase() === wanted.toLowerCase()))
        return { problem: "Another style already has that name" };
      if (get().mine.length >= MAX_OWN_STYLES) return { problem: "You have the most styles CutVii keeps" };
      const parsed = StylePresetSchema.safeParse({
        id: `my-${crypto.randomUUID()}`,
        name: wanted,
        style,
        ...(fade && fade > 0 ? { fade: Math.min(5, fade) } : {}),
      });
      if (!parsed.success) return { problem: "This look cannot be saved as a style" };
      keep((s) => ({ mine: [...s.mine, parsed.data], order: [parsed.data.id, ...s.order] }));
      return { id: parsed.data.id };
    },
    setMine: (list) => {
      const seen = new Set(BUILT_IN);
      const mine = list.slice(0, MAX_OWN_STYLES).flatMap((p) => {
        const r = StylePresetSchema.safeParse(p);
        return r.success && !seen.has(r.data.id) && seen.add(r.data.id) ? [r.data] : [];
      });
      const fresh = mine.filter((p) => !get().mine.some((old) => old.id === p.id)).map((p) => p.id);
      // new arrivals go to the front of every list, like a style that was just made
      keep((s) => ({
        mine,
        order: [...fresh, ...s.order.filter((id) => !fresh.includes(id))].slice(0, 500),
      }));
    },
    exportFile: async (id) => {
      const preset = get().mine.find((p) => p.id === id);
      if (!preset) throw new Error("Only your own styles can be exported; duplicate a built-in one first.");
      try {
        const path = await invoke<string | null>("export_text_style", {
          name: preset.name,
          style: preset.style,
          fade: preset.fade ?? null,
        });
        return path ?? null;
      } catch (e) {
        throw new Error(typeof e === "string" ? e : e instanceof Error ? e.message : "Failed", { cause: e });
      }
    },
    importFiles: async (installedFonts) => {
      let raw: unknown;
      try {
        raw = await invoke("import_text_styles");
      } catch (e) {
        throw new Error(typeof e === "string" ? e : e instanceof Error ? e.message : "Failed", { cause: e });
      }
      const found = StyleImportSchema.safeParse(raw);
      if (!found.success) throw new Error("The import returned something unexpected.");
      const summary: StyleImportSummary = {
        added: [],
        skipped: [],
        problems: found.data.problems.map(([file, message]) => ({ file, message })),
        missingFonts: [],
      };
      const have = new Set(installedFonts.map((f) => f.toLowerCase()));
      for (const item of found.data.styles) {
        const name = item.name.trim().slice(0, MAX_STYLE_NAME);
        const parsed = StylePresetSchema.safeParse({
          id: `my-${crypto.randomUUID()}`,
          name: name || "Style",
          style: item.style,
          ...(item.fade && item.fade > 0 ? { fade: item.fade } : {}),
        });
        if (!parsed.success) {
          summary.problems.push({ file: name || "style", message: "not a valid text style" });
          continue;
        }
        const same = [...STYLE_PRESETS, ...get().mine].find(
          (p) =>
            p.name.toLowerCase() === parsed.data.name.toLowerCase() &&
            JSON.stringify(p.style) === JSON.stringify(parsed.data.style),
        );
        if (same) {
          summary.skipped.push(same.name);
          continue;
        }
        if (get().mine.length >= MAX_OWN_STYLES) {
          summary.problems.push({ file: parsed.data.name, message: "you have the most styles CutVii keeps" });
          continue;
        }
        // keep both: nothing built in or of the user's is ever replaced
        const style = { ...parsed.data, name: freeName(parsed.data.name), source: "imported" as const };
        keep((s) => ({ mine: [...s.mine, style], order: [style.id, ...s.order] }));
        summary.added.push(style.name);
        const font = style.style.font;
        if (font && !have.has(font.toLowerCase()) && !summary.missingFonts.includes(font)) {
          summary.missingFonts.push(font);
        }
      }
      return summary;
    },
    rename: (id, name) => {
      const wanted = name.trim();
      if (BUILT_IN.has(id)) return "Built-in styles cannot be renamed; duplicate it first";
      if (!wanted) return "A style needs a name";
      if (wanted.length > MAX_STYLE_NAME) return `A name can be ${MAX_STYLE_NAME} characters at most`;
      const clash = [...STYLE_PRESETS, ...get().mine].some(
        (p) => p.id !== id && p.name.toLowerCase() === wanted.toLowerCase(),
      );
      if (clash) return "Another style already has that name";
      keep((s) => ({ mine: s.mine.map((p) => (p.id === id ? { ...p, name: wanted } : p)) }));
      return null;
    },
    update: (id, change) => {
      if (BUILT_IN.has(id) || !CustomSchema.safeParse(change).success) return;
      keep((s) => ({
        mine: s.mine.map((p) => {
          if (p.id !== id) return p;
          const next: StylePreset = { id: p.id, name: p.name, style: change.style };
          if (change.fade) next.fade = change.fade;
          return next;
        }),
      }));
    },
    remove: (id) => {
      if (BUILT_IN.has(id)) return;
      keep((s) => {
        const subtitleCustom = { ...s.subtitleCustom };
        delete subtitleCustom[id];
        return {
          mine: s.mine.filter((p) => p.id !== id),
          order: s.order.filter((x) => x !== id),
          subtitleStyleId: s.subtitleStyleId === id ? null : s.subtitleStyleId,
          subtitleCustom,
        };
      });
      if (get().editingId === id) set({ editingId: null });
    },
    setSubtitleStyle: (subtitleStyleId) => keep(() => ({ subtitleStyleId })),
    setSubtitlePosition: (at) =>
      keep(() => ({
        subtitlePosition:
          at && [at.x, at.y].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)
            ? { x: at.x, y: at.y }
            : null,
      })),
    setSubtitleSize: (share) =>
      keep(() => ({
        subtitleSize: share !== null && Number.isFinite(share) ? Math.min(0.2, Math.max(0.02, share)) : null,
      })),
    setSafeMargin: (safeMargin) => keep(() => ({ safeMargin })),
    setSubtitleCustom: (id, custom) =>
      keep((s) => {
        const subtitleCustom = { ...s.subtitleCustom };
        if (custom && CustomSchema.safeParse(custom).success) subtitleCustom[id] = custom;
        else delete subtitleCustom[id];
        return { subtitleCustom };
      }),
    reset: () => {
      set({ ...EMPTY, editingId: null });
      writePrefs(EMPTY);
    },
  };
});

export const isBuiltIn = (id: string) => BUILT_IN.has(id);

/** Every style, built-in first, then the user's own, in their original order. */
export const allStyles = (s: Pick<StyleState, "mine">): StylePreset[] => [...STYLE_PRESETS, ...s.mine];

/** Every style as it is listed: the most recently used first, the rest in their original order. */
export function orderedStyles(s: Pick<StyleState, "mine" | "order">): StylePreset[] {
  const all = allStyles(s);
  const byId = new Map(all.map((p) => [p.id, p]));
  const recent = s.order.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  const used = new Set(recent.map((p) => p.id));
  return [...recent, ...all.filter((p) => !used.has(p.id))];
}

export const styleById = (s: Pick<StyleState, "mine">, id: string | null | undefined) =>
  id ? allStyles(s).find((p) => p.id === id) : undefined;

/** The plain look subtitles have when no style is chosen. */
export const PLAIN_SUBTITLE: TextStyle = { color: "#FFFFFF", bold: true };

/**
 * The style subtitles will be made in right now: the chosen style (or the plain look) with the user's
 * customisation of it, if they made one. The subtitle step previews exactly this, and generation uses it.
 */
export function subtitleStyleOf(s: Pick<StyleState, "mine" | "subtitleStyleId" | "subtitleCustom">): {
  id: string;
  name: string;
  style: TextStyle;
  fade?: number;
  customised: boolean;
} {
  const chosen = styleById(s, s.subtitleStyleId);
  const id = chosen?.id ?? DEFAULT_STYLE;
  const base = chosen ?? { id, name: "Default", style: PLAIN_SUBTITLE };
  const custom = s.subtitleCustom[id];
  return custom
    ? { id, name: base.name, style: custom.style, fade: custom.fade, customised: true }
    : { id, name: base.name, style: base.style, fade: base.fade, customised: false };
}
