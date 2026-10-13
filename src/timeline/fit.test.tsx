import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import fixtureV2 from "../../fixtures/project-v2.json";
import fixtureV3 from "../../fixtures/project-v7.json";
import App from "@/App";
import { createProject } from "@/project/factory";
import type { Project } from "@/project/model";
import { parseProject } from "@/project/parse";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useUiStore } from "@/store/ui";
import { addClip, setClipFit } from "./edit";
import { addAssetToTimeline, changeFit, redo, undo } from "./editor";
import { DEFAULT_FIT_MODE, fitLayout } from "./fit";

const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);
const state = () => useProjectStore.getState();

describe("fitLayout: 16:9 picture into a 9:16 canvas", () => {
  const [sw, sh, cw, ch] = [1920, 1080, 1080, 1920];

  it("fill covers the canvas and crops the sides equally", () => {
    const { picture, backdrop } = fitLayout(sw, sh, cw, ch, "fill");
    close(picture.height, 1);
    close(picture.y, 0);
    close(picture.width, 16 / 9 / (9 / 16)); // 3.16x the canvas width
    close(picture.x, (1 - picture.width) / 2); // centred: the same amount cropped left and right
    expect(picture.x).toBeLessThan(0);
    expect(backdrop).toBeUndefined();
  });

  it("fit shows the whole picture with bars above and below", () => {
    const { picture } = fitLayout(sw, sh, cw, ch, "fit");
    close(picture.width, 1);
    close(picture.x, 0);
    close(picture.height, 9 / 16 / (16 / 9)); // 31.6 % of the canvas height
    close(picture.y, (1 - picture.height) / 2);
  });

  it("blur-bg is the fitted picture over a filling copy", () => {
    const blur = fitLayout(sw, sh, cw, ch, "blur-bg");
    expect(blur.picture).toEqual(fitLayout(sw, sh, cw, ch, "fit").picture);
    expect(blur.backdrop).toEqual(fitLayout(sw, sh, cw, ch, "fill").picture);
  });
});

describe("fitLayout: 9:16 picture into a 16:9 canvas", () => {
  const [sw, sh, cw, ch] = [1080, 1920, 1920, 1080];

  it("fill covers the width and crops top and bottom equally", () => {
    const { picture } = fitLayout(sw, sh, cw, ch, "fill");
    close(picture.width, 1);
    close(picture.height, 16 / 9 / (9 / 16));
    close(picture.y, (1 - picture.height) / 2);
    expect(picture.y).toBeLessThan(0);
  });

  it("fit pillar-boxes; blur-bg puts a filling copy behind", () => {
    const fit = fitLayout(sw, sh, cw, ch, "fit").picture;
    close(fit.height, 1);
    close(fit.width, 9 / 16 / (16 / 9));
    close(fit.x, (1 - fit.width) / 2);
    expect(fitLayout(sw, sh, cw, ch, "blur-bg").backdrop!.width).toBe(1);
  });
});

describe("fitLayout: general rules", () => {
  it("a picture with the canvas's own shape fills it exactly in every mode", () => {
    for (const mode of ["fill", "fit", "blur-bg"] as const) {
      const { picture } = fitLayout(1280, 720, 1920, 1080, mode);
      expect(picture).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    }
  });

  it("never depends on pixel counts, only on shapes: a tiny picture is scaled up", () => {
    expect(fitLayout(160, 90, 1080, 1920, "fill")).toEqual(fitLayout(1920, 1080, 1080, 1920, "fill"));
    expect(fitLayout(160, 90, 1080, 1920, "fit")).toEqual(fitLayout(3840, 2160, 1080, 1920, "fit"));
  });

  it("the picture keeps its aspect ratio in every mode", () => {
    for (const mode of ["fill", "fit", "blur-bg"] as const) {
      const { picture } = fitLayout(1920, 1080, 1080, 1350, mode);
      close((picture.width * 1080) / (picture.height * 1350), 1920 / 1080);
    }
  });

  it("unknown sizes fall back to the whole canvas", () => {
    expect(fitLayout(0, 0, 1080, 1920, "fill").picture).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });
});

