import { fireEvent, render, within } from "@testing-library/react";
import { Timeline } from "@/components/layout/Timeline";
import type { Project } from "@/project/model";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useWaveformStore } from "@/store/waveforms";
import { IDS, makeProject } from "@/test/makeProject";
import { fadeGain, fadeRamp, setClipSound, smoothStep, soundFadesOf, soundGain, soundRamp } from "./audio";
import { addClip } from "./edit";
import { undo } from "./editor";
import { setClipTransition } from "./transitions";

/** Music "sound" on a1 at 0..4 (50 px per second by default, so 200 px wide) and a video on v1 at 0..4. */
function project(): Project {
  let p = makeProject();
  for (const [assetId, trackId, id] of [
    [IDS.aud, IDS.a1, "sound"],
    [IDS.vid, IDS.v1, "picture"],
  ] as const) {
    const r = addClip(p, { assetId, trackId, start: 0, id });
    if (!r.ok) throw new Error(r.error.message);
    p = r.project;
    p = {
      ...p,
      tracks: p.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => (c.id === id ? { ...c, sourceIn: 0, sourceOut: 4 } : c)),
      })),
    };
  }
  return p;
}
const stored = (id = "sound") =>
  useProjectStore
    .getState()
    .project.tracks.flatMap((t) => t.clips)
    .find((c) => c.id === id)!;
const load = (p: Project) => {
  // peaks still being read: the clips have sound, and nothing asks Rust for them in a test
  useWaveformStore.setState({
    entries: Object.fromEntries(p.assets.map((a) => [a.path, { status: "loading" as const }])),
  });
  useProjectStore.getState().loadProject(p, "/p.cutvii", []);
};
/** The handles of one clip. */
const handles = (clipId: string) => {
  const el = document.querySelector<HTMLElement>(`[data-clip-id="${clipId}"]`);
  if (!el) throw new Error(`no clip ${clipId}`);
  return {
    fadeIn: within(el).queryByTestId("fade-in-handle"),
    fadeOut: within(el).queryByTestId("fade-out-handle"),
    rampIn: within(el).queryByTestId("fade-in-ramp"),
    rampOut: within(el).queryByTestId("fade-out-ramp"),
  };
};

beforeEach(() => useSelectionStore.getState().clear());

describe("fade envelope", () => {
  it("ramps straight in and out and never goes outside 0..1", () => {
    expect(fadeRamp(0, 4, 2, 1)).toBe(0);
    expect(fadeRamp(1, 4, 2, 1)).toBe(0.5);
    expect(fadeRamp(2, 4, 2, 1)).toBe(1);
    expect(fadeRamp(3.5, 4, 2, 1)).toBeCloseTo(0.5);
    expect(fadeRamp(4, 4, 2, 1)).toBe(0);
    expect(fadeRamp(2, 4, 0, 0)).toBe(1);
  });

  it("shapes the sound's fade as a half sine: no corner at either end, and the same halfway", () => {
    expect(smoothStep(0)).toBe(0);
    expect(smoothStep(1)).toBeCloseTo(1);
    expect(smoothStep(0.5)).toBeCloseTo(0.5);
    // gentler than a straight ramp near the ends
    expect(smoothStep(0.1)).toBeLessThan(0.1);
    expect(smoothStep(0.9)).toBeGreaterThan(0.9);
    expect(soundRamp(0.25, 4, 1, 0)).toBeCloseTo(smoothStep(0.25));
    expect(soundRamp(3.75, 4, 0, 1)).toBeCloseTo(smoothStep(0.25));

    // the sound follows it; a picture's own fade (text transparency) stays a straight ramp
    const clip = { sourceIn: 0, sourceOut: 4, timelineStart: 0, fadeIn: 1 };
    expect(soundGain(clip, 0.25)).toBeCloseTo(smoothStep(0.25));
    expect(fadeGain(clip, 0.25)).toBeCloseTo(0.25);
  });

  it("makes the sound fade at least as long as the transition of its picture", () => {
    const base = { sourceIn: 0, sourceOut: 4, timelineStart: 0, fadeIn: 0.5 };
    expect(soundFadesOf(base)).toEqual({ fadeIn: 0.5, fadeOut: 0 });
    expect(soundFadesOf({ ...base, transitionIn: { kind: "dissolve", duration: 1.5 } })).toEqual({
      fadeIn: 1.5,
      fadeOut: 0,
    });
  });
});

