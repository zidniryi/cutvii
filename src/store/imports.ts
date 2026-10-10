import { create } from "zustand";

export type JobState = "queued" | "reading" | "ready" | "failed" | "skipped";

export interface ImportJob {
  id: string;
  name: string;
  state: JobState;
  /** Why it failed or was skipped, in plain language. */
  message?: string;
}

interface ImportsState {
  /** Placeholder cards: files that are waiting, being read, or that could not be imported. */
  jobs: ImportJob[];
  /** An OS drag is currently over the window. */
  hovering: boolean;
  addJobs: (jobs: Pick<ImportJob, "id" | "name">[]) => void;
  update: (id: string, patch: Partial<Omit<ImportJob, "id">>) => void;
  remove: (id: string) => void;
  clearFinished: () => void;
  setHovering: (hovering: boolean) => void;
}

export const useImportsStore = create<ImportsState>((set) => ({
  jobs: [],
  hovering: false,
  addJobs: (jobs) =>
    set((s) => ({ jobs: [...s.jobs, ...jobs.map((j) => ({ ...j, state: "queued" as const }))] })),
  update: (id, patch) => set((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)) })),
  remove: (id) => set((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) })),
  clearFinished: () =>
    set((s) => ({ jobs: s.jobs.filter((j) => j.state !== "failed" && j.state !== "skipped") })),
  setHovering: (hovering) => set({ hovering }),
}));
