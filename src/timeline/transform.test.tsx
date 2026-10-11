import { fireEvent, render, screen, within } from "@testing-library/react";
import { Inspector } from "@/components/layout/Inspector";
import { Preview } from "@/components/layout/Preview";
import { layersAt } from "@/playback/engine";
import type { Project } from "@/project/model";
import { parseProject } from "@/project/parse";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useUiStore } from "@/store/ui";
import { expectValid, IDS, makeProject } from "@/test/makeProject";
import { addClip } from "./edit";
import { undo } from "./editor";
import { addTextClip } from "./text";
import {
  isTransformed,
  NO_TRANSFORM,
  setClipTransform,
  transformOf,
  transformStyle,
  type Transform,
} from "./transform";

/** A video ("below") on v1 and another ("above") on v2, both from 0; music on a1. */
function project(): Project {
  let p = makeProject();
  for (const [assetId, trackId, id] of [
    [IDS.vid, IDS.v1, "below"],
    [IDS.vid2, IDS.v2, "above"],
    [IDS.aud, IDS.a1, "sound"],
  ]) {
    const r = addClip(p, { assetId, trackId, start: 0, id });
    if (!r.ok) throw new Error(r.error.message);
    p = r.project;
  }
  return p;
}
const clipOf = (p: Project, id: string) => p.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!;
const moved = (p: Project, id: string, patch: Partial<Transform> | null) => {
  const r = setClipTransform(p, id, patch);
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
};
const visible = (p: Project, t = 1) =>
  layersAt(p, t, 0)
    .filter((l) => l.visible)
    .map((l) => l.clip.id);

describe("transform in the project", () => {
  it("stores position, scale and opacity always, rotation and flips only when set", () => {
    const p = moved(project(), "above", { scale: 0.5, x: 0.25, rotation: 30, flipH: true });
    expectValid(p);
    expect(clipOf(p, "above")).toMatchObject({
      scale: 0.5,
      x: 0.25,
      y: 0,
      opacity: 1,
      rotation: 30,
      flipH: true,
    });
    expect("flipV" in clipOf(p, "above")).toBe(false);
    expect(transformOf(clipOf(p, "above"))).toEqual({
      ...NO_TRANSFORM,
      scale: 0.5,
      x: 0.25,
      rotation: 30,
      flipH: true,
    });

    const back = moved(p, "above", null);
    expect(isTransformed(clipOf(back, "above"))).toBe(false);
    expect("rotation" in clipOf(back, "above") || "flipH" in clipOf(back, "above")).toBe(false);
    expectValid(back);
    // nothing to change is not an edit
    expect(setClipTransform(back, "above", { scale: 1 })).toEqual({ ok: true, project: back });
    expect(setClipTransform(back, "above", null)).toEqual({ ok: true, project: back });
  });

  it("refuses values outside the limits, in edits and in project files", () => {
    const p = project();
    for (const patch of [
      { scale: 0 },
      { scale: 4.5 },
      { x: 2.1 },
      { y: -3 },
      { rotation: 181 },
      { opacity: 1.2 },
    ]) {
      expect(setClipTransform(p, "above", patch)).toMatchObject({
        ok: false,
        error: { code: "out-of-range" },
      });
    }
    expect(setClipTransform(p, "sound", { scale: 0.5 })).toMatchObject({ ok: false });
    expect(setClipTransform(p, "nope", { scale: 0.5 })).toMatchObject({
      ok: false,
      error: { code: "unknown-clip" },
    });

    const errors = (change: object) => {
      const copy = structuredClone(p);
      Object.assign(clipOf(copy, "above"), change);
      const r = parseProject(copy);
      return r.ok ? [] : r.errors;
    };
    expect(errors({ scale: 4, x: -2, rotation: -180, flipV: true })).toHaveLength(0);
    for (const bad of [{ scale: 10 }, { x: 5 }, { rotation: 400 }, { flipH: "yes" }, { skew: 1 }]) {
      expect(errors(bad)).not.toHaveLength(0);
    }
  });

  it("turns into CSS in the export's order: mirror and scale, then turn, then move", () => {
    const c = (patch: Partial<Transform>) => clipOf(moved(project(), "above", patch), "above");
    expect(transformStyle(clipOf(project(), "above"))).toEqual({ transform: undefined, opacity: undefined });
    expect(transformStyle(c({ scale: 0.5 }))).toEqual({ transform: "scale(0.5, 0.5)", opacity: undefined });
    expect(
      transformStyle(c({ x: 0.25, y: -0.1, rotation: 90, scale: 0.5, flipH: true, opacity: 0.8 })),
    ).toEqual({
      transform: "translate(25%, -10%) rotate(90deg) scale(-0.5, 0.5)",
      opacity: 0.8,
    });
    expect(transformStyle(c({ flipV: true })).transform).toBe("scale(1, -1)");
  });
});

