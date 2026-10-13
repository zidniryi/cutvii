import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { Inspector } from "@/components/layout/Inspector";
import type { Project } from "@/project/model";
import { parseProject } from "@/project/parse";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useUiStore } from "@/store/ui";
import { expectValid, IDS, makeProject } from "@/test/makeProject";
import { detachAudio, setClipClean, setClipDuck } from "./audio";
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
const ok = (r: ReturnType<typeof setClipClean>) => {
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
};

describe("sound clean-up in the project", () => {
  it("stores only what is switched on, and survives save and reopen", () => {
    let p = ok(setClipClean(project(), "video", { noise: 0.6 }));
    expect(clipOf(p, "video").clean).toEqual({ noise: 0.6, rumble: false });
    expectValid(p);
    const reopened = parseProject(JSON.parse(JSON.stringify(p)));
    expect(reopened.ok && clipOf(reopened.project, "video").clean).toEqual({ noise: 0.6, rumble: false });
    p = ok(setClipClean(p, "video", { rumble: true }));
    expect(clipOf(p, "video").clean).toEqual({ noise: 0.6, rumble: true });
    p = ok(setClipClean(p, "video", { noise: 0, rumble: false }));
    expect("clean" in clipOf(p, "video")).toBe(false);
    expect(ok(setClipClean(p, "video", { noise: 0 }))).toBe(p); // nothing changes: no new project
  });

  it("refuses values out of range, stills, and files with a bad value", () => {
    expect(setClipClean(project(), "video", { noise: 1.2 }).ok).toBe(false);
    expect(setClipClean(project(), "video", { noise: Number.NaN }).ok).toBe(false);
    expect(setClipClean(project(), "still", { rumble: true }).ok).toBe(false);
    expect(setClipClean(project(), "nobody", { rumble: true }).ok).toBe(false);
    const raw = JSON.parse(JSON.stringify(ok(setClipClean(project(), "video", { noise: 0.5 }))));
    raw.tracks.flatMap((t: { clips: { id: string; clean?: unknown }[] }) => t.clips)[0].clean = {
      noise: 7,
      rumble: false,
    };
    expect(parseProject(raw).ok).toBe(false);
  });

  it("ducking is stored from 0 to 1 and refused outside it", () => {
    const p = ok(setClipDuck(project(), "video", 0.7));
    expect(clipOf(p, "video").duck).toBe(0.7);
    expectValid(p);
    expect("duck" in clipOf(ok(setClipDuck(p, "video", 0)), "video")).toBe(false);
    expect(setClipDuck(p, "video", 1.5).ok).toBe(false);
    expect(setClipDuck(p, "still", 0.5).ok).toBe(false);
    const raw = JSON.parse(JSON.stringify(p));
    raw.tracks.flatMap((t: { clips: { duck?: number }[] }) => t.clips)[0].duck = 3;
    expect(parseProject(raw).ok).toBe(false);
    const sound = ok(detachAudio(p, "video", { clipId: "sound", trackId: "new-audio" }));
    expect(clipOf(sound, "sound").duck).toBe(0.7);
  });

  it("goes with the sound when it is detached", () => {
    const p = ok(setClipClean(project(), "video", { noise: 0.4, rumble: true }));
    const after = ok(detachAudio(p, "video", { clipId: "sound", trackId: "new-audio" }));
    expect(clipOf(after, "sound").clean).toEqual({ noise: 0.4, rumble: true });
    expectValid(after);
  });
});

