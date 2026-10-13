import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { Inspector } from "@/components/layout/Inspector";
import { Preview } from "@/components/layout/Preview";
import type { Project } from "@/project/model";
import { parseProject } from "@/project/parse";
import { useLutStore } from "@/store/luts";
import { useMediaDetailsStore } from "@/store/mediaDetails";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useUiStore } from "@/store/ui";
import { expectValid, IDS, makeProject } from "@/test/makeProject";
import { colorKey, colorOf, isGraded, NO_COLOR, parseLut, setClipColor, type ColorAdjust } from "./color";
import { addClip } from "./edit";
import { undo } from "./editor";

/** A video ("video") on v1 at 0..10, a still ("still") on v2 at 20..25, music ("music") on a1. */
function project(): Project {
  let p = makeProject();
  for (const [assetId, trackId, id, start] of [
    [IDS.vid, IDS.v1, "video", 0],
    [IDS.img, IDS.v2, "still", 20],
    [IDS.aud, IDS.a1, "music", 0],
  ] as const) {
    const r = addClip(p, { assetId, trackId, start, id });
    if (!r.ok) throw new Error(r.error.message);
    p = r.project;
  }
  return p;
}
const clipOf = (p: Project, id: string) => p.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!;
const graded = (p: Project, id: string, patch: Partial<ColorAdjust> | null) => {
  const r = setClipColor(p, id, patch);
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
};
/** A table file as Rust writes it: 2 points per side, every value `fill`. */
function lutFile(fill = 0.5, size = 2): ArrayBuffer {
  const buffer = new ArrayBuffer(12 + size ** 3 * 12);
  const view = new DataView(buffer);
  [..."CVLT"].forEach((c, i) => view.setUint8(i, c.charCodeAt(0)));
  view.setUint32(4, 1, true);
  view.setUint32(8, size, true);
  new Float32Array(buffer, 12).fill(fill);
  return buffer;
}

describe("colour in the project", () => {
  it("stores the eight values only when something is set, and checks them in project files", () => {
    const p = graded(project(), "video", { exposure: 0.3, tint: -0.2 });
    expectValid(p);
    expect(clipOf(p, "video").color).toEqual({ ...NO_COLOR, exposure: 0.3, tint: -0.2 });
    expect(isGraded(colorOf(clipOf(p, "video")))).toBe(true);
    // back to zero, or reset: not stored at all
    expect("color" in clipOf(graded(p, "video", { exposure: 0, tint: 0 }), "video")).toBe(false);
    expect("color" in clipOf(graded(p, "video", null), "video")).toBe(false);
    expect(setClipColor(p, "video", { exposure: 0.3 })).toEqual({ ok: true, project: p }); // not an edit

    expect(setClipColor(p, "video", { contrast: 1.5 })).toMatchObject({
      ok: false,
      error: { code: "out-of-range" },
    });
    expect(setClipColor(p, "video", { shadows: Number.NaN })).toMatchObject({ ok: false });
    expect(setClipColor(p, "music", { exposure: 0.1 })).toMatchObject({ ok: false }); // sound has no colour
    expect(setClipColor(p, "nope", { exposure: 0.1 })).toMatchObject({
      ok: false,
      error: { code: "unknown-clip" },
    });

    const errors = (color: unknown) => {
      const copy = structuredClone(p);
      Object.assign(clipOf(copy, "video"), { color });
      const r = parseProject(copy);
      return r.ok ? [] : r.errors;
    };
    expect(errors({ ...NO_COLOR, saturation: -1, vibrance: 1 })).toHaveLength(0);
    expect(errors({ ...NO_COLOR, exposure: 2 })).not.toHaveLength(0);
    expect(errors({ exposure: 0.1 })).not.toHaveLength(0); // all eight are written
    expect(errors({ ...NO_COLOR, gamma: 1 })).not.toHaveLength(0);
  });

  it("reads the table Rust bakes and refuses anything else", () => {
    const lut = parseLut(lutFile(0.25, 3));
    expect(lut.size).toBe(3);
    expect(lut.table).toHaveLength(81);
    expect(lut.table[40]).toBe(0.25);
    expect(() => parseLut(new ArrayBuffer(8))).toThrow();
    expect(() => parseLut(lutFile().slice(0, 40))).toThrow(/wrong size/);
    const wrong = lutFile();
    new DataView(wrong).setUint8(0, 88);
    expect(() => parseLut(wrong)).toThrow(/not a colour table/);
    expect(colorKey({ ...NO_COLOR, tint: 0.5 })).not.toBe(colorKey(NO_COLOR));
  });
});

