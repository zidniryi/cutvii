import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useUiStore } from "@/store/ui";
import { IDS, makeProject } from "@/test/makeProject";
import { addAssetToTimeline, changeVolume } from "@/timeline/editor";
import { commonValue, Inspector, TABS_FOR } from "./Inspector";

const state = () => useProjectStore.getState();
const tabNames = () =>
  within(screen.getByRole("tablist", { name: "Clip properties" }))
    .getAllByRole("tab")
    .map((t) => t.textContent);
const tab = (name: string) => screen.getByRole("tab", { name });

function place(assetId: string, start?: number) {
  let id = "";
  act(() => {
    addAssetToTimeline(assetId, { start });
    id = useSelectionStore.getState().selectedClipIds[0];
  });
  return id;
}

beforeEach(() => {
  useProjectStore.setState({
    project: {
      ...makeProject(),
      assets: makeProject().assets.map((a) =>
        a.id === IDS.vid ? { ...a, width: 1920, height: 1080, fpsNum: 30000, fpsDen: 1001 } : a,
      ),
    },
    past: [],
    future: [],
    missingPaths: [],
  });
  useSelectionStore.setState({ selectedClipIds: [] });
  usePlaybackStore.setState({ playhead: 0 });
  useUiStore.setState({ notice: null, sidePanel: "inspector", inspectorTab: {}, canvasDialogOpen: false });
});

describe("Inspector tabs", () => {
  it("offers only the tabs that have controls for that kind of clip", () => {
    expect(TABS_FOR).toEqual({
      video: ["video", "transition", "color", "ai", "audio", "speed", "info"],
      audio: ["audio", "ai", "speed", "info"],
      image: ["video", "transition", "color", "info"],
    });

    place(IDS.vid);
    const { unmount } = render(<Inspector />);
    expect(tabNames()).toEqual(["Video", "Transition", "Preset", "AI", "Audio", "Speed", "Info"]);
    unmount();

    act(() => useSelectionStore.getState().clear());
    place(IDS.aud);
    const second = render(<Inspector />);
    expect(tabNames()).toEqual(["Audio", "AI", "Speed", "Info"]);
    second.unmount();

    act(() => useSelectionStore.getState().clear());
    place(IDS.img, 30);
    render(<Inspector />);
    expect(tabNames()).toEqual(["Video", "Transition", "Preset", "Info"]); // a still has no sound and no speed
  });

  it("keeps the header (name, type and track, Start, Duration) visible on every tab", async () => {
    place(IDS.vid, 2);
    render(<Inspector />);
    for (const name of ["Video", "Audio", "Speed", "Info"]) {
      await userEvent.click(tab(name));
      const header = within(screen.getByTestId("inspector-header"));
      expect(header.getByText("vid.mp4")).toBeInTheDocument();
      expect(header.getByText("Video · Video 1")).toBeInTheDocument();
      expect(header.getByLabelText("Start (s)")).toHaveValue(2);
      expect(header.getByLabelText("Duration (s)")).toHaveValue(10);
    }
  });

  it("each tab shows its own controls and nothing else", async () => {
    place(IDS.vid);
    render(<Inspector />);
    const panel = () => within(screen.getByRole("tabpanel"));

    expect(tab("Video")).toHaveAttribute("aria-selected", "true"); // the first tab is the default
    expect(panel().getByRole("radiogroup", { name: "Fit to canvas" })).toBeInTheDocument();
    expect(panel().queryByRole("slider", { name: "Volume" })).not.toBeInTheDocument();

    await userEvent.click(tab("Audio"));
    expect(panel().getByRole("slider", { name: "Volume" })).toBeInTheDocument();
    expect(panel().queryByRole("radiogroup", { name: "Fit to canvas" })).not.toBeInTheDocument();

    await userEvent.click(tab("Speed"));
    expect(panel().getByRole("region", { name: "Speed" })).toBeInTheDocument();

    await userEvent.click(tab("Info"));
    expect(panel().getByText("Source in")).toBeInTheDocument();
    expect(panel().getByText("1920×1080")).toBeInTheDocument();
    expect(panel().getByText("29.97 fps")).toBeInTheDocument();
    expect(panel().getByText("/m/vid.mp4")).toBeInTheDocument();
    expect(panel().queryByText(/codec/i)).not.toBeInTheDocument(); // not known yet, so not shown
  });

  it("editing through a tab still works exactly as before (one undo step)", async () => {
    const id = place(IDS.vid);
    render(<Inspector />);
    await userEvent.click(tab("Audio"));
    const before = state().past.length;
    const percent = screen.getByLabelText("Volume percent");
    await userEvent.clear(percent);
    await userEvent.type(percent, "60{Enter}");
    expect(state().project.tracks[0].clips.find((c) => c.id === id)!.volume).toBeCloseTo(0.6);
    expect(state().past).toHaveLength(before + 1);
  });

  it("remembers the last tab per kind of clip", async () => {
    const video = place(IDS.vid, 0);
    const audio = place(IDS.aud, 0);
    render(<Inspector />);

    act(() => useSelectionStore.getState().select(video));
    await userEvent.click(tab("Speed"));
    act(() => useSelectionStore.getState().select(audio));
    expect(tab("Audio")).toHaveAttribute("aria-selected", "true"); // audio clips have their own memory
    await userEvent.click(tab("Info"));

    act(() => useSelectionStore.getState().select(video));
    expect(tab("Speed")).toHaveAttribute("aria-selected", "true");
    act(() => useSelectionStore.getState().select(audio));
    expect(tab("Info")).toHaveAttribute("aria-selected", "true");
    expect(useUiStore.getState().inspectorTab).toEqual({ video: "speed", audio: "info" });
  });

  it("a remembered tab that this clip does not have falls back to the first one", () => {
    useUiStore.setState({ inspectorTab: { image: "speed" } });
    place(IDS.img);
    render(<Inspector />);
    expect(tab("Video")).toHaveAttribute("aria-selected", "true");
  });

  it("is a keyboard tablist: arrows wrap, Home and End jump, one tab stop, and the playhead does not move", () => {
    place(IDS.vid);
    render(<Inspector />);
    const list = screen.getByRole("tablist", { name: "Clip properties" });
    tab("Video").focus();

    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(tab("Transition")).toHaveAttribute("aria-selected", "true");
    expect(tab("Transition")).toHaveFocus();
    fireEvent.keyDown(list, { key: "End" });
    expect(tab("Info")).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(list, { key: "ArrowRight" }); // wraps
    expect(tab("Video")).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(list, { key: "ArrowLeft" });
    expect(tab("Info")).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(list, { key: "Home" });
    expect(tab("Video")).toHaveAttribute("aria-selected", "true");

    expect(screen.getAllByRole("tab").filter((t) => t.tabIndex === 0)).toHaveLength(1); // roving tabindex
    expect(usePlaybackStore.getState().playhead).toBe(0);
    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveAttribute("aria-labelledby", tab("Video").id);
    expect(panel.className).toContain("overflow-y-auto"); // scrolling stays inside the tab content
    expect(tab("Video").className).toContain("h-11"); // 44 px target
  });
});

