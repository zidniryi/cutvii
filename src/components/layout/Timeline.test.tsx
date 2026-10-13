import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@/components/ui/tooltip";
import App from "@/App";
import { useProjectStore } from "@/store/project";
import { usePlaybackStore } from "@/store/playback";
import { useSelectionStore } from "@/store/selection";
import { useTimelineViewStore } from "@/store/timelineView";
import { useUiStore } from "@/store/ui";
import { addAssetToTimeline } from "@/timeline/editor";
import { expectValid, IDS, makeProject } from "@/test/makeProject";
import { findClip } from "@/timeline/clips";
import { ROW_HEIGHT } from "@/timeline/geometry";
import { Timeline } from "./Timeline";

const state = () => useProjectStore.getState();
const clips = () => state().project.tracks.flatMap((t) => t.clips);

function setup() {
  return render(
    <TooltipProvider>
      <Timeline />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  useProjectStore.setState({ project: makeProject(), past: [], future: [] });
  useSelectionStore.setState({ selectedClipIds: [] });
  usePlaybackStore.setState({ playhead: 0 });
  useTimelineViewStore.setState({ pps: 50, snapping: true });
  useUiStore.setState({ notice: null });
});

describe("Timeline", () => {
  it("renders a lane per track and a clip per placed asset", () => {
    addAssetToTimeline(IDS.vid);
    addAssetToTimeline(IDS.aud);
    setup();
    expect(screen.getAllByRole("group", { name: /lane$/ })).toHaveLength(3);
    expect(screen.getByRole("button", { name: "vid.mp4 clip" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "aud.mp3 clip" })).toBeInTheDocument();
  });

  it("selects on click, additive on shift, and clears on empty lane click", async () => {
    addAssetToTimeline(IDS.vid);
    addAssetToTimeline(IDS.aud);
    useSelectionStore.getState().clear();
    setup();
    const vid = screen.getByRole("button", { name: "vid.mp4 clip" });
    const aud = screen.getByRole("button", { name: "aud.mp3 clip" });

    fireEvent.pointerDown(vid, { button: 0 });
    fireEvent.pointerUp(window);
    expect(useSelectionStore.getState().selectedClipIds).toHaveLength(1);
    expect(vid).toHaveAttribute("aria-pressed", "true");

    fireEvent.pointerDown(aud, { button: 0, shiftKey: true });
    expect(useSelectionStore.getState().selectedClipIds).toHaveLength(2);

    fireEvent.pointerDown(screen.getByRole("group", { name: "Video 1 lane" }), { button: 0 });
    expect(useSelectionStore.getState().selectedClipIds).toHaveLength(0);
  });

  it("moves a clip by dragging, as one undo step", () => {
    addAssetToTimeline(IDS.vid, { start: 0 });
    const id = clips()[0].id;
    const past = state().past.length;
    setup();
    const clip = screen.getByRole("button", { name: "vid.mp4 clip" });
    const y = ROW_HEIGHT / 2; // jsdom has no layout: lanes start at y=0, so this is the middle of the first lane

    fireEvent.pointerDown(clip, { button: 0, clientX: 10, clientY: y });
    fireEvent.pointerMove(window, { clientX: 110, clientY: y }); // +100px = +2s
    expect(findClip(state().project, id)!.clip.timelineStart).toBe(0); // preview only, not committed
    fireEvent.pointerUp(window);

    expect(findClip(state().project, id)!.clip.timelineStart).toBe(2);
    expect(state().past).toHaveLength(past + 1);
    expectValid(state().project);
  });

  it("a clip dragged onto the front of another takes its place, and that one moves later", () => {
    addAssetToTimeline(IDS.vid, { start: 0 }); // 0..10
    addAssetToTimeline(IDS.vid2, { start: 12 }); // 12..16
    const first = clips().find((c) => c.assetId === IDS.vid)!.id;
    const id = clips().find((c) => c.assetId === IDS.vid2)!.id;
    const past = state().past.length;
    setup();
    const y = ROW_HEIGHT / 2; // jsdom has no layout: lanes start at y=0, so this is the middle of the first lane

    fireEvent.pointerDown(screen.getByRole("button", { name: "vid2.mp4 clip" }), {
      button: 0,
      clientX: 600,
      clientY: y,
    });
    fireEvent.pointerMove(window, { clientX: 100, clientY: y }); // -10s -> would start at 2, on the first half
    fireEvent.pointerUp(window);

    expect(findClip(state().project, id)!.clip.timelineStart).toBe(0); // it is the first clip now
    expect(findClip(state().project, first)!.clip.timelineStart).toBe(4); // and the other follows it
    expect(state().past).toHaveLength(past + 1); // one undo step for both
    expect(useUiStore.getState().notice).toBeNull(); // no "would overlap" any more
    expectValid(state().project);
  });

  it("trims with the edge handle", () => {
    addAssetToTimeline(IDS.vid, { start: 0 });
    const id = clips()[0].id;
    setup();
    const y = ROW_HEIGHT / 2; // jsdom has no layout: lanes start at y=0, so this is the middle of the first lane
    fireEvent.pointerDown(
      within(screen.getByRole("button", { name: "vid.mp4 clip" })).getByTestId("trim-end"),
      {
        button: 0,
        clientX: 500,
        clientY: y,
      },
    );
    fireEvent.pointerMove(window, { clientX: 300, clientY: y }); // -4s
    fireEvent.pointerUp(window);
    expect(findClip(state().project, id)!.clip).toMatchObject({ sourceIn: 0, sourceOut: 6 });
  });

  it("Escape cancels a drag", () => {
    addAssetToTimeline(IDS.vid, { start: 0 });
    const id = clips()[0].id;
    setup();
    const y = ROW_HEIGHT / 2; // jsdom has no layout: lanes start at y=0, so this is the middle of the first lane
    fireEvent.pointerDown(screen.getByRole("button", { name: "vid.mp4 clip" }), {
      button: 0,
      clientX: 0,
      clientY: y,
    });
    fireEvent.pointerMove(window, { clientX: 100, clientY: y });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(window);
    expect(findClip(state().project, id)!.clip.timelineStart).toBe(0);
  });

  it("toolbar: split, delete, undo, zoom and snapping toggle", async () => {
    addAssetToTimeline(IDS.vid, { start: 0 });
    usePlaybackStore.getState().setPlayhead(4);
    setup();

    await userEvent.click(screen.getByRole("button", { name: "Split at playhead (S)" }));
    expect(clips()).toHaveLength(2);

    await userEvent.click(screen.getByRole("button", { name: "Delete selected (Del)" }));
    expect(clips()).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(useTimelineViewStore.getState().pps).toBeGreaterThan(50);
    await userEvent.click(screen.getByRole("button", { name: "Snapping on" }));
    expect(useTimelineViewStore.getState().snapping).toBe(false);
  });

  it("context menu splits and deletes", async () => {
    addAssetToTimeline(IDS.vid, { start: 0 });
    usePlaybackStore.getState().setPlayhead(5);
    setup();
    fireEvent.contextMenu(screen.getByRole("button", { name: "vid.mp4 clip" }), { clientX: 20, clientY: 20 });
    await userEvent.click(screen.getByRole("menuitem", { name: /Split at playhead/ }));
    expect(clips()).toHaveLength(2);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    fireEvent.contextMenu(screen.getAllByRole("button", { name: "vid.mp4 clip" })[0], {
      clientX: 20,
      clientY: 20,
    });
    await userEvent.click(screen.getByRole("menuitem", { name: /Delete/ }));
    expect(clips()).toHaveLength(1);
  });

  it("windows rendering: far-away clips are not in the DOM", () => {
    addAssetToTimeline(IDS.vid, { start: 0 });
    addAssetToTimeline(IDS.vid2, { start: 5000 });
    setup();
    expect(screen.getByRole("button", { name: "vid.mp4 clip" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "vid2.mp4 clip" })).not.toBeInTheDocument();
  });

  it("playhead follows the store and the ruler scrubs it", () => {
    setup();
    act(() => usePlaybackStore.getState().setPlayhead(2));
    expect(screen.getByTestId("playhead")).toHaveStyle({ left: "100px" });
    fireEvent.pointerDown(screen.getByTestId("ruler"), { button: 0, clientX: 300 }); // 6s
    fireEvent.pointerUp(window);
    expect(usePlaybackStore.getState().playhead).toBeCloseTo(6);
  });
});

