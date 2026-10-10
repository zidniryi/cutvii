import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import App from "@/App";
import type { Project } from "@/project/model";
import { restTimeFor, sourceTimeFor, timelineTimeFor } from "@/playback/engine";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { reverseKey, useReverseStore } from "@/store/reverse";
import { useSelectionStore } from "@/store/selection";
import { useUiStore } from "@/store/ui";
import { expectValid, IDS, makeProject } from "@/test/makeProject";
import { clipDuration, clipEnd, findClip } from "./clips";
import {
  addClip,
  FREEZE_SECONDS,
  insertFreezeFrame,
  setClipReversed,
  setClipSpeed,
  sourceTimeAt,
  splitClip,
  trimClip,
  type EditResult,
} from "./edit";
import { addAssetToTimeline, undo } from "./editor";
import { freezeFrameAtPlayhead, freezeTarget } from "./freeze";
import { resolveShortcut } from "./shortcuts";

const invokeMock = vi.mocked(invoke);
const must = (r: EditResult): Project => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  expectValid(r.project);
  return r.project;
};
const code = (r: EditResult) => (r.ok ? "ok" : r.error.code);
const clip = (p: Project, id: string) => findClip(p, id)!.clip;
const state = () => useProjectStore.getState();

/** vid (10 s) on v1 at 2 s, using source 2..8 (6 s), reversed. */
function reversed(): Project {
  let p = must(addClip(makeProject(), { assetId: IDS.vid, trackId: IDS.v1, start: 2, id: "c", duration: 8 }));
  p = must(trimClip(p, "c", "start", 4)); // source 2..8, timeline 4..10
  p = must(setClipReversed(p, "c", true));
  return p;
}

beforeEach(() => {
  invokeMock.mockReset();
  useProjectStore.setState({ project: makeProject(), past: [], future: [] });
  useSelectionStore.setState({ selectedClipIds: [] });
  usePlaybackStore.setState({ playhead: 0, playing: false, mediaErrors: {} });
  useReverseStore.setState({ previews: {} });
  useUiStore.setState({ notice: null, dialog: null, sidePanel: "library" });
});

describe("reverse: editing", () => {
  it("reversing keeps the place and length, and is refused for stills", () => {
    const p = reversed();
    expect(clip(p, "c")).toMatchObject({ timelineStart: 4, sourceIn: 2, sourceOut: 8, reversed: true });
    expect(clipDuration(clip(p, "c"))).toBe(6);
    const img = must(addClip(makeProject(), { assetId: IDS.img, trackId: IDS.v1, start: 0, id: "i" }));
    expect(code(setClipReversed(img, "i", true))).toBe("out-of-range");
  });

  it("a reversed clip shows the end of its source first", () => {
    const c = clip(reversed(), "c"); // timeline 4..10 plays source 8 -> 2
    expect(sourceTimeAt(c, 4)).toBe(8);
    expect(sourceTimeAt(c, 7)).toBe(5);
    expect(sourceTimeAt(c, 10)).toBe(2);
    const fast = clip(must(setClipSpeed(reversed(), "c", 2)), "c"); // 4..7
    expect(sourceTimeAt(fast, 5)).toBe(6);
  });

  it("trimming a reversed clip removes what is actually on that edge", () => {
    let p = must(trimClip(reversed(), "c", "start", 5)); // drop the first second shown = source 7..8
    expect(clip(p, "c")).toMatchObject({ timelineStart: 5, sourceIn: 2, sourceOut: 7 });
    p = must(trimClip(p, "c", "end", 9)); // drop the last second shown = source 2..3
    expect(clip(p, "c")).toMatchObject({ timelineStart: 5, sourceIn: 3, sourceOut: 7 });
    expect(clipEnd(clip(p, "c"))).toBe(9);

    // growing back is limited by the file on each side: start by what is after sourceOut, end by sourceIn
    p = must(trimClip(p, "c", "start", -50));
    expect(clip(p, "c")).toMatchObject({ sourceOut: 10, timelineStart: 2 }); // 3 s more source, 3 s earlier
    p = must(trimClip(p, "c", "end", 500));
    expect(clip(p, "c").sourceIn).toBe(0);
    expect(clipEnd(clip(p, "c"))).toBe(12);
  });

  it("splitting a reversed clip keeps playback continuous across the cut", () => {
    const p = must(splitClip(reversed(), "c", 6, "right")); // 2 s in: source 8 -> 6 | 6 -> 2
    expect(clip(p, "c")).toMatchObject({ timelineStart: 4, sourceIn: 6, sourceOut: 8, reversed: true });
    expect(clip(p, "right")).toMatchObject({ timelineStart: 6, sourceIn: 2, sourceOut: 6, reversed: true });
    expect(sourceTimeAt(clip(p, "c"), 6)).toBe(sourceTimeAt(clip(p, "right"), 6)); // same frame on both sides
    expect(clipEnd(clip(p, "right"))).toBe(10);
  });
});