describe("Clean up sound in the Audio tab", () => {
  function open(p: Project, selected = "video", playhead = 0) {
    useProjectStore.getState().loadProject(p, "/p.cutvii", []);
    usePlaybackStore.setState({ playhead, playing: false, volume: 1, muted: false });
    useSelectionStore.getState().select(selected);
    useUiStore.setState({ notice: null, inspectorTab: { video: "audio" } });
  }
  const play = vi.fn(() => Promise.resolve());
  const pause = vi.fn();
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    play.mockClear();
    pause.mockClear();
    vi.spyOn(window.HTMLMediaElement.prototype, "play").mockImplementation(play);
    vi.spyOn(window.HTMLMediaElement.prototype, "pause").mockImplementation(pause);
    open(project());
  });
  afterEach(() => vi.restoreAllMocks());

  it("sets noise and rumble, each as one undo step", () => {
    render(<Inspector />);
    const panel = within(screen.getByRole("group", { name: "Clean up sound" }));
    const listen = panel.getByRole("button", { name: "Listen to 6 s" });
    expect(listen).toBeDisabled(); // nothing is switched on yet

    const slider = panel.getByRole("slider", { name: "Reduce noise" });
    fireEvent.change(slider, { target: { value: "60" } });
    expect(stored("video").clean).toBeUndefined(); // stored when the slider is let go
    expect(listen).toBeEnabled();
    fireEvent.pointerUp(slider);
    expect(stored("video").clean).toEqual({ noise: 0.6, rumble: false });

    fireEvent.click(panel.getByRole("button", { name: "Remove rumble and hum" }));
    expect(stored("video").clean).toEqual({ noise: 0.6, rumble: true });
    expect(panel.getByRole("button", { name: "Rumble removed (below 80 Hz)" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    undo();
    expect(stored("video").clean).toEqual({ noise: 0.6, rumble: false });
    undo();
    expect(stored("video").clean).toBeUndefined();
  });

  it("plays a cleaned sample from the playhead, and says so when it fails", async () => {
    open(ok(setClipClean(project(), "video", { noise: 0.5 })), "video", 5); // 3 s into the clip (starts at 2)
    vi.mocked(invoke).mockResolvedValueOnce("/cache/audio-samples/abc.wav");
    render(<Inspector />);
    const panel = within(screen.getByRole("group", { name: "Clean up sound" }));
    fireEvent.click(panel.getByRole("button", { name: "Listen to 6 s" }));
    await panel.findByRole("button", { name: "Stop" });
    expect(invoke).toHaveBeenCalledWith("audio_clean_sample", {
      path: "/m/vid.mp4",
      start: 3,
      clean: { noise: 0.5, rumble: false },
    });
    expect(play).toHaveBeenCalledTimes(1);
    fireEvent.click(panel.getByRole("button", { name: "Stop" }));
    expect(pause).toHaveBeenCalled();
    expect(panel.getByRole("button", { name: "Listen to 6 s" })).toBeInTheDocument();

    vi.mocked(invoke).mockRejectedValueOnce("this clip has no sound");
    fireEvent.click(panel.getByRole("button", { name: "Listen to 6 s" }));
    await waitFor(() => expect(panel.getByRole("alert")).toHaveTextContent("this clip has no sound"));
  });

  it("sets ducking from the slider as one undo step", () => {
    render(<Inspector />);
    const panel = within(screen.getByRole("group", { name: "Ducking" }));
    const slider = panel.getByRole("slider", { name: "Lower under other sound" });
    expect(slider).toHaveAttribute("aria-valuetext", "Off");
    fireEvent.change(slider, { target: { value: "50" } });
    expect(stored("video").duck).toBeUndefined(); // stored when the slider is let go
    fireEvent.pointerUp(slider);
    expect(stored("video").duck).toBe(0.5);
    expect(panel.getByText(/Heard in the export only/)).toBeInTheDocument();
    expectValid(useProjectStore.getState().project);
    fireEvent.change(slider, { target: { value: "0" } });
    fireEvent.pointerUp(slider);
    expect("duck" in stored("video")).toBe(false);
    undo();
    expect(stored("video").duck).toBe(0.5);
    undo();
    expect(stored("video").duck).toBeUndefined();
  });

  it("is not offered for a still", () => {
    open(project(), "still");
    render(<Inspector />);
    expect(screen.queryByRole("group", { name: "Clean up sound" })).not.toBeInTheDocument();
  });
});
