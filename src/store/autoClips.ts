/**
 * Auto clips wizard state (section 6u). It lives outside the dialog on purpose: closing the wizard never
 * stops a search and never loses a review, and the "Clips ready" badge reads from here.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { clipSpeed, findClip, sourceDuration } from "@/timeline/clips";
import {
  autoClipsBlocker,
  cutAtWord,
  moveCut,
  nudgeCut,
  withCut,
  type CutContext,
  type Edge,
  type TranscriptWord,
  DEFAULT_SETTINGS,
  lengthRange,
  searchClips,
  searchRequest,
  sortedClips,
  type AutoClipsSettings,
  type FoundClip,
  type ReviewClip,
  type SortBy,
  type SourceSpan,
  type Tier,
  type TranscriptSentence,
} from "@/timeline/autoClips";
import { useAiStore } from "./ai";
import { useMediaDetailsStore } from "./mediaDetails";
import { useProjectStore } from "./project";
import { useTextStyleStore } from "./textStyles";

/** The subtitle style Auto clips starts with on its first run (Hype Bar would need word timing). */
export const FIRST_STYLE = "orange-cut";
export const FIRST_STYLE_KEY = "cutvii.auto-clips.first-style";

export type WizardStep = 1 | 2 | 3;
export type JobStatus = "idle" | "running" | "ready" | "error";

/** How long a sample of speech recognition is, for the time estimate. */
export const ESTIMATE_SAMPLE_SECONDS = 15;

export type Estimate =
  { status: "running" } | { status: "done"; seconds: number } | { status: "failed"; message: string };

interface AutoClipsState {
  open: boolean;
  step: WizardStep;
  /** The timeline clip being searched. */
  clipId: string | null;
  settings: AutoClipsSettings;
  status: JobStatus;
  /** 0..100 while the speech model runs; null while it is only starting up or reading the cache. */
  percent: number | null;
  error: string | null;
  /** The engine's note ("only 2 clips found for this length"). */
  notice: string | null;
  clips: ReviewClip[];
  sentences: TranscriptSentence[];
  fromCache: boolean;
  /** Spans the user deleted or replaced: "Find another" never offers them again. */
  skipped: SourceSpan[];
  sort: SortBy;
  /** Id of the clip a "Find another" is working on. */
  replacing: string | null;
  /** The user has looked at the results (clears the "Clips ready" badge). */
  seen: boolean;
  estimate: Estimate | null;
  /** The clip shown in the review's preview. */
  selectedId: string | null;
  /** What the cuts are measured against, and the file to preview; set when a search starts. */
  context: (CutContext & { path: string; video: boolean }) | null;
  /** Cuts snap to sentence boundaries (Alt or Shift, or switching this off, frees them). */
  snap: boolean;

  openWizard: (clipId?: string) => void;
  hide: () => void;
  setStep: (step: WizardStep) => void;
  patchSettings: (patch: Partial<AutoClipsSettings>) => void;
  start: () => Promise<void>;
  /** Stop the search that is running. */
  cancel: () => void;
  /** Forget the results and go back to the settings. */
  discard: () => void;
  estimateTime: () => Promise<void>;

  setSort: (sort: SortBy) => void;
  toggle: (id: string) => void;
  setAllIncluded: (included: boolean) => void;
  includeOnly: (tier: Tier) => void;
  setTitle: (id: string, title: string) => void;
  remove: (id: string) => void;
  findAnother: (id: string) => Promise<void>;
  select: (id: string) => void;
  /** Select the clip before (-1) or after (+1) the selected one, in the order shown. */
  selectNext: (direction: -1 | 1) => void;
  setSnap: (snap: boolean) => void;
  /** Move a cut to a source time; `free` skips sentence snapping. Always frame-aligned, inside the range. */
  setCut: (id: string, edge: Edge, time: number, free?: boolean) => void;
  nudge: (id: string, edge: Edge, direction: -1 | 1, free?: boolean) => void;
  cutAtWord: (id: string, word: TranscriptWord) => void;
}

const message = (e: unknown) => (e instanceof Error ? e.message : typeof e === "string" ? e : "Failed.");
const isCancel = (text: string) => /cancel/i.test(text);

let attached: Promise<unknown> | null = null;
/** Bumped when results are discarded, so a search that finishes later does not bring them back. */
let generation = 0;

const spanOf = (c: Pick<FoundClip, "sourceIn" | "sourceOut">): SourceSpan => ({
  start: c.sourceIn,
  end: c.sourceOut,
});

/** The speech model to use: the chosen one if it is on this machine, otherwise any that is. */
export function usableModel(settings: Pick<AutoClipsSettings, "model">): string | null {
  const models = useAiStore.getState().models;
  const installed = models.filter((m) => m.installed);
  return (
    installed.find((m) => m.id === settings.model)?.id ??
    installed.find((m) => m.id === "base")?.id ??
    installed[0]?.id ??
    null
  );
}

