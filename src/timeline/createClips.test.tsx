import { invoke } from "@tauri-apps/api/core";
import type { Project } from "@/project/model";
import { parseProject } from "@/project/parse";
import { useAutoClipsStore } from "@/store/autoClips";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { expectValid, IDS, makeProject } from "@/test/makeProject";
import { DEFAULT_SETTINGS, type ReviewClip, type TranscriptSentence } from "./autoClips";
import { projectDuration } from "./clips";
import {
  addAutoClips,
  clipProject,
  exportCanvas,
  exportSelectedClips,
  createClipsInProject,
  placeClips,
  SUBTITLE_WORDS,
  subtitlesForPlaced,
} from "./createClips";
import { addClip } from "./edit";
import { undo } from "./editor";

/** A 10-minute talk ("talk") on v1 from 5 s; the project ends at 605 s. */
function project(): Project {
  const base = makeProject();
  const r = addClip(
    {
      ...base,
      assets: [
        ...base.assets,
        { id: "long", path: "/m/talk.mp4", type: "video", duration: 700, width: 1920, height: 1080 },
      ],
    },
    { assetId: "long", trackId: IDS.v1, start: 5, id: "talk", duration: 600 },
  );
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
}
const clip = (id: string, sourceIn: number, sourceOut: number, included = true): ReviewClip => ({
  id,
  title: `Title ${id}`,
  text: "",
  sourceIn,
  sourceOut,
  timelineStart: 5 + sourceIn,
  timelineDuration: sourceOut - sourceIn,
  score: 0.5,
  tier: "medium",
  reasons: [],
  included,
});
const SENTENCES: TranscriptSentence[] = [
  { start: 40, end: 46, text: "Why does this simple habit work so well for nearly everyone who tries it?" },
  { start: 47, end: 52, text: "Because it is small." },
  { start: 200, end: 206, text: "Second part here." },
  { start: 300, end: 305, text: "Not in any clip." },
];
const clipsOf = (p: Project, trackId: string) => p.tracks.find((t) => t.id === trackId)?.clips ?? [];

describe("placing the clips", () => {
  it("lines them up after everything on the timeline, in spoken order, on whole frames", () => {
    const p = project();
    const placed = placeClips(p, [clip("b", 200, 230.5), clip("a", 40, 60)], ["x", "y"]);
    expect(placed.map((c) => [c.sourceIn, c.start])).toEqual([
      [40, 605],
      [200, 625],
    ]);
    expect(placed[0].start).toBeGreaterThanOrEqual(projectDuration(p));
  });

  it("makes short subtitles from the words inside the clip, in order, never overlapping", () => {
    const placed = { id: "x", title: "", sourceIn: 40, sourceOut: 52, start: 605 };
    const lines = subtitlesForPlaced(placed, SENTENCES);
    expect(lines.map((l) => l.text)).toEqual([
      "Why does this simple habit work so",
      "well for nearly everyone who tries it?",
      "Because it is small.",
    ]);
    expect(lines.every((l) => l.text.split(" ").length <= SUBTITLE_WORDS)).toBe(true);
    expect(lines[0].start).toBe(605);
    lines.forEach((l, i) => {
      expect(l.start).toBeGreaterThanOrEqual(605);
      expect(l.start + l.duration).toBeLessThanOrEqual(617 + 1e-9);
      if (i > 0) expect(l.start).toBeGreaterThanOrEqual(lines[i - 1].start + lines[i - 1].duration - 1e-9);
    });
    // a cut in the middle of a sentence keeps only the words inside
    const tight = subtitlesForPlaced({ ...placed, sourceIn: 43, sourceOut: 46 }, SENTENCES);
    expect(tight.map((l) => l.text).join(" ")).not.toMatch(/Why|Because/);
  });

  it("adds a new track with trimmed, centred clips and leaves everything else as it was", () => {
    const p = project();
    const placed = placeClips(p, [clip("a", 40, 60), clip("b", 200, 230)], ["x", "y"]);
    const r = addAutoClips(
      p,
      "long",
      placed,
      [],
      "vertical",
      { clipTrack: "new", subtitleTrack: "subs" },
      false,
    );
    if (!r.ok) throw new Error(r.error.message);
    expectValid(r.project);
    expect(r.project.tracks.filter((t) => t.id !== "new")).toEqual(p.tracks);
    expect(clipsOf(r.project, "new")).toMatchObject([
      { id: "x", assetId: "long", timelineStart: 605, sourceIn: 40, sourceOut: 60, fitMode: "fill" },
      { id: "y", assetId: "long", timelineStart: 625, sourceIn: 200, sourceOut: 230, fitMode: "fill" },
    ]);
    expect(clipsOf(r.project, "new").every((c) => c.speed === undefined)).toBe(true);
    expect(r.project.tracks.find((t) => t.id === "subs")).toBeUndefined();
    // no new media: the clips point at the original file
    expect(r.project.assets).toEqual(p.assets);

    // keeping the canvas leaves the fit alone; a missing original is refused
    const kept = addAutoClips(
      p,
      "long",
      placed,
      [],
      "keep",
      { clipTrack: "new", subtitleTrack: "subs" },
      false,
    );
    expect(kept.ok && clipsOf(kept.project, "new")[0].fitMode).toBeUndefined();
    expect(
      addAutoClips(p, "gone", placed, [], "keep", { clipTrack: "n", subtitleTrack: "s" }, false).ok,
    ).toBe(false);
  });
});

