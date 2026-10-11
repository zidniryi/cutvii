import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import fixtureV3 from "../../fixtures/project-v3.json";
import fixtureV4 from "../../fixtures/project-v5.json";
import App from "@/App";
import { createProject } from "@/project/factory";
import { SCHEMA_VERSION, type Project } from "@/project/model";
import { removeAsset } from "@/project/ops";
import { parseProject } from "@/project/parse";
import { useImagePreviewStore } from "@/store/imagePreviews";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useUiStore } from "@/store/ui";
import { expectValid } from "@/test/makeProject";
import { addClip, applyFitBackgroundToAll, setClipFit, setClipFitBackground, type EditResult } from "./edit";
import { redo, undo } from "./editor";
import { backgroundColor, backgroundOf, blurFraction, showsBackground } from "./fit";

const state = () => useProjectStore.getState();
const must = (r: EditResult): Project => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  expectValid(r.project);
  return r.project;
};
const code = (r: EditResult) => (r.ok ? "ok" : r.error.code);

/** 9:16 project: a wide video, two images and a song; clips "v" (video), "i" (image) and "a" (audio). */
function base(): Project {
  let p: Project = {
    ...createProject("p", { width: 1080, height: 1920 }),
    assets: [
      { id: "vid", path: "/m/wide.mp4", type: "video", duration: 5, width: 1920, height: 1080 },
      {
        id: "wall",
        path: "/m/wall.png",
        type: "image",
        width: 3000,
        height: 2000,
        thumbnailPath: "/cache/thumb-wall.jpg",
      },
      { id: "logo", path: "/m/logo.png", type: "image", width: 400, height: 400 },
      { id: "song", path: "/m/song.mp3", type: "audio", duration: 9 },
    ],
  };
  p = must(addClip(p, { assetId: "vid", trackId: p.tracks[0].id, start: 0, id: "v" }));
  p = must(addClip(p, { assetId: "logo", trackId: p.tracks[0].id, start: 6, id: "i" }));
  p = must(addClip(p, { assetId: "song", trackId: p.tracks[1].id, start: 0, id: "a" }));
  return must(setClipFit(p, "v", "fit"));
}
const clipOf = (p: Project, id: string) => p.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!;

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  useProjectStore.setState({ project: base(), past: [], future: [], missingPaths: [] });
  useSelectionStore.setState({ selectedClipIds: ["v"] });
  usePlaybackStore.setState({ playhead: 1, playing: false, mediaErrors: {} });
  useUiStore.setState({ sidePanel: "inspector", inspectorTab: {}, dialog: null, notice: null });
  useImagePreviewStore.setState({ previews: {}, requested: {} });
});

