import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { Inspector } from "@/components/layout/Inspector";
import { Preview } from "@/components/layout/Preview";
import { SCHEMA_VERSION, type ClipLut, type Project } from "@/project/model";
import { parseProject } from "@/project/parse";
import { useLutStore } from "@/store/luts";
import { useMediaDetailsStore } from "@/store/mediaDetails";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useUiStore } from "@/store/ui";
import { resetUserLuts, useUserLutStore, type UserLut } from "@/store/userLuts";
import { expectValid, IDS, makeProject } from "@/test/makeProject";
import { colorKey, gradeKey, lutOf, NO_COLOR, parseLut, setClipLut } from "./color";
import { addClip } from "./edit";
import { undo } from "./editor";

const FILM: UserLut = { id: "0123456789abcdef01234567", name: "Film", size: 33 };
const TEAL: UserLut = { id: "abcdef0123456789abcdef01", name: "Teal", size: 17 };
const film = (intensity = 1): ClipLut => ({ id: FILM.id, name: FILM.name, intensity });

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
const withLut = (p: Project, id: string, lut: ClipLut | null) => {
  const r = setClipLut(p, id, lut);
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
};
function tableFile(): ArrayBuffer {
  const buffer = new ArrayBuffer(12 + 8 * 12);
  const view = new DataView(buffer);
  [..."CVLT"].forEach((c, i) => view.setUint8(i, c.charCodeAt(0)));
  view.setUint32(4, 1, true);
  view.setUint32(8, 2, true);
  return buffer;
}

describe("a LUT in the project", () => {
  it("is schema version 7: an optional lut per clip, checked in project files", () => {
    expect(SCHEMA_VERSION).toBe(7);
    const p = withLut(project(), "video", film(0.6));
    expectValid(p);
    expect(clipOf(p, "video").lut).toEqual({ id: FILM.id, name: "Film", intensity: 0.6 });
    expect("lut" in clipOf(withLut(p, "video", null), "video")).toBe(false);
    expect(setClipLut(p, "video", film(0.6))).toEqual({ ok: true, project: p }); // not an edit

    const bad = (lut: unknown) => {
      const doc = JSON.parse(JSON.stringify(p));
      doc.tracks[0].clips[0].lut = lut;
      return parseProject(doc).ok;
    };
    expect(bad({ ...film(), id: "../../etc/passwd" })).toBe(false);
    expect(bad({ ...film(), id: FILM.id.toUpperCase() })).toBe(false);
    expect(bad({ ...film(), intensity: 1.5 })).toBe(false);
    expect(bad({ ...film(), name: "" })).toBe(false);
    expect(bad({ ...film(), path: "/tmp/x.cube" })).toBe(false); // never a path
    expect(bad(film())).toBe(true);
  });

  it("is only for clips with a picture, and its intensity stays within 0 to 1", () => {
    const p = project();
    expect(setClipLut(p, "music", film())).toMatchObject({
      ok: false,
      error: { code: "incompatible-track" },
    });
    expect(setClipLut(p, "nope", film())).toMatchObject({ ok: false, error: { code: "unknown-clip" } });
    expect(setClipLut(p, "video", film(1.2))).toMatchObject({ ok: false, error: { code: "out-of-range" } });
    expect(setClipLut(p, "still", film())).toMatchObject({ ok: true });
  });

  it("has its own table: the key follows the LUT and its intensity, and 0 is the same as none", () => {
    const warm = { ...NO_COLOR, temperature: 0.5 };
    expect(gradeKey(warm, null)).toBe(colorKey(warm));
    const keys = [
      gradeKey(warm, null),
      gradeKey(warm, film()),
      gradeKey(warm, film(0.5)),
      gradeKey(NO_COLOR, film()),
    ];
    expect(new Set(keys).size).toBe(4);
    expect(gradeKey(warm, { ...film(), id: TEAL.id })).not.toBe(gradeKey(warm, film()));
    expect(lutOf({ lut: film(0) })).toBeNull();
    expect(lutOf({})).toBeNull();
    expect(lutOf({ lut: film(0.3) })).toEqual(film(0.3));
  });
});