describe("fade handles on a clip", () => {
  it("are dragged along the clip: the ramp follows, the fade is stored on release, one undo step", () => {
    load(project());
    render(<Timeline />);
    const handle = handles("sound").fadeIn!;
    const ramp = () => handles("sound").rampIn!;
    expect(handles("sound").rampIn).toBeNull(); // no fade, no ramp

    fireEvent.pointerDown(handle, { button: 0, clientX: 300 });
    fireEvent.pointerMove(window, { clientX: 400 }); // 100 px = 2 s
    expect(parseFloat(ramp().style.width)).toBeCloseTo(100, 0);
    expect(stored().fadeIn).toBeUndefined(); // still being dragged
    fireEvent.pointerUp(window);
    expect(stored().fadeIn).toBeCloseTo(2);
    expect(stored().timelineStart).toBe(0); // the clip did not move
    expect(useSelectionStore.getState().selectedClipIds).toEqual(["sound"]);

    undo();
    expect(stored().fadeIn).toBeUndefined();
  });

  it("do not leave less room than the fade at the other end needs", () => {
    load(project());
    render(<Timeline />);
    fireEvent.pointerDown(handles("sound").fadeOut!, { button: 0, clientX: 500 });
    fireEvent.pointerMove(window, { clientX: 400 }); // leftwards: 2 s out
    fireEvent.pointerUp(window);
    expect(stored().fadeOut).toBeCloseTo(2);

    // the clip is 4 s: a fade in dragged past the end stops where the fade out begins
    fireEvent.pointerDown(handles("sound").fadeIn!, { button: 0, clientX: 0 });
    fireEvent.pointerMove(window, { clientX: 5000 });
    fireEvent.pointerUp(window);
    expect(stored().fadeIn).toBeCloseTo(2);
    expect(stored().fadeOut).toBeCloseTo(2);
  });

  it("are removed with a double-click or Delete and nudged with the arrow keys", () => {
    load(project());
    render(<Timeline />);
    const handle = () => handles("sound").fadeIn!;
    fireEvent.keyDown(handle(), { key: "ArrowRight" });
    fireEvent.keyDown(handle(), { key: "ArrowRight" });
    expect(stored().fadeIn).toBeCloseTo(0.2);
    fireEvent.keyDown(handle(), { key: "ArrowLeft" });
    expect(stored().fadeIn).toBeCloseTo(0.1);
    fireEvent.doubleClick(handle());
    expect(stored().fadeIn).toBeUndefined();

    fireEvent.keyDown(handle(), { key: "ArrowRight" });
    fireEvent.keyDown(handle(), { key: "Delete" });
    expect(stored().fadeIn).toBeUndefined();
    expect(stored()).toBeDefined(); // the clip stays
  });

  it("are left to the transition at an end that has one", () => {
    const r = setClipTransition(project(), "picture", { kind: "dissolve", duration: 1 });
    if (!r.ok) throw new Error(r.error.message);
    load(r.project);
    render(<Timeline />);
    // the picture's sound fades in with its transition, so only the music has a knob at that end
    expect(handles("picture").fadeIn).toBeNull();
    expect(handles("picture").fadeOut).not.toBeNull();
    expect(handles("sound").fadeIn).not.toBeNull();
  });

  it("are not shown on a muted clip or on a still", () => {
    const m = setClipSound(project(), "sound", { muted: true });
    if (!m.ok) throw new Error(m.error.message);
    load(m.project);
    render(<Timeline />);
    expect(handles("sound").fadeIn).toBeNull();
    expect(handles("sound").fadeOut).toBeNull();
    expect(handles("picture").fadeIn).not.toBeNull();
  });

  it("show a knob only while the pointer is near that end of the clip", () => {
    load(project());
    render(<Timeline />);
    const clip = document.querySelector<HTMLElement>('[data-clip-id="sound"]')!;
    const dot = (way: "in" | "out") =>
      (way === "in" ? handles("sound").fadeIn : handles("sound").fadeOut)!.firstElementChild as HTMLElement;
    const shown = (way: "in" | "out") => dot(way).className.split(/\s+/).includes("opacity-100");

    expect(shown("in")).toBe(false);
    expect(shown("out")).toBe(false);

    fireEvent.pointerMove(clip, { clientX: 10 }); // the first px of the clip
    expect(shown("in")).toBe(true);
    expect(shown("out")).toBe(false);

    fireEvent.pointerMove(clip, { clientX: 100 }); // the middle of the 200 px clip
    expect(shown("in")).toBe(false);
    expect(shown("out")).toBe(false);

    fireEvent.pointerMove(clip, { clientX: 190 });
    expect(shown("in")).toBe(false);
    expect(shown("out")).toBe(true);

    fireEvent.pointerLeave(clip);
    expect(shown("out")).toBe(false);
  });
});