describe("creating from the review", () => {
  const drawnTexts: string[] = [];
  beforeEach(() => {
    drawnTexts.length = 0;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "render_text") {
        const text = (args as { spec: { content: string } }).spec.content;
        drawnTexts.push(text);
        return `/data/text/${drawnTexts.length}.png`;
      }
      return undefined;
    });
    useProjectStore.setState({ project: project(), past: [], future: [] });
    useSelectionStore.getState().clear();
    useAutoClipsStore.setState({
      clipId: "talk",
      settings: DEFAULT_SETTINGS,
      status: "ready",
      clips: [clip("a", 40, 52), clip("b", 200, 206), clip("c", 300, 305, false)],
      sentences: SENTENCES,
      context: {
        fps: 30,
        rangeIn: 0,
        rangeOut: 600,
        timelineStart: 5,
        speed: 1,
        path: "/m/talk.mp4",
        video: true,
      },
    });
  });
  const now = () => useProjectStore.getState().project;

  it("creates the included clips with subtitles as ONE undo step", async () => {
    const before = now();
    const result = await createClipsInProject();
    if (!result.ok) throw new Error(result.reason);
    expect(result.clipIds).toHaveLength(2); // "c" was not included
    expect(result.subtitles).toBe(4);
    expect(drawnTexts).toEqual([
      "Why does this simple habit work so",
      "well for nearly everyone who tries it?",
      "Because it is small.",
      "Second part here.",
    ]);
    expectValid(now());
    expect(useProjectStore.getState().past).toHaveLength(1);
    expect(useProjectStore.getState().past[0].label).toBe("Create 2 clips");

    const added = now().tracks.filter((t) => !before.tracks.some((b) => b.id === t.id));
    expect(added).toHaveLength(2); // the clips, and the subtitles above them
    const [clipsTrack, subtitleTrack] = [...added].sort((a, b) => a.order - b.order);
    expect(clipsTrack.clips).toMatchObject([
      { timelineStart: 605, sourceIn: 40, sourceOut: 52, fitMode: "fill" },
      { timelineStart: 617, sourceIn: 200, sourceOut: 206, fitMode: "fill" },
    ]);
    // every subtitle sits inside the clip it belongs to
    expect(subtitleTrack.clips).toHaveLength(4);
    for (const s of subtitleTrack.clips) {
      expect(s.timelineStart).toBeGreaterThanOrEqual(605);
      expect(s.timelineStart + (s.sourceOut - s.sourceIn)).toBeLessThanOrEqual(623 + 1e-6);
    }
    expect(subtitleTrack.clips.filter((s) => s.timelineStart >= 617)).toHaveLength(1);
    // the new clips are selected
    expect(useSelectionStore.getState().selectedClipIds).toEqual(result.clipIds);

    // save and reopen: the file round-trips unchanged
    const reopened = parseProject(JSON.parse(JSON.stringify(now())));
    expect(reopened.ok && reopened.project).toEqual(now());

    // one Undo takes everything away again
    undo();
    expect(now()).toEqual(before);
  });

  it("creates without subtitles when they are switched off, and draws nothing", async () => {
    useAutoClipsStore.getState().patchSettings({ subtitles: false, output: "keep" });
    const before = now();
    const result = await createClipsInProject();
    expect(result).toMatchObject({ ok: true, subtitles: 0 });
    expect(drawnTexts).toEqual([]);
    const added = now().tracks.filter((t) => !before.tracks.some((b) => b.id === t.id));
    expect(added).toHaveLength(1);
    expect(added[0].clips[0].fitMode).toBeUndefined();
  });

  it("changes nothing when a subtitle cannot be drawn, the media is gone or nothing is selected", async () => {
    const before = now();
    vi.mocked(invoke).mockRejectedValue("no font");
    expect(await createClipsInProject()).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/draw the subtitles/),
    });
    expect(now()).toBe(before);

    useAutoClipsStore.getState().setAllIncluded(false);
    expect(await createClipsInProject()).toMatchObject({ ok: false, reason: "Select at least one clip" });

    useAutoClipsStore.getState().setAllIncluded(true);
    useProjectStore.setState({
      project: {
        ...before,
        assets: before.assets.filter((a) => a.id !== "long"),
        tracks: before.tracks.map((t) => ({ ...t, clips: [] })),
      },
    });
    expect(await createClipsInProject()).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/no longer in the project/),
    });
  });
});

