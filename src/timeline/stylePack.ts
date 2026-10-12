/**
 * Style packs (section 6x): the user's own text styles, colour presets and export presets in one
 * `.cutvii-pack` file. Rust reads and checks the file (`media/pack.rs`); here every item is checked AGAIN
 * with the same schemas the single items use, conflicts with what the user already has are worked out, and
 * the chosen items are put into My styles / My presets / My export presets.
 *
 * Built-in items are never exported and can never be overwritten. Fonts are never in a pack: a style only
 * names its font.
 */
import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import { ExportPresetSchema, type ExportPreset } from "@/export/presets";
import { StylePresetSchema, type StylePreset } from "@/project/model";
import { useColorPresetStore } from "@/store/colorPresets";
import { useExportPresetStore } from "@/store/exportPresets";
import { useTextStyleStore } from "@/store/textStyles";
import { LookSchema, LOOKS, type Look } from "./looks";
import { STYLE_PRESETS } from "./textStyles";

export type PackKind = "text" | "color" | "export";
export const KIND_LABEL: Record<PackKind, string> = {
  text: "Text styles",
  color: "Colour presets",
  export: "Export presets",
};

/** One item of a pack, already checked. `key` is unique inside the pack. */
export type PackItem =
  | { kind: "text"; key: string; value: StylePreset }
  | { kind: "color"; key: string; value: Look }
  | { kind: "export"; key: string; value: ExportPreset };

export interface Pack {
  name: string;
  author: string | null;
  notes: string | null;
  items: PackItem[];
  /** Items left out, by Rust or here, with the reason. Plain text. */
  problems: string[];
}

const CheckedPackSchema = z.object({
  name: z.string().min(1).max(80),
  author: z.string().max(80).nullable(),
  notes: z.string().max(2500).nullable(),
  textStyles: z.array(z.unknown()).max(200),
  colorPresets: z.array(z.unknown()).max(200),
  exportPresets: z.array(z.unknown()).max(200),
  problems: z.array(z.string().max(400)).max(700),
});

/** What Rust sends for a pack, checked item by item. Throws when it is not a pack at all. */
export function parsePack(raw: unknown): Pack {
  const outer = CheckedPackSchema.safeParse(raw);
  if (!outer.success) throw new Error("This is not a CutVii style pack.");
  const { data } = outer;
  const items: PackItem[] = [];
  const problems = [...data.problems];
  const nameOf = (v: unknown) =>
    typeof (v as { name?: unknown } | null)?.name === "string"
      ? (v as { name: string }).name.slice(0, 40)
      : "?";
  data.textStyles.forEach((v, i) => {
    const r = StylePresetSchema.safeParse(v);
    if (r.success) items.push({ kind: "text", key: `text-${i}`, value: r.data });
    else problems.push(`Text style “${nameOf(v)}” is not valid.`);
  });
  data.colorPresets.forEach((v, i) => {
    const o = v as { kind?: unknown; id?: unknown; name?: unknown; adjust?: unknown } | null;
    const r =
      o?.kind === "adjust" ? LookSchema.safeParse({ id: o.id, name: o.name, adjust: o.adjust }) : null;
    if (r?.success) items.push({ kind: "color", key: `color-${i}`, value: r.data });
    else problems.push(`Colour preset “${nameOf(v)}” is not valid.`);
  });
  data.exportPresets.forEach((v, i) => {
    const r = ExportPresetSchema.safeParse(v);
    if (r.success) items.push({ kind: "export", key: `export-${i}`, value: r.data });
    else problems.push(`Export preset “${nameOf(v)}” is not valid.`);
  });
  return { name: data.name, author: data.author, notes: data.notes, items, problems };
}

// ---------------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------------

export interface PackSelection {
  name: string;
  author: string;
  notes: string;
  textIds: string[];
  colorIds: string[];
  exportIds: string[];
}

/** The pack to write: only the user's own items that were ticked. Built-in items are never included. */
export function buildPack(selection: PackSelection) {
  const text = useTextStyleStore.getState().mine.filter((p) => selection.textIds.includes(p.id));
  const color = useColorPresetStore.getState().mine.filter((p) => selection.colorIds.includes(p.id));
  const exports = useExportPresetStore.getState().mine.filter((p) => selection.exportIds.includes(p.id));
  return {
    format: "cutvii-pack",
    version: 1,
    name: selection.name.trim(),
    ...(selection.author.trim() ? { author: selection.author.trim() } : {}),
    ...(selection.notes.trim() ? { notes: selection.notes.trim() } : {}),
    textStyles: text.map((p) => ({
      id: p.id,
      name: p.name,
      style: p.style,
      ...(p.fade ? { fade: p.fade } : {}),
    })),
    colorPresets: color.map((p) => ({ id: p.id, name: p.name, kind: "adjust", adjust: p.adjust })),
    exportPresets: exports.map((p) => ({ id: p.id, name: p.name, options: p.options })),
  };
}

const message = (e: unknown) =>
  (typeof e === "string" ? e : e instanceof Error ? e.message : "Failed").replace(/^invalid input: /, "");

/** Save a pack through Rust's save dialog. Resolves to the path, or null when cancelled. */
export async function exportPack(selection: PackSelection): Promise<string | null> {
  try {
    return (await invoke<string | null>("export_style_pack", { pack: buildPack(selection) })) ?? null;
  } catch (e) {
    throw new Error(message(e), { cause: e });
  }
}

/** Pick a pack with Rust's open dialog and check it. Null when cancelled. */
export async function openPack(): Promise<Pack | null> {
  let raw: unknown;
  try {
    raw = await invoke("open_style_pack");
  } catch (e) {
    throw new Error(message(e), { cause: e });
  }
  return raw == null ? null : parsePack(raw);
}

