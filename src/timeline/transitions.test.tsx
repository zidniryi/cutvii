import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { Inspector } from "@/components/layout/Inspector";
import { Timeline } from "@/components/layout/Timeline";
import { Preview } from "@/components/layout/Preview";
import { layersAt, planSync } from "@/playback/engine";
import type { Project } from "@/project/model";
import { parseProject } from "@/project/parse";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useUiStore } from "@/store/ui";
import { expectValid, IDS, makeProject } from "@/test/makeProject";
import { addClip } from "./edit";
import { undo } from "./editor";
import { transformAt, transformStyle } from "./transform";
import { soundGain } from "./audio";
import {
  holdAfter,
  remainingAt,
  setClipTransition,
  TRANSITIONS,
  transitionOf,
  transitionOutOf,
} from "./transitions";

/** One track: "first" at 0..4 and "second" right after it at 4..8; music on a1. */
function project(): Project {
  let p = makeProject();
  const cut = (id: string): Project => ({
    ...p,
    tracks: p.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => (c.id === id ? { ...c, sourceIn: 0, sourceOut: 4 } : c)),
    })),
  });
  for (const [assetId, trackId, id, start] of [
    [IDS.vid, IDS.v1, "first", 0],
    [IDS.vid2, IDS.v1, "second", 4],
    [IDS.aud, IDS.a1, "sound", 0],
  ] as const) {
    const r = addClip(p, { assetId, trackId, start, id });
    if (!r.ok) throw new Error(r.error.message);
    p = r.project;
    p = cut(id);
  }
  return p;
}
const clipOf = (p: Project, id: string) => p.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!;
const withTransition = (kind: string, duration = 1, id = "second") => {
  const r = setClipTransition(project(), id, { kind, duration });
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
};

beforeEach(() => useUiStore.setState({ transitionWay: "in" }));

describe("transitions in the project", () => {
  it("offers sixteen kinds, each starting somewhere else than where the clip belongs", () => {
    expect(TRANSITIONS).toHaveLength(16);
    expect(new Set(TRANSITIONS.map((k) => k.id)).size).toBe(16);
    expect(TRANSITIONS.every((k) => k.outName.length > 0)).toBe(true);
    for (const k of TRANSITIONS) {
      const { x, y, scale, rotation, opacity } = k.from;
      expect(x !== 0 || y !== 0 || scale !== 1 || rotation !== 0 || opacity !== 1, k.id).toBe(true);
    }
  });

  it("eases in straight lines from all of it left to none", () => {
    expect([-1, 0, 0.25, 0.5, 0.75, 1, 2].map(remainingAt)).toEqual([1, 1, 0.84375, 0.5, 0.15625, 0, 0]);
    expect(remainingAt(0.125)).toBeCloseTo(0.921875);
  });

  it("is stored on the incoming clip, valid to save, and refused when it makes no sense", () => {
    const p = withTransition("dissolve", 0.8);
    expect(clipOf(p, "second").transitionIn).toEqual({ kind: "dissolve", duration: 0.8 });
    expectValid(p);
    const reopened = parseProject(JSON.parse(JSON.stringify(p)));
    expect(reopened.ok && clipOf(reopened.project, "second").transitionIn).toEqual({
      kind: "dissolve",
      duration: 0.8,
    });
    const removed = setClipTransition(p, "second", null);
    expect(removed.ok && "transitionIn" in clipOf(removed.project, "second")).toBe(false);
    expect(setClipTransition(project(), "second", { kind: "sparkle", duration: 1 }).ok).toBe(false);
    expect(setClipTransition(project(), "second", { kind: "dissolve", duration: 9 }).ok).toBe(false);
    expect(setClipTransition(project(), "sound", { kind: "dissolve", duration: 1 }).ok).toBe(false);
    const raw = JSON.parse(JSON.stringify(p));
    raw.tracks[0].clips[1].transitionIn.kind = "sparkle";
    expect(parseProject(raw).ok).toBe(false);
  });

  it("is never longer than its clip, and tells the clip before it how long to hold", () => {
    const p = withTransition("dissolve", 3);
    expect(transitionOf(clipOf(p, "second"))!.seconds).toBe(3);
    expect(transitionOf({ ...clipOf(p, "second"), sourceOut: 2 })!.seconds).toBe(2);
    const track = p.tracks.find((t) => t.id === IDS.v1)!;
    expect(holdAfter(clipOf(p, "first"), track.clips)).toBe(3);
    expect(holdAfter(clipOf(p, "second"), track.clips)).toBe(0);
    // a gap between them: nothing is held
    const apart = track.clips.map((c) => (c.id === "second" ? { ...c, timelineStart: 5 } : c));
    expect(holdAfter(apart[0], apart)).toBe(0);
  });

  it("brings the clip in from where the kind starts, on top of its own transform", () => {
    const slide = clipOf(withTransition("slide-left", 1), "second");
    expect(transformAt(slide, 4).x).toBe(-1);
    expect(transformAt(slide, 4.5).x).toBeCloseTo(-0.5);
    expect(transformAt(slide, 5).x).toBe(0);
    expect(transformAt(slide, 7).x).toBe(0);
    const zoom = { ...clipOf(withTransition("zoom-in", 1), "second"), scale: 0.5, opacity: 0.8 };
    expect(transformAt(zoom, 4).scale).toBeCloseTo(0.15);
    expect(transformAt(zoom, 4).opacity).toBeCloseTo(0);
    expect(transformAt(zoom, 4.5).scale).toBeCloseTo(0.325);
    expect(transformAt(zoom, 4.5).opacity).toBeCloseTo(0.4);
    expect(transformAt(zoom, 5)).toMatchObject({ scale: 0.5, opacity: 0.8 });
    expect(transformStyle(slide, 4.5).transform).toBe("translate(-50%, 0%)");
  });
});

