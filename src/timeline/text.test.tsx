import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { Inspector } from "@/components/layout/Inspector";
import { Preview } from "@/components/layout/Preview";
import { assetName } from "@/lib/media";
import { layersAt } from "@/playback/engine";
import { SCHEMA_VERSION, type Project, type TextSpec } from "@/project/model";
import { parseProject } from "@/project/parse";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useUiStore } from "@/store/ui";
import { expectValid, IDS, makeProject } from "@/test/makeProject";
import { addClip } from "./edit";
import { undo } from "./editor";
import { splitClip } from "./edit";
import {
  addTextAtPlayhead,
  addTextClip,
  applyTextEdit,
  defaultTextSpec,
  editText,
  textHitBox,
  textTrackFor,
  watchTextPictures,
} from "./text";
import { TYPING_DELAY_MS } from "@/components/inspector/TextPanel";
import { withCanvas } from "@/project/canvas";

const spec: TextSpec = {
  content: "Hello\nworld",
  fontSize: 64,
  color: "#FFFFFF",
  bold: true,
  x: 0.5,
  y: 0.5,
};
const PICTURE = "/data/text/abc.png";

/** A 10 s video on v1 from 0, with text added at `start`. */
function withText(start: number): Project {
  const base = addClip(makeProject(), { assetId: IDS.vid, trackId: IDS.v1, start: 0, id: "video" });
  if (!base.ok) throw new Error(base.error.message);
  const r = addTextClip(base.project, {
    picture: PICTURE,
    spec,
    start,
    assetId: "text",
    clipId: "title",
    trackId: "new-track",
  });
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
}
const visible = (p: Project, t: number) =>
  layersAt(p, t, 0)
    .filter((l) => l.visible)
    .map((l) => l.clip.id);

describe("text in the project file", () => {
  it("is schema version 6: an image asset may carry text, nothing else may", () => {
    expect(SCHEMA_VERSION).toBe(6);
    const p = withText(2);
    expectValid(p);
    expect(p.assets.at(-1)).toMatchObject({
      type: "image",
      path: PICTURE,
      width: 1920,
      height: 1080,
      text: spec,
    });

    const errors = (change: (p: Project) => void) => {
      const copy = structuredClone(p);
      change(copy);
      const r = parseProject(copy);
      return r.ok ? [] : r.errors;
    };
    expect(errors((c) => (c.assets[0].text = spec)).join()).toMatch(/only an image asset can be text/);
    expect(errors((c) => (c.assets.at(-1)!.text!.content = "  "))).not.toHaveLength(0);
    expect(errors((c) => (c.assets.at(-1)!.text!.fontSize = 4))).not.toHaveLength(0);
    expect(errors((c) => (c.assets.at(-1)!.text!.color = "white"))).not.toHaveLength(0);
    expect(errors((c) => (c.assets.at(-1)!.text!.x = 1.2))).not.toHaveLength(0);
    expect(errors((c) => Object.assign(c.assets.at(-1)!.text!, { font: "Arial" }))).not.toHaveLength(0);
  });

  it("is named after its first line", () => {
    expect(assetName({ path: PICTURE, text: spec })).toBe("Hello");
    expect(assetName({ path: "/m/clip.mp4" })).toBe("clip.mp4");
  });

  it("starts at a size that suits the canvas", () => {
    expect(defaultTextSpec(1080)).toMatchObject({ content: "Text", fontSize: 97, align: "center", x: 0.5 });
    expect(defaultTextSpec(40).fontSize).toBe(8);
  });
});

