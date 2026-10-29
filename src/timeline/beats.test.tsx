import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { Inspector } from "@/components/layout/Inspector";
import type { Project } from "@/project/model";
import { parseProject } from "@/project/parse";
import { useBeatStore } from "@/store/beats";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useUiStore } from "@/store/ui";
import { expectValid, IDS, makeProject } from "@/test/makeProject";
import {
  adjustedBeats,
  beatsOnTimeline,
  effectiveBpm,
  setClipBeatFx,
  tapTempo,
  type BeatGrid,
} from "./beats";
import { addClip } from "./edit";
import { undo } from "./editor";

/** A 10 s video ("video") on v1 at 2..12 and a still ("still") on v2. */
function project(): Project {
  let p = makeProject();
  for (const [assetId, trackId, id, start] of [
    [IDS.vid, IDS.v1, "video", 2],
    [IDS.img, IDS.v2, "still", 20],
  ] as const) {
    const r = addClip(p, { assetId, trackId, start, id });
    if (!r.ok) throw new Error(r.error.message);
    p = r.project;
  }
  return p;
}
const clipOf = (p: Project, id: string) => p.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!;
const stored = (id: string) => clipOf(useProjectStore.getState().project, id);
const ok = (r: ReturnType<typeof setClipBeatFx>) => {
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
};

/** A steady 120 BPM grid over 0..10 s with its first beat at 0.25 s. */
const GRID: BeatGrid = {
  version: 1,
  start: 0,
  end: 10,
  bpm: 120,
  offset: 0.25,
  clarity: 0.9,
  clear: true,
  steady: true,
  beats: Array.from({ length: 20 }, (_, i) => 0.25 + i * 0.5),
};
const ID = "0123456789abcdef";
const close = (a: number[], b: number[]) => {
  expect(a.length).toBe(b.length);
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6));
};

describe("beat grid adjustments", () => {
  it("half, double, a typed tempo and a nudge change the beats", () => {
    close(adjustedBeats(GRID, undefined), GRID.beats);
    close(
      adjustedBeats(GRID, { effects: [], halfDouble: "half" }),
      GRID.beats.filter((_, i) => i % 2 === 0),
    );
    expect(adjustedBeats(GRID, { effects: [], halfDouble: "double" })).toHaveLength(39);
    expect(adjustedBeats(GRID, { effects: [], halfDouble: "double" })[1]).toBeCloseTo(0.5);
    close(
      adjustedBeats(GRID, { effects: [], bpmOverride: 60 }),
      [0.25, 1.25, 2.25, 3.25, 4.25, 5.25, 6.25, 7.25, 8.25, 9.25],
    );
    close(adjustedBeats(GRID, { effects: [], offsetMs: -300 }).slice(0, 2), [0.45, 0.95]); // 0.25 - 0.3 wraps in
    expect(effectiveBpm(GRID, { effects: [], bpmOverride: 90, halfDouble: "double" })).toBe(180);
  });

  it("follows the tracked beats when the tempo changes", () => {
    const changing = { ...GRID, steady: false, beats: [0.5, 1.0, 1.5, 1.9, 2.3, 2.7] };
    close(adjustedBeats(changing, undefined), changing.beats);
    close(
      adjustedBeats(changing, { effects: [], offsetMs: 100 }),
      changing.beats.map((b) => b + 0.1),
    );
  });

  it("maps beats to the timeline through trim and speed, and skips reversed clips", () => {
    const clip = { timelineStart: 2, sourceIn: 1, sourceOut: 5, speed: 2 };
    // source beats 1.25, 1.75 … 4.75 → timeline 2 + (s - 1) / 2
    close(
      beatsOnTimeline(clip, GRID)!,
      [1.25, 1.75, 2.25, 2.75, 3.25, 3.75, 4.25, 4.75].map((s) => 2 + (s - 1) / 2),
    );
    expect(beatsOnTimeline({ ...clip, reversed: true }, GRID)).toBeNull();
  });

  it("tap tempo needs four taps and starts over after a pause", () => {
    expect(tapTempo([0, 500, 1000])).toBeNull();
    expect(tapTempo([0, 500, 1000, 1500])).toBe(120);
    expect(tapTempo([0, 500, 1000, 1500, 2010, 2500])).toBe(120); // median ignores one uneven tap
    expect(tapTempo([0, 500, 1000, 1500, 9000, 9600, 10200])).toBeNull(); // only three since the pause
    expect(tapTempo([0, 100, 200, 300])).toBeNull(); // 600 BPM is out of range
  });
});