describe("fitBackground: model and rules", () => {
  it("defaults to black with blur 30, and is schema version 5", () => {
    expect(SCHEMA_VERSION).toBe(5);
    expect(backgroundOf({})).toEqual({ kind: "black", blur: 30 });
    expect(backgroundColor({ kind: "black" })).toBe("#000000");
    expect(backgroundColor({ kind: "color", color: "#123456" })).toBe("#123456");
    expect(backgroundColor({ kind: "image", assetId: "x" })).toBe("#000000");
    expect(blurFraction(30)).toBeCloseTo(0.03);
    expect(blurFraction(0)).toBe(0);
    expect(blurFraction(500)).toBeCloseTo(0.1); // clamped
    expect(showsBackground("fill")).toBe(false);
    expect(showsBackground("fit") && showsBackground("blur-bg")).toBe(true);
  });

  it("project files: v4 parses, v3 is left to the migration, and incomplete backgrounds are rejected", () => {
    expect(parseProject(fixtureV4).ok).toBe(true);
    expect(parseProject(fixtureV3).ok).toBe(false);
    const withBg = (bg: unknown) => {
      const p = structuredClone(fixtureV4) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      p.tracks[0].clips[0].fitBackground = bg;
      return parseProject(p);
    };
    expect(withBg({ kind: "color", color: "#00AA00" }).ok).toBe(true);
    expect(withBg({ kind: "image", assetId: "asset-image", blur: 55 }).ok).toBe(true);
    expect(withBg({ kind: "color" }).ok).toBe(false);
    expect(withBg({ kind: "color", color: "green" }).ok).toBe(false);
    expect(withBg({ kind: "image" }).ok).toBe(false);
    expect(withBg({ kind: "image", assetId: "asset-video" }).ok).toBe(false); // not an image
    expect(withBg({ kind: "image", assetId: "ghost" }).ok).toBe(false);
    expect(withBg({ kind: "black", blur: 150 }).ok).toBe(false);
    expect(withBg({ kind: "gradient" }).ok).toBe(false);
  });

  it("setClipFitBackground validates, and is a no-op for the same value", () => {
    const p = base();
    expect(
      clipOf(must(setClipFitBackground(p, "v", { kind: "color", color: "#00AA00" })), "v").fitBackground,
    ).toEqual({ kind: "color", color: "#00AA00" });
    expect(code(setClipFitBackground(p, "v", { kind: "color", color: "nope" }))).toBe("out-of-range");
    expect(code(setClipFitBackground(p, "v", { kind: "image", assetId: "vid" }))).toBe("unknown-asset");
    expect(code(setClipFitBackground(p, "v", { kind: "black", blur: 101 }))).toBe("out-of-range");
    expect(code(setClipFitBackground(p, "nope", { kind: "black" }))).toBe("unknown-clip");
    const same = setClipFitBackground(p, "v", { kind: "black" }); // absent already means black
    expect(same.ok && same.project).toBe(p);
  });

  it("apply to all touches every clip on video tracks, and only those", () => {
    const p = must(applyFitBackgroundToAll(base(), { kind: "image", assetId: "wall" }));
    expect(clipOf(p, "v").fitBackground).toEqual({ kind: "image", assetId: "wall" });
    expect(clipOf(p, "i").fitBackground).toEqual({ kind: "image", assetId: "wall" });
    expect(clipOf(p, "a").fitBackground).toBeUndefined();
    const again = applyFitBackgroundToAll(p, { kind: "image", assetId: "wall" });
    expect(again.ok && again.project).toBe(p); // nothing left to change: not a new undo step
  });

  it("removing an image that is used as a background falls back to black", () => {
    const p = must(setClipFitBackground(base(), "v", { kind: "image", assetId: "wall", blur: 60 }));
    const next = removeAsset(p, "wall");
    expect(clipOf(next, "v").fitBackground).toEqual({ kind: "black", blur: 60 });
    expectValid(next);
  });

  it("survives save and reopen", () => {
    let p = must(setClipFitBackground(base(), "v", { kind: "image", assetId: "wall", blur: 12 }));
    p = must(setClipFitBackground(p, "i", { kind: "color", color: "#AABBCC" }));
    const reopened = parseProject(JSON.parse(JSON.stringify(p)));
    expect(reopened.ok && reopened.project).toEqual(p);
  });
});

