import { create } from "zustand";
import { z } from "zod";
import { CanvasSchema } from "@/project/model";

const KEY = "cutvii.canvasTemplates.v1";
export const MAX_TEMPLATES = 24;

const SavedSchema = CanvasSchema.extend({ id: z.string().min(1), name: z.string().trim().min(1).max(40) });
export type SavedTemplate = z.infer<typeof SavedSchema>;

/** Read from localStorage; anything unreadable or invalid is dropped, never thrown. */
export function loadTemplates(storage: Pick<Storage, "getItem"> = localStorage): SavedTemplate[] {
  try {
    const raw = JSON.parse(storage.getItem(KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((item) => {
      const r = SavedSchema.safeParse(item);
      return r.success ? [r.data] : [];
    });
  } catch {
    return [];
  }
}

function persist(list: SavedTemplate[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage full or unavailable: the template still works for this session */
  }
}

interface TemplateState {
  templates: SavedTemplate[];
  /** Saves (or replaces one with the same name). Returns an error message instead of throwing. */
  save: (name: string, size: { width: number; height: number; fps: number }) => string | null;
  remove: (id: string) => void;
}

export const useTemplateStore = create<TemplateState>((set, get) => ({
  templates: loadTemplates(),
  save: (name, size) => {
    const clean = name.trim();
    if (!clean) return "Give the template a name";
    if (clean.length > 40) return "Template names can be at most 40 characters";
    const entry = SavedSchema.safeParse({ ...size, id: crypto.randomUUID(), name: clean });
    if (!entry.success) return entry.error.issues[0].message;

    const others = get().templates.filter((t) => t.name.toLowerCase() !== clean.toLowerCase());
    if (others.length >= MAX_TEMPLATES) return `You can keep up to ${MAX_TEMPLATES} templates`;
    const next = [...others, entry.data];
    persist(next);
    set({ templates: next });
    return null;
  },
  remove: (id) => {
    const next = get().templates.filter((t) => t.id !== id);
    persist(next);
    set({ templates: next });
  },
}));