describe("beat settings in the project", () => {
  it("are stored, survive save and reopen, and an empty setting is removed", () => {
    let p = ok(setClipBeatFx(project(), "video", { gridId: ID, halfDouble: "double", offsetMs: 20 }));
    expect(clipOf(p, "video").beatFx).toEqual({
      effects: [],
      gridId: ID,
      halfDouble: "double",
      offsetMs: 20,
    });
    expectValid(p);
    const reopened = parseProject(JSON.parse(JSON.stringify(p)));
    expect(reopened.ok && clipOf(reopened.project, "video").beatFx).toEqual(clipOf(p, "video").beatFx);
    p = ok(setClipBeatFx(p, "video", { gridId: undefined, halfDouble: undefined, offsetMs: 0 }));
    expect("beatFx" in clipOf(p, "video")).toBe(false);
  });

  it("refuses stills, out-of-range values and broken files", () => {
    expect(setClipBeatFx(project(), "still", { gridId: ID }).ok).toBe(false);
    expect(setClipBeatFx(project(), "video", { bpmOverride: 20 }).ok).toBe(false);
    expect(setClipBeatFx(project(), "video", { bpmOverride: Number.NaN }).ok).toBe(false);
    expect(setClipBeatFx(project(), "video", { offsetMs: 2500 }).ok).toBe(false);
    const raw = JSON.parse(JSON.stringify(ok(setClipBeatFx(project(), "video", { gridId: ID }))));
    const clip = raw.tracks
      .flatMap((t: { clips: { id: string }[] }) => t.clips)
      .find((c: { id: string }) => c.id === "video");
    clip.beatFx.gridId = "../../etc";
    expect(parseProject(raw).ok).toBe(false);
    clip.beatFx = { effects: [], surprise: 1 };
    expect(parseProject(raw).ok).toBe(false);
  });
});

describe("Beats in the Audio tab", () => {
  function open(p: Project) {
    useProjectStore.getState().loadProject(p, "/p.cutvii", []);
    usePlaybackStore.setState({ playhead: 0, playing: false, volume: 1, muted: false });
    useSelectionStore.getState().select("video");
    useUiStore.setState({ notice: null, inspectorTab: { video: "audio" } });
  }
  const fetchSpy = vi.fn();
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    useBeatStore.setState({ grids: {}, running: null });
    vi.stubGlobal("fetch", fetchSpy);
    open(project());
  });
  afterEach(() => vi.unstubAllGlobals());

  it("detects the beats of the used range as one undo step, then halves them", async () => {
    vi.mocked(invoke).mockImplementation((cmd) =>
      Promise.resolve(cmd === "detect_beats" ? { gridId: ID, grid: GRID } : null),
    );
    render(<Inspector />);
    const panel = within(screen.getByRole("group", { name: "Beats" }));
    fireEvent.click(panel.getByRole("button", { name: /Detect beats/ }));
    await panel.findByText("120.0 BPM");
    expect(invoke).toHaveBeenCalledWith("detect_beats", { path: "/m/vid.mp4", start: 0, end: 10 });
    expect(stored("video").beatFx).toEqual({ effects: [], gridId: ID });

    fireEvent.click(panel.getByRole("radio", { name: "Half" }));
    expect(stored("video").beatFx?.halfDouble).toBe("half");
    await panel.findByText("60.0 BPM");
    undo();
    expect(stored("video").beatFx).toEqual({ effects: [], gridId: ID });
    undo();
    expect(stored("video").beatFx).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled(); // nothing goes over the network
  });

  it("can be stopped, and a stop is not shown as an error", async () => {
    let fail: (e: unknown) => void = () => undefined;
    vi.mocked(invoke).mockImplementation((cmd) =>
      cmd === "detect_beats" ? new Promise((_, reject) => (fail = reject)) : Promise.resolve(null),
    );
    render(<Inspector />);
    fireEvent.click(screen.getByRole("button", { name: /Detect beats/ }));
    const stop = await screen.findByRole("button", { name: "Stop" });
    expect(screen.getByText("Estimating the time left…")).toBeInTheDocument();
    fireEvent.click(stop);
    expect(invoke).toHaveBeenCalledWith("cancel_beat_job");
    await act(async () => fail("export cancelled"));
    await screen.findByRole("button", { name: /Detect beats/ });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(stored("video").beatFx).toBeUndefined();
  });

  it("loads the grid of a reopened project from the cache, and says when it is gone", async () => {
    open(ok(setClipBeatFx(project(), "video", { gridId: ID, bpmOverride: 100 })));
    vi.mocked(invoke).mockResolvedValueOnce(GRID);
    const { unmount } = render(<Inspector />);
    await screen.findByText("100.0 BPM");
    expect(invoke).toHaveBeenCalledWith("beat_grid", { path: "/m/vid.mp4", gridId: ID });
    unmount();

    useBeatStore.setState({ grids: {} });
    vi.mocked(invoke).mockResolvedValueOnce(null);
    render(<Inspector />);
    await screen.findByText(/no longer stored/);
  });

  it("warns when there is no clear beat, and a typed tempo is one undo step", async () => {
    useBeatStore.setState({ grids: { [ID]: { ...GRID, clear: false, clarity: 0.04 } } });
    open(ok(setClipBeatFx(project(), "video", { gridId: ID })));
    render(<Inspector />);
    expect(screen.getByText(/No clear beat/)).toBeInTheDocument();
    const field = screen.getByLabelText("Tempo (BPM)");
    fireEvent.change(field, { target: { value: "95" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(stored("video").beatFx?.bpmOverride).toBe(95));
    fireEvent.click(screen.getByRole("button", { name: "Move the beats 10 ms later" }));
    expect(stored("video").beatFx?.offsetMs).toBe(10);
    undo();
    undo();
    expect(stored("video").beatFx).toEqual({ effects: [], gridId: ID });
  });
});
