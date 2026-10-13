import { create } from "zustand";

const KEY = "cutvii.inspector-sections.v1";

/** The sections the user closed. Kept on this computer, not in the project. */
function load(): Record<string, true> {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
    const ids: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(ids)) return {};
    return Object.fromEntries(ids.filter((id) => typeof id === "string").map((id) => [id, true]));
  } catch {
    return {};
  }
}

interface SectionState {
  closed: Record<string, true>;
  toggle: (id: string) => void;
}

/** Which inspector sections are folded away. Every section is open until it is closed once. */
export const useSectionStore = create<SectionState>((set, get) => ({
  closed: load(),
  toggle: (id) => {
    const closed = { ...get().closed };
    if (closed[id]) delete closed[id];
    else closed[id] = true;
    set({ closed });
    try {
      localStorage.setItem(KEY, JSON.stringify(Object.keys(closed)));
    } catch {
      // no storage: the choice lasts until the app closes
    }
  },
}));
