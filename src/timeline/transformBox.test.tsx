import { act, fireEvent, render, screen } from "@testing-library/react";
import { Preview } from "@/components/layout/Preview";
import { TRANSFORM_LIMITS, type Project } from "@/project/model";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useUiStore } from "@/store/ui";
import { expectValid, IDS, makeProject } from "@/test/makeProject";
import { addClip } from "./edit";
import { undo } from "./editor";
import { findClip } from "./clips";
import { NO_TRANSFORM, transformStyle } from "./transform";
import {
  boxCorners,
  centreOf,
  inside,
  keepCentre,
  layerBox,
  moved,
  normalAngle,
  rotatedFrom,
  scaledFrom,
  setTransformAt,
  withDraft,
} from "./transformBox";

const canvas = { width: 1920, height: 1080 };
const whole = { x: 0, y: 0, width: 1, height: 1 };
const near = (a: number, b: number, d = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(d);

describe("the box around a clip", () => {
  it("is the whole canvas with no transform, and follows scale, turn and move", () => {
    const c = boxCorners(whole, NO_TRANSFORM, canvas);
    expect(c[0]).toEqual({ x: 0, y: 0 });
    expect(c[2]).toEqual({ x: 1920, y: 1080 });
    const half = boxCorners(whole, { ...NO_TRANSFORM, scale: 0.5, x: 0.1 }, canvas);
    near(half[0].x, 480 + 192);
    near(half[0].y, 270);
    const turned = boxCorners(whole, { ...NO_TRANSFORM, rotation: 90 }, canvas);
    near(turned[0].x, 960 + 540); // the top-left corner swings to the top-right
    near(turned[0].y, 540 - 960);
    expect(inside(half, centreOf(half))).toBe(true);
    expect(inside(half, { x: 5, y: 5 })).toBe(false);
  });

  it("matches the CSS the preview draws (same order: scale, turn, move)", () => {
    const t = { ...NO_TRANSFORM, scale: 0.5, rotation: 30, x: 0.1, y: -0.05 };
    expect(transformStyle({ ...t }).transform).toBe("translate(10%, -5%) rotate(30deg) scale(0.5, 0.5)");
    // the box centre of a whole-canvas layer is the canvas centre moved by x and y, however it is turned
    const c = centreOf(boxCorners(whole, t, canvas));
    near(c.x, 960 + 192);
    near(c.y, 540 - 54);
  });

  it("of a see-through picture is its own fitted picture, not the canvas", () => {
    const p = makeProject();
    const asset = { ...p.assets.find((a) => a.id === IDS.img)!, alpha: true, width: 1000, height: 1000 };
    const r = addClip(p, { assetId: IDS.img, trackId: IDS.v1, start: 0, id: "c", duration: 2 });
    if (!r.ok) throw new Error();
    const clip = findClip(r.project, "c")!.clip;
    const b = layerBox(clip, asset, canvas);
    near(b.height, 1);
    near(b.width, 1080 / 1920);
    expect(layerBox(clip, { ...asset, alpha: undefined }, canvas)).toEqual(whole);
  });
});

describe("gestures", () => {
  it("move: follows the pointer, stays inside the limit, snaps onto the centre lines unless free", () => {
    const m = moved(NO_TRANSFORM, whole, canvas, 192, -108, true);
    near(m.x, 0.1);
    near(m.y, -0.1);
    const snapped = moved(NO_TRANSFORM, whole, canvas, 5, -4);
    expect([snapped.x, snapped.y]).toEqual([0, 0]);
    expect(snapped.vertical).toEqual([0.5]);
    expect(snapped.horizontal).toEqual([0.5]);
    const far = moved(NO_TRANSFORM, whole, canvas, 9e6, 0, true);
    expect(far.x).toBe(TRANSFORM_LIMITS.offset);
  });

  it("resize: the scale follows the distance from the centre, inside the limits", () => {
    const c = { x: 960, y: 540 };
    near(scaledFrom(1, c, { x: 1160, y: 540 }, { x: 1360, y: 540 }), 2);
    near(scaledFrom(1, c, { x: 1160, y: 540 }, { x: 1060, y: 540 }), 0.5);
    expect(scaledFrom(1, c, { x: 1160, y: 540 }, { x: 961, y: 540 })).toBe(TRANSFORM_LIMITS.minScale);
    expect(scaledFrom(3, c, { x: 1160, y: 540 }, { x: 9000, y: 540 })).toBe(TRANSFORM_LIMITS.maxScale);
  });

  it("turn: follows the pointer's angle, Shift snaps to 15 degrees, always -180..180", () => {
    const c = { x: 0, y: 0 };
    near(rotatedFrom(0, c, { x: 10, y: 0 }, { x: 0, y: 10 }), 90); // clockwise on screen
    expect(rotatedFrom(0, c, { x: 10, y: 0 }, { x: 10, y: 0.5 }, 15)).toBe(0);
    expect(rotatedFrom(0, c, { x: 10, y: 0 }, { x: 10, y: 3.4 }, 15)).toBe(15);
    expect(rotatedFrom(170, c, { x: 10, y: 0 }, { x: 0, y: 10 })).toBe(-100);
    expect(normalAngle(540)).toBe(180);
    expect(normalAngle(-181)).toBe(179);
  });

  it("scaling and turning keep the box where it is on screen", () => {
    const t = { ...NO_TRANSFORM, scale: 0.4, x: 0.2, y: 0.1 };
    const box = { x: 0.1, y: 0.2, width: 0.4, height: 0.3 };
    const before = centreOf(boxCorners(box, t, canvas));
    for (const next of [
      { ...t, scale: 0.9 },
      { ...t, rotation: 40 },
      { ...t, scale: 0.2, rotation: -75 },
    ]) {
      const after = centreOf(boxCorners(box, keepCentre(t, next, box, canvas), canvas));
      near(after.x, before.x, 1e-6);
      near(after.y, before.y, 1e-6);
    }
  });
});

describe("saving a gesture", () => {
  function clipProject(extra?: Partial<Parameters<typeof withDraft>[0]>): Project {
    let p = makeProject();
    const r = addClip(p, { assetId: IDS.vid, trackId: IDS.v1, start: 0, id: "c", duration: 4 });
    if (!r.ok) throw new Error();
    p = r.project;
    if (extra) {
      p = {
        ...p,
        tracks: p.tracks.map((t) => ({
          ...t,
          clips: t.clips.map((c) => (c.id === "c" ? { ...c, ...extra } : c)),
        })),
      };
    }
    expectValid(p);
    return p;
  }
  const clipOf = (p: Project) => findClip(p, "c")!.clip;

  it("sets several values in one edit", () => {
    const r = setTransformAt(clipProject(), "c", { x: 0.1, scale: 0.5, rotation: 20 }, 1);
    if (!r.ok) throw new Error(r.error.message);
    expect(clipOf(r.project)).toMatchObject({ x: 0.1, scale: 0.5, rotation: 20 });
    expect(clipOf(r.project).keyframes).toBeUndefined();
  });

  it("gives an animated value a keyframe at the playhead and leaves the other values plain", () => {
    const animated = clipProject({
      keyframes: {
        scale: [
          { t: 0, v: 1 },
          { t: 3, v: 2 },
        ],
      },
    });
    const r = setTransformAt(animated, "c", { scale: 1.5, x: 0.2 }, 1);
    if (!r.ok) throw new Error(r.error.message);
    const c = clipOf(r.project);
    expect(c.x).toBe(0.2);
    expect(c.keyframes!.scale!.map((k) => k.v)).toEqual([1, 1.5, 2]);
    expect(c.keyframes!.scale![1].t).toBeCloseTo(1, 5);
  });

  it("draws a gesture in progress without the keyframes of the values it changes", () => {
    const animated = clipOf(
      clipProject({
        keyframes: {
          scale: [
            { t: 0, v: 1 },
            { t: 3, v: 2 },
          ],
          x: [{ t: 0, v: 0.1 }],
        },
      }),
    );
    const d = withDraft(animated, { scale: 0.7 });
    expect(d.scale).toBe(0.7);
    expect(d.keyframes).toEqual({ x: [{ t: 0, v: 0.1 }] });
    expect(
      withDraft({ ...animated, keyframes: { scale: animated.keyframes!.scale } }, { scale: 1 }).keyframes,
    ).toBeUndefined();
  });
});

describe("in the preview", () => {
  beforeEach(() => {
    useProjectStore.setState({ project: makeProject(), past: [], future: [] });
    useSelectionStore.setState({ selectedClipIds: [] });
    usePlaybackStore.setState({ playhead: 1, playing: false, mediaErrors: {} });
    useUiStore.setState({ transformDraft: null, cropEdit: null });
    // jsdom has no layout: the stage is 960 x 540 on screen for a 1920 x 1080 canvas
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 960,
      bottom: 540,
      width: 960,
      height: 540,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    class RO {
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", RO);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function show() {
    const r = addClip(useProjectStore.getState().project, {
      assetId: IDS.vid,
      trackId: IDS.v1,
      start: 0,
      id: "c",
      duration: 4,
    });
    if (!r.ok) throw new Error();
    useProjectStore.setState({ project: r.project, past: [], future: [] });
    useSelectionStore.setState({ selectedClipIds: ["c"] });
    render(<Preview />);
  }
  const clip = () => findClip(useProjectStore.getState().project, "c")!.clip;
  const pointer = (type: string, el: Element, x: number, y: number, extra = {}) =>
    fireEvent(
      el,
      Object.assign(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, ...extra }), {
        pointerId: 1,
      }),
    );

  it("shows a box with four resize handles and a turn handle for the selected clip only", () => {
    show();
    expect(screen.getByTestId("transform-overlay")).toBeInTheDocument();
    expect(document.querySelectorAll('[data-handle="scale"]')).toHaveLength(4);
    expect(document.querySelectorAll('[data-handle="rotate"]')).toHaveLength(1);
    act(() => useSelectionStore.setState({ selectedClipIds: [] }));
    expect(screen.queryByTestId("transform-overlay")).toBeNull();
  });

  it("dragging the box moves the clip: the preview follows at once, one undo step on release", () => {
    show();
    const body = screen.getByTestId("transform-body");
    pointer("pointerdown", body, 480, 270);
    pointer("pointermove", body, 576, 216, { altKey: true }); // 96 px right, 54 px up = 10 % each
    expect(useUiStore.getState().transformDraft?.patch).toMatchObject({ x: 0.1, y: -0.1 });
    expect(clip().x).toBe(0); // not saved yet
    expect(screen.getByTestId("video-layer").style.transform).toContain("translate(10%, -10%)");
    pointer("pointerup", body, 576, 216, { altKey: true });
    expect(clip()).toMatchObject({ x: 0.1, y: -0.1 });
    expect(useUiStore.getState().transformDraft).toBeNull();
    act(() => undo());
    expect(clip().x).toBe(0); // the whole move was one step
  });

  it("a click on the box without moving changes nothing and adds no undo step", () => {
    show();
    const body = screen.getByTestId("transform-body");
    pointer("pointerdown", body, 480, 270);
    pointer("pointerup", body, 480, 270);
    expect(useProjectStore.getState().past).toHaveLength(0);
  });

  it("dragging a corner outwards makes the clip bigger, about its own centre", () => {
    show();
    const corner = document.querySelector('[data-handle="scale"]')!; // top-left, at 0,0
    pointer("pointerdown", corner, 0, 0);
    pointer("pointermove", corner, -480, -270); // twice as far from the centre
    pointer("pointerup", corner, -480, -270);
    expect(clip().scale).toBeCloseTo(2, 2);
    expect(clip().x).toBeCloseTo(0, 3); // the centre did not move
  });

  it("dragging the round handle turns the clip; Shift snaps to 15 degrees", () => {
    show();
    const handle = document.querySelector('[data-handle="rotate"]')!;
    pointer("pointerdown", handle, 480, -30); // straight above the centre
    pointer("pointermove", handle, 480 + 380, 270 - 170, { shiftKey: true }); // roughly 66 degrees clockwise
    pointer("pointerup", handle, 480 + 380, 270 - 170, { shiftKey: true });
    expect(clip().rotation! % 15).toBe(0);
    expect(clip().rotation).toBeGreaterThan(0);
  });

  it("Escape in the middle of a drag puts everything back", () => {
    show();
    const body = screen.getByTestId("transform-body");
    pointer("pointerdown", body, 480, 270);
    pointer("pointermove", body, 600, 300, { altKey: true });
    expect(useUiStore.getState().transformDraft).not.toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useUiStore.getState().transformDraft).toBeNull();
    pointer("pointerup", body, 600, 300);
    expect(clip().x).toBe(0);
  });

  it("a trackpad pinch resizes and a twist turns, saved as one step when the gesture ends", () => {
    show();
    const stage = screen.getByTestId("preview-stage");
    const gesture = (type: string, scale = 1, rotation = 0) =>
      fireEvent(
        stage,
        Object.assign(new Event(type, { bubbles: true, cancelable: true }), { scale, rotation }),
      );
    gesture("gesturestart");
    gesture("gesturechange", 1.5, 30);
    expect(useUiStore.getState().transformDraft?.patch).toMatchObject({ scale: 1.5 });
    expect(clip().scale).toBe(1);
    gesture("gestureend", 1.5, 30);
    expect(clip().scale).toBeCloseTo(1.5, 2);
    expect(clip().rotation).toBeCloseTo(30, 0);
    expect(useProjectStore.getState().past).toHaveLength(1);
  });

  it("a press on an unselected clip's picture selects it", () => {
    show();
    act(() => useSelectionStore.setState({ selectedClipIds: [] }));
    const stage = screen.getByTestId("preview-stage");
    pointer("pointerdown", stage, 480, 270);
    expect(useSelectionStore.getState().selectedClipIds).toEqual(["c"]);
  });
});
