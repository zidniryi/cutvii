import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { AutoClipsWizard } from "@/components/autoclips/AutoClipsWizard";
import type { Project } from "@/project/model";
import { useAiStore, type SpeechModel } from "@/store/ai";
import { selectClipsReady, useAutoClipsStore } from "@/store/autoClips";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useUiStore } from "@/store/ui";
import { IDS, makeProject } from "@/test/makeProject";
import { openAutoClips } from "./ai";
import {
  autoClipsBlocker,
  cutAtWord,
  cutPoints,
  moveCut,
  nudgeCut,
  withCut,
  wordsOf,
  type CutContext,
  DEFAULT_SETTINGS,
  lengthRange,
  searchRequest,
  sortedClips,
  type FoundClip,
} from "./autoClips";
import { addClip } from "./edit";

const LONG = "long";
/** A 10-minute talk ("talk") on v1 from 5 s, using 30..630 s of its file; plus the usual short clips. */
function project(): Project {
  const base = makeProject();
  const withAsset: Project = {
    ...base,
    assets: [...base.assets, { id: LONG, path: "/m/talk.mp4", type: "video", duration: 700 }],
  };
  const r = addClip(withAsset, { assetId: LONG, trackId: IDS.v1, start: 5, id: "talk" });
  if (!r.ok) throw new Error(r.error.message);
  const short = addClip(r.project, { assetId: IDS.vid, trackId: IDS.v2, start: 0, id: "short" });
  if (!short.ok) throw new Error(short.error.message);
  return {
    ...short.project,
    tracks: short.project.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => (c.id === "talk" ? { ...c, sourceIn: 30, sourceOut: 630 } : c)),
    })),
  };
}

const MODELS: SpeechModel[] = [
  { id: "tiny", label: "Tiny", approxMb: 75, source: "https://huggingface.co/x/t.bin", installed: false },
  { id: "base", label: "Base", approxMb: 142, source: "https://huggingface.co/x/b.bin", installed: true },
];

const found = (
  id: string,
  sourceIn: number,
  sourceOut: number,
  tier: FoundClip["tier"],
  score: number,
): FoundClip => ({
  id,
  title: `Title ${id}`,
  text: `Text of ${id}.`,
  sourceIn,
  sourceOut,
  timelineStart: 5 + (sourceIn - 30),
  timelineDuration: sourceOut - sourceIn,
  score,
  tier,
  reasons: [
    { rule: "strong-opening", label: "Opens with a question", value: 1, met: true },
    { rule: "low-silence", label: "Little silence (40% quiet)", value: 0, met: false },
  ],
});
const RESULT = {
  clips: [
    found("a", 40, 80, "high", 0.9),
    found("b", 200, 245, "medium", 0.6),
    found("c", 400, 440, "low", 0.3),
  ],
  sentences: [
    { start: 32, end: 38, text: "Before it starts." },
    { start: 40.15, end: 45, text: "Why does this work?" },
    { start: 46, end: 60, text: "Because it is small and daily." },
    { start: 61, end: 79.7, text: "That is the whole trick." },
    { start: 82, end: 90, text: "And then something else." },
  ],
  fromCache: false,
  notice: null,
};

type Call = { command: string; args: { request?: ReturnType<typeof searchRequest> } };
const calls: Call[] = [];
/** Rust, faked: the search answers with `answer` (or the next one from a list). */
function rust(answer: unknown | unknown[] = RESULT) {
  const queue = Array.isArray(answer) ? [...answer] : null;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    calls.push({ command, args: (args ?? {}) as Call["args"] });
    if (command === "whisper_models") return MODELS;
    if (command === "find_clips_in_media") {
      const next = queue ? queue.shift() : answer;
      if (next instanceof Error) throw next.message;
      return next;
    }
    return undefined;
  });
}
const searches = () => calls.filter((c) => c.command === "find_clips_in_media").map((c) => c.args.request!);
const auto = () => useAutoClipsStore.getState();

beforeEach(() => {
  calls.length = 0;
  useProjectStore.setState({ project: project() });
  useSelectionStore.getState().clear();
  useUiStore.setState({ notice: null, dialog: null });
  useAiStore.setState({ models: MODELS, loaded: true, download: null, listening: null });
  auto().discard();
  useAutoClipsStore.setState({ open: false, clipId: null, settings: DEFAULT_SETTINGS, sort: "score" });
  rust();
});

