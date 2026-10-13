import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { Inspector } from "@/components/layout/Inspector";
import { Preview } from "@/components/layout/Preview";
import { SCHEMA_VERSION, type Crop, type Project } from "@/project/model";
import { parseProject } from "@/project/parse";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useUiStore } from "@/store/ui";
import { expectValid, IDS, makeProject } from "@/test/makeProject";
import { addClip, setClipCrop } from "./edit";
import { undo } from "./editor";
import { cropForAspect, dragCrop, keptAspect, MIN_KEPT } from "./crop";
import { cropInnerStyle, croppedSize, cropOf, isCropped, NO_CROP } from "./fit";
import { addTextClip } from "./text";

const crop = (c: Partial<Crop>): Crop => ({ ...NO_CROP, ...c });

/** 1920x1080 canvas with a 2000x1000 image ("still") on v1 and a video ("video") on v2. */
function project(): Project {
  const base = makeProject();
  const sized = {
    ...base,
    assets: base.assets.map((a) => (a.id === IDS.img ? { ...a, width: 2000, height: 1000 } : a)),
  };
  const a = addClip(sized, { assetId: IDS.img, trackId: IDS.v1, start: 0, id: "still" });
  if (!a.ok) throw new Error(a.error.message);
  const b = addClip(a.project, { assetId: IDS.vid, trackId: IDS.v2, start: 6, id: "video" });
  if (!b.ok) throw new Error(b.error.message);
  const c = addClip(b.project, { assetId: IDS.aud, trackId: IDS.a1, start: 0, id: "sound" });
  if (!c.ok) throw new Error(c.error.message);
  return c.project;
}
const clipOf = (p: Project, id: string) => p.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!;
const cropped = (p: Project, id: string, c: Crop | null) => {
  const r = setClipCrop(p, id, c);
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
};

describe("crop in the project", () => {
  it("is schema version 7: an optional crop per clip, with at least a tenth of the picture left", () => {
    expect(SCHEMA_VERSION).toBe(7);
    const p = cropped(project(), "still", crop({ left: 0.25, top: 0.1 }));
    expectValid(p);
    expect(clipOf(p, "still").crop).toEqual({ left: 0.25, top: 0.1, right: 0, bottom: 0 });

    const errors = (c: unknown) => {
      const copy = structuredClone(p);
      Object.assign(clipOf(copy, "still"), { crop: c });
      const r = parseProject(copy);
      return r.ok ? [] : r.errors;
    };
    expect(errors(crop({ left: 0.45, right: 0.45 }))).toHaveLength(0);
    expect(errors(crop({ left: 0.5, right: 0.5 })).join()).toMatch(/tenth of the picture/);
    expect(errors(crop({ top: 0.95 }))).not.toHaveLength(0);
    expect(errors(crop({ bottom: -0.1 }))).not.toHaveLength(0);
    expect(errors({ left: 0.1 })).not.toHaveLength(0); // all four sides are required
    expect(errors({ ...NO_CROP, zoom: 2 })).not.toHaveLength(0);
  });

  it("sets, changes and removes a crop; no-ops are not edits; sound and text cannot be cropped", () => {
    const p = project();
    expect(setClipCrop(p, "still", null)).toEqual({ ok: true, project: p });
    expect(setClipCrop(p, "still", NO_CROP)).toEqual({ ok: true, project: p });

    const once = cropped(p, "video", crop({ right: 0.3 }));
    expect(clipOf(once, "video").crop).toEqual(crop({ right: 0.3 }));
    expect(setClipCrop(once, "video", crop({ right: 0.3 }))).toEqual({ ok: true, project: once });
    const reset = cropped(once, "video", NO_CROP);
    expect("crop" in clipOf(reset, "video")).toBe(false); // never stored as zeros
    expectValid(reset);

    expect(setClipCrop(p, "sound", crop({ left: 0.1 }))).toMatchObject({ ok: false });
    expect(setClipCrop(p, "nope", crop({ left: 0.1 }))).toMatchObject({
      ok: false,
      error: { code: "unknown-clip" },
    });
    expect(setClipCrop(p, "still", crop({ top: 0.6, bottom: 0.6 }))).toMatchObject({
      ok: false,
      error: { code: "out-of-range" },
    });
    const text = addTextClip(p, {
      picture: "/data/text/a.png",
      spec: { content: "Hi", fontSize: 64, color: "#FFFFFF", x: 0.5, y: 0.5 },
      start: 20,
      assetId: "text",
      clipId: "title",
      trackId: "v9",
    });
    if (!text.ok) throw new Error("setup");
    expect(setClipCrop(text.project, "title", crop({ left: 0.1 }))).toMatchObject({ ok: false });
  });
});