describe("placing text", () => {
  it("uses the top video track when it is free, otherwise a new track above everything", () => {
    const p = makeProject(); // v1 (order 0), v2 (order 1), a1
    expect(textTrackFor(p, 0, 5)).toBe(IDS.v2);
    const busy = addClip(p, { assetId: IDS.vid2, trackId: IDS.v2, start: 3, id: "x" }); // 3..7
    if (!busy.ok) throw new Error("setup");
    expect(textTrackFor(busy.project, 0, 5)).toBeNull(); // 0..5 would overlap
    expect(textTrackFor(busy.project, 7, 5)).toBe(IDS.v2);
    expect(textTrackFor({ ...p, tracks: p.tracks.filter((t) => t.type === "audio") }, 0, 5)).toBeNull();

    const added = addTextClip(busy.project, {
      picture: PICTURE,
      spec,
      start: 4,
      assetId: "text",
      clipId: "title",
      trackId: "new-track",
    });
    if (!added.ok) throw new Error(added.error.message);
    expectValid(added.project);
    const track = added.project.tracks.find((t) => t.id === "new-track")!;
    expect(track.type).toBe("video");
    expect(track.order).toBeGreaterThan(Math.max(...p.tracks.map((t) => t.order)));
    expect(track.clips).toMatchObject([{ id: "title", assetId: "text", timelineStart: 4, sourceOut: 5 }]);
  });
});

describe("text in the preview", () => {
  it("shows text together with the first picture under it, and hides what that picture covers", () => {
    const p = withText(2); // video on v1 0..10, text on v2 2..7
    expect(visible(p, 1)).toEqual(["video"]);
    expect(visible(p, 3)).toEqual(["video", "title"]);

    // an opaque clip above the text covers it, like any other picture
    const above = addClip(
      { ...p, tracks: [...p.tracks, { ...p.tracks[0], id: "v3", name: "Video 3", order: 9, clips: [] }] },
      { assetId: IDS.vid2, trackId: "v3", start: 3, id: "cover" },
    );
    if (!above.ok) throw new Error(above.error.message);
    expect(visible(above.project, 4)).toEqual(["cover"]);
    expect(visible(above.project, 2.5)).toEqual(["video", "title"]);

    // two texts stacked over a video: all three show; text alone shows on its own
    const second = addTextClip(p, {
      picture: "/data/text/def.png",
      spec,
      start: 2,
      assetId: "text2",
      clipId: "subtitle",
      trackId: "v4",
    });
    if (!second.ok) throw new Error(second.error.message);
    expect(visible(second.project, 3)).toEqual(["video", "title", "subtitle"]);
    expect(visible(withText(12), 13)).toEqual(["title"]);
  });

  it("draws the text picture over the video with no background of its own", () => {
    useProjectStore.getState().loadProject(withText(2), "/p.cutvii", []);
    usePlaybackStore.setState({ playhead: 3, playing: false });
    render(<Preview />);
    const text = screen.getByTestId("text-layer");
    expect(text).toHaveAttribute("src", `asset://localhost${PICTURE}`);
    expect(text.style.backgroundColor).toBe("");
    expect(Number(text.style.zIndex)).toBeGreaterThan(Number(screen.getByTestId("video-layer").style.zIndex));
    expect(screen.getByTestId("video-layer")).toHaveStyle({ opacity: "1" });
    expect(screen.queryByTestId("image-layer")).not.toBeInTheDocument();
  });
});

describe("Add text", () => {
  beforeEach(() => {
    useProjectStore.getState().loadProject(makeProject(), "/p.cutvii", []);
    usePlaybackStore.setState({ playhead: 1.5, playing: false });
    useSelectionStore.getState().clear();
    useUiStore.getState().setNotice(null);
    vi.mocked(invoke).mockReset();
  });

  it("draws the default text in Rust and adds it at the playhead as one undoable step", async () => {
    vi.mocked(invoke).mockResolvedValue(PICTURE);
    await addTextAtPlayhead();
    expect(invoke).toHaveBeenCalledWith("render_text", {
      spec: defaultTextSpec(1080),
      width: 1920,
      height: 1080,
    });
    const { project } = useProjectStore.getState();
    expectValid(project);
    const asset = project.assets.at(-1)!;
    expect(asset).toMatchObject({ path: PICTURE, type: "image", text: { content: "Text" } });
    const clip = project.tracks.find((t) => t.id === IDS.v2)!.clips[0];
    expect(clip).toMatchObject({ assetId: asset.id, timelineStart: 1.5 });
    expect(useSelectionStore.getState().selectedClipIds).toEqual([clip.id]);

    // the inspector shows what works for text: its editor and facts, no fit, background, sound or speed
    const view = render(<Inspector />);
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Text", "Info"]);
    expect(screen.getByRole("textbox", { name: "Text" })).toHaveValue("Text");
    view.unmount();

    undo();
    const undone = useProjectStore.getState().project;
    expect(undone.assets).toHaveLength(4);
    expect(undone.tracks.every((t) => t.clips.length === 0)).toBe(true);
  });

  it("says why when the text cannot be drawn, and changes nothing", async () => {
    vi.mocked(invoke).mockRejectedValue("invalid input: invalid canvas size");
    const before = useProjectStore.getState().project;
    await addTextAtPlayhead();
    await waitFor(() => expect(useUiStore.getState().notice).toMatch(/Could not add text: .*canvas size/));
    expect(useProjectStore.getState().project).toBe(before);
  });
});