describe("which clips can be searched", () => {
  it("needs sound, a minute of material and a clip that plays forwards", () => {
    const p = project();
    expect(autoClipsBlocker(p, "talk")).toBeNull();
    expect(autoClipsBlocker(p, "short")).toMatch(/under 60 s/);
    expect(autoClipsBlocker(p, "nope")).toMatch(/missing/);
    // FFprobe found no sound track in the video
    expect(autoClipsBlocker(p, "talk", { audioCodec: undefined })).toMatch(/no sound track/);
    expect(autoClipsBlocker(p, "talk", { audioCodec: "aac" })).toBeNull();
    const reversed: Project = {
      ...p,
      tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => ({ ...c, reversed: true })) })),
    };
    expect(autoClipsBlocker(reversed, "talk")).toMatch(/Reversed/);
  });

  it("says why instead of opening for a clip that is too short", () => {
    expect(openAutoClips("short")).toBe(false);
    expect(useUiStore.getState().notice).toMatch(/under 60 s/);
    expect(auto().open).toBe(false);
    expect(openAutoClips("talk")).toBe(true);
    expect(auto()).toMatchObject({ open: true, step: 1, clipId: "talk" });
  });
});

describe("settings", () => {
  it("turns the chosen length into seconds and rejects a bad custom range", () => {
    expect(lengthRange(DEFAULT_SETTINGS)).toEqual({ ok: true, min: 30, max: 60 });
    expect(lengthRange({ length: "custom", customMin: 20, customMax: 45 })).toEqual({
      ok: true,
      min: 20,
      max: 45,
    });
    expect(lengthRange({ length: "custom", customMin: 50, customMax: 45 }).ok).toBe(false);
    expect(lengthRange({ length: "custom", customMin: 2, customMax: 45 }).ok).toBe(false);
    expect(lengthRange({ length: "custom", customMin: 20, customMax: 999 }).ok).toBe(false);
    expect(lengthRange({ length: "custom", customMin: NaN, customMax: 45 }).ok).toBe(false);
  });

  it("asks the engine for the clip's used range, placement and the project frame rate", () => {
    const request = searchRequest(
      project(),
      "talk",
      { ...DEFAULT_SETTINGS, language: "id", count: 5 },
      "base",
    );
    expect(request).toMatchObject({
      path: "/m/talk.mp4",
      sourceIn: 30,
      sourceOut: 630,
      timelineStart: 5,
      speed: 1,
      reversed: false,
      model: "base",
      language: "id",
      minSeconds: 30,
      maxSeconds: 60,
      count: 5,
      fps: 30,
      exclude: [],
    });
  });
});

describe("the search job", () => {
  it("finds clips, includes them all and keeps everything when the wizard is closed and reopened", async () => {
    openAutoClips("talk");
    auto().patchSettings({ count: 3 });
    await act(() => auto().start());
    expect(auto()).toMatchObject({ status: "ready", step: 2 });
    expect(auto().clips.map((c) => [c.id, c.included])).toEqual([
      ["a", true],
      ["b", true],
      ["c", true],
    ]);

    // review edits
    auto().toggle("b");
    auto().setTitle("a", "My best bit");
    auto().setSort("time");
    auto().hide();
    expect(auto().open).toBe(false);

    // reopening (from the menu, with no clip named) shows the same review
    expect(openAutoClips()).toBe(true);
    expect(auto()).toMatchObject({ open: true, step: 2, sort: "time", settings: { count: 3 } });
    expect(auto().clips.find((c) => c.id === "a")?.title).toBe("My best bit");
    expect(auto().clips.find((c) => c.id === "b")?.included).toBe(false);
    expect(searches()).toHaveLength(1);
  });

  it("shows a badge when results arrive while the wizard is closed, until they are looked at", async () => {
    openAutoClips("talk");
    const running = auto().start();
    auto().hide();
    await act(() => running);
    expect(selectClipsReady(auto())).toBe(true);
    expect(auto().step).toBe(1); // nobody was moved while the window was closed
    openAutoClips();
    expect(selectClipsReady(auto())).toBe(false);
    expect(auto().step).toBe(2);
  });

  it("goes back to the settings quietly when the search is stopped, and reports a real failure", async () => {
    rust([new Error("export cancelled"), new Error("there is no sound to transcribe in that clip")]);
    openAutoClips("talk");
    await act(() => auto().start());
    expect(auto()).toMatchObject({ status: "idle", error: null, clips: [] });
    await act(() => auto().start());
    expect(auto()).toMatchObject({ status: "error", error: "there is no sound to transcribe in that clip" });
  });

  it("does not start without a downloaded model", async () => {
    useAiStore.setState({ models: MODELS.map((m) => ({ ...m, installed: false })) });
    openAutoClips("talk");
    await act(() => auto().start());
    expect(auto().error).toMatch(/Download a speech model/);
    expect(searches()).toHaveLength(0);
  });

  it("rejects an answer from Rust that is not what it should be", async () => {
    rust({ clips: [{ id: "x" }], sentences: [], fromCache: false, notice: null });
    openAutoClips("talk");
    await act(() => auto().start());
    expect(auto()).toMatchObject({
      status: "error",
      error: "The clip search returned something unexpected.",
    });
  });
});