describe("a LUT in the preview and the Color tab", () => {
  let library: UserLut[];
  let imported: unknown;
  const fetchMock = vi.fn();
  function open(p: Project, selected: string, playhead: number) {
    useProjectStore.getState().loadProject(p, "/p.cutvii", []);
    usePlaybackStore.setState({ playhead, playing: false });
    useSelectionStore.getState().select(selected);
    useUiStore.setState({
      notice: null,
      dialog: null,
      inspectorTab: { video: "color", image: "color" },
      colorDraft: null,
      colorBefore: null,
    });
    useMediaDetailsStore.setState({ entries: {} });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  }
  beforeEach(() => {
    library = [FILM, TEAL];
    imported = { luts: [], problems: [] };
    resetUserLuts();
    useLutStore.setState({ entries: {}, order: [], held: {} });
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, arrayBuffer: async () => tableFile() });
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation((async (cmd: string, args?: { id?: string }) => {
      if (cmd === "media_details") return { sizeBytes: 1, hdr: false };
      if (cmd === "color_luts") return library;
      if (cmd === "import_color_luts") return imported;
      if (cmd === "delete_color_lut") {
        library = library.filter((l) => l.id !== args?.id);
        return undefined;
      }
      if (cmd === "bake_color_lut") return "/cache/luts/abc.cvlut";
      return undefined;
    }) as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const stored = (id = "video") => clipOf(useProjectStore.getState().project, id).lut;
  const baked = () =>
    vi
      .mocked(invoke)
      .mock.calls.filter((c) => c[0] === "bake_color_lut")
      .map((c) => c[1]);
  const panel = () => within(screen.getByRole("group", { name: "LUT" }));

  it("asks Rust for one table with the LUT on top of Adjust, and draws through the colour canvas", async () => {
    open(withLut(project(), "video", film(0.8)), "video", 1);
    render(<Preview />);
    await waitFor(() => expect(screen.getByTestId("color-canvas")).toBeInTheDocument());
    // no slider is set: the LUT alone is enough for the clip to be graded
    expect(baked()).toEqual([{ adjust: NO_COLOR, lut: film(0.8) }]);
    expect(useLutStore.getState().entries[gradeKey(NO_COLOR, film(0.8))]?.status).toBe("ready");
  });

  it("leaves a LUT that is not on this computer out of the preview and says so in the Color tab", async () => {
    library = [TEAL];
    open(withLut(project(), "video", film()), "video", 1);
    render(
      <>
        <Preview />
        <Inspector />
      </>,
    );
    expect(await panel().findByRole("alert")).toHaveTextContent("“Film” is not on this computer");
    expect(panel().getByRole("option", { name: "Film (missing)" })).toBeInTheDocument();
    expect(panel().queryByRole("slider")).toBeNull();
    expect(screen.queryByTestId("color-canvas")).not.toBeInTheDocument();
    // the setting stays in the project until the user decides
    expect(stored()).toEqual(film());
    fireEvent.change(panel().getByLabelText("LUT"), { target: { value: "" } });
    expect(stored()).toBeUndefined();
    expect(panel().queryByRole("alert")).toBeNull();
  });

  it("choose, change the intensity and remove: each is one undo step, and a drag previews first", async () => {
    open(project(), "video", 1);
    render(
      <>
        <Preview />
        <Inspector />
      </>,
    );
    await panel().findByRole("option", { name: "Teal" });
    expect(panel().queryByRole("slider")).toBeNull();

    fireEvent.change(panel().getByLabelText("LUT"), { target: { value: TEAL.id } });
    expect(stored()).toEqual({ id: TEAL.id, name: "Teal", intensity: 1 });

    const slider = panel().getByRole("slider", { name: "Intensity" });
    fireEvent.change(slider, { target: { value: "40" } });
    // while dragging: the preview asks for the new table, the project is not changed yet
    expect(stored()?.intensity).toBe(1);
    await waitFor(() =>
      expect(baked()).toContainEqual({ adjust: NO_COLOR, lut: { ...stored()!, intensity: 0.4 } }),
    );
    fireEvent.pointerUp(slider);
    expect(stored()?.intensity).toBe(0.4);
    expect(useUiStore.getState().colorDraft).toBeNull();

    act(() => void undo());
    expect(stored()?.intensity).toBe(1);
    act(() => void undo());
    expect(stored()).toBeUndefined();
  });

  it("imports .cube files through Rust, puts the first one on the clip and reports refused files", async () => {
    open(project(), "video", 1);
    render(<Inspector />);
    await panel().findByRole("option", { name: "Film" });
    const fresh: UserLut = { id: "00112233445566778899aabb", name: "Fresh", size: 33 };
    library = [...library, fresh];
    imported = {
      luts: [fresh],
      problems: [["broken.cube", "invalid input: line 4: a value is out of range"]],
    };
    fireEvent.click(panel().getByRole("button", { name: "Import LUT…" }));
    await waitFor(() => expect(stored()).toEqual({ id: fresh.id, name: "Fresh", intensity: 1 }));
    expect(useUiStore.getState().notice).toBe(
      "Imported Fresh. broken.cube: line 4: a value is out of range.",
    );
    expect(await panel().findByRole("option", { name: "Fresh" })).toBeInTheDocument();
    // the webview never names a file: the dialog is Rust's
    expect(vi.mocked(invoke).mock.calls.find((c) => c[0] === "import_color_luts")).toEqual([
      "import_color_luts",
    ]);

    // cancelled: nothing changes, nothing is said
    useUiStore.getState().setNotice(null);
    imported = { luts: [], problems: [] };
    fireEvent.click(panel().getByRole("button", { name: "Import LUT…" }));
    await waitFor(() =>
      expect(vi.mocked(invoke).mock.calls.filter((c) => c[0] === "import_color_luts")).toHaveLength(2),
    );
    expect(useUiStore.getState().notice).toBeNull();
    expect(stored()?.name).toBe("Fresh");
  });

  it("removes a LUT from CutVii only after asking; clips that used it then show it as missing", async () => {
    open(withLut(project(), "video", film()), "video", 1);
    render(<Inspector />);
    await panel().findByRole("option", { name: "Film" });
    fireEvent.click(panel().getByRole("button", { name: "Remove this LUT from CutVii" }));
    await waitFor(() =>
      expect(useUiStore.getState().dialog?.title).toBe("Remove the LUT “Film” from CutVii?"),
    );
    expect(vi.mocked(invoke).mock.calls.some((c) => c[0] === "delete_color_lut")).toBe(false);
    act(() => useUiStore.getState().dialog?.resolve(true));
    expect(await panel().findByRole("alert")).toHaveTextContent("not on this computer");
    expect(invoke).toHaveBeenCalledWith("delete_color_lut", { id: FILM.id });
    expect(useUserLutStore.getState().luts).toEqual([TEAL]);
    expect(stored()).toEqual(film());
  });

  it("offers no LUT for sound", () => {
    open(project(), "music", 1);
    render(<Inspector />);
    expect(screen.queryByRole("group", { name: "LUT" })).toBeNull();
  });

  it("keeps the parsed table for the clip", async () => {
    useLutStore.getState().ensure(NO_COLOR, "video", film());
    await waitFor(() => expect(useLutStore.getState().held.video).toEqual(parseLut(tableFile())));
    expect(invoke).toHaveBeenCalledWith("bake_color_lut", { adjust: NO_COLOR, lut: film() });
  });
});
