import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { Inspector } from "@/components/layout/Inspector";
import { Preview } from "@/components/layout/Preview";
import { assetName } from "@/lib/media";
import { layersAt } from "@/playback/engine";
import { SCHEMA_VERSION, type Project, type TextSpec } from "@/project/model";
import { parseProject } from "@/project/parse";
import { usePlaybackStore } from "@/store/playback";
import { useFontStore } from "@/store/fonts";
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
import { placeList } from "@/components/inspector/FontPicker";
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
    expect(errors((c) => Object.assign(c.assets.at(-1)!.text!, { shadow: true }))).not.toHaveLength(0);
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

  it("keeps what is typed while a redraw is running, and then draws only the newest text", async () => {
    const release: ((v: string) => void)[] = [];
    vi.mocked(invoke).mockImplementation(() => new Promise<string>((r) => release.push(r)) as never);
    render(<Inspector />);
    const box = screen.getByRole("textbox", { name: "Text" });
    const contents = () =>
      vi.mocked(invoke).mock.calls.map(([, args]) => (args as { spec: TextSpec }).spec.content);

    vi.useFakeTimers();
    for (const typed of ["A", "AB", "ABC"]) {
      fireEvent.change(box, { target: { value: typed } });
      await act(() => vi.advanceTimersByTimeAsync(TYPING_DELAY_MS + 10));
    }
    vi.useRealTimers();
    expect(contents()).toEqual(["A"]); // one redraw at a time
    expect(box).toHaveValue("ABC");

    await act(async () => release[0]("/data/text/a.png"));
    await waitFor(() => expect(contents()).toEqual(["A", "ABC"])); // "AB" is never drawn
    expect(box).toHaveValue("ABC"); // the finished picture of "A" did not reset the box
    await act(async () => release[1]("/data/text/abc.png"));
    await waitFor(() =>
      expect(textOf()).toMatchObject({ path: "/data/text/abc.png", text: { content: "ABC" } }),
    );
    expect(box).toHaveValue("ABC");
    expect(invoke).toHaveBeenCalledTimes(2);
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

    const down = screen.getByRole("spinbutton", { name: "Y (%)" });
    fireEvent.change(down, { target: { value: "85" } });
    expect(textOf().text?.y).toBe(0.5); // moves when the field is left
    fireEvent.blur(down);
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
    // the shifted old picture stays until the redrawn one is on screen: no jump back, no blink
    await waitFor(() => expect(text()).toHaveAttribute("src", "asset://localhost/data/text/moved.png"));
    await waitFor(() => expect(text().style.transform).toBe(""));
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

describe("choosing a font", () => {
  const FONTS = [
    { family: "Noto Sans", bundled: true, preview: "/cache/font-previews/noto.png" },
    { family: "Roboto", bundled: true, preview: "/cache/font-previews/roboto.png" },
    { family: "Rokkitt", bundled: true },
    { family: "My Hand", bundled: false, preview: "/cache/font-previews/hand.png" },
  ];
  const stored = () => useProjectStore.getState().project.assets.find((a) => a.id === "text")!.text!;
  /** Rust answers per command; `picked` is what the import dialog returns. */
  function rust(picked: string[] | Error) {
    vi.mocked(invoke).mockImplementation((async (cmd: string, args?: { spec: TextSpec }) => {
      if (cmd === "text_fonts") return FONTS;
      if (cmd === "import_text_font") {
        if (picked instanceof Error) throw picked.message;
        if (picked.length > 0) FONTS.push(...picked.map((family) => ({ family, bundled: false })));
        return picked;
      }
      return `/data/text/${args?.spec.font ?? "default"}.png`;
    }) as never);
  }
  beforeEach(() => {
    useProjectStore.getState().loadProject(withText(2), "/p.cutvii", []);
    useSelectionStore.getState().select("title");
    useFontStore.setState({ fonts: [{ family: "Noto Sans", bundled: true }], loaded: false });
    vi.mocked(invoke).mockReset();
  });
  /** Open the picker once Rust has sent the list. */
  async function openPicker() {
    await waitFor(() => expect(useFontStore.getState().fonts.length).toBeGreaterThan(1));
    fireEvent.click(screen.getByRole("button", { name: /^Font: / }));
    return within(screen.getByRole("dialog", { name: "Choose a font" }));
  }
  const names = (picker: { getAllByRole: (role: string) => HTMLElement[] }) =>
    picker.getAllByRole("option").map((o) => o.getAttribute("aria-label"));

  it("opens a list of every font, drawn in its own typeface, with the current one ticked", async () => {
    rust([]);
    render(<Inspector />);
    expect(screen.getByRole("button", { name: "Font: Noto Sans" })).toHaveAttribute("aria-expanded", "false");
    const picker = await openPicker();
    expect(names(picker)).toEqual(["My Hand", "Noto Sans", "Roboto", "Rokkitt"]); // imported first, then A to Z
    expect(picker.getByText("Imported")).toBeInTheDocument();
    expect(picker.getByText("Included")).toBeInTheDocument();
    expect(picker.getByRole("option", { name: "Noto Sans" })).toHaveAttribute("aria-selected", "true");
    // a picture of the name where Rust made one, plain text otherwise
    expect(picker.getByRole("option", { name: "Roboto" }).querySelector("img")).toHaveAttribute(
      "src",
      "asset://localhost/cache/font-previews/roboto.png",
    );
    expect(picker.getByRole("option", { name: "Rokkitt" })).toHaveTextContent("Rokkitt");
    expect(picker.getByRole("combobox", { name: "Search fonts" })).toHaveFocus();

    fireEvent.click(picker.getByRole("option", { name: "Roboto" }));
    await waitFor(() => expect(stored().font).toBe("Roboto"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Font: Roboto" })).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith(
      "render_text",
      expect.objectContaining({ spec: expect.objectContaining({ font: "Roboto", content: "Hello\nworld" }) }),
    );
    expectValid(useProjectStore.getState().project);
    undo();
    expect(stored().font).toBeUndefined();
  });

  it("searches as you type and works from the keyboard", async () => {
    rust([]);
    render(<Inspector />);
    const picker = await openPicker();
    const search = picker.getByRole("combobox", { name: "Search fonts" });

    fireEvent.change(search, { target: { value: "  ro" } });
    expect(names(picker)).toEqual(["Roboto", "Rokkitt"]);
    expect(picker.queryByText("Imported")).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(picker.queryAllByRole("option")).toHaveLength(0);
    expect(picker.getByText(/No font matches “zzz”/)).toBeInTheDocument();
    fireEvent.keyDown(search, { key: "Enter" }); // nothing to choose
    expect(stored().font).toBeUndefined();

    fireEvent.change(search, { target: { value: "RO" } }); // case does not matter
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(picker.getByRole("option", { name: "Rokkitt" })).toHaveAttribute("data-active", "true");
    fireEvent.keyDown(search, { key: "ArrowDown" }); // wraps round
    expect(picker.getByRole("option", { name: "Roboto" })).toHaveAttribute("data-active", "true");
    fireEvent.keyDown(search, { key: "ArrowUp" });
    fireEvent.keyDown(search, { key: "Enter" });
    await waitFor(() => expect(stored().font).toBe("Rokkitt"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes on Escape or a press elsewhere without changing the font", async () => {
    rust([]);
    render(<Inspector />);
    let picker = await openPicker();
    fireEvent.keyDown(picker.getByRole("combobox", { name: "Search fonts" }), { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Font: Noto Sans" })).toHaveFocus();

    await openPicker();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // choosing the font already in use is not an edit
    picker = await openPicker();
    fireEvent.click(picker.getByRole("option", { name: "Noto Sans" }));
    expect(invoke).not.toHaveBeenCalledWith("render_text", expect.anything());
    expect(useProjectStore.getState().past).toHaveLength(0);
  });

  it("floats the list below the button, or above it when there is no room, and never off the window", () => {
    const window = { width: 1280, height: 800 };
    const button = (top: number) => ({ left: 980, right: 1270, top, bottom: top + 40, width: 290 });
    // plenty of room below: hangs under the button, widened to fit the font names, kept inside the window
    expect(placeList(button(200), window)).toEqual({ left: 932, width: 340, top: 244, listHeight: 360 });
    // near the bottom: opens upwards, anchored to the top of the button
    expect(placeList(button(700), window)).toEqual({ left: 932, width: 340, bottom: 104, listHeight: 360 });
    // a short window: takes the larger side and a shorter list
    const short = placeList(button(260), { width: 1280, height: 520 });
    expect(short).toMatchObject({ bottom: 264, listHeight: 162 });
    // a narrow window: as wide as it can be
    expect(
      placeList({ left: 10, right: 310, top: 100, bottom: 140, width: 300 }, { width: 320, height: 800 }),
    ).toMatchObject({ left: 8, width: 304 });
  });

  it("imports a font file through Rust and switches the text to it", async () => {
    rust(["Lobster"]);
    render(<Inspector />);
    const picker = await openPicker();
    fireEvent.click(picker.getByRole("button", { name: /Import a font file/ }));
    await waitFor(() => expect(stored().font).toBe("Lobster"));
    expect(invoke).toHaveBeenCalledWith("import_text_font");
    expect(await screen.findByRole("button", { name: "Font: Lobster" })).toBeInTheDocument();
    FONTS.pop();
  });

  it("changes nothing when the import is cancelled, and says why when it fails", async () => {
    rust([]);
    const view = render(<Inspector />);
    fireEvent.click((await openPicker()).getByRole("button", { name: /Import a font file/ }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("import_text_font"));
    expect(stored().font).toBeUndefined();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    view.unmount();

    rust(new Error("invalid input: that file is not a font CutVii can read"));
    useFontStore.setState({ loaded: false });
    render(<Inspector />);
    fireEvent.click((await openPicker()).getByRole("button", { name: /Import a font file/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Could not import the font: .*not a font/);
    expect(stored().font).toBeUndefined();
  });

  it("says so when a project uses a font that is not installed here", async () => {
    rust([]);
    const p = withText(2);
    p.assets.at(-1)!.text = { ...spec, font: "Fancy Script" };
    expectValid(p);
    useProjectStore.getState().loadProject(p, "/p.cutvii", []);
    render(<Inspector />);
    expect(screen.getByRole("button", { name: "Font: Fancy Script" })).toHaveTextContent("Fancy Script");
    expect(
      screen.getByText(/“Fancy Script” is not installed here, so the text is drawn in Noto Sans/),
    ).toBeInTheDocument();
    const picker = await openPicker();
    expect(picker.queryByRole("option", { selected: true })).not.toBeInTheDocument();
  });
});
