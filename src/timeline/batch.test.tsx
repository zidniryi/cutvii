/** Drag from media cards, zoom controls, shortcuts and save behaviour, through the real UI. */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import App from "@/App";
import { saveFlow } from "@/project/fileActions";
import { useDragDropStore } from "@/store/dragDrop";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useTimelineViewStore } from "@/store/timelineView";
import { useUiStore } from "@/store/ui";
import { IDS, makeProject } from "@/test/makeProject";
import { addClip } from "@/timeline/edit";
import { addAssetToTimeline } from "@/timeline/editor";
import { edgeScrollDelta, EDGE_PX, MAX_SCROLL_PER_FRAME } from "@/timeline/dropTargeting";
import { DEFAULT_PPS, ROW_HEIGHT } from "@/timeline/geometry";
import { newDropPlacement, planPlacement } from "@/timeline/placement";

const state = () => useProjectStore.getState();
const view = () => useTimelineViewStore.getState();
const LANES = { left: 112, top: 528 };
const AREA = { left: 0, top: 500, right: 1200, bottom: 800 };
const SCROLLER = { left: 112, top: 500, right: 1200, bottom: 800 };
const rect = (b: Partial<DOMRect>) =>
  ({
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
    ...b,
  }) as DOMRect;
let restore: () => void;
const handlers = new Map<string, (e: { payload: unknown }) => void>();

beforeEach(() => {
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this.hasAttribute("data-timeline-area")) return rect(AREA);
    if (this.hasAttribute("data-timeline-lanes")) return rect(LANES);
    if (this.hasAttribute("data-timeline-scroller")) return rect(SCROLLER);
    return original.call(this);
  };
  restore = () => (Element.prototype.getBoundingClientRect = original);
  handlers.clear();
  vi.mocked(listen).mockImplementation((async (name: string, cb: (e: { payload: unknown }) => void) => {
    handlers.set(name, cb);
    return () => handlers.delete(name);
  }) as unknown as typeof listen);
  vi.mocked(invoke).mockReset();

  useProjectStore.getState().newProject();
  useProjectStore.setState({ project: makeProject() });
  useProjectStore.setState({ saved: state().project });
  useSelectionStore.setState({ selectedClipIds: [] });
  usePlaybackStore.setState({ playhead: 0, playing: false, mediaErrors: {} });
  useTimelineViewStore.setState({ pps: DEFAULT_PPS, snapping: true, scrollTarget: null });
  useDragDropStore.getState().clear();
  useUiStore.setState({ notice: null, dialog: null, saving: false, sidePanel: "library" });
});
afterEach(() => restore());

const lane = (i: number) => LANES.top + ROW_HEIGHT * i + 10;
const xAt = (seconds: number) => LANES.left + seconds * DEFAULT_PPS;
const card = (name: string) => screen.getByText(name).closest("[data-testid=media-card]") as HTMLElement;
const clips = () => state().project.tracks.flatMap((t) => t.clips);

describe("placement rules", () => {
  const p = makeProject();
  const video = { type: "video" as const, duration: 4 };
  const audio = { type: "audio" as const, duration: 9 };

  it("uses the lane under the pointer when it accepts the media", () => {
    const plan = planPlacement(p, newDropPlacement({ kind: "track", trackId: IDS.v2, time: 3 }), video);
    expect(plan).toMatchObject({
      trackId: IDS.v2,
      trackType: "video",
      start: 3,
      duration: 4,
      adapted: false,
    });
    expect(plan.hint).toBeUndefined();
  });

  it("adapts a wrong lane to the right kind of track, with a hint", () => {
    const a = planPlacement(p, newDropPlacement({ kind: "track", trackId: IDS.v1, time: 1 }), audio);
    expect(a).toMatchObject({
      trackId: IDS.a1,
      trackType: "audio",
      adapted: true,
      hint: "Audio goes on an audio track",
    });
    const v = planPlacement(p, newDropPlacement({ kind: "track", trackId: IDS.a1, time: 1 }), video);
    expect(v).toMatchObject({ trackId: IDS.v1, adapted: true, hint: "Video and images go on a video track" });
  });

  it("empty space means a new track; images default to 5 s", () => {
    const plan = planPlacement(p, newDropPlacement({ kind: "new-track", time: 2 }), { type: "image" });
    expect(plan).toMatchObject({ trackId: null, trackType: "video", start: 2, duration: 5 });
  });

  it("slides past occupied time and lines several files up one after another", () => {
    const r = addClip(p, { assetId: IDS.vid, trackId: IDS.v1, start: 0, id: "c" }); // 0..10
    if (!r.ok) throw new Error("setup");
    const placement = newDropPlacement({ kind: "track", trackId: IDS.v1, time: 4 });
    const first = planPlacement(r.project, placement, video);
    expect(first.start).toBe(10);
    placement.cursor.video = first.start + first.duration;
    expect(planPlacement(r.project, placement, video).start).toBe(14);
  });

  it("reuses the track a drop just created for the next file of the same kind", () => {
    const placement = newDropPlacement({ kind: "new-track", time: 0 });
    placement.created.video = IDS.v2;
    expect(planPlacement(p, placement, video).trackId).toBe(IDS.v2);
    expect(planPlacement(p, placement, audio).trackId).toBeNull(); // audio still needs its own
  });
});

