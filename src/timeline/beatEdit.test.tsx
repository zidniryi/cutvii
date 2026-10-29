import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { SeekBar } from "@/components/preview/SeekBar";
import { BeatMarks } from "@/components/timeline/BeatMarks";
import { Inspector } from "@/components/layout/Inspector";
import { Timeline } from "@/components/layout/Timeline";
import type { Project, TimelineClip } from "@/project/model";
import { parseProject } from "@/project/parse";
import { useBeatStore } from "@/store/beats";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useTimelineViewStore } from "@/store/timelineView";
import { useUiStore } from "@/store/ui";
import { useWaveformStore } from "@/store/waveforms";
import { expectValid, IDS, makeProject } from "@/test/makeProject";
import {
  cutOnBeats,
  cutPoints,
  piecesAfterCut,
  projectBeatTimes,
  setClipBeatFx,
  type BeatGrid,
} from "./beats";
import { addClip } from "./edit";
import { cutClipOnBeats, undo } from "./editor";
import { clipDuration } from "./clips";
import { snapClipMove, snapTime } from "./snap";

const ID = "0123456789abcdef";
/** A steady 120 BPM grid over the first 10 s of the file; the first beat is at 0.25 s. */
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

/** "video" (10 s, with a beat grid) on v1 at 2..12, a clip "later" on v1 at 14, a still on v2 at 20. */
function project(): Project {
  let p = makeProject();
  for (const [assetId, trackId, id, start] of [
    [IDS.vid, IDS.v1, "video", 2],
    [IDS.vid, IDS.v1, "later", 14],
    [IDS.img, IDS.v2, "still", 20],
  ] as const) {
    const r = addClip(p, { assetId, trackId, start, id });
    if (!r.ok) throw new Error(r.error.message);
    p = r.project;
  }
  const r = setClipBeatFx(p, "video", { gridId: ID });
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
}
const clips = (p: Project, trackId: string = IDS.v1): TimelineClip[] =>
  [...p.tracks.find((t) => t.id === trackId)!.clips].sort((a, b) => a.timelineStart - b.timelineStart);
const stored = () => useProjectStore.getState().project;
const grids = { [ID]: GRID };
const ok = (r: { ok: boolean; project?: Project; error?: { message: string } }) => {
  if (!r.ok) throw new Error(r.error?.message);
  return r.project!;
};
const close = (a: number[], b: number[]) => {
  expect(a.length).toBe(b.length);
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6));
};

beforeEach(() => {
  useBeatStore.setState({ grids, running: null });
  useSelectionStore.getState().clear();
  useTimelineViewStore.setState({ snapping: true, snapBeats: true });
});

describe("snap to beats", () => {
  it("collects the beats of every clip with a grid, except the excluded one", () => {
    const p = project();
    const beats = projectBeatTimes(p, grids);
    expect(beats).toHaveLength(20);
    close(beats.slice(0, 3), [2.25, 2.75, 3.25]);
    expect(projectBeatTimes(p, grids, "video")).toEqual([]);
    expect(projectBeatTimes(p, {})).toEqual([]); // grid not loaded: nothing to snap to
    expect(projectBeatTimes(p, { [ID]: null })).toEqual([]);
    // reversed clips have no beats
    const reversed = {
      ...p,
      tracks: p.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => ({ ...c, reversed: c.id === "video" })),
      })),
    };
    expect(projectBeatTimes(reversed, grids)).toEqual([]);
  });

  it("follows trim and speed", () => {
    const p = project();
    const fast: Project = {
      ...p,
      tracks: p.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => (c.id === "video" ? { ...c, sourceIn: 1, sourceOut: 5, speed: 2 } : c)),
      })),
    };
    // source beats 1.25 … 4.75 land at 2 + (s - 1) / 2
    close(
      projectBeatTimes(fast, grids),
      [1.25, 1.75, 2.25, 2.75, 3.25, 3.75, 4.25, 4.75].map((s) => 2 + (s - 1) / 2),
    );
  });

  it("pulls a point and a moved clip's edge onto a beat, only when the beats are given", () => {
    const p = project();
    const beats = projectBeatTimes(p, grids);
    const near = { playhead: 100, threshold: 0.05 };
    expect(snapTime(p, 4.27, { ...near, beats })).toEqual({ time: 4.25, snappedTo: "beat" });
    expect(snapTime(p, 4.27, near).snappedTo).toBeNull();
    expect(snapTime(p, 4.4, { ...near, beats }).snappedTo).toBeNull(); // out of range
    // the 5 s still moved so that its end is close to the beat at 10.25
    const still = clips(p, IDS.v2)[0];
    const moved = snapClipMove(p, still, 5.27, { ...near, beats });
    expect(moved.snappedTo).toBe("beat");
    expect(moved.time).toBeCloseTo(5.25, 6);
    expect(snapClipMove(p, still, 5.27, near).snappedTo).toBeNull();
  });
});