export const useAutoClipsStore = create<AutoClipsState>((set, get) => {
  const attach = () => {
    attached ??= listen<{ percent: number }>("auto-clips-progress", (e) => {
      if (get().status === "running") set({ percent: e.payload.percent });
    }).catch(() => null);
  };
  const audioDetails = (clipId: string) => {
    const project = useProjectStore.getState().project;
    const found = findClip(project, clipId);
    const asset = found && project.assets.find((a) => a.id === found.clip.assetId);
    if (!asset) return undefined;
    const entry = useMediaDetailsStore.getState().entries[asset.path];
    return entry?.status === "ready" ? entry.details : undefined;
  };

  return {
    open: false,
    step: 1,
    clipId: null,
    settings: DEFAULT_SETTINGS,
    status: "idle",
    percent: null,
    error: null,
    notice: null,
    clips: [],
    sentences: [],
    fromCache: false,
    skipped: [],
    sort: "score",
    replacing: null,
    seen: true,
    estimate: null,
    selectedId: null,
    context: null,
    snap: true,

    openWizard: (clipId) => {
      attach();
      // the very first time: start with a style made for short clips, unless one was already chosen.
      // After that the shared subtitle style simply remembers what was used last.
      try {
        if (!localStorage.getItem(FIRST_STYLE_KEY)) {
          localStorage.setItem(FIRST_STYLE_KEY, "1");
          const styles = useTextStyleStore.getState();
          if (styles.subtitleStyleId === null) styles.setSubtitleStyle(FIRST_STYLE);
        }
      } catch {
        // no storage (private mode): the default style stays
      }
      const s = get();
      // a running search keeps its clip; otherwise a different clip starts from empty results
      const target = s.status === "running" ? s.clipId : (clipId ?? s.clipId);
      if (target !== s.clipId) {
        generation += 1;
        set({
          clipId: target,
          status: "idle",
          clips: [],
          sentences: [],
          skipped: [],
          error: null,
          notice: null,
          percent: null,
          estimate: null,
        });
      }
      const reviewing = get().clips.length > 0;
      set({ open: true, step: get().status === "running" ? 1 : reviewing ? 2 : 1, seen: true });
    },
    hide: () => set({ open: false }),
    setStep: (step) => set({ step, seen: true }),
    patchSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch }, estimate: null })),

    start: async () => {
      attach();
      const s = get();
      if (s.status === "running" || !s.clipId) return;
      const project = useProjectStore.getState().project;
      const blocker = autoClipsBlocker(project, s.clipId, audioDetails(s.clipId));
      if (blocker) return set({ status: "error", error: blocker });
      const range = lengthRange(s.settings);
      if (!range.ok) return set({ status: "error", error: range.reason });
      const model = usableModel(s.settings);
      if (!model) return set({ status: "error", error: "Download a speech model first." });

      const mine = ++generation;
      const source = findClip(project, s.clipId)!;
      const asset = project.assets.find((a) => a.id === source.clip.assetId)!;
      const context = {
        fps: project.settings.fps,
        rangeIn: source.clip.sourceIn,
        rangeOut: source.clip.sourceOut,
        timelineStart: source.clip.timelineStart,
        speed: clipSpeed(source.clip),
        path: asset.path,
        video: asset.type === "video" && source.track.type === "video",
      };
      set({
        status: "running",
        percent: null,
        error: null,
        notice: null,
        skipped: [],
        clips: [],
        context,
        selectedId: null,
      });
      try {
        const found = await searchClips(searchRequest(project, s.clipId, s.settings, model));
        if (mine !== generation) return;
        set((cur) => ({
          status: "ready",
          percent: 100,
          clips: found.clips.map((c) => ({ ...c, included: true })),
          sentences: found.sentences,
          fromCache: found.fromCache,
          notice: found.notice,
          selectedId: sortedClips(found.clips, cur.sort)[0]?.id ?? null,
          // looking at the Review step already counts as seeing it
          step: cur.open && found.clips.length > 0 ? 2 : cur.step,
          seen: cur.open && found.clips.length > 0,
        }));
      } catch (e) {
        if (mine !== generation) return;
        const text = message(e);
        set(isCancel(text) ? { status: "idle", percent: null } : { status: "error", error: text });
      }
    },
    cancel: () => {
      if (get().status === "running" || get().replacing) useAiStore.getState().cancel();
    },
    discard: () => {
      generation += 1;
      set({
        status: "idle",
        clips: [],
        sentences: [],
        skipped: [],
        notice: null,
        error: null,
        percent: null,
        replacing: null,
        selectedId: null,
        step: 1,
        seen: true,
      });
    },
    estimateTime: async () => {
      const s = get();
      const project = useProjectStore.getState().project;
      const found = s.clipId ? findClip(project, s.clipId) : undefined;
      const asset = found && project.assets.find((a) => a.id === found.clip.assetId);
      const model = usableModel(s.settings);
      if (!found || !asset || !model || s.status === "running") return;
      const length = sourceDuration(found.clip);
      // a sample from the middle of the clip, where people are usually talking
      const from = found.clip.sourceIn + Math.max(0, (length - ESTIMATE_SAMPLE_SECONDS) / 2);
      set({ estimate: { status: "running" } });
      const t0 = performance.now();
      try {
        await invoke("transcribe_media", {
          path: asset.path,
          sourceIn: from,
          sourceOut: from + Math.min(ESTIMATE_SAMPLE_SECONDS, length),
          model,
          language: s.settings.language === "" ? null : s.settings.language,
        });
        const took = (performance.now() - t0) / 1000;
        const sample = Math.min(ESTIMATE_SAMPLE_SECONDS, length);
        set({ estimate: { status: "done", seconds: (took / sample) * length } });
      } catch (e) {
        set({ estimate: { status: "failed", message: message(e) } });
      }
    },

    setSort: (sort) => set({ sort }),
    toggle: (id) =>
      set((s) => ({ clips: s.clips.map((c) => (c.id === id ? { ...c, included: !c.included } : c)) })),
    setAllIncluded: (included) => set((s) => ({ clips: s.clips.map((c) => ({ ...c, included })) })),
    includeOnly: (tier) => set((s) => ({ clips: s.clips.map((c) => ({ ...c, included: c.tier === tier })) })),
    setTitle: (id, title) => set((s) => ({ clips: s.clips.map((c) => (c.id === id ? { ...c, title } : c)) })),
    remove: (id) =>
      set((s) => {
        const gone = s.clips.find((c) => c.id === id);
        const clips = s.clips.filter((c) => c.id !== id);
        const order = sortedClips(s.clips, s.sort);
        const at = order.findIndex((c) => c.id === id);
        return {
          clips,
          skipped: gone ? [...s.skipped, spanOf(gone)] : s.skipped,
          // keep something selected: the next card, else the one before
          selectedId: s.selectedId === id ? ((order[at + 1] ?? order[at - 1])?.id ?? null) : s.selectedId,
        };
      }),

    findAnother: async (id) => {
      attach();
      const s = get();
      const old = s.clips.find((c) => c.id === id);
      const model = usableModel(s.settings);
      if (!old || !s.clipId || !model || s.replacing || s.status === "running") return;
      const project = useProjectStore.getState().project;
      const mine = generation;
      set({ replacing: id, notice: null });
      try {
        const found = await searchClips(
          searchRequest(project, s.clipId, s.settings, model, {
            count: 1,
            // everything on screen, plus what was thrown away before
            exclude: [...s.clips.map(spanOf), ...s.skipped],
          }),
        );
        if (mine !== generation) return;
        const next = found.clips[0];
        set((cur) => ({
          replacing: null,
          clips: next
            ? cur.clips.map((c) => (c.id === id ? { ...next, included: c.included } : c))
            : cur.clips,
          skipped: next ? [...cur.skipped, spanOf(old)] : cur.skipped,
          selectedId: next && cur.selectedId === id ? next.id : cur.selectedId,
          notice: next ? null : "No other clip fits this length. Try a wider length range.",
        }));
      } catch (e) {
        if (mine !== generation) return;
        const text = message(e);
        set({ replacing: null, notice: isCancel(text) ? null : text });
      }
    },

    select: (id) => set({ selectedId: id }),
    selectNext: (direction) =>
      set((s) => {
        const order = sortedClips(s.clips, s.sort);
        if (order.length === 0) return {};
        const at = order.findIndex((c) => c.id === s.selectedId);
        const to = at < 0 ? 0 : Math.min(order.length - 1, Math.max(0, at + direction));
        return { selectedId: order[to].id };
      }),
    setSnap: (snap) => set({ snap }),
    setCut: (id, edge, time, free = false) =>
      set((s) => {
        const ctx = s.context;
        if (!ctx) return {};
        return {
          clips: s.clips.map((c) =>
            c.id === id ? withCut(c, moveCut(c, edge, time, ctx, s.sentences, free || !s.snap), ctx) : c,
          ),
        };
      }),
    nudge: (id, edge, direction, free = false) =>
      set((s) => {
        const ctx = s.context;
        if (!ctx) return {};
        return {
          clips: s.clips.map((c) =>
            c.id === id
              ? withCut(c, nudgeCut(c, edge, direction, ctx, s.sentences, free || !s.snap), ctx)
              : c,
          ),
        };
      }),
    cutAtWord: (id, word) =>
      set((s) => {
        const ctx = s.context;
        if (!ctx) return {};
        return { clips: s.clips.map((c) => (c.id === id ? withCut(c, cutAtWord(c, word, ctx), ctx) : c)) };
      }),
  };
});

/** True when results are waiting that the user has not looked at (the "Clips ready" badge). */
export const selectClipsReady = (s: AutoClipsState) => s.status === "ready" && s.clips.length > 0 && !s.seen;