describe("edge auto-scroll", () => {
  it("scrolls only near the edges, faster the closer the pointer is", () => {
    expect(edgeScrollDelta(600, 100, 1100)).toBe(0);
    expect(edgeScrollDelta(100 + EDGE_PX - 1, 100, 1100)).toBeLessThan(0);
    expect(edgeScrollDelta(1100 - EDGE_PX + 1, 100, 1100)).toBeGreaterThan(0);
    expect(edgeScrollDelta(100, 100, 1100)).toBe(-MAX_SCROLL_PER_FRAME);
    expect(edgeScrollDelta(1100, 100, 1100)).toBe(MAX_SCROLL_PER_FRAME);
    expect(Math.abs(edgeScrollDelta(110, 100, 1100))).toBeGreaterThan(
      Math.abs(edgeScrollDelta(140, 100, 1100)),
    );
    expect(edgeScrollDelta(50, 0, 60)).toBe(0); // too narrow to have edges
  });
});

describe("dragging a media card to the timeline (pointer events)", () => {
  it("shows a ghost at the snapped time and lane, then places the clip on release", async () => {
    render(<App />);
    fireEvent.pointerDown(card("vid2.mp4"), { button: 0, clientX: 40, clientY: 200 });
    fireEvent.pointerMove(window, { clientX: 60, clientY: 220 });
    expect(screen.getByTestId("drag-chip")).toHaveTextContent("vid2.mp4");
    expect(screen.queryByTestId("drop-ghost")).not.toBeInTheDocument(); // not over the timeline yet

    fireEvent.pointerMove(window, { clientX: xAt(3.01), clientY: lane(1) });
    const ghost = screen.getByTestId("drop-ghost");
    expect(ghost).toHaveStyle({ left: "150px", width: "200px" }); // 3 s (frame-snapped), 4 s long
    expect(screen.getByRole("group", { name: "Video 2 lane" })).toHaveAttribute("data-drop-active", "true");
    expect(clips()).toHaveLength(0); // nothing committed while dragging

    fireEvent.pointerUp(window, { clientX: xAt(3.01), clientY: lane(1) });
    expect(clips()).toHaveLength(1);
    expect(state().project.tracks[1].clips[0]).toMatchObject({ assetId: IDS.vid2, timelineStart: 3 });
    expect(screen.queryByTestId("drop-ghost")).not.toBeInTheDocument();
    expect(screen.queryByTestId("drag-chip")).not.toBeInTheDocument();
  });

  it("adapts a wrong lane and tells the user; empty space previews and creates a new track", async () => {
    render(<App />);
    fireEvent.pointerDown(card("aud.mp3"), { button: 0, clientX: 40, clientY: 200 });
    fireEvent.pointerMove(window, { clientX: xAt(1), clientY: lane(0) }); // a video lane
    expect(screen.getByTestId("drop-ghost")).toHaveTextContent("Audio goes on an audio track");
    expect(screen.getByRole("group", { name: "Audio 1 lane" })).toHaveAttribute("data-drop-active", "true");
    fireEvent.pointerUp(window, { clientX: xAt(1), clientY: lane(0) });
    expect(state().project.tracks[2].clips).toHaveLength(1);
    expect(useUiStore.getState().notice).toBe("Audio goes on an audio track");

    fireEvent.pointerDown(card("vid.mp4"), { button: 0, clientX: 40, clientY: 200 });
    fireEvent.pointerMove(window, { clientX: xAt(0), clientY: lane(3) + 20 }); // below the three lanes
    expect(screen.getByTestId("new-track-row")).toHaveTextContent("New video track");
    fireEvent.pointerUp(window, { clientX: xAt(0), clientY: lane(3) + 20 });
    expect(state().project.tracks).toHaveLength(4);
    expect(state().project.tracks[3].clips).toHaveLength(1);
  });

  it("a click (no movement), Escape, or a drop outside the timeline places nothing", async () => {
    render(<App />);
    fireEvent.pointerDown(card("vid.mp4"), { button: 0, clientX: 40, clientY: 200 });
    fireEvent.pointerUp(window, { clientX: 40, clientY: 200 });

    fireEvent.pointerDown(card("vid.mp4"), { button: 0, clientX: 40, clientY: 200 });
    fireEvent.pointerMove(window, { clientX: xAt(2), clientY: lane(0) });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(window, { clientX: xAt(2), clientY: lane(0) });

    fireEvent.pointerDown(card("vid.mp4"), { button: 0, clientX: 40, clientY: 200 });
    fireEvent.pointerMove(window, { clientX: 300, clientY: 100 });
    fireEvent.pointerUp(window, { clientX: 300, clientY: 100 });
    expect(clips()).toHaveLength(0);
    expect(useDragDropStore.getState().dragging).toBeNull();
  });

  it("the card's own buttons still work and do not start a drag", async () => {
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Add vid.mp4 to timeline" }));
    expect(clips()).toHaveLength(1);
    expect(useDragDropStore.getState().dragging).toBeNull();
  });

  it("OS files hovering the timeline show a ghost on the lane under the pointer", async () => {
    render(<App />);
    await waitFor(() => expect(handlers.has("file-drop-over")).toBe(true));
    act(() => handlers.get("file-drop-over")!({ payload: { x: xAt(2), y: lane(0) } }));
    expect(screen.getByTestId("drop-ghost")).toHaveTextContent("Drop to add");
    expect(screen.queryByTestId("drop-overlay")).not.toBeInTheDocument(); // library overlay is for import-only drops
    act(() => handlers.get("file-drop-hover")!({ payload: { active: false } }));
    expect(screen.queryByTestId("drop-ghost")).not.toBeInTheDocument();
  });
});