/** Read a pack that was dropped on the window (Rust holds the path; only its drop id is known here). */
export async function readDroppedPack(id: number): Promise<Pack> {
  try {
    return parsePack(await invoke("read_dropped_pack", { id }));
  } catch (e) {
    throw new Error(message(e), { cause: e });
  }
}

export const isPackFile = (name: string) => name.toLowerCase().endsWith(".cutvii-pack");

// ---------------------------------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------------------------------

/**
 * How an item clashes with what is already here:
 * - "own": one of the user's items has the same id or the same name;
 * - "builtin": a built-in style or look has that id or name (it can be kept beside it or skipped, never
 *   put in its place);
 * - "none".
 */
export type Conflict = "none" | "own" | "builtin";
/** What to do with a clashing item. "replace" is only possible for a clash with one of the user's own. */
export type Choice = "keep" | "skip" | "replace";

interface Named {
  id: string;
  name: string;
}
const lower = (s: string) => s.toLowerCase();
const clashes = (list: Named[], item: Named) =>
  list.find((p) => p.id === item.id) ?? list.find((p) => lower(p.name) === lower(item.name));

function listsFor(kind: PackKind): { mine: Named[]; builtIn: Named[] } {
  if (kind === "text") return { mine: useTextStyleStore.getState().mine, builtIn: STYLE_PRESETS };
  if (kind === "color") return { mine: useColorPresetStore.getState().mine, builtIn: LOOKS };
  return { mine: useExportPresetStore.getState().mine, builtIn: [] };
}

export function conflictOf(item: PackItem): Conflict {
  const { mine, builtIn } = listsFor(item.kind);
  if (clashes(mine, item.value)) return "own";
  if (clashes(builtIn, item.value)) return "builtin";
  return "none";
}

/** Fonts the pack's text styles name that are not among `installed`. */
export function missingFonts(items: PackItem[], installed: string[]): string[] {
  const have = new Set(installed.map(lower));
  const out: string[] = [];
  for (const item of items) {
    const font = item.kind === "text" ? item.value.style.font : undefined;
    if (font && !have.has(lower(font)) && !out.includes(font)) out.push(font);
  }
  return out;
}

const NAME_LIMIT = 40;
function freeName(wanted: string, taken: Set<string>): string {
  if (!taken.has(lower(wanted))) return wanted;
  const base = wanted.slice(0, NAME_LIMIT - 4);
  for (let n = 2; ; n++) if (!taken.has(lower(`${base} ${n}`))) return `${base} ${n}`;
}

/**
 * One kind's list after the import. Pure.
 * - skip: nothing changes;
 * - replace (clash with the user's own): that item takes the imported values but keeps ITS id, so whatever
 *   points at it (the subtitle style, for one) still does;
 * - keep, or no clash: added as a new item; an id that is taken gets a fresh one, a name that is taken a
 *   number.
 * A built-in item is never in `mine`, so nothing here can touch one.
 */
export function mergeImported<T extends Named>(
  mine: T[],
  builtIn: Named[],
  incoming: { value: T; choice: Choice }[],
  newId: () => string = () => `my-${crypto.randomUUID()}`,
): { next: T[]; added: string[]; replaced: string[]; skipped: string[] } {
  let next = [...mine];
  const added: string[] = [];
  const replaced: string[] = [];
  const skipped: string[] = [];
  for (const { value, choice } of incoming) {
    const own = clashes(next, value);
    if (choice === "skip") {
      skipped.push(value.name);
      continue;
    }
    if (choice === "replace" && own) {
      // the name must still be free among the others (and never a built-in's)
      const others = new Set([...next.filter((p) => p.id !== own.id), ...builtIn].map((p) => lower(p.name)));
      const name = freeName(value.name, others);
      next = next.map((p) => (p.id === own.id ? { ...value, id: own.id, name, source: "imported" } : p));
      replaced.push(name);
      continue;
    }
    const all = [...next, ...builtIn];
    const id = all.some((p) => p.id === value.id) || !value.id.startsWith("my-") ? newId() : value.id;
    const name = freeName(value.name, new Set(all.map((p) => lower(p.name))));
    next.push({ ...value, id, name, source: "imported" });
    added.push(name);
  }
  return { next, added, replaced, skipped };
}

export interface ImportOutcome {
  added: string[];
  replaced: string[];
  skipped: string[];
}

/** Put the ticked items into the three stores. `choices` are by item key; a missing one means "keep". */
export function importItems(items: PackItem[], choices: Record<string, Choice>): ImportOutcome {
  const outcome: ImportOutcome = { added: [], replaced: [], skipped: [] };
  const take = <T extends Named>(kind: PackKind, mine: T[], builtIn: Named[], set: (next: T[]) => void) => {
    const incoming = items
      .filter((i) => i.kind === kind)
      .map((i) => ({ value: i.value as unknown as T, choice: choices[i.key] ?? "keep" }));
    if (incoming.length === 0) return;
    const r = mergeImported(mine, builtIn, incoming);
    set(r.next);
    outcome.added.push(...r.added);
    outcome.replaced.push(...r.replaced);
    outcome.skipped.push(...r.skipped);
  };
  take("text", useTextStyleStore.getState().mine, STYLE_PRESETS, (next) =>
    useTextStyleStore.getState().setMine(next),
  );
  take("color", useColorPresetStore.getState().mine, LOOKS, (next) =>
    useColorPresetStore.getState().setMine(next),
  );
  take("export", useExportPresetStore.getState().mine, [], (next) =>
    useExportPresetStore.getState().setMine(next),
  );
  return outcome;
}