describe("editing text", () => {
  const textOf = (clipId = "title") => {
    const p = useProjectStore.getState().project;
    const clip = p.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)!;
    return p.assets.find((a) => a.id === clip.assetId)!;
  };
  /** Rust is asked to draw; the picture name tells which text it was. */
  const drawn = () =>
    vi
      .mocked(invoke)
      .mockImplementation(
        (async (_cmd: string, args: { spec: TextSpec; width: number }) =>
          `/data/text/${args.spec.content}-${args.spec.fontSize}-${args.spec.color}-${args.width}.png`) as never,
      );

  beforeEach(() => {
    useProjectStore.getState().loadProject(withText(2), "/p.cutvii", []);
    useSelectionStore.getState().select("title");
    vi.mocked(invoke).mockReset();
    drawn();
  });
  afterEach(() => vi.useRealTimers());

  it("redraws the text and swaps the picture in as one undoable step", async () => {
    expect(await editText("title", { content: "Intro", fontSize: 120 })).toBeNull();
    expect(invoke).toHaveBeenCalledWith("render_text", {
      spec: { ...spec, content: "Intro", fontSize: 120 },
      width: 1920,
      height: 1080,
    });
    expect(textOf()).toMatchObject({
      id: "text",
      path: "/data/text/Intro-120-#FFFFFF-1920.png",
      text: { content: "Intro", fontSize: 120, bold: true },
    });
    expectValid(useProjectStore.getState().project);
    undo();
    expect(textOf()).toMatchObject({ path: PICTURE, text: spec });
  });

  it("rejects invalid values without drawing or changing anything", async () => {
    const before = useProjectStore.getState().project;
    expect(await editText("title", { content: "   " })).toMatch(/must not be empty/);
    expect(await editText("title", { fontSize: 3 })).toMatch(/8 to 2000/);
    expect(await editText("title", { x: 2 })).not.toBeNull();
    expect(await editText("gone", { content: "x" })).toMatch(/no longer/);
    expect(invoke).not.toHaveBeenCalled();
    expect(useProjectStore.getState().project).toBe(before);

    vi.mocked(invoke).mockRejectedValue("invalid input: boom");
    expect(await editText("title", { content: "New" })).toMatch(/Could not draw the text: .*boom/);
    expect(useProjectStore.getState().project).toBe(before);
  });

  it("builds quick edits on each other and applies only the newest picture", async () => {
    const release: ((v: string) => void)[] = [];
    vi.mocked(invoke).mockImplementation(() => new Promise<string>((r) => release.push(r)) as never);
    const first = editText("title", { content: "A" });
    const second = editText("title", { color: "#FF0000" }); // before the first picture is back
    release[0]("/data/text/first.png");
    release[1]("/data/text/second.png");
    await Promise.all([first, second]);
    expect(textOf()).toMatchObject({
      path: "/data/text/second.png",
      text: { content: "A", color: "#FF0000" },
    });
    expect(useProjectStore.getState().past).toHaveLength(0 + 1);
  });

  it("gives one half of a split text its own copy, so the other half keeps its words", () => {
    const split = splitClip(withText(2), "title", 4, "second-half");
    if (!split.ok) throw new Error(split.error.message);
    const r = applyTextEdit(split.project, {
      clipId: "second-half",
      picture: "/data/text/new.png",
      spec: { ...spec, content: "Part two" },
      newAssetId: "text-copy",
    });
    if (!r.ok) throw new Error(r.error.message);
    expectValid(r.project);
    const clips = r.project.tracks.flatMap((t) => t.clips);
    expect(clips.find((c) => c.id === "title")!.assetId).toBe("text");
    expect(clips.find((c) => c.id === "second-half")!.assetId).toBe("text-copy");
    expect(r.project.assets.find((a) => a.id === "text")).toMatchObject({ path: PICTURE, text: spec });
    expect(r.project.assets.find((a) => a.id === "text-copy")).toMatchObject({
      path: "/data/text/new.png",
      text: { content: "Part two" },
    });
  });

  it("edits from the inspector: typing waits, the other fields apply at once", async () => {
    render(<Inspector />);
    const box = screen.getByRole("textbox", { name: "Text" });
    expect(box).toHaveValue("Hello\nworld");

    vi.useFakeTimers();
    fireEvent.change(box, { target: { value: "Hi" } });
    fireEvent.change(box, { target: { value: "Hi there" } });
    expect(invoke).not.toHaveBeenCalled(); // still typing
    await act(() => vi.advanceTimersByTimeAsync(TYPING_DELAY_MS + 10));
    vi.useRealTimers();
    await waitFor(() => expect(textOf().text?.content).toBe("Hi there"));
    expect(invoke).toHaveBeenCalledTimes(1);

    fireEvent.change(box, { target: { value: " " } });
    fireEvent.blur(box);
    expect(screen.getByRole("alert")).toHaveTextContent("Text must not be empty");
    expect(textOf().text?.content).toBe("Hi there");
    fireEvent.keyDown(box, { key: "Escape" });
    expect(box).toHaveValue("Hi there");

    const size = screen.getByRole("spinbutton", { name: "Size (px)" });
    fireEvent.change(size, { target: { value: "5000" } });
    fireEvent.keyDown(size, { key: "Enter" });
    await waitFor(() => expect(textOf().text?.fontSize).toBe(2000)); // clamped

    const hex = screen.getByRole("textbox", { name: "Text colour (hex)" });
    fireEvent.change(hex, { target: { value: "#e5733a" } });
    fireEvent.blur(hex);
    await waitFor(() => expect(textOf().text?.color).toBe("#E5733A"));

    fireEvent.click(screen.getByRole("button", { name: "Bold" }));
    await waitFor(() => expect(textOf().text?.bold).toBe(false));
    fireEvent.click(screen.getByRole("radio", { name: "Align right" }));
    await waitFor(() => expect(textOf().text?.align).toBe("right"));

    const down = screen.getByRole("slider", { name: /Position down/ });
    fireEvent.change(down, { target: { value: "85" } });
    expect(textOf().text?.y).toBe(0.5); // moves on release
    fireEvent.pointerUp(down);
    await waitFor(() => expect(textOf().text?.y).toBe(0.85));
    expectValid(useProjectStore.getState().project);
  });

  it("redraws text pictures when the canvas size changes, and again after an undo", async () => {
    const stop = watchTextPictures();
    expect(invoke).not.toHaveBeenCalled(); // already the size of the canvas
    useProjectStore.getState().execute({
      label: "Change canvas",
      apply: (p) => ({ ok: true, project: withCanvas(p, { width: 1080, height: 1920, fps: 30 }) }),
    });
    await waitFor(() => expect(textOf()).toMatchObject({ width: 1080, height: 1920 }));
    expect(textOf().path).toBe("/data/text/Hello\nworld-64-#FFFFFF-1080.png");
    expect(useProjectStore.getState().past).toHaveLength(1); // not an undo step of its own

    undo();
    expect(textOf()).toMatchObject({ width: 1920, height: 1080, path: PICTURE });
    stop();
  });
});