describe("fitMode in the project", () => {
  it("defaults to fill, and v2 files are not read directly", () => {
    expect(DEFAULT_FIT_MODE).toBe("fill");
    expect(parseProject(fixtureV3).ok).toBe(true);
    expect(parseProject(fixtureV2).ok).toBe(false); // upgraded by the Rust migration first (tested there)
    const old = structuredClone(fixtureV3) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    old.tracks[0].clips[0].fit = "fill"; // the old field name is gone
    expect(parseProject(old).ok).toBe(false);
    old.tracks[0].clips[0].fit = undefined;
    old.tracks[0].clips[0].fitMode = "stretch";
    expect(parseProject(old).ok).toBe(false);
  });

  it("is one undoable action, redoable, and survives save and reopen", () => {
    useProjectStore.setState({
      project: {
        ...createProject("p", { width: 1080, height: 1920 }),
        assets: [{ id: "v", path: "/m/wide.mp4", type: "video", duration: 5, width: 1920, height: 1080 }],
      },
      past: [],
      future: [],
    });
    addAssetToTimeline("v");
    const id = state().project.tracks[0].clips[0].id;
    const clip = () => state().project.tracks[0].clips[0];
    expect(clip().fitMode).toBeUndefined(); // new clips use the default

    const before = state().past.length;
    expect(changeFit(id, "blur-bg").ok).toBe(true);
    expect(state().past).toHaveLength(before + 1);
    expect(changeFit(id, "blur-bg").ok).toBe(true); // same value: nothing recorded
    expect(state().past).toHaveLength(before + 1);

    undo();
    expect(clip().fitMode).toBeUndefined();
    redo();
    expect(clip().fitMode).toBe("blur-bg");

    const reopened = parseProject(JSON.parse(JSON.stringify(state().project)));
    expect(reopened.ok && reopened.project).toEqual(state().project);
    expect(reopened.ok && reopened.project.tracks[0].clips[0].fitMode).toBe("blur-bg");
  });

  it("setClipFit is a no-op for the current value, including the implicit default", () => {
    let p: Project = {
      ...createProject(),
      assets: [{ id: "v", path: "/m/v.mp4", type: "video", duration: 5 }],
    };
    const r = addClip(p, { assetId: "v", trackId: p.tracks[0].id, start: 0, id: "c" });
    if (!r.ok) throw new Error("setup");
    p = r.project;
    const same = setClipFit(p, "c", "fill");
    expect(same.ok && same.project).toBe(p);
  });
});

describe("preview", () => {
  beforeEach(() => {
    useSelectionStore.setState({ selectedClipIds: [] });
    usePlaybackStore.setState({ playhead: 0, playing: false, mediaErrors: {} });
    useUiStore.setState({ sidePanel: "library", dialog: null, notice: null });
    useProjectStore.setState({
      project: {
        ...createProject("p", { width: 1080, height: 1920 }),
        assets: [{ id: "v", path: "/m/wide.mp4", type: "video", duration: 5, width: 1920, height: 1080 }],
      },
      past: [],
      future: [],
    });
  });

  it("a landscape video in a 9:16 project fills the canvas instead of sitting small in the middle", async () => {
    render(<App />);
    act(() => void addAssetToTimeline("v"));
    const layer = () => screen.getByTestId("video-layer");
    const picture = () => layer().querySelector<HTMLElement>("[data-role=picture]")!;

    expect(layer().dataset.fit).toBe("fill");
    expect(picture().style.height).toBe("100%"); // full canvas height
    expect(parseFloat(picture().style.width)).toBeCloseTo(316.049, 2); // wider than the canvas: sides cropped
    expect(parseFloat(picture().style.left)).toBeCloseTo(-108.025, 2);

    await userEvent.click(screen.getByRole("tab", { name: "Inspector" }));
    const chips = within(screen.getByRole("radiogroup", { name: "Fit to canvas" }));
    await userEvent.click(chips.getByRole("radio", { name: "Fit" }));
    expect(picture().style.width).toBe("100%");
    expect(parseFloat(picture().style.height)).toBeCloseTo(31.640625, 4);
    expect(layer().querySelector("[data-role=backdrop]")).toBeNull();

    await userEvent.click(chips.getByRole("radio", { name: "Blur" }));
    const backdrop = layer().querySelector<HTMLElement>("[data-role=backdrop]")!;
    expect(backdrop.style.height).toBe("100%"); // the blurred copy fills the canvas
    expect(backdrop.style.filter).toContain("blur");
    expect(picture().style.width).toBe("100%"); // the sharp picture stays fitted
    expect(chips.getByRole("radio", { name: "Blur" })).toHaveAttribute("aria-checked", "true");
  });

  it("audio clips have no fit control", async () => {
    useProjectStore.setState({
      project: { ...createProject(), assets: [{ id: "a", path: "/m/a.mp3", type: "audio", duration: 5 }] },
    });
    render(<App />);
    act(() => void addAssetToTimeline("a"));
    await userEvent.click(screen.getByRole("tab", { name: "Inspector" }));
    expect(screen.queryByRole("radiogroup", { name: "Fit to canvas" })).not.toBeInTheDocument();
  });
});