describe("timeline zoom", () => {
  it("Ctrl/Cmd + = / - / 0 zoom the timeline, never the page, and show the level", () => {
    act(() => void addAssetToTimeline(IDS.vid)); // 10 s
    render(<App />);
    expect(screen.getByLabelText("Zoom level")).toHaveTextContent("100%");

    const plus = new KeyboardEvent("keydown", { key: "=", metaKey: true, cancelable: true, bubbles: true });
    act(() => void window.dispatchEvent(plus));
    expect(plus.defaultPrevented).toBe(true);
    expect(view().pps).toBeCloseTo(DEFAULT_PPS * 1.25);
    expect(screen.getByLabelText("Zoom level")).toHaveTextContent("125%");

    fireEvent.keyDown(window, { key: "-", ctrlKey: true });
    expect(view().pps).toBeCloseTo(DEFAULT_PPS);

    const zero = new KeyboardEvent("keydown", { key: "0", ctrlKey: true, cancelable: true, bubbles: true });
    act(() => void window.dispatchEvent(zero));
    expect(zero.defaultPrevented).toBe(true);
    expect(view().pps).toBeCloseTo(1000 / (10 + 10)); // jsdom viewport fallback 1000 px, 10 s + tail
    expect(view().scrollTarget?.left).toBe(0);
  });

  it("keyboard zoom is anchored at the playhead", () => {
    act(() => void addAssetToTimeline(IDS.vid));
    usePlaybackStore.setState({ playhead: 4 }); // x = 200 at 50 pps
    render(<App />);
    fireEvent.keyDown(window, { key: "+", ctrlKey: true, shiftKey: true });
    // the playhead (time 4) must still be 200 px from the left edge: 4 * 62.5 - 200 = 50
    expect(view().scrollTarget?.left).toBeCloseTo(50);
  });

  it("Ctrl/Cmd + wheel zooms at the cursor and is always prevented; plain wheel is left alone", () => {
    render(<App />);
    const scroller = document.querySelector("[data-timeline-scroller]")!;

    const zoomIn = new WheelEvent("wheel", {
      deltaY: -40,
      ctrlKey: true,
      clientX: SCROLLER.left + 300,
      cancelable: true,
      bubbles: true,
    });
    act(() => void scroller.dispatchEvent(zoomIn));
    expect(zoomIn.defaultPrevented).toBe(true);
    const zoomed = view().pps;
    expect(zoomed).toBeGreaterThan(DEFAULT_PPS);
    // time under the cursor (300 px -> 6 s) stays under the cursor
    expect((view().scrollTarget!.left + 300) / zoomed).toBeCloseTo(6, 5);

    const plain = new WheelEvent("wheel", { deltaY: -40, cancelable: true, bubbles: true });
    act(() => void scroller.dispatchEvent(plain));
    expect(plain.defaultPrevented).toBe(false);
    expect(view().pps).toBe(zoomed);

    // over the rest of the app: still no page zoom, and the timeline does not change
    const elsewhere = new WheelEvent("wheel", {
      deltaY: -40,
      metaKey: true,
      cancelable: true,
      bubbles: true,
    });
    act(() => void document.body.dispatchEvent(elsewhere));
    expect(elsewhere.defaultPrevented).toBe(true);
    expect(view().pps).toBe(zoomed);
  });

  it("trackpad pinch (WebKit gesture events) zooms and is prevented", () => {
    render(<App />);
    const scroller = document.querySelector("[data-timeline-scroller]")!;
    const gesture = (type: string, scale: number) => {
      const e = new Event(type, { cancelable: true, bubbles: true });
      Object.assign(e, { scale, clientX: SCROLLER.left + 100 });
      act(() => void scroller.dispatchEvent(e));
      return e;
    };
    expect(gesture("gesturestart", 1).defaultPrevented).toBe(true);
    expect(gesture("gesturechange", 1.5).defaultPrevented).toBe(true);
    expect(view().pps).toBeCloseTo(DEFAULT_PPS * 1.5);
    gesture("gesturechange", 3); // cumulative scale: another 2x
    expect(view().pps).toBeCloseTo(DEFAULT_PPS * 3);
  });

  it("buttons disable at the limits and zoom is not saved in the project", async () => {
    render(<App />);
    for (let i = 0; i < 20; i++) fireEvent.keyDown(window, { key: "=", ctrlKey: true });
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Zoom out" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Fit project" }));
    expect(JSON.stringify(state().project)).not.toMatch(/pps|zoom/i);
    expect(state().project).toBe(state().saved); // zooming never makes the project dirty
  });
});