describe("crop geometry", () => {
  it("fits what is left of the picture and enlarges the picture inside its frame", () => {
    expect(isCropped(NO_CROP)).toBe(false);
    expect(cropOf({})).toBe(NO_CROP);
    expect(croppedSize(2000, 1000, crop({ left: 0.5 }))).toEqual({ width: 1000, height: 1000 });
    expect(croppedSize(2000, 1000, crop({ top: 0.25, bottom: 0.25 }))).toEqual({ width: 2000, height: 500 });
    // keep the right half: the picture is twice as wide as the frame and shifted one frame to the left
    expect(cropInnerStyle(crop({ left: 0.5 }))).toEqual({
      left: "-100%",
      top: "0%",
      width: "200%",
      height: "100%",
    });
    // keep the middle half vertically
    expect(cropInnerStyle(crop({ top: 0.25, bottom: 0.25 }))).toEqual({
      left: "0%",
      top: "-50%",
      width: "100%",
      height: "200%",
    });
  });
});

describe("crop in the preview and the inspector", () => {
  const load = (p: Project, playhead: number, selected: string) => {
    useProjectStore.getState().loadProject(p, "/p.cutvii", []);
    usePlaybackStore.setState({ playhead, playing: false });
    useSelectionStore.getState().select(selected);
    useUiStore.getState().setNotice(null);
  };

  it("shows only the kept part of a still, fitted by its cropped shape", () => {
    // 2000x1000 with the left half cut is 1000x1000: on a 16:9 canvas "fit" makes it 56.25% wide, full height
    const fitted = (p: Project) => ({
      ...p,
      tracks: p.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => (c.id === "still" ? { ...c, fitMode: "fit" as const } : c)),
      })),
    });
    load(fitted(project()), 1, "still");
    const { unmount } = render(<Preview />);
    const plain = screen.getByTestId("image-layer").querySelector<HTMLElement>('[data-role="picture"]')!;
    expect(plain.parentElement).toBe(screen.getByTestId("image-layer")); // no frame without a crop
    expect(plain.style.width).toBe("100%");
    unmount();

    load(fitted(cropped(project(), "still", crop({ left: 0.5 }))), 1, "still");
    render(<Preview />);
    const frame = screen.getByTestId("image-layer").querySelector<HTMLElement>('[data-role="crop-frame"]')!;
    expect(frame.style.width).toBe("56.25%");
    expect(frame.style.height).toBe("100%");
    expect(frame.style.left).toBe("21.875%");
    const picture = frame.querySelector<HTMLElement>('[data-role="picture"]')!;
    expect(picture.style.left).toBe("-100%");
    expect(picture.style.width).toBe("200%");
  });

  it("frames a cropped video the same way", () => {
    load(cropped(project(), "video", crop({ top: 0.5 })), 7, "video");
    render(<Preview />);
    const frame = screen.getByTestId("video-layer").querySelector<HTMLElement>('[data-role="crop-frame"]')!;
    const video = frame.querySelector("video")!;
    expect(video.style.top).toBe("-100%");
    expect(video.style.height).toBe("200%");
  });

  it("crops from the inspector: sliders apply on release, share an axis, and Reset removes the crop", () => {
    load(project(), 1, "still");
    render(<Inspector />);
    const group = within(screen.getByRole("group", { name: "Crop" }));
    const stored = () => clipOf(useProjectStore.getState().project, "still").crop;
    expect(group.getByRole("button", { name: "Reset crop" })).toBeDisabled();

    const left = group.getByRole("slider", { name: /Left/ });
    fireEvent.change(left, { target: { value: "30" } });
    expect(stored()).toBeUndefined(); // still dragging
    fireEvent.pointerUp(left);
    expect(stored()).toEqual(crop({ left: 0.3 }));

    // the right side can only take what the left side leaves: 90% in total
    const right = group.getByRole("slider", { name: /Right/ });
    fireEvent.change(right, { target: { value: "90" } });
    fireEvent.pointerUp(right);
    expect(stored()).toEqual(crop({ left: 0.3, right: 0.6 }));
    expectValid(useProjectStore.getState().project);

    undo();
    expect(stored()).toEqual(crop({ left: 0.3 }));
    fireEvent.click(group.getByRole("button", { name: "Reset crop" }));
    expect(stored()).toBeUndefined();
    expect(useUiStore.getState().notice).toBeNull();
  });

  it("offers no crop for sound", () => {
    load(project(), 1, "sound");
    render(<Inspector />);
    expect(screen.queryByRole("group", { name: "Crop" })).not.toBeInTheDocument();
  });
});

