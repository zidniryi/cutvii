import { act, fireEvent, render, screen } from "@testing-library/react";
import { AutoMatchDialog } from "@/components/AutoMatchDialog";
import { MediaLibrary } from "@/components/layout/MediaLibrary";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Project } from "@/project/model";
import { useAutoMatch } from "@/store/autoMatch";
import { useBeatStore } from "@/store/beats";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { expectValid, IDS, makeProject } from "@/test/makeProject";
import { autoMatch, planAutoMatch, setClipBeatFx, type BeatGrid } from "./beats";
import { clipDuration } from "./clips";
import { addClip } from "./edit";
import { autoMatchClips, undo } from "./editor";

const ID = "0123456789abcdef";
/** 120 BPM over the first 10 s of the song, first beat at 0.25 s. */
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
/** 60 BPM over 20 s: a beat is a second. */
const SLOW: BeatGrid = {
  ...GRID,
  end: 20,
  bpm: 60,
  offset: 0.5,
  beats: Array.from({ length: 20 }, (_, i) => 0.5 + i),
};

/** The song "music" (a1, 0..10 s of the 20 s file) with beats; library: vid 10 s, vid2 4 s, img, aud. */
function project(grid = GRID): Project {
  const r = addClip(makeProject(), {
    assetId: IDS.aud,
    trackId: IDS.a1,
    start: 0,
    duration: grid.end,
    id: "music",
  });
  if (!r.ok) throw new Error(r.error.message);
  const s = setClipBeatFx(r.project, "music", { gridId: ID });
  if (!s.ok) throw new Error(s.error.message);
  return s.project;
}
const track = (p: Project) => p.tracks.find((t) => t.name === "Beat edit");
const stored = () => useProjectStore.getState().project;
const music = (p = project()) => p.tracks.flatMap((t) => t.clips).find((c) => c.id === "music")!;
const opts = { beatsPerClip: 1 } as const;

beforeEach(() => {
  useBeatStore.setState({ grids: { [ID]: GRID }, running: null });
  useSelectionStore.setState({ selectedClipIds: [], selectedAssetIds: [] });
  useAutoMatch.getState().close();
});

describe("planning Auto-match", () => {
  it("puts each file in the slot between beats, whole frames, touching, from the first beat", () => {
    const plan = planAutoMatch(project(), music(), GRID, [IDS.vid, IDS.img, IDS.vid2], opts);
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.placements.map((p) => p.assetId)).toEqual([IDS.vid, IDS.img, IDS.vid2]);
    const frame = 1 / 30;
    expect(plan.placements[0].start).toBeCloseTo(Math.round(0.25 * 30) * frame, 9); // first beat, on a frame
    plan.placements.forEach((p, i) => {
      expect(p.duration).toBeCloseTo(0.5, 1);
      if (i > 0)
        expect(p.start).toBeCloseTo(plan.placements[i - 1].start + plan.placements[i - 1].duration, 9);
      expect(Math.abs(p.start * 30 - Math.round(p.start * 30))).toBeLessThan(1e-6);
    });
  });

  it("counts beats per clip, stops at the end of the list, and goes round when asked", () => {
    const ids = [IDS.vid, IDS.img, IDS.vid2];
    const count = (o: Parameters<typeof planAutoMatch>[4]) => {
      const plan = planAutoMatch(project(), music(), GRID, ids, o);
      return plan.ok ? plan.placements.length : plan.message;
    };
    expect(count({ beatsPerClip: 1 })).toBe(3);
    expect(count({ beatsPerClip: 1, repeat: true })).toBe(19); // 20 beats = 19 slots
    expect(count({ beatsPerClip: 4, repeat: true })).toBe(4);
    expect(count({ beatsPerClip: 4 })).toBe(3);
    const plan = planAutoMatch(project(), music(), GRID, ids, { beatsPerClip: 4, repeat: true });
    expect(plan.ok && plan.placements.map((p) => p.assetId)).toEqual([IDS.vid, IDS.img, IDS.vid2, IDS.vid]);
  });

  it("marks a video shorter than its beats, leaves sound files out, and says why it cannot", () => {
    const slow = project(SLOW);
    const plan = planAutoMatch(slow, music(slow), SLOW, [IDS.vid2, IDS.aud, IDS.img], { beatsPerClip: 8 });
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.skipped).toBe(1);
    expect(plan.placements.map((p) => [p.assetId, p.short])).toEqual([
      [IDS.vid2, true],
      [IDS.img, false],
    ]);
    expect(plan.placements[0].duration).toBeCloseTo(4, 6); // the whole 4 s video, the slot is 8 s
    expect(planAutoMatch(project(), music(), GRID, [IDS.aud], opts)).toMatchObject({ ok: false });
    expect(planAutoMatch(project(), music(), GRID, [], opts)).toMatchObject({ ok: false });
    expect(planAutoMatch(project(), { ...music(), reversed: true }, GRID, [IDS.vid], opts)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/backwards/),
    });
    expect(
      planAutoMatch(project(), music(), { ...GRID, beats: [], bpm: 0, steady: false }, [IDS.vid], opts),
    ).toMatchObject({
      ok: false,
    });
  });

  it("follows trim and speed of the song", () => {
    const p = project();
    const fast = { ...music(p), sourceIn: 1, sourceOut: 5, speed: 2 };
    const plan = planAutoMatch(p, fast, GRID, [IDS.vid], opts);
    if (!plan.ok) throw new Error(plan.message);
    // first beat inside 1..5 is 1.25 s into the file: 0 + (1.25 - 1) / 2 = 0.125 s on the timeline
    expect(plan.placements[0].start).toBeCloseTo(Math.round(0.125 * 30) / 30, 9);
    expect(plan.placements[0].duration).toBeCloseTo(0.25, 1); // a beat is a quarter second at double speed
  });
});