describe("cut on beats", () => {
  const video = (p = project()) => clips(p).find((c) => c.id === "video")!;

  it("splits at every beat; the pieces cover the clip exactly", () => {
    const p = ok(cutOnBeats(project(), "video", GRID, { every: 1 }));
    expectValid(p);
    const pieces = clips(p).filter((c) => c.timelineStart < 13);
    expect(pieces).toHaveLength(21); // 20 cuts
    expect(piecesAfterCut(project(), video(), GRID, 1)).toBe(21);
    close(
      pieces.slice(0, 4).map((c) => c.timelineStart),
      [2, 2.25, 2.75, 3.25],
    );
    pieces.forEach((c, i) => {
      if (i > 0)
        expect(c.timelineStart).toBeCloseTo(pieces[i - 1].timelineStart + clipDuration(pieces[i - 1]), 6);
      expect(c.beatFx?.gridId).toBe(ID); // every piece keeps its beat grid
    });
    expect(pieces.reduce((n, c) => n + clipDuration(c), 0)).toBeCloseTo(10, 6);
    expect(pieces[0].sourceIn).toBe(0);
    expect(pieces.at(-1)!.sourceOut).toBe(10);
  });

  it("cuts every 2nd, 4th and 8th beat counting from the first beat in the clip", () => {
    for (const [every, expected] of [
      [2, [2, 2.25, 3.25, 4.25, 5.25, 6.25, 7.25, 8.25, 9.25, 10.25, 11.25]],
      [4, [2, 2.25, 4.25, 6.25, 8.25, 10.25]],
      [8, [2, 2.25, 6.25, 10.25]],
    ] as const) {
      const p = ok(cutOnBeats(project(), "video", GRID, { every }));
      close(
        clips(p)
          .filter((c) => c.timelineStart < 13)
          .map((c) => c.timelineStart),
        [...expected],
      );
    }
  });

  it("can drop the part before the first beat and move the rest of the track up", () => {
    const p = ok(cutOnBeats(project(), "video", GRID, { every: 4, removeLeadIn: true }));
    expectValid(p);
    const track = clips(p);
    close(
      track.map((c) => c.timelineStart),
      [2, 4, 6, 8, 10, 13.75], // each start moved up by the 0.25 s lead-in; "later" too
    );
    expect(track[0].sourceIn).toBeCloseTo(0.25, 6); // starts on the first beat
    expect(track.at(-1)!.id).toBe("later");
    // another track is left alone
    expect(clips(p, IDS.v2)[0].timelineStart).toBe(20);
  });

  it("refuses reversed clips and clips with no beat, and leaves the project as it was", () => {
    const p = project();
    const reversed: Project = {
      ...p,
      tracks: p.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => (c.id === "video" ? { ...c, reversed: true } : c)),
      })),
    };
    const r = cutOnBeats(reversed, "video", GRID, { every: 1 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.message).toMatch(/backwards/);
    expect(
      cutOnBeats(p, "later", { ...GRID, start: 50, end: 60, offset: 50.25, beats: [] }, { every: 1 }).ok,
    ).toBe(false);
    expect(cutPoints(video(reversed), GRID, 1)).toEqual([]);
    expect(cutOnBeats(p, "nobody", GRID, { every: 1 }).ok).toBe(false);
  });

  it("is one undo step, and survives save and reopen", () => {
    useProjectStore.getState().loadProject(project(), "/p.cutvii", []);
    const before = stored();
    expect(cutClipOnBeats("video", GRID, { every: 2 }).ok).toBe(true);
    expect(clips(stored()).length).toBeGreaterThan(3);
    const reopened = parseProject(JSON.parse(JSON.stringify(stored())));
    expect(reopened.ok).toBe(true);
    undo();
    expect(stored().tracks).toEqual(before.tracks);
  });
});