describe("Inspector with no or several clips selected", () => {
  it("nothing selected shows the project settings", async () => {
    render(<Inspector />);
    expect(screen.getByText("Nothing selected")).toBeInTheDocument();
    const settings = within(screen.getByLabelText("Project settings"));
    expect(settings.getByText("1920×1080 · 30 fps")).toBeInTheDocument();
    expect(settings.getByText("#000000")).toBeInTheDocument();
    expect(settings.getByText("3 / 0")).toBeInTheDocument(); // tracks / clips
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Change canvas…" }));
    expect(useUiStore.getState().canvasDialogOpen).toBe(true);
  });

  it("several clips show shared values, and Mixed where they differ", () => {
    const a = place(IDS.vid, 0);
    const b = place(IDS.vid2, 20);
    act(() => {
      changeVolume(b, 0.5);
      useSelectionStore.getState().setSelection([a, b]);
    });
    render(<Inspector />);
    expect(screen.getByText("2 clips selected")).toBeInTheDocument();
    const shared = within(screen.getByLabelText("Shared properties"));
    const value = (label: string) => shared.getByText(label).nextElementSibling!.textContent;

    expect(value("Start")).toBe("Mixed");
    expect(value("Duration")).toBe("Mixed");
    expect(value("Volume")).toBe("Mixed"); // 100 % and 50 %
    expect(value("Speed")).toBe("1×"); // the same on both
    expect(value("Fit to canvas")).toBe("Fill");
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("commonValue: one value when all agree, Mixed otherwise", () => {
    expect(commonValue([2, 2, 2], (v) => `${v}×`)).toBe("2×");
    expect(commonValue([2, 3], (v) => `${v}×`)).toBe("Mixed");
    expect(commonValue([], String)).toBe("—");
  });
});