describe("exporting each clip as its own file", () => {
  type Sent = { items: { title: string; project: Project }[]; options: Record<string, unknown> };
  let sent: Sent | null = null;
  const drawnAt: [number, number][] = [];
  beforeEach(() => {
    sent = null;
    drawnAt.length = 0;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "render_text") {
        const a = args as { width: number; height: number };
        drawnAt.push([a.width, a.height]);
        return `/data/text/${drawnAt.length}.png`;
      }
      if (command === "export_clips") {
        sent = args as Sent;
        return {
          folder: "/out",
          cancelled: false,
          files: sent.items.map((item) => ({
            title: item.title,
            report: { path: `/out/${item.title}.mp4`, duration: projectDuration(item.project) },
          })),
        };
      }
      return undefined;
    });
    useProjectStore.setState({ project: project(), past: [], future: [] });
    useAutoClipsStore.setState({
      clipId: "talk",
      settings: DEFAULT_SETTINGS,
      status: "ready",
      clips: [clip("b", 200, 206), clip("a", 40, 52), clip("c", 300, 305, false)],
      sentences: SENTENCES,
      context: {
        fps: 30,
        rangeIn: 0,
        rangeOut: 600,
        timelineStart: 5,
        speed: 1,
        path: "/m/talk.mp4",
        video: true,
      },
    });
  });

  it("sizes the canvas for the chosen shape, always with even numbers", () => {
    const p = { width: 1920, height: 1080 };
    expect(exportCanvas("vertical", 1080, p)).toEqual({ width: 1080, height: 1920 });
    expect(exportCanvas("vertical", 720, p)).toEqual({ width: 720, height: 1280 });
    expect(exportCanvas("square", 720, p)).toEqual({ width: 720, height: 720 });
    expect(exportCanvas("keep", 720, p)).toEqual({ width: 1280, height: 720 });
    const odd = exportCanvas("keep", 720, { width: 1000, height: 333 });
    expect(odd.width % 2 === 0 && odd.height % 2 === 0).toBe(true);
  });

  it("builds a valid one-clip project that starts at 0 and lasts exactly as long as the clip", () => {
    const p = project();
    const asset = p.assets.find((a) => a.id === "long")!;
    const r = clipProject(
      p,
      asset,
      { title: "Hook", sourceIn: 40, sourceOut: 52.5 },
      [],
      { width: 1080, height: 1920 },
      "vertical",
      false,
    );
    if (!r.ok) throw new Error(r.error.message);
    expectValid(r.project);
    expect(r.project.name).toBe("Hook");
    expect(r.project.settings).toMatchObject({ width: 1080, height: 1920, fps: 30 });
    expect(r.project.assets).toEqual([asset]);
    expect(r.project.tracks).toHaveLength(1);
    expect(r.project.tracks[0].clips).toMatchObject([
      { timelineStart: 0, sourceIn: 40, sourceOut: 52.5, fitMode: "fill" },
    ]);
    expect(projectDuration(r.project)).toBe(12.5);
  });

  it("sends one project per included clip, in spoken order, with subtitles drawn for the export canvas", async () => {
    const before = useProjectStore.getState().project;
    const result = await exportSelectedClips(720, "high");
    if (!result.ok) throw new Error(result.reason);
    expect(sent!.options).toEqual({ width: 720, height: 1280, fps: 30, quality: "high", format: "mp4" });
    expect(sent!.items.map((i) => i.title)).toEqual(["Title a", "Title b"]);
    for (const item of sent!.items) expectValid(item.project);
    expect(sent!.items.map((i) => projectDuration(i.project))).toEqual([12, 6]);
    // subtitles: 3 lines for "a", 1 for "b", each inside its own clip, drawn at the export size
    expect(drawnAt).toEqual([
      [720, 1280],
      [720, 1280],
      [720, 1280],
      [720, 1280],
    ]);
    const subs = sent!.items.map((i) => [...i.project.tracks].sort((x, y) => y.order - x.order)[0].clips);
    expect(subs.map((s) => s.length)).toEqual([3, 1]);
    expect(subs[1][0].timelineStart).toBeGreaterThanOrEqual(0);
    expect(subs[1][0].timelineStart + (subs[1][0].sourceOut - subs[1][0].sourceIn)).toBeLessThanOrEqual(
      6 + 1e-6,
    );
    // what the files should last, to hold against FFprobe's answer
    expect(result.expected).toEqual([12, 6]);
    expect(result.report?.files.map((f) => f.report?.duration)).toEqual([12, 6]);
    // exporting never touches the open project
    expect(useProjectStore.getState().project).toBe(before);
    expect(useProjectStore.getState().past).toHaveLength(0);
  });

  it("reports a dismissed folder dialog, a failure, and an empty selection", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => (command === "export_clips" ? null : "/t.png"));
    expect(await exportSelectedClips(1080, "standard")).toMatchObject({ ok: true, report: null });
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "export_clips") throw "an export is already running";
      return "/t.png";
    });
    expect(await exportSelectedClips(1080, "standard")).toEqual({
      ok: false,
      reason: "an export is already running",
    });
    useAutoClipsStore.getState().setAllIncluded(false);
    expect(await exportSelectedClips(1080, "standard")).toMatchObject({
      ok: false,
      reason: "Select at least one clip",
    });
  });
});