describe("beat markers", () => {
  const clipOf = (id = "video") => clips(project()).find((c) => c.id === id)!;

  it("draw one tick per beat of the clip, and follow the zoom", () => {
    const { container, rerender } = render(<BeatMarks clip={clipOf()} path="/m/vid.mp4" pps={100} />);
    const d = () => container.querySelector("path")!.getAttribute("d")!;
    expect(d().startsWith("M25.0 0v7")).toBe(true); // beat at 2.25 is 0.25 s into the clip
    expect(d().split("M").length - 1).toBe(20);
    rerender(<BeatMarks clip={clipOf()} path="/m/vid.mp4" pps={5} />); // 2.5 px apart: thinned
    expect(d().split("M").length - 1).toBeLessThan(20);
  });

  it("draw nothing without loaded beats or on a reversed clip", () => {
    useBeatStore.setState({ grids: { [ID]: null } });
    const none = render(<BeatMarks clip={clipOf()} path="/m/vid.mp4" pps={100} />);
    expect(none.container.querySelector("svg")).toBeNull();
    none.unmount();
    useBeatStore.setState({ grids });
    const reversed = render(<BeatMarks clip={{ ...clipOf(), reversed: true }} path="/m/vid.mp4" pps={100} />);
    expect(reversed.container.querySelector("svg")).toBeNull();
  });

  it("show on the clip in the timeline, and on the seek bar for the selected clip", () => {
    useWaveformStore.setState({
      entries: Object.fromEntries(project().assets.map((a) => [a.path, { status: "loading" as const }])),
    });
    useProjectStore.getState().loadProject(project(), "/p.cutvii", []);
    const timeline = render(<Timeline />);
    const el = document.querySelector<HTMLElement>('[data-clip-id="video"]')!;
    expect(within(el).queryByTestId("beat-marks")).not.toBeNull();
    expect(
      within(document.querySelector<HTMLElement>('[data-clip-id="later"]')!).queryByTestId("beat-marks"),
    ).toBeNull();
    timeline.unmount();

    render(<SeekBar />);
    expect(screen.queryByTestId("seek-beats")).toBeNull(); // nothing selected
    act(() => useSelectionStore.getState().select("video"));
    expect(screen.queryByTestId("seek-beats")).not.toBeNull();
    act(() => useSelectionStore.getState().select("later"));
    expect(screen.queryByTestId("seek-beats")).toBeNull(); // that clip has no beats
  });

  it("have a toolbar switch for snapping that appears only with a grid", () => {
    useWaveformStore.setState({ entries: {} });
    useProjectStore.getState().loadProject(project(), "/p.cutvii", []);
    const { unmount } = render(<Timeline />);
    const toggle = screen.getByRole("button", { name: "Snap to beats on" });
    fireEvent.click(toggle);
    expect(useTimelineViewStore.getState().snapBeats).toBe(false);
    screen.getByRole("button", { name: "Snap to beats off" });
    unmount();

    const bare = ok(setClipBeatFx(project(), "video", { gridId: undefined }));
    useProjectStore.getState().loadProject(bare, "/p.cutvii", []);
    render(<Timeline />);
    expect(screen.queryByRole("button", { name: /Snap to beats/ })).toBeNull();
  });
});

describe("Cut on beats in the Audio tab", () => {
  beforeEach(() => {
    useProjectStore.getState().loadProject(project(), "/p.cutvii", []);
    usePlaybackStore.setState({ playhead: 0, playing: false, volume: 1, muted: false });
    useSelectionStore.getState().select("video");
    useUiStore.setState({ notice: null, inspectorTab: { video: "audio" } });
  });

  it("cuts every 4 beats with one click and one undo", () => {
    render(<Inspector />);
    const panel = within(screen.getByRole("group", { name: "Cut on beats" }));
    fireEvent.click(panel.getByRole("radio", { name: "4 beats" }));
    const button = panel.getByRole("button", { name: /Cut on beats/ });
    expect(button).toHaveTextContent("6 pieces");
    fireEvent.click(button);
    expect(clips(stored()).filter((c) => c.timelineStart < 13)).toHaveLength(6);
    undo();
    expect(clips(stored()).filter((c) => c.timelineStart < 13)).toHaveLength(1);
  });

  it("drops the lead-in when asked", () => {
    render(<Inspector />);
    const panel = within(screen.getByRole("group", { name: "Cut on beats" }));
    fireEvent.click(panel.getByRole("checkbox"));
    fireEvent.click(panel.getByRole("radio", { name: "8 beats" }));
    fireEvent.click(panel.getByRole("button", { name: /Cut on beats/ }));
    expect(clips(stored())[0].timelineStart).toBeCloseTo(2, 6);
    expect(clips(stored())[0].sourceIn).toBeCloseTo(0.25, 6);
  });

  it("is disabled for a clip that plays backwards", () => {
    const p = project();
    useProjectStore.getState().loadProject(
      {
        ...p,
        tracks: p.tracks.map((t) => ({
          ...t,
          clips: t.clips.map((c) => (c.id === "video" ? { ...c, reversed: true } : c)),
        })),
      },
      "/p.cutvii",
      [],
    );
    render(<Inspector />);
    expect(screen.getByRole("button", { name: /Cut on beats/ })).toBeDisabled();
  });
});