describe("keyboard shortcuts", () => {
  function setupApp() {
    addAssetToTimeline(IDS.vid, { start: 0 });
    usePlaybackStore.getState().setPlayhead(4);
    return render(<App />);
  }

  it("S splits, Delete removes, Ctrl+Z / Ctrl+Shift+Z undo and redo", () => {
    setupApp();
    fireEvent.keyDown(window, { key: "s" });
    expect(clips()).toHaveLength(2);
    fireEvent.keyDown(window, { key: "Delete" });
    expect(clips()).toHaveLength(1); // selection after add is the original clip id
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(clips()).toHaveLength(2);
    fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
    expect(clips()).toHaveLength(1);
  });

  it("arrow keys and Home move the playhead; typing in an input is ignored", () => {
    setupApp();
    fireEvent.keyDown(window, { key: "ArrowRight", shiftKey: true });
    expect(usePlaybackStore.getState().playhead).toBeCloseTo(5);
    fireEvent.keyDown(window, { key: "Home" });
    expect(usePlaybackStore.getState().playhead).toBe(0);

    const input = screen.getByRole("searchbox", { name: "Search media" });
    fireEvent.keyDown(input, { key: "s" });
    expect(clips()).toHaveLength(1);
  });
});

describe("track controls and semantics", () => {
  it("mute and hide are undoable toggles that reflect state", async () => {
    setup();
    const mute = screen.getByRole("button", { name: "Mute Video 1" });
    expect(mute).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(mute);
    expect(state().project.tracks[0].muted).toBe(true);
    expect(screen.getByRole("button", { name: "Unmute Video 1" })).toHaveAttribute("aria-pressed", "true");
    expect(state().past.at(-1)?.label).toBe("Mute track");

    await userEvent.click(screen.getByRole("button", { name: "Hide Video 2" }));
    expect(state().project.tracks[1].hidden).toBe(true);
    // audio tracks have no picture to hide
    expect(screen.queryByRole("button", { name: /Hide Audio 1/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mute Audio 1" })).toBeInTheDocument();
  });

  it("shows a hint on an empty timeline and removes it once something is placed", () => {
    const { unmount } = setup();
    expect(screen.getByText(/Drag media from the library onto a track/)).toBeInTheDocument();
    unmount();
    addAssetToTimeline(IDS.vid);
    setup();
    expect(screen.queryByText(/Drag media from the library onto a track/)).not.toBeInTheDocument();
  });

  it("the ruler is a keyboard-operable slider for the playhead", () => {
    addAssetToTimeline(IDS.vid);
    setup();
    const slider = screen.getByRole("slider", { name: "Playhead position" });
    expect(slider).toHaveAttribute("aria-valuemax", "10");
    fireEvent.keyDown(slider, { key: "ArrowRight", shiftKey: true });
    expect(usePlaybackStore.getState().playhead).toBeCloseTo(1);
    expect(slider).toHaveAttribute("aria-valuenow", "1");
    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    expect(usePlaybackStore.getState().playhead).toBeCloseTo(1 - 1 / 30);
  });
});