describe("Auto-match as an edit", () => {
  it("adds a Beat edit track, mutes videos but not pictures, and the result is valid", () => {
    const r = autoMatch(project(), "music", GRID, [IDS.vid, IDS.img], opts);
    if (!r.ok) throw new Error(r.error.message);
    expectValid(r.project);
    const clips = track(r.project)!.clips;
    expect(track(r.project)!.type).toBe("video");
    expect(clips.map((c) => c.assetId)).toEqual([IDS.vid, IDS.img]);
    expect(clips.map((c) => c.muted)).toEqual([true, undefined]);
    expect(clips.every((c) => Math.abs(clipDuration(c) - 0.5) < 0.04)).toBe(true);
    const kept = autoMatch(project(), "music", GRID, [IDS.vid], { ...opts, keepSound: true });
    expect(kept.ok && track(kept.project)!.clips[0].muted).toBeUndefined();
    expect(autoMatch(project(), "nobody", GRID, [IDS.vid], opts).ok).toBe(false);
  });

  it("is one undo step, selects the new clips, and survives save and reopen", () => {
    useProjectStore.getState().loadProject(project(), "/p.cutvii", []);
    const before = stored();
    expect(autoMatchClips("music", GRID, [IDS.vid, IDS.img, IDS.vid2], opts).ok).toBe(true);
    const placed = track(stored())!.clips;
    expect(placed).toHaveLength(3);
    expect(useSelectionStore.getState().selectedClipIds).toEqual(placed.map((c) => c.id));
    const reopened = JSON.parse(JSON.stringify(stored())) as Project;
    expect(track(reopened)!.clips).toHaveLength(3);
    undo();
    expect(stored().tracks).toEqual(before.tracks);
  });

  it("changes nothing when it cannot place anything", () => {
    useProjectStore.getState().loadProject(project(), "/p.cutvii", []);
    const before = stored();
    expect(autoMatchClips("music", GRID, [IDS.aud], opts).ok).toBe(false);
    expect(stored()).toBe(before);
  });
});

describe("the Auto-match dialog", () => {
  beforeEach(() => useProjectStore.getState().loadProject(project(), "/p.cutvii", []));

  it("is opened from the library's selection bar with the picked media", () => {
    act(() => useSelectionStore.getState().setAssetSelection([IDS.vid, IDS.img]));
    render(
      <TooltipProvider>
        <MediaLibrary />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Match to beat/ }));
    expect(useAutoMatch.getState().assetIds).toEqual([IDS.vid, IDS.img]);
  });

  it("explains what to do when no selected clip has beats", () => {
    act(() => useAutoMatch.getState().open([IDS.vid]));
    render(<AutoMatchDialog />);
    expect(screen.getByText(/Select a clip on the timeline whose beats are found first/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Place clips" })).toBeDisabled();
  });

  it("shows the plan, places the clips and closes", () => {
    act(() => {
      useSelectionStore.getState().select("music");
      useAutoMatch.getState().open([IDS.vid, IDS.img]);
    });
    render(<AutoMatchDialog />);
    expect(screen.getByText(/2 clips will be placed/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "4 beats" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Keep the sound/ }));
    fireEvent.click(screen.getByRole("button", { name: "Place clips" }));
    expect(track(stored())!.clips).toHaveLength(2);
    expect(track(stored())!.clips[0].muted).toBeUndefined(); // sound kept
    expect(clipDuration(track(stored())!.clips[0])).toBeCloseTo(2, 1);
    expect(screen.queryByRole("dialog")).toBeNull();
    undo();
    expect(track(stored())).toBeUndefined();
  });
});