describe("colour tables", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    useLutStore.setState({ entries: {}, order: [], held: {} });
    vi.mocked(invoke).mockReset();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("are baked by Rust once per setting and loaded from the cached file", async () => {
    vi.mocked(invoke).mockResolvedValue("/cache/luts/abc.cvlut");
    fetchMock.mockResolvedValue({ ok: true, arrayBuffer: async () => lutFile(0.75) });
    const warm = { ...NO_COLOR, temperature: 0.5 };
    useLutStore.getState().ensure(warm, "video");
    useLutStore.getState().ensure(warm, "video");
    await waitFor(() => expect(useLutStore.getState().entries[colorKey(warm)]?.status).toBe("ready"));
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("bake_color_lut", { adjust: warm });
    expect(fetchMock).toHaveBeenCalledWith("asset://localhost/cache/luts/abc.cvlut");
    // the clip that asked keeps it as its latest
    expect(useLutStore.getState().held.video?.table[0]).toBe(0.75);
  });

  it("report a failure instead of leaving the setting loading for ever", async () => {
    vi.mocked(invoke).mockRejectedValue("invalid input: boom");
    const cold = { ...NO_COLOR, temperature: -0.5 };
    useLutStore.getState().ensure(cold);
    await waitFor(() => expect(useLutStore.getState().entries[colorKey(cold)]).toEqual({ status: "failed" }));
  });
});

