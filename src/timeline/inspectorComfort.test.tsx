import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { Inspector } from "@/components/layout/Inspector";
import { Timeline } from "@/components/layout/Timeline";
import type { Project } from "@/project/model";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useUiStore } from "@/store/ui";
import { expectValid, IDS, makeProject } from "@/test/makeProject";
import { addClip } from "./edit";
import { useSectionStore } from "@/store/inspectorSections";
import { undo } from "./editor";
import { keyMarks, resetProp, setKey } from "./keyframes";
import { setClipTransform } from "./transform";

/** A video ("below") on v1 at 2..12 and another ("above", 4 s long) on v2 at 2..6. */
function project(): Project {
  let p = makeProject();
  for (const [assetId, trackId, id] of [
    [IDS.vid, IDS.v1, "below"],
    [IDS.vid2, IDS.v2, "above"],
  ]) {
    const r = addClip(p, { assetId, trackId, start: 2, id });
    if (!r.ok) throw new Error(r.error.message);
    p = r.project;
  }
  return p;
}
const clipOf = (p: Project, id = "above") => p.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!;
const ok = (r: ReturnType<typeof setKey>) => {
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
};
/** "above" slides right from source 1 s to 3 s and fades at 3 s. */
const animated = () => {
  let p = ok(setKey(project(), "above", "x", 1, 0));
  p = ok(setKey(p, "above", "x", 3, 0.5));
  return ok(setKey(p, "above", "opacity", 3, 0.2));
};
const stored = (id = "above") => clipOf(useProjectStore.getState().project, id);
function open(p: Project, playhead: number) {
  useProjectStore.getState().loadProject(p, "/p.cutvii", []);
  usePlaybackStore.setState({ playhead, playing: false });
  useSelectionStore.getState().select("above");
  useUiStore.setState({ notice: null, inspectorTab: {} });
}

describe("keyframe marks on the timeline", () => {
  it("sit where the key's picture is: through trim, speed and reverse, one mark per moment", () => {
    const clip = clipOf(animated());
    expect(keyMarks(clip)).toEqual([
      { at: 1, props: ["x"] },
      { at: 3, props: ["x", "opacity"] },
    ]);
    expect(keyMarks({ ...clip, speed: 2 }).map((m) => m.at)).toEqual([0.5, 1.5]);
    expect(keyMarks({ ...clip, reversed: true }).map((m) => m.at)).toEqual([1, 3]); // 4 - 3 and 4 - 1
    expect(keyMarks({ ...clip, reversed: true })[0].props).toEqual(["x", "opacity"]);
    // trimmed to source 2..4: the key at 1 s is no longer in the clip
    expect(keyMarks({ ...clip, sourceIn: 2 })).toEqual([{ at: 1, props: ["x", "opacity"] }]);
    expect(keyMarks(clipOf(project()))).toEqual([]);
  });

  it("are drawn on the clip; a click moves the playhead there and does not move the clip", () => {
    open(animated(), 0);
    useSelectionStore.getState().clear();
    render(<Timeline />);
    const clip = document.querySelector<HTMLElement>('[data-clip-id="above"]')!;
    const marks = within(clip).getAllByTestId("key-mark");
    expect(marks.map((m) => m.style.left)).toEqual(["50px", "150px"]); // 50 px per second
    expect(marks[1]).toHaveAccessibleName("Keyframe at 3.00 s: Move across, Opacity");
    expect(
      within(document.querySelector<HTMLElement>('[data-clip-id="below"]')!).queryByTestId("key-mark"),
    ).toBeNull();

    fireEvent.pointerDown(marks[1], { button: 0, clientX: 300 });
    fireEvent.pointerMove(window, { clientX: 400 });
    fireEvent.pointerUp(window, { clientX: 400 });
    fireEvent.click(marks[1]);
    expect(usePlaybackStore.getState().playhead).toBe(5); // clip starts at 2
    expect(useSelectionStore.getState().selectedClipIds).toEqual(["above"]);
    expect(stored().timelineStart).toBe(2);
  });
});

describe("reset per field", () => {
  it("puts one transform value back and drops only that value's keyframes", () => {
    const moved = setClipTransform(animated(), "above", { scale: 0.5, rotation: 30 });
    if (!moved.ok) throw new Error(moved.error.message);
    let p = ok(resetProp(moved.project, "above", "x"));
    expect(clipOf(p).keyframes).toEqual({ opacity: [{ t: 3, v: 0.2 }] });
    expect(clipOf(p).x).toBe(0);
    p = ok(resetProp(p, "above", "rotation"));
    expect(clipOf(p).rotation).toBeUndefined();
    expect(clipOf(p).scale).toBe(0.5);
    expectValid(p);
    expect(ok(resetProp(p, "above", "y"))).toBe(p); // already plain: nothing changes
    expect(resetProp(p, "nobody", "x").ok).toBe(false);
  });

  it("shows a reset button only on changed values; one press is one undo step", () => {
    open(animated(), 3);
    render(<Inspector />);
    const panel = within(screen.getByRole("group", { name: "Transform" }));
    expect(panel.getByRole("button", { name: "Reset Scale", hidden: true })).toBeDisabled();
    expect(panel.getByRole("button", { name: "Reset Move down", hidden: true })).toBeDisabled();

    fireEvent.click(panel.getByRole("button", { name: "Reset Move across" }));
    expect(stored().keyframes).toEqual({ opacity: [{ t: 3, v: 0.2 }] });
    expect(panel.getByRole("button", { name: "Reset Move across", hidden: true })).toBeDisabled();
    fireEvent.click(panel.getByRole("button", { name: "Reset Opacity" }));
    expect(stored().keyframes).toBeUndefined();
    expect(stored().opacity).toBe(1);
    undo();
    expect(stored().keyframes).toEqual({ opacity: [{ t: 3, v: 0.2 }] });
    expect(useUiStore.getState().notice).toBeNull();
  });
});