describe("reverse: preview", () => {
  it("maps the playhead into the reversed copy, which starts at 0", () => {
    const c = clip(reversed(), "c");
    expect(sourceTimeFor(c, 4)).toBe(0);
    expect(sourceTimeFor(c, 7)).toBe(3);
    expect(timelineTimeFor(c, 3)).toBe(7);
    expect(restTimeFor(c)).toBe(0);
    const forward = { ...c, reversed: false };
    expect(restTimeFor(forward)).toBe(2);
    expect(sourceTimeFor(forward, 7)).toBe(5);
  });

  it("prepares a reversed copy once, shows the state, then plays that copy", async () => {
    let finish!: (path: string) => void;
    invokeMock.mockImplementation((async (cmd: string) =>
      cmd === "prepare_reverse_preview"
        ? new Promise<string>((r) => (finish = r))
        : undefined) as typeof invoke);
    useProjectStore.setState({ project: reversed() });
    usePlaybackStore.setState({ playhead: 5 });
    render(<App />);

    expect(await screen.findAllByText(/Preparing reverse preview… 0%/)).not.toHaveLength(0);
    expect(document.querySelector("video")).toBeNull(); // never played forwards by mistake
    expect(invokeMock).toHaveBeenCalledWith("prepare_reverse_preview", {
      key: reverseKey("/m/vid.mp4", 2, 8),
      path: "/m/vid.mp4",
      sourceIn: 2,
      sourceOut: 8,
    });

    await act(async () => finish("/cache/reverse/abc.mp4"));
    await waitFor(() =>
      expect(document.querySelector("video")?.getAttribute("src")).toBe(
        "asset://localhost/cache/reverse/abc.mp4",
      ),
    );
    expect(document.querySelector("video")!.currentTime).toBeCloseTo(1); // 1 s into the reversed copy
    expect(screen.queryByText(/Preparing reverse preview/)).not.toBeInTheDocument();

    // re-rendering or other edits do not request it again
    act(() => void addAssetToTimeline(IDS.aud));
    expect(invokeMock.mock.calls.filter((c) => c[0] === "prepare_reverse_preview")).toHaveLength(1);
  });

  it("shows a failure instead of a frozen picture", async () => {
    invokeMock.mockImplementation((async (cmd: string) => {
      if (cmd === "prepare_reverse_preview") throw "this FFmpeg has no H.264 encoder for the reverse preview";
    }) as typeof invoke);
    useProjectStore.setState({ project: reversed() });
    usePlaybackStore.setState({ playhead: 5 });
    render(<App />);
    expect(
      await screen.findByText(/Reverse preview failed: this FFmpeg has no H.264 encoder/),
    ).toBeInTheDocument();
  });

  it("the inspector toggles Reverse as one undo step and warns for long ranges", async () => {
    invokeMock.mockImplementation((async () => new Promise(() => {})) as typeof invoke);
    render(<App />);
    act(() => void addAssetToTimeline(IDS.aud)); // 20 s audio, selected
    await userEvent.click(screen.getByRole("tab", { name: "Inspector" }));
    await userEvent.click(screen.getByRole("tab", { name: "Speed" }));
    const panel = screen.getByRole("region", { name: "Speed" });
    const before = state().past.length;

    await userEvent.click(within(panel).getByRole("button", { name: "Reverse" }));
    expect(state().project.tracks[2].clips[0].reversed).toBe(true);
    expect(state().past).toHaveLength(before + 1);
    expect(within(panel).getByRole("button", { name: "Reverse" })).toHaveAttribute("aria-pressed", "true");
    expect(within(panel).getByRole("status")).toHaveTextContent("Preparing reverse preview");
    expect(within(panel).queryByRole("button", { name: "Freeze frame" })).not.toBeInTheDocument(); // audio has no frames

    act(() => undo());
    expect(state().project.tracks[2].clips[0].reversed).toBeUndefined();
  });
});