describe("shortcuts and saving", () => {
  it("Ctrl/Cmd+S saves once, is prevented, and the status shows Saving… then Saved", async () => {
    let finish!: (p: string) => void;
    vi.mocked(invoke).mockImplementation((async (cmd: string) =>
      cmd === "save_project" ? new Promise<string>((r) => (finish = r)) : undefined) as typeof invoke);
    render(<App />);
    act(() => void addAssetToTimeline(IDS.vid));

    const e = new KeyboardEvent("keydown", { key: "s", metaKey: true, cancelable: true, bubbles: true });
    act(() => void window.dispatchEvent(e));
    expect(e.defaultPrevented).toBe(true);
    expect(await screen.findByText("Saving…")).toBeInTheDocument();

    // the same key press arriving again (webview + native menu) must not start a second save
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await act(async () => handlers.get("menu-action")?.({ payload: "save-project" }));
    expect(vi.mocked(invoke).mock.calls.filter((c) => c[0] === "save_project")).toHaveLength(1);

    await act(async () => finish("/p/once.cutvii"));
    expect(await screen.findByText("Saved · once.cutvii")).toBeInTheDocument();
    expect(useUiStore.getState().saving).toBe(false);
  });

  it("a failed save releases the lock so the next save can run", async () => {
    vi.mocked(invoke).mockImplementation((async (cmd: string) => {
      if (cmd === "save_project") throw "disk full";
    }) as typeof invoke);
    const first = saveFlow(false);
    await waitFor(() => expect(useUiStore.getState().dialog?.title).toBe("Could not save the project"));
    expect(useUiStore.getState().saving).toBe(false); // not stuck on "Saving…" while the dialog is open
    act(() => useUiStore.getState().closeDialog(true));
    expect(await first).toBe(false);

    vi.mocked(invoke).mockImplementation((async (cmd: string) =>
      cmd === "save_project" ? "/p/ok.cutvii" : undefined) as typeof invoke);
    expect(await saveFlow(false)).toBe(true);
  });

  it("Cmd+S still saves while typing, but editing keys are left to the field", async () => {
    vi.mocked(invoke).mockImplementation((async (cmd: string) =>
      cmd === "save_project" ? "/p/t.cutvii" : undefined) as typeof invoke);
    render(<App />);
    act(() => void addAssetToTimeline(IDS.vid));
    usePlaybackStore.setState({ playhead: 4 });
    const search = screen.getByRole("searchbox", { name: "Search media" });
    search.focus();

    fireEvent.keyDown(search, { key: "s" });
    fireEvent.keyDown(search, { key: "Backspace" });
    fireEvent.keyDown(search, { key: " " });
    expect(clips()).toHaveLength(1);
    expect(usePlaybackStore.getState().playing).toBe(false);

    fireEvent.keyDown(search, { key: "s", metaKey: true });
    expect(await screen.findByText("Saved · t.cutvii")).toBeInTheDocument();
  });

  it("buttons advertise their shortcut", () => {
    render(<App />);
    expect(screen.getByRole("button", { name: "Undo" })).toHaveAttribute("aria-keyshortcuts", "Ctrl/⌘ Z");
    expect(screen.getByRole("button", { name: "Zoom in" })).toHaveAttribute("aria-keyshortcuts", "Ctrl/⌘ +");
    expect(screen.getByRole("button", { name: "Fit project" })).toHaveAttribute(
      "aria-keyshortcuts",
      "Ctrl/⌘ 0",
    );
    expect(screen.getByRole("button", { name: /Split at playhead \(S\)/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Play \(Space\)/ })).toBeInTheDocument();
  });
});