describe("Inspector: Background row", () => {
  const video = () => within(screen.getByRole("tabpanel"));
  const bg = () => clipOf(state().project, "v").fitBackground;

  it("appears for Fit and Blur, not for Fill", async () => {
    render(<App />);
    expect(video().getByRole("radiogroup", { name: "Background" })).toBeInTheDocument();
    expect(video().getByRole("radio", { name: "Black" })).toHaveAttribute("aria-checked", "true");
    expect(video().queryByLabelText("Blur amount")).not.toBeInTheDocument(); // only for Blur

    await userEvent.click(video().getByRole("radio", { name: "Blur" }));
    expect(video().getByLabelText("Blur amount")).toHaveValue("30");
    // a video is opaque: behind its blurred copy nothing can show, so the colour/image choice is not offered
    expect(video().queryByRole("radiogroup", { name: "Background" })).not.toBeInTheDocument();

    await userEvent.click(video().getByRole("radio", { name: "Fill" }));
    expect(video().queryByRole("radiogroup", { name: "Background" })).not.toBeInTheDocument();
  });

  it("Color: each committed change is one undo step, and the preview shows it", async () => {
    render(<App />);
    const before = state().past.length;
    await userEvent.click(video().getByRole("radio", { name: "Color" }));
    expect(bg()).toEqual({ kind: "color", color: "#202020" });
    expect(state().past).toHaveLength(before + 1);

    const hex = video().getByLabelText("Background colour (hex)");
    await userEvent.clear(hex);
    await userEvent.type(hex, "#00aa00");
    expect(bg()).toEqual({ kind: "color", color: "#202020" }); // typing alone changes nothing
    fireEvent.keyDown(hex, { key: "Enter" });
    expect(bg()).toEqual({ kind: "color", color: "#00aa00" });
    expect(state().past).toHaveLength(before + 2);
    expect(state().past.at(-1)?.label).toBe("Change background");
    expect(screen.getByTestId("video-layer")).toHaveStyle({ backgroundColor: "#00aa00" });

    await userEvent.clear(video().getByLabelText("Background colour (hex)"));
    await userEvent.type(video().getByLabelText("Background colour (hex)"), "zzz{Enter}");
    expect(bg()).toEqual({ kind: "color", color: "#00aa00" }); // invalid input is not applied

    act(() => undo());
    expect(bg()).toEqual({ kind: "color", color: "#202020" });
    act(() => redo());
    expect(bg()).toEqual({ kind: "color", color: "#00aa00" });
  });

  it("Image: picks from the library's images and shows it covering the canvas behind the clip", async () => {
    vi.mocked(invoke).mockImplementation((async (cmd: string, args?: { path: string }) =>
      cmd === "prepare_image_preview" ? `/cache/previews${args!.path}.jpg` : undefined) as typeof invoke);
    render(<App />);
    await userEvent.click(video().getByRole("radio", { name: "Image" }));
    expect(bg()).toEqual({ kind: "image", assetId: "wall" }); // the first image in the library

    const picker = () => within(video().getByRole("radiogroup", { name: "Background image" }));
    expect(
      picker()
        .getAllByRole("radio")
        .map((o) => o.getAttribute("aria-label")),
    ).toEqual(["wall.png", "logo.png"]); // images only
    await userEvent.click(picker().getByRole("radio", { name: "logo.png" }));
    expect(bg()).toEqual({ kind: "image", assetId: "logo" });

    await userEvent.click(picker().getByRole("radio", { name: "wall.png" }));
    expect(picker().getByRole("radio", { name: "wall.png" })).toHaveAttribute("aria-checked", "true");
    const layer = screen.getByTestId("video-layer");
    const behind = layer.querySelector<HTMLElement>("[data-role=background]")!;
    expect(behind.tagName).toBe("IMG");
    expect(behind.className).toContain("object-cover");
    // a downscaled cached copy is requested once and used instead of the full-size file
    await vi.waitFor(() =>
      expect(layer.querySelector("[data-role=background]")!.getAttribute("src")).toBe(
        "asset://localhost/cache/previews/m/wall.png.jpg",
      ),
    );
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(
          (c) => c[0] === "prepare_image_preview" && (c[1] as { path: string }).path === "/m/wall.png",
        ),
    ).toHaveLength(1);
    // the sharp picture is still on top, fitted
    expect(layer.querySelector<HTMLElement>("[data-role=picture]")!.style.width).toBe("100%");
  });

  it("Choose image… picks a file, adds it to the library and uses it; cancel changes nothing", async () => {
    let pick: unknown = null;
    vi.mocked(invoke).mockImplementation((async (cmd: string) =>
      cmd === "pick_image" ? pick : undefined) as typeof invoke);
    render(<App />);
    await userEvent.click(video().getByRole("radio", { name: "Image" }));
    const before = state().project;

    await userEvent.click(video().getByRole("button", { name: "Choose image…" })); // cancelled
    expect(state().project).toBe(before);

    pick = {
      path: "/pics/sunset.jpg",
      mediaType: "image",
      width: 4000,
      height: 3000,
      thumbnailPath: "/cache/t-sunset.jpg",
    };
    await userEvent.click(video().getByRole("button", { name: "Choose image…" }));
    const added = state().project.assets.find((a) => a.path === "/pics/sunset.jpg")!;
    expect(added).toMatchObject({ type: "image", width: 4000 });
    expect(bg()).toEqual({ kind: "image", assetId: added.id });
    expect(
      within(video().getByRole("radiogroup", { name: "Background image" })).getByRole("radio", {
        name: "sunset.jpg",
      }),
    ).toHaveAttribute("aria-checked", "true");
    expectValid(state().project);

    // choosing a file that is already in the library reuses it instead of importing twice
    pick = { path: "/m/logo.png", mediaType: "image", width: 400, height: 400 };
    await userEvent.click(video().getByRole("button", { name: "Choose image…" }));
    expect(bg()).toEqual({ kind: "image", assetId: "logo" });
    expect(state().project.assets.filter((a) => a.path === "/m/logo.png")).toHaveLength(1);
  });

  it("with no images in the library, Image goes straight to the file picker; a missing image offers Relink", async () => {
    vi.mocked(invoke).mockImplementation((async (cmd: string) =>
      cmd === "pick_image"
        ? { path: "/pics/new.png", mediaType: "image", width: 800, height: 600 }
        : undefined) as typeof invoke);
    const noImages = { ...base(), assets: base().assets.filter((a) => a.type !== "image") };
    useProjectStore.setState({
      project: {
        ...noImages,
        tracks: noImages.tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => c.id !== "i") })),
      },
    });
    const { unmount } = render(<App />);
    await userEvent.click(video().getByRole("radio", { name: "Image" }));
    await vi.waitFor(() => expect(bg()?.kind).toBe("image"));
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("pick_image");
    unmount();

    useProjectStore.setState({
      project: must(setClipFitBackground(base(), "v", { kind: "image", assetId: "wall" })),
      missingPaths: ["/m/wall.png"],
    });
    render(<App />);
    const alert = video().getByRole("alert");
    expect(alert).toHaveTextContent("background image file is missing");
    expect(within(alert).getByRole("button", { name: "Relink" })).toBeInTheDocument();
  });

  it("Blur amount: dragging previews nothing permanent, release commits one step, kind changes keep it", async () => {
    render(<App />);
    await userEvent.click(video().getByRole("radio", { name: "Blur" }));
    const before = state().past.length;
    const slider = video().getByLabelText("Blur amount");

    fireEvent.change(slider, { target: { value: "70" } });
    fireEvent.change(slider, { target: { value: "80" } });
    expect(bg()).toBeUndefined();
    expect(state().past).toHaveLength(before);
    fireEvent.pointerUp(slider);
    expect(bg()).toEqual({ kind: "black", blur: 80 });
    expect(state().past).toHaveLength(before + 1);

    // switch to Fit to pick a colour, then back: the amount survives the kind change
    await userEvent.click(video().getByRole("radio", { name: "Fit" }));
    await userEvent.click(video().getByRole("radio", { name: "Color" }));
    expect(bg()).toEqual({ kind: "color", color: "#202020", blur: 80 });
    await userEvent.click(video().getByRole("radio", { name: "Blur" }));
    const backdrop = screen.getByTestId("video-layer").querySelector<HTMLElement>("[data-role=backdrop]")!;
    expect(backdrop.style.filter).toBe("blur(8cqh)"); // 80 -> 8 % of the canvas height

    fireEvent.change(video().getByLabelText("Blur amount"), { target: { value: "0" } });
    fireEvent.pointerUp(video().getByLabelText("Blur amount"));
    expect(
      screen.getByTestId("video-layer").querySelector<HTMLElement>("[data-role=backdrop]")!.style.filter,
    ).toBe("");
  });

  it("a still in Blur mode keeps the background choice (it shows through transparency)", async () => {
    useSelectionStore.setState({ selectedClipIds: ["i"] });
    usePlaybackStore.setState({ playhead: 7 });
    render(<App />);
    await userEvent.click(video().getByRole("radio", { name: "Blur" }));
    expect(video().getByRole("radiogroup", { name: "Background" })).toBeInTheDocument();
    expect(video().getByLabelText("Blur amount")).toBeInTheDocument();
  });

  it("Apply to all clips copies this background to every picture clip in one undo step", async () => {
    render(<App />);
    await userEvent.click(video().getByRole("radio", { name: "Color" }));
    const before = state().past.length;
    await userEvent.click(video().getByRole("button", { name: "Apply to all clips" }));
    expect(clipOf(state().project, "i").fitBackground).toEqual({ kind: "color", color: "#202020" });
    expect(clipOf(state().project, "a").fitBackground).toBeUndefined();
    expect(state().past).toHaveLength(before + 1);
    expect(state().past.at(-1)?.label).toBe("Apply background to all clips");

    act(() => undo());
    expect(clipOf(state().project, "i").fitBackground).toBeUndefined();
    expect(clipOf(state().project, "v").fitBackground).toEqual({ kind: "color", color: "#202020" }); // its own change is a separate step
  });
});