describe("review", () => {
  beforeEach(async () => {
    openAutoClips("talk");
    await act(() => auto().start());
  });

  it("Find another swaps in a clip that avoids everything shown and everything thrown away", async () => {
    auto().remove("c");
    rust({ ...RESULT, clips: [found("d", 300, 340, "medium", 0.5)] });
    await act(() => auto().findAnother("b"));

    const request = searches().at(-1)!;
    expect(request.count).toBe(1);
    // on screen (a, b) and deleted (c)
    expect(request.exclude).toEqual([
      { start: 40, end: 80 },
      { start: 200, end: 245 },
      { start: 400, end: 440 },
    ]);
    expect(auto().clips.map((c) => c.id)).toEqual(["a", "d"]);
    // the new one overlaps nothing that is left
    const [a, d] = auto().clips;
    expect(d.sourceIn >= a.sourceOut || d.sourceOut <= a.sourceIn).toBe(true);
    // the replaced clip is never offered again
    expect(auto().skipped).toContainEqual({ start: 200, end: 245 });
  });

  it("keeps the clip and says so when there is nothing else to offer", async () => {
    rust({ ...RESULT, clips: [] });
    await act(() => auto().findAnother("b"));
    expect(auto().clips.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(auto().notice).toMatch(/No other clip/);
  });

  it("selects all, none and only the High ones, and sorts by score or time", () => {
    auto().setAllIncluded(false);
    expect(auto().clips.every((c) => !c.included)).toBe(true);
    auto().includeOnly("high");
    expect(
      auto()
        .clips.filter((c) => c.included)
        .map((c) => c.id),
    ).toEqual(["a"]);
    auto().setAllIncluded(true);
    expect(auto().clips.every((c) => c.included)).toBe(true);
    const shuffled = [RESULT.clips[2], RESULT.clips[0], RESULT.clips[1]];
    expect(sortedClips(shuffled, "score").map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(sortedClips(shuffled, "time").map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(sortedClips([found("z", 500, 530, "high", 0.9), ...shuffled], "score")[0].id).toBe("a");
  });
});

describe("the wizard", () => {
  it("walks Settings → Review → Create with Back, and offers nothing that does not work yet", async () => {
    render(<AutoClipsWizard />);
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => void openAutoClips("talk"));
    const dialog = within(screen.getByRole("dialog", { name: "Auto clips" }));

    // defaults: 30-60 s, Auto, vertical, subtitles on; unbuilt options are switched off
    expect(dialog.getByRole("radio", { name: "30–60 s" })).toBeChecked();
    expect(dialog.getByRole("radio", { name: "Auto" })).toBeChecked();
    expect(dialog.getByRole("radio", { name: "Vertical 9:16" })).toBeChecked();
    expect(dialog.getByRole("checkbox", { name: "Add subtitles to each clip" })).toBeChecked();
    expect(dialog.getAllByText("Coming soon")).toHaveLength(2);
    expect(dialog.getByText(/never leave it/)).toBeInTheDocument();

    fireEvent.click(dialog.getByRole("radio", { name: "15–30 s" }));
    fireEvent.click(dialog.getByRole("radio", { name: "5" }));
    fireEvent.click(dialog.getByRole("button", { name: "Find clips" }));
    await waitFor(() => expect(dialog.getByRole("list", { name: "Suggested clips" })).toBeInTheDocument());
    expect(searches()[0]).toMatchObject({ minSeconds: 15, maxSeconds: 30, count: 5 });

    // the honesty note, score badges and reasons
    expect(dialog.getByText(/do not predict\s+views/)).toBeInTheDocument();
    expect(dialog.getByLabelText("Score: High")).toBeInTheDocument();
    expect(dialog.getAllByText("Opens with a question")).toHaveLength(3);
    expect(dialog.getAllByRole("note")[0]).toHaveAccessibleName(
      /Why this clip: ✓ Opens with a question; – Little silence/,
    );
    expect(dialog.getByRole("status")).toHaveTextContent("3 of 3 selected");

    fireEvent.click(dialog.getByRole("checkbox", { name: "Include Title b" }));
    fireEvent.change(dialog.getAllByRole("textbox", { name: "Clip title" })[0], {
      target: { value: "Hook" },
    });
    expect(auto().clips.find((c) => c.id === "a")?.title).toBe("Hook");
    fireEvent.click(dialog.getAllByRole("button", { name: "Delete this suggestion" })[2]);
    expect(dialog.getByRole("status")).toHaveTextContent("1 of 2 selected");

    fireEvent.click(dialog.getByRole("button", { name: "Next" }));
    expect(dialog.getByText(/1 clip selected · Vertical 9:16 · with subtitles/)).toBeInTheDocument();
    // two separate things to do: save files (asks for the folder first), or add to the timeline
    expect(dialog.getByRole("button", { name: "Choose folder and save 1 clip" })).toBeEnabled();
    expect(dialog.getByRole("button", { name: "Add 1 clip to the timeline" })).toBeEnabled();
    expect(dialog.getByText("Coming soon")).toBeInTheDocument(); // new project per clip
    fireEvent.click(dialog.getByRole("button", { name: "Back" }));
    expect(dialog.getByRole("list", { name: "Suggested clips" })).toBeInTheDocument();

    // Next needs something selected
    fireEvent.click(dialog.getByRole("button", { name: "Select none" }));
    expect(dialog.getByRole("button", { name: "Next" })).toBeDisabled();

    // Escape closes; the review is still there afterwards
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(auto().clips).toHaveLength(2);
  });

  it("shows progress while searching and Stop search asks Rust to cancel", async () => {
    let finish: (v: unknown) => void = () => {};
    vi.mocked(invoke).mockImplementation(async (command) => {
      calls.push({ command, args: {} });
      if (command === "find_clips_in_media") return new Promise((resolve) => (finish = resolve));
      return undefined;
    });
    render(<AutoClipsWizard />);
    act(() => void openAutoClips("talk"));
    fireEvent.click(screen.getByRole("button", { name: "Find clips" }));
    expect(await screen.findByRole("progressbar", { name: "Finding clips" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop search" }));
    expect(calls.some((c) => c.command === "cancel_ai_job")).toBe(true);
    await act(async () => finish(RESULT));
  });

  it("will not search with a custom length that makes no sense", () => {
    render(<AutoClipsWizard />);
    act(() => void openAutoClips("talk"));
    fireEvent.click(screen.getByRole("radio", { name: "Custom" }));
    fireEvent.change(screen.getByLabelText("Shortest clip, seconds"), { target: { value: "90" } });
    fireEvent.change(screen.getByLabelText("Longest clip, seconds"), { target: { value: "40" } });
    expect(screen.getByRole("alert")).toHaveTextContent(/shortest length must be below/);
    expect(screen.getByRole("button", { name: "Find clips" })).toBeDisabled();
  });
});

describe("editing a cut", () => {
  const ctx: CutContext = { fps: 30, rangeIn: 30, rangeOut: 630, timelineStart: 5, speed: 2 };
  const sentences = RESULT.sentences;
  const clip = { sourceIn: 40, sourceOut: 80 };
  const onFrame = (t: number) => Math.abs(t * 30 - Math.round(t * 30)) < 1e-6;
  const sane = (c: { sourceIn: number; sourceOut: number }) => {
    expect(onFrame(c.sourceIn) && onFrame(c.sourceOut)).toBe(true);
    expect(c.sourceIn).toBeGreaterThanOrEqual(30);
    expect(c.sourceOut).toBeLessThanOrEqual(630);
    expect(c.sourceOut - c.sourceIn).toBeGreaterThanOrEqual(1 - 1e-6);
  };

  it("offers cut points just outside each sentence, never inside a neighbour", () => {
    const starts = cutPoints(sentences, "start");
    const ends = cutPoints(sentences, "end");
    expect(starts[1]).toBeCloseTo(40); // 0.15 s before the first word
    expect(ends[1]).toBeCloseTo(45.3); // 0.3 s after the last
    sentences.forEach((s, i) => {
      expect(starts[i]).toBeLessThanOrEqual(s.start);
      expect(ends[i]).toBeGreaterThanOrEqual(s.end);
      if (i > 0) expect(starts[i]).toBeGreaterThanOrEqual(sentences[i - 1].end);
      if (i + 1 < sentences.length) expect(ends[i]).toBeLessThanOrEqual(sentences[i + 1].start);
    });
  });

  it("dragging snaps to the nearest sentence boundary, on a whole frame", () => {
    const start = moveCut(clip, "start", 47.2, ctx, sentences, false);
    expect(start.sourceIn).toBeCloseTo(45.833, 2); // just before "Because…" (46 - 0.15), floored to a frame
    expect(start.sourceIn).toBeLessThanOrEqual(46);
    sane(start);
    const end = moveCut(clip, "end", 58, ctx, sentences, false);
    expect(end.sourceOut).toBeGreaterThanOrEqual(60); // after "…daily."
    expect(end.sourceOut).toBeLessThanOrEqual(61);
    sane(end);
  });

  it("a free cut lands anywhere, still on a whole frame", () => {
    const free = moveCut(clip, "start", 47.213, ctx, sentences, true);
    expect(free.sourceIn).toBeCloseTo(47.2, 5);
    sane(free);
  });

  it("stays inside the searched range and never shorter than a second", () => {
    sane(moveCut(clip, "start", -50, ctx, sentences, true));
    expect(moveCut(clip, "start", -50, ctx, sentences, true).sourceIn).toBe(30);
    expect(moveCut(clip, "end", 9999, ctx, sentences, true).sourceOut).toBe(630);
    // past the other cut: stops a second short of it
    expect(moveCut(clip, "start", 500, ctx, sentences, true).sourceIn).toBeCloseTo(79);
    expect(moveCut(clip, "end", 0, ctx, sentences, true).sourceOut).toBeCloseTo(41);
    // a range that does not start on a frame: the cut does not leave it
    const odd = { ...ctx, rangeIn: 30.01, rangeOut: 629.99 };
    const inside = moveCut(clip, "start", 0, odd, sentences, true);
    expect(inside.sourceIn).toBeGreaterThanOrEqual(30.01);
    expect(onFrame(inside.sourceIn)).toBe(true);
    expect(moveCut(clip, "end", 9999, odd, sentences, true).sourceOut).toBeLessThanOrEqual(629.99);
  });

  it("nudging moves one sentence, or one frame when free", () => {
    const later = nudgeCut(clip, "start", 1, ctx, sentences, false);
    expect(later.sourceIn).toBeGreaterThan(45);
    expect(later.sourceIn).toBeLessThanOrEqual(46);
    const earlier = nudgeCut(clip, "start", -1, ctx, sentences, false);
    expect(earlier.sourceIn).toBeLessThan(33);
    sane(later);
    sane(earlier);
    expect(nudgeCut(clip, "end", 1, ctx, sentences, true).sourceOut).toBeCloseTo(80 + 1 / 30);
    expect(nudgeCut(clip, "start", -1, ctx, sentences, true).sourceIn).toBeCloseTo(40 - 1 / 30);
    // nothing further that way: unchanged
    const atLast = { sourceIn: 40, sourceOut: 90.3 };
    expect(nudgeCut(atLast, "end", 1, ctx, sentences, false)).toEqual(atLast);
  });

  it("a word click moves the nearer cut to that word", () => {
    const words = wordsOf(sentences[2]);
    expect(words.map((w) => w.text)).toEqual(["Because", "it", "is", "small", "and", "daily."]);
    expect(words[0].start).toBe(46);
    expect(words.at(-1)!.end).toBeCloseTo(60);
    const toStart = cutAtWord(clip, words[0], ctx);
    expect(toStart).toEqual({ sourceIn: 46, sourceOut: 80 });
    const late = wordsOf(sentences[3]).at(-1)!;
    const toEnd = cutAtWord(clip, late, ctx);
    expect(toEnd.sourceIn).toBe(40);
    expect(toEnd.sourceOut).toBeCloseTo(79.7, 1);
    sane(toEnd);
  });

  it("the place on the timeline follows the cut (trim and speed)", () => {
    const moved = withCut(RESULT.clips[0], { sourceIn: 50, sourceOut: 70 }, ctx);
    expect(moved.timelineStart).toBe(5 + (50 - 30) / 2);
    expect(moved.timelineDuration).toBe(10);
  });
});

describe("review with the preview", () => {
  beforeEach(async () => {
    render(<AutoClipsWizard />);
    act(() => void openAutoClips("talk"));
    await act(() => auto().start());
  });
  const clipA = () => auto().clips.find((c) => c.id === "a")!;

  it("shows the best clip in a player and plays just that stretch with Space", () => {
    const media = screen.getByLabelText("Preview of Title a") as HTMLVideoElement;
    expect(media.getAttribute("src")).toContain("/m/talk.mp4");
    expect(media.currentTime).toBe(40);
    fireEvent.keyDown(window, { key: " " });
    expect(media.play).toHaveBeenCalled();
    // reaching the end of the clip stops and rewinds
    media.currentTime = 80.2;
    fireEvent.timeUpdate(media);
    expect(media.pause).toHaveBeenCalled();
    expect(media.currentTime).toBe(40);
  });

  it("Up and Down choose a clip, Enter includes or excludes it", () => {
    expect(auto().selectedId).toBe("a");
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(auto().selectedId).toBe("b");
    expect(screen.getByLabelText("Preview of Title b")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Enter" });
    expect(auto().clips.find((c) => c.id === "b")?.included).toBe(false);
    fireEvent.keyDown(window, { key: "ArrowUp" });
    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(auto().selectedId).toBe("a");
    // typing a title does not trigger the shortcuts
    const title = screen.getAllByRole("textbox", { name: "Clip title" })[0];
    fireEvent.keyDown(title, { key: "ArrowDown" });
    fireEvent.keyDown(title, { key: " " });
    expect(auto().selectedId).toBe("a");
  });

  it("the cut handles move with the arrow keys: by sentence, or by frame with Alt", () => {
    const start = screen.getByRole("slider", { name: "Clip start" });
    fireEvent.keyDown(start, { key: "ArrowRight" });
    expect(clipA().sourceIn).toBeGreaterThan(45);
    expect(auto().selectedId).toBe("a"); // the arrow did not change the selection
    const before = clipA().sourceIn;
    fireEvent.keyDown(start, { key: "ArrowLeft", altKey: true });
    expect(clipA().sourceIn).toBeCloseTo(before - 1 / 30);
    // the timeline placement follows
    expect(clipA().timelineStart).toBeCloseTo(5 + (clipA().sourceIn - 30));

    fireEvent.click(screen.getByRole("button", { name: "End later" }));
    expect(clipA().sourceOut).toBeGreaterThan(80);
    // snapping off: the buttons move one frame
    fireEvent.click(screen.getByRole("checkbox", { name: "Snap to sentences" }));
    const end = clipA().sourceOut;
    fireEvent.click(screen.getByRole("button", { name: "End earlier" }));
    expect(clipA().sourceOut).toBeCloseTo(end - 1 / 30);
    fireEvent.click(screen.getByRole("checkbox", { name: "Snap to sentences" }));
  });

  it("clicking a word in the transcript moves the nearest cut there", () => {
    fireEvent.click(within(screen.getByLabelText("Transcript")).getByRole("button", { name: "Because" }));
    expect(clipA().sourceIn).toBe(46);
    expect(clipA().sourceOut).toBe(80);
  });

  it("on narrow screens the list opens as a sheet and closes when a clip is chosen", () => {
    const toggle = screen.getByRole("button", { name: "Show the clip list (3)" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Hide the clip list" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    fireEvent.click(screen.getByText("Text of b."));
    expect(auto().selectedId).toBe("b");
    expect(screen.getByRole("button", { name: "Show the clip list (3)" })).toBeInTheDocument();
  });
});