describe("moving text in the preview", () => {
  const short: TextSpec = { content: "Hello", fontSize: 108, color: "#FFFFFF", x: 0.5, y: 0.5 };

  it("estimates where the text sits from its size, lines and alignment", () => {
    const box = textHitBox(short, 1920, 1080);
    expect((box.left + box.right) / 2).toBeCloseTo(0.5);
    expect((box.top + box.bottom) / 2).toBeCloseTo(0.5);
    expect(box.right - box.left).toBeCloseTo((5 * 108 * 0.62) / 1920 + 0.04);
    expect(box.bottom - box.top).toBeCloseTo((108 * 1.25) / 1080 + 0.04);

    const left = textHitBox({ ...short, align: "left" }, 1920, 1080);
    expect(left.left).toBeCloseTo(0.05 - 0.02); // the 90% box starts at 5%
    const right = textHitBox({ ...short, align: "right", x: 0.5 }, 1920, 1080);
    expect(right.right).toBeCloseTo(0.95 + 0.02);
    const two = textHitBox({ ...short, content: "Hello\nworld" }, 1920, 1080);
    expect(two.bottom - two.top).toBeCloseTo((2 * 108 * 1.25) / 1080 + 0.04);
    const long = textHitBox({ ...short, content: "x".repeat(100) }, 1920, 1080);
    expect(long.right - long.left).toBeCloseTo(0.9 + 0.04); // wraps, never wider than the box
    expect(long.bottom - long.top).toBeGreaterThan(two.bottom - two.top);
  });

  it("drags the text with the pointer and saves the new position on release", async () => {
    useProjectStore.getState().loadProject(withText(2), "/p.cutvii", []);
    usePlaybackStore.setState({ playhead: 3, playing: false });
    useSelectionStore.getState().clear();
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue("/data/text/moved.png");
    render(<Preview />);
    const stage = screen.getByTestId("preview-stage");
    stage.getBoundingClientRect = () =>
      ({ left: 100, top: 50, width: 800, height: 450, right: 900, bottom: 500 }) as DOMRect;
    const text = () => screen.getByTestId("text-layer");
    const stored = () => useProjectStore.getState().project.assets.find((a) => a.id === "text")!;

    // pressing beside the text does nothing
    fireEvent.pointerDown(stage, { button: 0, clientX: 120, clientY: 60 });
    fireEvent.pointerMove(stage, { clientX: 300, clientY: 200 });
    fireEvent.pointerUp(stage);
    expect(text().style.transform).toBe("");
    expect(useSelectionStore.getState().selectedClipIds).toEqual([]);

    // a click on the text selects it without moving it
    fireEvent.pointerDown(stage, { button: 0, clientX: 500, clientY: 275 });
    expect(useSelectionStore.getState().selectedClipIds).toEqual(["title"]);
    fireEvent.pointerUp(stage);
    expect(invoke).not.toHaveBeenCalled();

    // drag 200px right (25% of 800) and 90px down (20% of 450)
    fireEvent.pointerDown(stage, { button: 0, clientX: 500, clientY: 275 });
    fireEvent.pointerMove(stage, { clientX: 700, clientY: 365 });
    expect(text().style.transform).toBe("translate(25%, 20%)");
    expect(stage.style.cursor).toBe("grabbing");
    expect(stored().text).toMatchObject({ x: 0.5, y: 0.5 }); // nothing saved while dragging
    fireEvent.pointerUp(stage);
    await waitFor(() => expect(stored().text).toMatchObject({ x: 0.75, y: 0.7 }));
    expect(invoke).toHaveBeenCalledWith(
      "render_text",
      expect.objectContaining({
        spec: expect.objectContaining({ x: 0.75, y: 0.7, content: "Hello\nworld" }),
      }),
    );
    await waitFor(() => expect(text().style.transform).toBe(""));
    expect(text()).toHaveAttribute("src", "asset://localhost/data/text/moved.png");
    expect(useProjectStore.getState().past).toHaveLength(1);

    // dragged past the edge: the centre stops at the edge of the canvas
    fireEvent.pointerDown(stage, { button: 0, clientX: 700, clientY: 365 });
    fireEvent.pointerMove(stage, { clientX: 2000, clientY: -500 });
    expect(text().style.transform).toBe("translate(25%, -70%)");
    fireEvent.pointerUp(stage);
    await waitFor(() => expect(stored().text).toMatchObject({ x: 1, y: 0 }));
    undo();
    expect(stored().text).toMatchObject({ x: 0.75, y: 0.7 });
  });
});