describe("leaving, fading through black, and the sound", () => {
  const out = (kind: string, duration: number, id = "first") => {
    const r = setClipTransition(project(), id, { kind, duration }, "out");
    if (!r.ok) throw new Error(r.error.message);
    return r.project;
  };

  it("a clip leaves over its last seconds, towards where the kind starts", () => {
    const p = out("slide-left", 1);
    const first = clipOf(p, "first"); // timeline 0..4
    expect(first.transitionOut).toEqual({ kind: "slide-left", duration: 1 });
    expectValid(p);
    expect(transformAt(first, 2.9).x).toBe(0);
    expect(transformAt(first, 3.5).x).toBeCloseTo(-0.5);
    expect(transformAt(first, 4).x).toBeCloseTo(-1);
    const fade = clipOf(out("dissolve", 2), "first");
    expect(transformAt(fade, 1.9).opacity).toBe(1);
    expect(transformAt(fade, 3).opacity).toBeCloseTo(0.5);
    expect(transformAt(fade, 4.5).opacity).toBeCloseTo(0); // still gone while it is held
  });

  it("the way out gets what the way in leaves of the clip", () => {
    const both = {
      ...clipOf(project(), "first"),
      transitionIn: { kind: "dissolve", duration: 3 },
      transitionOut: { kind: "dissolve", duration: 3 },
    };
    expect(transitionOf(both)!.seconds).toBe(3);
    expect(transitionOutOf(both)!.seconds).toBe(1);
    expect(
      transitionOutOf({ ...both, transitionIn: { kind: "dissolve", duration: 3 }, sourceOut: 3 }),
    ).toBeNull();
  });

  it("fade out, then fade from black: nothing is held, so black shows at the cut", () => {
    let p = out("dissolve", 0.5);
    const r = setClipTransition(p, "second", { kind: "fade-black", duration: 0.5 });
    if (!r.ok) throw new Error(r.error.message);
    p = r.project;
    const track = p.tracks.find((t) => t.id === IDS.v1)!;
    expect(holdAfter(clipOf(p, "first"), track.clips)).toBe(0); // "Fade from black" holds nothing
    const shown = layersAt(p, 4.1)
      .filter((l) => l.visible)
      .map((l) => l.clip.id);
    expect(shown).toEqual(["second"]);
    expect(transformAt(clipOf(p, "second"), 4.05).opacity).toBeLessThan(0.1);
    expect(transformAt(clipOf(p, "first"), 3.95).opacity).toBeLessThan(0.1);
  });

  it("the sound fades for as long as the picture comes in or leaves", () => {
    const clip = {
      ...clipOf(project(), "first"),
      transitionIn: { kind: "slide-left", duration: 1 },
      transitionOut: { kind: "dissolve", duration: 2 },
    };
    expect(soundGain(clip, 0.5)).toBeCloseTo(0.5);
    expect(soundGain(clip, 1.5)).toBe(1);
    expect(soundGain(clip, 3)).toBeCloseTo(0.5);
    expect(soundGain(clipOf(project(), "first"), 0.1)).toBe(1); // no transition: no fade
    // a longer fade of its own wins
    expect(soundGain({ ...clip, fadeIn: 2, transitionOut: undefined }, 1)).toBeCloseTo(0.5);
  });

  it("is set under Leaving in the panel, with the leaving names", () => {
    useProjectStore.getState().loadProject(project(), "/p.cutvii", []);
    usePlaybackStore.setState({ playhead: 1, playing: false });
    useSelectionStore.getState().select("first");
    useUiStore.setState({ notice: null, inspectorTab: { video: "transition" } });
    render(<Inspector />);
    const panel = within(screen.getByRole("group", { name: "Transition" }));
    fireEvent.click(panel.getByRole("tab", { name: "Leaving" }));
    const gallery = within(panel.getByRole("radiogroup", { name: "Transition out" }));
    expect(gallery.getByRole("radio", { name: "Fade to black" })).toBeInTheDocument();
    fireEvent.click(gallery.getByRole("radio", { name: "Fade out" }));
    const stored = () => clipOf(useProjectStore.getState().project, "first");
    expect(stored().transitionOut).toEqual({ kind: "dissolve", duration: 0.5 });
    expect(stored().transitionIn).toBeUndefined();
    expect(panel.getByRole("tab", { name: /Leaving/ })).toHaveTextContent("Leaving"); // marked as set
    const length = panel.getByRole("slider", { name: "Length" });
    fireEvent.change(length, { target: { value: "2" } });
    fireEvent.pointerUp(length);
    expect(stored().transitionOut).toEqual({ kind: "dissolve", duration: 2 });
    // "Play it" starts a little before the last 2 seconds of the clip (0..4)
    fireEvent.click(panel.getByRole("button", { name: "Play it" }));
    expect(usePlaybackStore.getState().playhead).toBeCloseTo(1.4);
    act(() => usePlaybackStore.setState({ playing: false }));
    undo();
    undo();
    expect(stored().transitionOut).toBeUndefined();
  });
});