describe("set start to playhead", () => {
  it("moves the clip to the playhead's frame as one undo step, and is off when it is already there", () => {
    open(project(), 2);
    render(<Inspector />);
    const button = screen.getByRole("button", { name: "Set start to playhead" });
    expect(button).toBeDisabled();

    expect(screen.getByLabelText("Start (s)")).toHaveValue(2); // the field keeps its label
    act(() => usePlaybackStore.setState({ playhead: 7.51 })); // between frames at 30 fps
    fireEvent.click(screen.getByRole("button", { name: "Set start to playhead" }));
    expect(stored().timelineStart).toBeCloseTo(7.5, 9);
    expectValid(useProjectStore.getState().project);
    undo();
    expect(stored().timelineStart).toBe(2);
  });

  it("says why when another clip is in the way", () => {
    const second = addClip(project(), { assetId: IDS.vid2, trackId: IDS.v2, start: 8, id: "later" });
    if (!second.ok) throw new Error(second.error.message);
    open(second.project, 6);
    render(<Inspector />);
    fireEvent.click(screen.getByRole("button", { name: "Set start to playhead" }));
    expect(stored().timelineStart).toBe(2);
    expect(useUiStore.getState().notice).toBeTruthy();
  });
});

describe("collapsible sections", () => {
  it("fold away under their title and stay folded for the next clip", () => {
    open(project(), 3);
    const { unmount } = render(<Inspector />);
    const header = screen.getByRole("button", { name: "Transform" });
    expect(header).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("group", { name: "Transform" })).toBeNull();
    expect(screen.getByRole("group", { name: "Crop" })).toBeInTheDocument(); // the others stay open
    expect(JSON.parse(localStorage.getItem("cutvii.inspector-sections.v1")!)).toEqual(["transform"]);

    unmount();
    useSelectionStore.getState().select("below");
    render(<Inspector />);
    expect(screen.getByRole("button", { name: "Transform" })).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByRole("button", { name: "Transform" }));
    expect(screen.getByRole("group", { name: "Transform" })).toBeInTheDocument();
    expect(useSectionStore.getState().closed).toEqual({});
  });
});

describe("scrubbing a number by its label", () => {
  /** Press the label, move the pointer `dx` px, and let go (or not). */
  const drag = (label: HTMLElement, dx: number, release = true) => {
    fireEvent.pointerDown(label, { button: 0, clientX: 100 });
    fireEvent.pointerMove(window, { clientX: 100 + dx });
    if (release) fireEvent.pointerUp(window, { clientX: 100 + dx });
  };

  it("changes a transform value one unit per two pixels, as one undo step on release", () => {
    open(project(), 3);
    render(<Inspector />);
    const panel = within(screen.getByRole("group", { name: "Transform" }));
    const label = panel.getByText("Rotation");
    drag(label, 60, false);
    expect(panel.getByRole("slider", { name: /Rotation/ })).toHaveValue("30"); // shown while dragging
    expect(stored().rotation).toBeUndefined(); // not stored yet
    fireEvent.pointerUp(window, { clientX: 160 });
    expect(stored().rotation).toBe(30);
    drag(label, -1000);
    expect(stored().rotation).toBe(-180); // stops at the limit
    undo();
    expect(stored().rotation).toBe(30);

    drag(label, 2); // a press that hardly moves is a click, not a change
    expect(stored().rotation).toBe(30);
    fireEvent.pointerDown(label, { button: 0, clientX: 100 });
    fireEvent.pointerMove(window, { clientX: 140 });
    fireEvent.pointerCancel(window);
    expect(stored().rotation).toBe(30);
    expect(panel.getByRole("slider", { name: /Rotation/ })).toHaveValue("30");
  });

  it("moves the clip a frame per step from the Start label", () => {
    open(project(), 0);
    render(<Inspector />);
    drag(screen.getByText("Start (s)"), 60); // 30 frames at 30 fps
    expect(stored().timelineStart).toBeCloseTo(3, 6);
    undo();
    expect(stored().timelineStart).toBe(2);
  });
});

describe("copy and paste of a transform", () => {
  it("gives another clip the same transform as one undo step; its keyframes go", () => {
    const moved = setClipTransform(animated(), "below", { scale: 0.5, x: 0.2, rotation: 15, flipH: true });
    if (!moved.ok) throw new Error(moved.error.message);
    open(moved.project, 3);
    useUiStore.getState().setTransformClipboard(null);
    useSelectionStore.getState().select("below");
    const { unmount } = render(<Inspector />);
    expect(screen.getByRole("button", { name: "Paste transform" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Copy transform" }));
    expect(useUiStore.getState().notice).toMatch(/copied/);
    expect(screen.getByRole("button", { name: "Paste transform" })).toBeDisabled(); // nothing would change

    unmount();
    useSelectionStore.getState().select("above");
    render(<Inspector />);
    fireEvent.click(screen.getByRole("button", { name: "Paste transform" }));
    const { scale, x, rotation, flipH, keyframes } = stored();
    expect({ scale, x, rotation, flipH, keyframes }).toEqual({
      scale: 0.5,
      x: 0.2,
      rotation: 15,
      flipH: true,
      keyframes: undefined,
    });
    expectValid(useProjectStore.getState().project);
    undo();
    expect(stored().keyframes).toBeDefined();
    expect(stored().scale).toBe(1);
  });
});
