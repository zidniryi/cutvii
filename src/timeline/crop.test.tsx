import { fireEvent, render, screen, within } from "@testing-library/react";
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
  it("is schema version 6: an optional crop per clip, with at least a tenth of the picture left", () => {
    expect(SCHEMA_VERSION).toBe(6);
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