describe("crop box math", () => {
  const near = (c: Crop, expected: Crop) =>
    (["left", "top", "right", "bottom"] as const).forEach((k) => expect(c[k]).toBeCloseTo(expected[k], 3));

  it("finds the largest centred crop for a shape", () => {
    // 1920x1080 to 9:16: full height, 607.5px wide -> 34.2% off each side
    near(cropForAspect(1920, 1080, 9 / 16), crop({ left: 0.342, right: 0.342 }));
    expect(keptAspect(1920, 1080, cropForAspect(1920, 1080, 9 / 16))).toBeCloseTo(9 / 16, 1);
    near(cropForAspect(1920, 1080, 1), crop({ left: 0.219, right: 0.219 }));
    near(cropForAspect(1920, 1080, 16 / 9), NO_CROP); // already that shape
    // a portrait picture to 16:9: full width, the top and bottom go
    near(cropForAspect(1080, 1920, 16 / 9), crop({ top: 0.342, bottom: 0.342 }));
    // a shape too extreme for the picture stops at the least that must remain
    const thin = cropForAspect(4000, 100, 1 / 10);
    expect(1 - thin.left - thin.right).toBeCloseTo(MIN_KEPT, 3);
  });

  it("moves the box without resizing it and stops at the edges", () => {
    const start = crop({ left: 0.2, right: 0.4, top: 0.1, bottom: 0.3 });
    near(dragCrop(start, "move", 0.1, 0.05), crop({ left: 0.3, right: 0.3, top: 0.15, bottom: 0.25 }));
    near(dragCrop(start, "move", 5, -5), crop({ left: 0.6, right: 0, top: 0, bottom: 0.4 }));
    near(dragCrop(NO_CROP, "move", 0.3, 0.3), NO_CROP); // the full picture has nowhere to go
  });

  it("resizes from edges and corners, never below a tenth of the picture", () => {
    near(dragCrop(NO_CROP, "w", 0.25, 0.9), crop({ left: 0.25 }));
    near(dragCrop(NO_CROP, "se", -0.2, -0.1), crop({ right: 0.2, bottom: 0.1 }));
    near(dragCrop(NO_CROP, "nw", 0.1, 0.3), crop({ left: 0.1, top: 0.3 }));
    near(dragCrop(crop({ left: 0.5 }), "e", -5, 0), crop({ left: 0.5, right: 0.4 })); // a tenth is left
    near(dragCrop(crop({ left: 0.5 }), "w", -5, 0), NO_CROP); // back out to the edge
    near(dragCrop(crop({ top: 0.2 }), "n", 0, 5), crop({ top: 0.9 }));
  });

  it("keeps a chosen shape while a corner is dragged", () => {
    const locked = { ratio: 1, srcW: 2000, srcH: 1000 };
    const square = cropForAspect(2000, 1000, 1); // 25% off each side
    near(square, crop({ left: 0.25, right: 0.25 }));
    // pulling the bottom-right corner in by 10% of the width: the height follows (20% of the height)
    const smaller = dragCrop(square, "se", -0.1, 0, locked);
    near(smaller, crop({ left: 0.25, right: 0.35, bottom: 0.2 }));
    expect(keptAspect(2000, 1000, smaller)).toBeCloseTo(1, 2);
    // it cannot grow past the picture, whichever way the corner is pulled
    near(dragCrop(smaller, "se", 3, 3, locked), square);
    const fromTopLeft = dragCrop(square, "nw", 0.2, 0.9, locked);
    expect(keptAspect(2000, 1000, fromTopLeft)).toBeCloseTo(1, 2);
    expect(1 - fromTopLeft.top - fromTopLeft.bottom).toBeGreaterThanOrEqual(MIN_KEPT - 1e-9);
    // edges cannot keep a shape, moving still works
    expect(dragCrop(square, "e", -0.1, 0, locked)).toBe(square);
    near(dragCrop(square, "move", -0.1, 0, locked), crop({ left: 0.15, right: 0.35 }));
  });
});