describe("colour in the preview and the inspector", () => {
  const warm: ColorAdjust = { ...NO_COLOR, temperature: 0.5 };
  function open(p: Project, selected: string, playhead: number) {
    useProjectStore.getState().loadProject(p, "/p.cutvii", []);
    usePlaybackStore.setState({ playhead, playing: false });
    useSelectionStore.getState().select(selected);
    useUiStore.setState({
      notice: null,
      inspectorTab: { video: "color", image: "color" },
      colorDraft: null,
      colorBefore: null,
    });
    useMediaDetailsStore.setState({ entries: {} });
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation((async (cmd: string) =>
      cmd === "media_details" ? { sizeBytes: 1, hdr: false } : undefined) as never);
    // jsdom has no WebGL: the canvas then draws nothing, which is the documented fallback
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  }
  const ready = (adjust: ColorAdjust, holder?: string) =>
    useLutStore.setState((s) => ({
      entries: { ...s.entries, [colorKey(adjust)]: { status: "ready", lut: parseLut(lutFile()) } },
      held: holder ? { ...s.held, [holder]: parseLut(lutFile()) } : s.held,
    }));
  beforeEach(() => useLutStore.setState({ entries: {}, order: [], held: {} }));
  afterEach(() => vi.restoreAllMocks());
  const stored = (id = "video") => clipOf(useProjectStore.getState().project, id).color;

  it("draws a graded clip through the colour canvas, with its media loaded so a shader may read it", () => {
    open(project(), "video", 1);
    const view = render(<Preview />);
    expect(screen.queryByTestId("color-canvas")).not.toBeInTheDocument();
    // readable by a shader from the first load: colour added later needs no reload of the video
    expect(view.container.querySelector("video")).toHaveAttribute("crossorigin", "anonymous");
    view.unmount();

    open(graded(project(), "video", warm), "video", 1);
    ready(warm);
    const { container } = render(<Preview />);
    const video = container.querySelector("video")!;
    expect(video).toHaveAttribute("crossorigin", "anonymous");
    const canvas = screen.getByTestId("color-canvas");
    expect(canvas.style.width).toBe(video.style.width); // exactly over the picture it grades
    expect(canvas.compareDocumentPosition(video) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();

    // "Before" shows the picture without the colour, a draft shows values that are not saved yet
    act(() => useUiStore.getState().setColorBefore("video"));
    expect(screen.queryByTestId("color-canvas")).not.toBeInTheDocument();
    act(() => useUiStore.getState().setColorBefore(null));
    expect(screen.getByTestId("color-canvas")).toBeInTheDocument();
  });

  it("grades a still the same way and leaves other clips alone", () => {
    open(graded(project(), "still", { ...NO_COLOR, saturation: -1 }), "still", 21);
    ready({ ...NO_COLOR, saturation: -1 });
    const { container } = render(<Preview />);
    expect(container.querySelector('img[data-role="picture"]')).toHaveAttribute("crossorigin", "anonymous");
    expect(screen.getAllByTestId("color-canvas")).toHaveLength(1);
  });

  it("previews while a slider is dragged and saves on release, one undo step each", () => {
    open(project(), "video", 1);
    render(
      <>
        <Preview />
        <Inspector />
      </>,
    );
    const panel = within(screen.getByRole("group", { name: "Colour" }));
    expect(panel.getByRole("button", { name: "Reset all" })).toBeDisabled();
    expect(panel.getAllByRole("slider")).toHaveLength(9); // eight Adjust sliders and the look Intensity

    const exposure = panel.getByRole("slider", { name: "Exposure" });
    fireEvent.change(exposure, { target: { value: "40" } });
    expect(stored()).toBeUndefined(); // nothing saved while dragging
    expect(useUiStore.getState().colorDraft).toEqual({
      clipId: "video",
      adjust: { ...NO_COLOR, exposure: 0.4 },
    });
    expect(invoke).toHaveBeenCalledWith("bake_color_lut", { adjust: { ...NO_COLOR, exposure: 0.4 } });
    act(() => ready({ ...NO_COLOR, exposure: 0.4 }, "video"));
    expect(screen.getByTestId("color-canvas")).toBeInTheDocument(); // the preview already shows it

    fireEvent.pointerUp(exposure);
    expect(stored()).toEqual({ ...NO_COLOR, exposure: 0.4 });
    expect(useUiStore.getState().colorDraft).toBeNull();
    expect(panel.getByText("+40")).toBeInTheDocument();

    const tint = panel.getByRole("slider", { name: "Tint" });
    fireEvent.change(tint, { target: { value: "-25" } });
    fireEvent.pointerUp(tint);
    expect(stored()).toEqual({ ...NO_COLOR, exposure: 0.4, tint: -0.25 });
    expectValid(useProjectStore.getState().project);
    expect(useProjectStore.getState().past).toHaveLength(2);

    // each slider has its own reset; Reset all clears the rest
    fireEvent.click(panel.getByRole("button", { name: "Reset Exposure" }));
    expect(stored()).toEqual({ ...NO_COLOR, tint: -0.25 });
    undo();
    expect(stored()).toEqual({ ...NO_COLOR, exposure: 0.4, tint: -0.25 });
    fireEvent.click(panel.getByRole("button", { name: "Reset all" }));
    expect(stored()).toBeUndefined();
    expect(useUiStore.getState().notice).toBeNull();
  });

  it("shows the picture without its colour while Before is held", () => {
    open(graded(project(), "video", warm), "video", 1);
    render(<Inspector />);
    const before = screen.getByRole("button", { name: "Before" });
    fireEvent.pointerDown(before);
    expect(useUiStore.getState().colorBefore).toBe("video");
    expect(before).toHaveAttribute("aria-pressed", "true");
    fireEvent.pointerUp(before);
    expect(useUiStore.getState().colorBefore).toBeNull();
    fireEvent.keyDown(before, { key: " " });
    expect(useUiStore.getState().colorBefore).toBe("video");
    fireEvent.keyUp(before, { key: " " });
    expect(useUiStore.getState().colorBefore).toBeNull();
  });

  it("warns about HDR footage, says when the preview could not be prepared, and offers no colour for sound", async () => {
    open(graded(project(), "video", warm), "video", 1);
    vi.mocked(invoke).mockImplementation((async (cmd: string) =>
      cmd === "media_details" ? { sizeBytes: 1, hdr: true } : undefined) as never);
    useLutStore.setState({ entries: { [colorKey(warm)]: { status: "failed" } }, order: [], held: {} });
    const view = render(<Inspector />);
    expect(await screen.findByRole("note")).toHaveTextContent(/HDR or wide-colour footage/);
    expect(screen.getByRole("alert")).toHaveTextContent(/colour preview could not be prepared/);
    view.unmount();

    open(project(), "music", 1);
    render(<Inspector />);
    expect(screen.queryByRole("tab", { name: "Preset" })).not.toBeInTheDocument();
  });
});