describe("transitions in the preview and the inspector", () => {
  const roles = (p: Project, t: number) =>
    layersAt(p, t)
      .filter((l) => l.track.type === "video")
      .map((l) => `${l.clip.id}:${l.role}:${l.visible ? "shown" : "hidden"}`);

  it("holds the clip before under the incoming one for the length of the transition", () => {
    expect(roles(project(), 4.2)).toEqual(["second:active:shown"]); // a plain cut
    const p = withTransition("dissolve", 1);
    expect(roles(p, 3.5)).toEqual(["first:active:shown", "second:upcoming:hidden"]);
    expect(roles(p, 4.2)).toEqual(["first:held:shown", "second:active:shown"]);
    expect(roles(p, 5.2)).toEqual(["second:active:shown"]);
    // a held clip stays paused on its frame while everything else plays
    expect(
      planSync({ role: "held", playing: true, paused: false, currentTime: 3.97, desired: 3.97 }),
    ).toEqual({
      pause: true,
      rate: 1,
    });
  });

  it("fades the incoming layer in over the held one as the playhead moves", () => {
    useProjectStore.getState().loadProject(withTransition("dissolve", 1), "/p.cutvii", []);
    usePlaybackStore.setState({ playhead: 4.5, playing: false });
    render(<Preview />);
    const shown = () => screen.getAllByTestId("video-layer").filter((el) => el.style.opacity !== "0");
    expect(shown()).toHaveLength(2);
    expect(shown()[1].style.opacity).toBe("0.5");
    act(() => usePlaybackStore.getState().setPlayhead(6));
    expect(shown()).toHaveLength(1);
    expect(shown()[0].style.opacity).toBe("1");
  });

  it("picks a kind and a length in the Transition tab, each as one undo step, and plays it", () => {
    useProjectStore.getState().loadProject(project(), "/p.cutvii", []);
    usePlaybackStore.setState({ playhead: 5, playing: false });
    useSelectionStore.getState().select("second");
    useUiStore.setState({ notice: null, inspectorTab: {} });
    render(<Inspector />);
    fireEvent.click(screen.getByRole("tab", { name: "Transition" }));
    const panel = within(screen.getByRole("group", { name: "Transition" }));
    const stored = () => clipOf(useProjectStore.getState().project, "second").transitionIn;
    const gallery = within(panel.getByRole("radiogroup", { name: "Transition in" }));
    expect(gallery.getAllByRole("radio")).toHaveLength(17); // None + sixteen
    expect(gallery.getByRole("radio", { name: "None" })).toBeChecked();
    expect(panel.queryByRole("slider")).not.toBeInTheDocument();

    fireEvent.click(gallery.getByRole("radio", { name: "Spin in" }));
    expect(stored()).toEqual({ kind: "spin", duration: 0.5 });
    expect(gallery.getByRole("radio", { name: "Spin in" })).toBeChecked();
    const length = panel.getByRole("slider", { name: "Length" });
    fireEvent.change(length, { target: { value: "1.2" } });
    expect(stored()!.duration).toBe(0.5); // stored when the slider is let go
    fireEvent.pointerUp(length);
    expect(stored()).toEqual({ kind: "spin", duration: 1.2 });
    fireEvent.click(gallery.getByRole("radio", { name: "Rise" }));
    expect(stored()).toEqual({ kind: "rise", duration: 1.2 }); // the length is kept
    expectValid(useProjectStore.getState().project);

    // "Play it" starts a little before the clip (which starts at 4 s)
    fireEvent.click(panel.getByRole("button", { name: "Play it" }));
    expect(usePlaybackStore.getState().playhead).toBeCloseTo(3.4);
    expect(usePlaybackStore.getState().playing).toBe(true);
    act(() => usePlaybackStore.setState({ playing: false }));

    undo();
    expect(stored()).toEqual({ kind: "spin", duration: 1.2 });
    fireEvent.click(gallery.getByRole("radio", { name: "None" }));
    expect(stored()).toBeUndefined();
    expect(useUiStore.getState().notice).toBeNull();
  });
});