describe("crop box in the preview", () => {
  const stored = (id = "still") => clipOf(useProjectStore.getState().project, id).crop;
  function open(playhead = 1) {
    useProjectStore.getState().loadProject(project(), "/p.cutvii", []);
    usePlaybackStore.setState({ playhead, playing: true });
    useSelectionStore.getState().select("still");
    useUiStore.setState({ cropEdit: null, cropLock: null, notice: null });
    render(
      <>
        <Preview />
        <Inspector />
      </>,
    );
    return within(screen.getByRole("group", { name: "Crop" }));
  }
  /** The whole picture is drawn 400x200 on screen, so 40px across is 10% and 20px down is 10%. */
  function onScreen() {
    const picture = screen.getByTestId("crop-picture");
    picture.getBoundingClientRect = () =>
      ({ left: 100, top: 100, width: 400, height: 200, right: 500, bottom: 300 }) as DOMRect;
    return picture;
  }
  const handle = (name: string) => screen.getByTestId("crop-box").querySelector(`[data-handle="${name}"]`)!;

  it("opens on the clip's whole picture, pauses, and closes with Done or Escape", () => {
    const panel = open(8); // the playhead is past the still (0..5)
    expect(screen.queryByTestId("crop-overlay")).not.toBeInTheDocument();
    fireEvent.click(panel.getByRole("button", { name: "Crop in the preview" }));
    expect(usePlaybackStore.getState()).toMatchObject({ playing: false, playhead: 0 }); // brought to the clip
    const overlay = screen.getByTestId("crop-overlay");
    expect(within(overlay).getByRole("button", { name: "Done" })).toHaveFocus();
    // 2000x1000 on a 16:9 canvas: full width, 88.9% of the height, shown at 86% so the handles can be reached
    const picture = screen.getByTestId("crop-picture");
    expect(picture.style.width).toBe("86%");
    expect(parseFloat(picture.style.height)).toBeCloseTo(76.44, 1);
    expect(screen.getByTestId("crop-box").style.width).toBe("100%");
    expect(screen.getByTestId("crop-box").querySelectorAll("[data-handle]")).toHaveLength(8);

    fireEvent.keyDown(overlay, { key: "Escape" });
    expect(screen.queryByTestId("crop-overlay")).not.toBeInTheDocument();
    fireEvent.click(panel.getByRole("button", { name: "Crop in the preview" }));
    fireEvent.click(panel.getByRole("button", { name: "Done cropping" }));
    expect(screen.queryByTestId("crop-overlay")).not.toBeInTheDocument();
    expect(stored()).toBeUndefined();
  });

  it("resizes with a handle and moves with the box; each release is one undo step", () => {
    const panel = open();
    fireEvent.click(panel.getByRole("button", { name: "Crop in the preview" }));
    const picture = onScreen();

    fireEvent.pointerDown(handle("e"), { button: 0, clientX: 500, clientY: 200 });
    fireEvent.pointerMove(picture, { clientX: 380, clientY: 260 }); // 120px left = 30%
    expect(screen.getByTestId("crop-box").style.width).toBe("70%");
    expect(stored()).toBeUndefined(); // nothing saved while dragging
    fireEvent.pointerUp(picture);
    expect(stored()).toEqual(crop({ right: 0.3 }));

    fireEvent.pointerDown(screen.getByTestId("crop-box"), { button: 0, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(picture, { clientX: 240, clientY: 200 }); // 10% right
    fireEvent.pointerUp(picture);
    expect(stored()).toEqual(crop({ left: 0.1, right: 0.2 }));
    expect(panel.getByRole("slider", { name: /Left/ })).toHaveValue("10"); // the sliders follow

    // a press without a move changes nothing
    fireEvent.pointerDown(handle("nw"), { button: 0, clientX: 140, clientY: 100 });
    fireEvent.pointerUp(picture);
    expect(useProjectStore.getState().past).toHaveLength(2);
    undo();
    expect(stored()).toEqual(crop({ right: 0.3 }));
    expectValid(useProjectStore.getState().project);
  });

  it("crops to a chosen shape and keeps it while resizing", () => {
    const panel = open();
    expect(panel.getByRole("radio", { name: "Free" })).toBeChecked();
    fireEvent.click(panel.getByRole("radio", { name: "1:1" }));
    expect(stored()).toEqual(crop({ left: 0.25, right: 0.25 })); // a square out of 2000x1000
    expect(panel.getByRole("radio", { name: "1:1" })).toBeChecked();

    fireEvent.click(panel.getByRole("button", { name: "Crop in the preview" }));
    const picture = onScreen();
    expect(screen.getByTestId("crop-box").querySelectorAll("[data-handle]")).toHaveLength(4); // corners only
    fireEvent.pointerDown(handle("se"), { button: 0, clientX: 400, clientY: 300 });
    fireEvent.pointerMove(picture, { clientX: 360, clientY: 300 }); // 10% narrower
    fireEvent.pointerUp(picture);
    expect(stored()).toEqual(crop({ left: 0.25, right: 0.35, bottom: 0.2 })); // still a square in pixels

    // Free lets go of the shape without changing the crop; a slider or Reset lets go of it too
    fireEvent.click(panel.getByRole("radio", { name: "Free" }));
    expect(stored()).toEqual(crop({ left: 0.25, right: 0.35, bottom: 0.2 }));
    expect(screen.getByTestId("crop-box").querySelectorAll("[data-handle]")).toHaveLength(8);
    fireEvent.click(panel.getByRole("radio", { name: "9:16" }));
    expect(stored()).toEqual(crop({ left: 0.359, right: 0.359 }));
    fireEvent.click(panel.getByRole("button", { name: "Reset crop" }));
    expect(stored()).toBeUndefined();
    expect(panel.getByRole("radio", { name: "Free" })).toBeChecked();
  });

  it("goes away when another clip is selected or the playhead leaves the clip", () => {
    const panel = open();
    fireEvent.click(panel.getByRole("button", { name: "Crop in the preview" }));
    expect(screen.getByTestId("crop-overlay")).toBeInTheDocument();
    act(() => usePlaybackStore.setState({ playhead: 7 }));
    expect(screen.queryByTestId("crop-overlay")).not.toBeInTheDocument();
    expect(useUiStore.getState().cropEdit).toBeNull();

    act(() => usePlaybackStore.setState({ playhead: 1 }));
    fireEvent.click(screen.getByRole("button", { name: "Crop in the preview" }));
    expect(screen.getByTestId("crop-overlay")).toBeInTheDocument();
    act(() => useSelectionStore.getState().select("video"));
    expect(screen.queryByTestId("crop-overlay")).not.toBeInTheDocument();
  });
});
