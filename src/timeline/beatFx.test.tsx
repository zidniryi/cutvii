import { fireEvent, render, screen, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { Inspector } from "@/components/layout/Inspector";
import { SettingsDialog } from "@/components/SettingsDialog";
import { exportProject } from "@/lib/exportApi";
import type { Project } from "@/project/model";
import { parseProject } from "@/project/parse";
import { useBeatSafety } from "@/store/beatSafety";
import { useBeatStore } from "@/store/beats";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useUiStore } from "@/store/ui";
import { IDS, makeProject } from "@/test/makeProject";
import { BEAT_TABLE, effectWarning, newEffect } from "./beatFx";
import { setClipBeatFx, type BeatGrid } from "./beats";
import { addClip } from "./edit";
import { undo } from "./editor";

const ID = "0123456789abcdef";
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

function project(): Project {
  const r = addClip(makeProject(), { assetId: IDS.vid, trackId: IDS.v1, start: 2, id: "video" });
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
}
const stored = () =>
  useProjectStore
    .getState()
    .project.tracks.flatMap((t) => t.clips)
    .find((c) => c.id === "video")!;

function open(p: Project) {
  useProjectStore.getState().loadProject(p, "/p.cutvii", []);
  usePlaybackStore.setState({ playhead: 0, playing: false, volume: 1, muted: false });
  useSelectionStore.getState().select("video");
  useUiStore.setState({ notice: null, inspectorTab: { video: "video" } });
}
const panel = () => within(screen.getByRole("group", { name: "Beat effects" }));

describe("beat effects in the Video tab", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(null);
    useBeatStore.setState({ grids: { [ID]: GRID }, running: null });
    useBeatSafety.setState({ reduceFlashing: true });
    open(project());
  });

  it("asks for the beats first, then adds, edits and removes effects, each one undo step", () => {
    render(<Inspector />);
    expect(panel().getByText(/press Detect beats first/)).toBeInTheDocument();

    const p = setClipBeatFx(project(), "video", { gridId: ID });
    if (!p.ok) throw new Error(p.error.message);
    open(p.project);
    fireEvent.click(panel().getByRole("button", { name: /Zoom pulse/ }));
    expect(stored().beatFx?.effects).toEqual([
      { kind: "zoom", intensity: 0.7, everyNthBeat: 1, offsetMs: 0 },
    ]);

    const slider = screen.getByLabelText("Strength");
    fireEvent.change(slider, { target: { value: "100" } });
    fireEvent.click(screen.getByRole("radio", { name: "4th" }));
    fireEvent.click(screen.getByRole("radio", { name: "Linear" }));
    fireEvent.change(screen.getByLabelText("Delay (ms)"), { target: { value: "40" } });
    expect(stored().beatFx?.effects[0]).toEqual({
      kind: "zoom",
      intensity: 1,
      everyNthBeat: 4,
      offsetMs: 40,
      easing: "linear",
    });
    fireEvent.click(panel().getByRole("button", { name: /Flash/ }));
    expect(stored().beatFx?.effects.map((e) => e.kind)).toEqual(["zoom", "flash"]);

    fireEvent.click(screen.getByRole("button", { name: "Remove Zoom pulse" }));
    expect(stored().beatFx?.effects.map((e) => e.kind)).toEqual(["flash"]);
    undo();
    expect(stored().beatFx?.effects.map((e) => e.kind)).toEqual(["zoom", "flash"]);
    undo(); // flash added
    undo(); // delay
    expect(stored().beatFx?.effects[0].offsetMs).toBe(0);
  });

  it("stops at eight effects with a notice, and is hidden for a reversed clip", () => {
    const p = setClipBeatFx(project(), "video", {
      gridId: ID,
      effects: Array.from({ length: 8 }, () => newEffect("zoom")),
    });
    if (!p.ok) throw new Error(p.error.message);
    open(p.project);
    render(<Inspector />);
    for (const b of panel().getAllByRole("button", { name: /Zoom pulse|Shake|Flash|Glitch/ })) {
      if (b.textContent) expect(b).toBeDisabled();
    }
    expect(
      setClipBeatFx(p.project, "video", { effects: Array.from({ length: 9 }, () => newEffect("zoom")) }).ok,
    ).toBe(true); // the editor allows it; the file check below refuses it
    const raw = JSON.parse(JSON.stringify(p.project));
    raw.tracks[0].clips[0].beatFx.effects.push(newEffect("shake"));
    expect(parseProject(raw).ok).toBe(false);
  });

  it("warns about strong flashes, and explains the limit while Reduce flashing is on", () => {
    const strong = { ...newEffect("flash"), intensity: 1 };
    expect(effectWarning(strong, true)).toMatch(/limits this flash to 50 %/);
    expect(effectWarning(strong, false)).toMatch(/seizures/);
    expect(effectWarning({ ...strong, intensity: 0.4 }, true)).toBeNull();
    expect(effectWarning({ ...newEffect("zoom"), intensity: 0.9 }, true)).toMatch(/strong/i);
    expect(BEAT_TABLE.reduceFlashing.maxFlashIntensity).toBe(0.5);
  });
});

describe("Reduce flashing setting", () => {
  it("is on by default, can be turned off in Settings, and reaches the export", async () => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(null);
    useBeatSafety.setState({ reduceFlashing: true });
    useUiStore.setState({ settingsOpen: true });
    render(<SettingsDialog />);
    const box = screen.getByRole("checkbox", { name: /Reduce flashing/ });
    expect(box).toBeChecked();
    await exportProject(project(), { width: 640, height: 360, fps: 30, quality: "draft", format: "mp4" });
    expect(vi.mocked(invoke).mock.calls[0][1]).toMatchObject({ reduceFlashing: true });
    fireEvent.click(box);
    expect(useBeatSafety.getState().reduceFlashing).toBe(false);
    await exportProject(project(), { width: 640, height: 360, fps: 30, quality: "draft", format: "mp4" });
    expect(vi.mocked(invoke).mock.calls[1][1]).toMatchObject({ reduceFlashing: false });
    useBeatSafety.setState({ reduceFlashing: true });
  });
});