describe("freeze frame", () => {
  const withImage = (p: Project): Project => ({
    ...p,
    assets: [...p.assets, { id: "still", path: "/frames/f.png", type: "image" }],
  });
  /** c1 2..12 and c2 14..18 on v1. */
  function two(): Project {
    let p = must(addClip(makeProject(), { assetId: IDS.vid, trackId: IDS.v1, start: 2, id: "c1" }));
    p = must(addClip(p, { assetId: IDS.vid2, trackId: IDS.v1, start: 14, id: "c2" }));
    return withImage(p);
  }

  it("splits at the time, holds the still for 2 s and moves everything after it later", () => {
    const p = must(insertFreezeFrame(two(), "c1", 5, "still", { right: "r", still: "s" }));
    const v1 = p.tracks[0].clips;
    expect(v1.map((c) => c.id)).toEqual(["c1", "s", "r", "c2"]);
    expect(clip(p, "c1")).toMatchObject({ timelineStart: 2, sourceIn: 0, sourceOut: 3 });
    expect(clip(p, "s")).toMatchObject({ timelineStart: 5, assetId: "still", sourceOut: FREEZE_SECONDS });
    expect(clip(p, "r")).toMatchObject({ timelineStart: 7, sourceIn: 3, sourceOut: 10 });
    expect(clip(p, "c2").timelineStart).toBe(16);
    expect(clipEnd(clip(p, "s"))).toBe(clip(p, "r").timelineStart);
  });

  it("refuses the clip edges, non-video tracks and unknown images", () => {
    const p = two();
    expect(code(insertFreezeFrame(p, "c1", 2, "still"))).toBe("out-of-range");
    expect(code(insertFreezeFrame(p, "c1", 5, "nope"))).toBe("unknown-asset");
    const audio = must(addClip(p, { assetId: IDS.aud, trackId: IDS.a1, start: 0, id: "a" }));
    expect(code(insertFreezeFrame(audio, "a", 5, "still"))).toBe("incompatible-track");
  });

  it("asks Rust for the exact source frame (speed and reverse included) and inserts it as one undo step", async () => {
    invokeMock.mockImplementation((async (cmd: string) =>
      cmd === "extract_freeze_frame"
        ? { path: "/data/frames/vid freeze 1.png", mediaType: "image", width: 1920, height: 1080 }
        : undefined) as typeof invoke);
    let p = must(addClip(makeProject(), { assetId: IDS.vid, trackId: IDS.v1, start: 0, id: "c" }));
    p = must(setClipSpeed(p, "c", 2)); // timeline 0..5
    useProjectStore.setState({ project: p, past: [], future: [] });
    usePlaybackStore.setState({ playhead: 2 });

    expect(freezeTarget()).toEqual({ clipId: "c", assetPath: "/m/vid.mp4", sourceTime: 4 });
    expect(await freezeFrameAtPlayhead()).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("extract_freeze_frame", { path: "/m/vid.mp4", time: 4 });

    const v1 = state().project.tracks[0].clips;
    expect(v1).toHaveLength(3);
    expect(v1[1]).toMatchObject({ timelineStart: 2, sourceOut: 2 });
    expect(state().project.assets.at(-1)).toMatchObject({
      path: "/data/frames/vid freeze 1.png",
      type: "image",
      width: 1920,
    });
    expect(state().past).toHaveLength(1);
    expect(state().past[0].label).toBe("Freeze frame");
    expectValid(state().project);

    act(() => undo()); // the still asset and the timeline change go together
    expect(state().project.tracks[0].clips).toHaveLength(1);
    expect(state().project.assets.some((a) => a.path.includes("freeze"))).toBe(false);
  });

  it("explains when there is nothing to freeze or extraction fails, and changes nothing", async () => {
    usePlaybackStore.setState({ playhead: 3 });
    expect(await freezeFrameAtPlayhead()).toBe(false);
    expect(useUiStore.getState().notice).toMatch(/inside a video clip/);
    expect(invokeMock).not.toHaveBeenCalled();

    invokeMock.mockImplementation((async () => {
      throw "there is no frame at that position";
    }) as typeof invoke);
    const p = must(addClip(makeProject(), { assetId: IDS.vid, trackId: IDS.v1, start: 0, id: "c" }));
    useProjectStore.setState({ project: p, past: [], future: [] });
    expect(await freezeFrameAtPlayhead()).toBe(false);
    expect(useUiStore.getState().notice).toMatch(/Freeze frame failed: there is no frame/);
    expect(state().project).toBe(p);
  });

  it("is reachable by Shift+F, the inspector button and the clip menu", async () => {
    const k = (key: string, shift: boolean, typing = false) =>
      resolveShortcut(
        { key, ctrlKey: false, metaKey: false, shiftKey: shift, altKey: false },
        { typing, onButton: false },
      )?.action ?? null;
    expect(k("F", true)).toBe("freeze");
    expect(k("f", false)).toBeNull();
    expect(k("F", true, true)).toBeNull();

    invokeMock.mockImplementation((async (cmd: string) =>
      cmd === "extract_freeze_frame"
        ? { path: "/data/frames/x.png", mediaType: "image", width: 100, height: 100 }
        : undefined) as typeof invoke);
    render(<App />);
    act(() => void addAssetToTimeline(IDS.vid));
    usePlaybackStore.setState({ playhead: 4 });

    fireEvent.keyDown(document.body, { key: "F", shiftKey: true });
    await waitFor(() => expect(state().project.tracks[0].clips).toHaveLength(3));

    usePlaybackStore.setState({ playhead: 1 });
    fireEvent.contextMenu(screen.getAllByRole("button", { name: "vid.mp4 clip" })[0], {
      clientX: 5,
      clientY: 5,
    });
    await userEvent.click(screen.getByRole("menuitem", { name: /Freeze frame/ }));
    await waitFor(() => expect(state().project.tracks[0].clips).toHaveLength(5));
  });
});