describe("transform in the preview", () => {
  it("lets the track below show around, or through, a transformed clip", () => {
    expect(visible(project())).toEqual(["above"]); // untouched: it covers everything
    expect(visible(moved(project(), "above", { scale: 0.5 }))).toEqual(["below", "above"]);
    expect(visible(moved(project(), "above", { opacity: 0.5 }))).toEqual(["below", "above"]);
    expect(visible(moved(project(), "above", { rotation: 10 }))).toEqual(["below", "above"]);
    // a transformed clip at the bottom changes nothing above it
    expect(visible(moved(project(), "below", { scale: 0.5 }))).toEqual(["above"]);
  });

  it("places the layer with the same numbers", () => {
    const p = moved(project(), "above", { scale: 0.5, x: 0.25, opacity: 0.6 });
    useProjectStore.getState().loadProject(p, "/p.cutvii", []);
    usePlaybackStore.setState({ playhead: 1, playing: false });
    render(<Preview />);
    const [below, above] = screen.getAllByTestId("video-layer");
    expect(above.style.transform).toBe("translate(25%, 0%) scale(0.5, 0.5)");
    expect(above.style.opacity).toBe("0.6");
    expect(below.style.transform).toBe("");
    expect(below.style.opacity).toBe("1"); // shown underneath
  });
});

describe("transform in the inspector", () => {
  const stored = (id = "above") => transformOf(clipOf(useProjectStore.getState().project, id));
  function open(p: Project, selected: string) {
    useProjectStore.getState().loadProject(p, "/p.cutvii", []);
    usePlaybackStore.setState({ playhead: 1, playing: false });
    useSelectionStore.getState().select(selected);
    useUiStore.setState({ notice: null, inspectorTab: {} });
    render(<Inspector />);
    return within(screen.getByRole("group", { name: "Transform" }));
  }
  const slide = (el: HTMLElement, value: number) => {
    fireEvent.change(el, { target: { value: String(value) } });
    fireEvent.pointerUp(el);
  };

  it("scales, moves, turns, mirrors and fades; each release is one undo step; Reset puts it all back", () => {
    const panel = open(project(), "above");
    expect(panel.getByRole("button", { name: "Reset transform" })).toBeDisabled();

    const scale = panel.getByRole("slider", { name: /Scale/ });
    fireEvent.change(scale, { target: { value: "50" } });
    expect(stored().scale).toBe(1); // still dragging
    fireEvent.pointerUp(scale);
    expect(stored().scale).toBe(0.5);

    slide(panel.getByRole("slider", { name: /Move across/ }), 25);
    slide(panel.getByRole("slider", { name: /Move down/ }), -10);
    slide(panel.getByRole("slider", { name: /Rotation/ }), 90);
    slide(panel.getByRole("slider", { name: /Opacity/ }), 80);
    fireEvent.click(panel.getByRole("button", { name: "Flip across" }));
    expect(stored()).toEqual({
      x: 0.25,
      y: -0.1,
      scale: 0.5,
      rotation: 90,
      flipH: true,
      flipV: false,
      opacity: 0.8,
    });
    expect(panel.getByRole("button", { name: "Flip across" })).toHaveAttribute("aria-pressed", "true");
    expectValid(useProjectStore.getState().project);
    expect(useProjectStore.getState().past).toHaveLength(6);

    undo();
    expect(stored().flipH).toBe(false);
    fireEvent.click(panel.getByRole("button", { name: "Reset transform" }));
    expect(stored()).toEqual(NO_TRANSFORM);
    expect(useUiStore.getState().notice).toBeNull();
  });

  it("offers text everything but its position, which the Text section already has", () => {
    const text = addTextClip(project(), {
      picture: "/data/text/a.png",
      spec: { content: "Hi", fontSize: 64, color: "#FFFFFF", x: 0.5, y: 0.5 },
      start: 12,
      assetId: "text",
      clipId: "title",
      trackId: "v9",
    });
    if (!text.ok) throw new Error(text.error.message);
    const panel = open(text.project, "title");
    expect(panel.queryByRole("slider", { name: /Move across/ })).not.toBeInTheDocument();
    slide(panel.getByRole("slider", { name: /Rotation/ }), -45);
    expect(stored("title")).toMatchObject({ rotation: -45, x: 0, y: 0 });
  });

  it("offers nothing for sound", () => {
    useProjectStore.getState().loadProject(project(), "/p.cutvii", []);
    useSelectionStore.getState().select("sound");
    useUiStore.setState({ inspectorTab: {} });
    render(<Inspector />);
    expect(screen.queryByRole("group", { name: "Transform" })).not.toBeInTheDocument();
  });
});
