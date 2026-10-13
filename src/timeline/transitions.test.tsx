import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { Inspector } from "@/components/layout/Inspector";
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
import { holdAfter, remainingAt, setClipTransition, TRANSITIONS, transitionOf } from "./transitions";

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

describe("transitions in the project", () => {
  it("offers ten kinds, each starting somewhere else than where the clip belongs", () => {
    expect(TRANSITIONS).toHaveLength(10);
    expect(new Set(TRANSITIONS.map((k) => k.id)).size).toBe(10);
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

  it("picks a kind and a length in the Video tab, each as one undo step", () => {
    useProjectStore.getState().loadProject(project(), "/p.cutvii", []);
    usePlaybackStore.setState({ playhead: 5, playing: false });
    useSelectionStore.getState().select("second");
    useUiStore.setState({ notice: null, inspectorTab: {} });
    render(<Inspector />);
    const panel = within(screen.getByRole("group", { name: "Transition" }));
    const stored = () => clipOf(useProjectStore.getState().project, "second").transitionIn;
    const select = panel.getByRole("combobox", { name: "Transition in" });
    expect(within(select).getAllByRole("option")).toHaveLength(11); // None + ten
    expect(panel.queryByRole("slider")).not.toBeInTheDocument();

    fireEvent.change(select, { target: { value: "spin" } });
    expect(stored()).toEqual({ kind: "spin", duration: 0.5 });
    const length = panel.getByRole("slider", { name: "Length" });
    fireEvent.change(length, { target: { value: "1.2" } });
    expect(stored()!.duration).toBe(0.5); // stored when the slider is let go
    fireEvent.pointerUp(length);
    expect(stored()).toEqual({ kind: "spin", duration: 1.2 });
    fireEvent.change(select, { target: { value: "rise" } });
    expect(stored()).toEqual({ kind: "rise", duration: 1.2 }); // the length is kept
    expectValid(useProjectStore.getState().project);

    undo();
    expect(stored()).toEqual({ kind: "spin", duration: 1.2 });
    fireEvent.change(select, { target: { value: "" } });
    expect(stored()).toBeUndefined();
    expect(useUiStore.getState().notice).toBeNull();
  });
});