describe("transitions on the timeline", () => {
  it("a tile dragged onto a clip sets its way in (left half) or its way out (right half)", () => {
    useProjectStore.getState().loadProject(project(), "/p.cutvii", []);
    usePlaybackStore.setState({ playhead: 1, playing: false });
    useSelectionStore.getState().select("second");
    useUiStore.setState({ notice: null, inspectorTab: { video: "transition" } });
    render(<Inspector />);
    // a stand-in for the clip "first" in the timeline: 200 px wide, starting at x = 100
    const target = document.createElement("div");
    target.dataset.clipId = "first";
    target.getBoundingClientRect = () => ({ left: 100, width: 200 }) as DOMRect;
    document.body.append(target);
    const original = document.elementFromPoint;
    document.elementFromPoint = (x: number) => (x >= 100 && x <= 300 ? target : null);
    const stored = () => clipOf(useProjectStore.getState().project, "first");
    const drag = (toX: number) => {
      // found anew each time: the drop selects the clip, and the panel is then that clip's
      const tile = screen.getByRole("radio", { name: "Zoom in" });
      fireEvent.pointerDown(tile, { button: 0, clientX: 900, clientY: 300 });
      fireEvent.pointerMove(window, { clientX: 600, clientY: 500 });
      fireEvent.pointerMove(window, { clientX: toX, clientY: 700 });
    };

    drag(120); // over the left half
    expect(target.dataset.dropWay).toBe("in");
    fireEvent.pointerUp(window, { clientX: 120, clientY: 700 });
    expect(target.dataset.dropWay).toBeUndefined();
    expect(stored().transitionIn).toEqual({ kind: "zoom-in", duration: 0.5 });
    expect(useSelectionStore.getState().selectedClipIds).toEqual(["first"]);

    drag(280); // over the right half
    expect(target.dataset.dropWay).toBe("out");
    fireEvent.pointerUp(window, { clientX: 280, clientY: 700 });
    expect(stored().transitionOut).toEqual({ kind: "zoom-in", duration: 0.5 });

    // dropped on nothing, or let go with Escape: nothing changes
    const before = useProjectStore.getState().project;
    drag(700);
    fireEvent.pointerUp(window, { clientX: 700, clientY: 700 });
    drag(120);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(window, { clientX: 120, clientY: 700 });
    expect(useProjectStore.getState().project).toBe(before);

    document.elementFromPoint = original;
    target.remove();
  });

  it("a clip shows where it comes in and leaves", () => {
    let p = withTransition("dissolve", 1);
    const r = setClipTransition(p, "second", { kind: "dissolve", duration: 0.5 }, "out");
    if (!r.ok) throw new Error(r.error.message);
    p = r.project;
    useProjectStore.getState().loadProject(p, "/p.cutvii", []);
    render(<Timeline />);
    expect(screen.getAllByTestId("transition-in-mark")).toHaveLength(1);
    expect(screen.getAllByTestId("transition-out-mark")).toHaveLength(1);

    // pulling the bar of the transition in to the right makes it longer; stored on release, one undo step
    const stored = () => clipOf(useProjectStore.getState().project, "second");
    const bar = screen.getByRole("slider", { name: "Length of the transition in" });
    const before = within(screen.getByTestId("transition-in-mark")).getByRole("slider");
    expect(before).toBe(bar);
    const wide = () => parseFloat(screen.getByTestId("transition-in-mark").style.width);
    const start = wide();
    fireEvent.pointerDown(bar, { button: 0, clientX: 500 });
    fireEvent.pointerMove(window, { clientX: 500 + start }); // as far again as it is wide: 1 s more
    expect(wide()).toBeCloseTo(start * 2, 0);
    expect(stored().transitionIn!.duration).toBe(1); // still being pulled
    fireEvent.pointerUp(window);
    expect(stored().transitionIn).toEqual({ kind: "dissolve", duration: 2 });
    expect(stored().timelineStart).toBe(4); // the clip itself did not move
    undo();
    expect(stored().transitionIn!.duration).toBe(1);

    // the block is a thing of its own: a click selects the clip and opens that end in the Transition tab
    const out = screen.getByRole("button", { name: /^Transition out: Fade out, 0\.5 s/ });
    fireEvent.pointerDown(out, { button: 0 });
    fireEvent.click(out);
    expect(useSelectionStore.getState().selectedClipIds).toEqual(["second"]);
    expect(useUiStore.getState().transitionWay).toBe("out");
    expect(useUiStore.getState().inspectorTab.video).toBe("transition");
    expect(stored().timelineStart).toBe(4); // pressing it did not start moving the clip
    // Delete on the block removes the transition and leaves the clip
    fireEvent.keyDown(out, { key: "Delete" });
    expect(stored().transitionOut).toBeUndefined();
    expect(stored().transitionIn).toBeDefined();
    expect(clipOf(useProjectStore.getState().project, "second")).toBeDefined();
    expect(screen.queryByTestId("transition-out-mark")).not.toBeInTheDocument();
  });
});
