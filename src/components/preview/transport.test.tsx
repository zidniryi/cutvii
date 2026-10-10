import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "@/App";
import { defaultOptions } from "@/export/options";
import { createFrameThrottle, startClock } from "@/playback/controller";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useUiStore } from "@/store/ui";
import { IDS, makeProject } from "@/test/makeProject";
import { addClip } from "@/timeline/edit";
import { timeAtPointer } from "./SeekBar";

const pb = () => usePlaybackStore.getState();
const BAR = { left: 100, width: 800 };
let restore: () => void;

/** makeProject with vid (10 s) on v1 at 0. */
function project() {
  const r = addClip(makeProject(), { assetId: IDS.vid, trackId: IDS.v1, start: 0, id: "c" });
  if (!r.ok) throw new Error("setup");
  return r.project;
}

beforeEach(() => {
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this.getAttribute("aria-label") === "Seek") {
      return {
        left: BAR.left,
        width: BAR.width,
        top: 0,
        bottom: 44,
        right: BAR.left + BAR.width,
        height: 44,
        x: BAR.left,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect;
    }
    return original.call(this);
  };
  restore = () => (Element.prototype.getBoundingClientRect = original);
  useProjectStore.setState({ project: project(), past: [], future: [] });
  useSelectionStore.setState({ selectedClipIds: [] });
  usePlaybackStore.setState({
    playhead: 0,
    playing: false,
    mediaErrors: {},
    volume: 1,
    muted: false,
    loop: false,
    previewSpeed: 1,
  });
  useUiStore.setState({ dialog: null, notice: null, sidePanel: "library" });
});
afterEach(() => {
  restore();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const xAt = (seconds: number) => BAR.left + (seconds / 10) * BAR.width;

describe("seek math and throttling", () => {
  it("maps a pointer to a time and clamps to the bar", () => {
    expect(timeAtPointer(500, 100, 800, 10)).toBe(5);
    expect(timeAtPointer(0, 100, 800, 10)).toBe(0);
    expect(timeAtPointer(5000, 100, 800, 10)).toBe(10);
    expect(timeAtPointer(500, 100, 0, 10)).toBe(0);
    expect(timeAtPointer(500, 100, 800, 0)).toBe(0);
  });

  it("applies only the latest request, once per animation frame", () => {
    vi.useFakeTimers();
    const applied: number[] = [];
    const t = createFrameThrottle<number>((v) => applied.push(v));
    for (const v of [1, 2, 3, 4]) t.request(v);
    expect(applied).toEqual([]); // nothing until the frame
    vi.advanceTimersByTime(20);
    expect(applied).toEqual([4]);

    t.request(5);
    t.request(6);
    t.flush(); // pointer released: apply now
    expect(applied).toEqual([4, 6]);
    vi.advanceTimersByTime(40);
    expect(applied).toEqual([4, 6]); // and not again

    t.request(7);
    t.cancel();
    vi.advanceTimersByTime(40);
    expect(applied).toEqual([4, 6]);
  });
});

describe("seek bar", () => {
  it("click jumps; the timeline playhead and the timecode show the same position", () => {
    render(<App />);
    const bar = screen.getByRole("slider", { name: "Seek" });
    expect(bar).toHaveAttribute("aria-valuemax", "10");

    fireEvent.pointerDown(bar, { button: 0, clientX: xAt(4) });
    fireEvent.pointerUp(window);
    expect(pb().playhead).toBeCloseTo(4);
    expect(bar).toHaveAttribute("aria-valuenow", "4");
    expect(screen.getByLabelText("Timecode")).toHaveTextContent("00:00:04:00 / 00:00:10:00");
    expect(screen.getByTestId("playhead")).toHaveStyle({ left: "200px" }); // timeline: 4 s at 50 px/s
    expect(screen.getByTestId("seek-fill")).toHaveStyle({ width: "40%" });

    // and the other way round: moving the playhead elsewhere moves the bar
    act(() => pb().setPlayhead(7.5));
    expect(bar).toHaveAttribute("aria-valuenow", "7.5");
    expect(screen.getByTestId("seek-fill")).toHaveStyle({ width: "75%" });
  });

  it("drag scrubs with a time bubble, one seek per frame, and ends exactly at the release point", () => {
    vi.useFakeTimers();
    render(<App />);
    const bar = screen.getByRole("slider", { name: "Seek" });
    const seeks: number[] = [];
    const off = usePlaybackStore.subscribe(
      (s, prev) => s.playhead !== prev.playhead && seeks.push(s.playhead),
    );

    fireEvent.pointerDown(bar, { button: 0, clientX: xAt(1) });
    expect(screen.getByTestId("seek-bubble")).toHaveTextContent("00:00:01:00");
    for (const s of [2, 3, 4, 5, 6]) fireEvent.pointerMove(window, { clientX: xAt(s) });
    expect(screen.getByTestId("seek-bubble")).toHaveTextContent("00:00:06:00"); // the bubble follows the pointer at once
    expect(seeks).toEqual([1]); // five moves, no seek yet: they are coalesced

    act(() => void vi.advanceTimersByTime(20));
    expect(seeks).toEqual([1, 6]); // one seek for the whole burst

    fireEvent.pointerMove(window, { clientX: xAt(8.5) });
    fireEvent.pointerUp(window);
    expect(pb().playhead).toBeCloseTo(8.5); // release applies the pending position immediately
    expect(screen.queryByTestId("seek-bubble")).not.toBeInTheDocument();
    off();
  });

  it("clamps beyond the ends and works from the keyboard", () => {
    render(<App />);
    const bar = screen.getByRole("slider", { name: "Seek" });
    fireEvent.pointerDown(bar, { button: 0, clientX: 5000 });
    fireEvent.pointerUp(window);
    expect(pb().playhead).toBe(10);

    fireEvent.keyDown(bar, { key: "Home" });
    expect(pb().playhead).toBe(0);
    fireEvent.keyDown(bar, { key: "ArrowRight" });
    expect(pb().playhead).toBeCloseTo(1 / 30); // exactly one frame, not two (no double handling)
    fireEvent.keyDown(bar, { key: "ArrowRight", shiftKey: true });
    expect(pb().playhead).toBeCloseTo(1 + 1 / 30);
    fireEvent.keyDown(bar, { key: "End" });
    expect(pb().playhead).toBe(10);
  });

  it("is inert on an empty timeline", () => {
    useProjectStore.setState({ project: makeProject() });
    render(<App />);
    const bar = screen.getByRole("slider", { name: "Seek" });
    expect(bar).toHaveAttribute("aria-disabled", "true");
    fireEvent.pointerDown(bar, { button: 0, clientX: xAt(4) });
    expect(pb().playhead).toBe(0);
    expect(screen.getByRole("button", { name: "Next frame" })).toBeDisabled();
  });
});

describe("transport buttons and keys", () => {
  it("start, end, previous and next frame", async () => {
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Go to end" }));
    expect(pb().playhead).toBe(10);
    await userEvent.click(screen.getByRole("button", { name: "Previous frame" }));
    expect(pb().playhead).toBeCloseTo(10 - 1 / 30);
    await userEvent.click(screen.getByRole("button", { name: "Next frame" }));
    await userEvent.click(screen.getByRole("button", { name: "Next frame" })); // already at the end: stays
    expect(pb().playhead).toBe(10);
    await userEvent.click(screen.getByRole("button", { name: "Go to start" }));
    expect(pb().playhead).toBe(0);
    expect(screen.getByRole("button", { name: "Previous frame" })).toHaveAttribute("aria-keyshortcuts", ",");
  });

  it("the , and . keys step one frame and snap to the frame grid; End goes to the end", () => {
    render(<App />);
    act(() => pb().setPlayhead(2.01)); // between frames 60 and 61
    fireEvent.keyDown(document.body, { key: "." });
    expect(pb().playhead).toBeCloseTo(61 / 30);
    fireEvent.keyDown(document.body, { key: "," });
    fireEvent.keyDown(document.body, { key: "," });
    expect(pb().playhead).toBeCloseTo(59 / 30);
    fireEvent.keyDown(document.body, { key: "End" });
    expect(pb().playhead).toBe(10);
    // not while typing
    const search = screen.getByRole("searchbox", { name: "Search media" });
    fireEvent.keyDown(search, { key: "," });
    expect(pb().playhead).toBe(10);
  });
});

describe("volume, mute, loop and preview speed (monitor only)", () => {
  it("volume and mute reach the media elements and never the project", async () => {
    render(<App />);
    const before = useProjectStore.getState().project;
    const video = document.querySelector("video")!;
    expect(video.volume).toBe(1);

    fireEvent.change(screen.getByRole("slider", { name: "Preview volume" }), { target: { value: "40" } });
    expect(pb().volume).toBeCloseTo(0.4);
    expect(video.volume).toBeCloseTo(0.4);

    await userEvent.click(screen.getByRole("button", { name: "Mute" }));
    expect(video.muted).toBe(true);
    expect(screen.getByRole("button", { name: "Unmute" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "Unmute" }));
    expect(video.muted).toBe(false);
    expect(video.volume).toBeCloseTo(0.4); // unmuting restores the level

    expect(useProjectStore.getState().project).toBe(before);
    expect(useProjectStore.getState().past).toHaveLength(0);
  });

  it("preview speed changes how fast it plays, but not the project or the export", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<App />);
    const before = useProjectStore.getState().project;

    await user.click(screen.getByRole("button", { name: /Preview speed, 1×/ }));
    const menu = screen.getByRole("menu", { name: "Preview speed" });
    expect(
      within(menu)
        .getAllByRole("menuitemradio")
        .map((i) => i.textContent),
    ).toEqual(["0.5×", "1×normal", "1.5×", "2×"]);
    await user.click(within(menu).getByRole("menuitemradio", { name: "2×" }));
    expect(pb().previewSpeed).toBe(2);
    expect(screen.getByRole("button", { name: /Preview speed, 2×/ })).toBeInTheDocument();
    expect(document.querySelector("video")!.playbackRate).toBe(2);

    // the project, its clips and the export defaults are untouched
    expect(useProjectStore.getState().project).toBe(before);
    expect(before.tracks[0].clips[0].speed).toBeUndefined();
    expect(defaultOptions(before)).toMatchObject({ fps: 30, quality: "standard" });
    expect(JSON.stringify(before)).not.toMatch(/previewSpeed/);
  });

  it("the clock runs at the preview speed and loops when asked", () => {
    vi.useFakeTimers();
    usePlaybackStore.setState({ playing: true, previewSpeed: 2 });
    let stop = startClock();
    vi.advanceTimersByTime(1000);
    expect(pb().playhead).toBeGreaterThan(1.8);
    expect(pb().playhead).toBeLessThan(2.2);
    stop();

    // without loop: stops at the end
    usePlaybackStore.setState({ playhead: 9.9, playing: true, previewSpeed: 1, loop: false });
    stop = startClock();
    vi.advanceTimersByTime(500);
    expect(pb().playing).toBe(false);
    expect(pb().playhead).toBe(10);
    stop();

    // with loop: wraps to the start and keeps playing
    usePlaybackStore.setState({ playhead: 9.9, playing: true, loop: true });
    stop = startClock();
    vi.advanceTimersByTime(600);
    expect(pb().playing).toBe(true);
    expect(pb().playhead).toBeLessThan(1);
    stop();
  });

  it("loop is a toggle", async () => {
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Loop off" }));
    expect(pb().loop).toBe(true);
    expect(screen.getByRole("button", { name: "Loop on" })).toHaveAttribute("aria-pressed", "true");
  });
});

describe("narrow screens", () => {
  it("secondary controls move into a More menu; the essentials stay", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    render(<App />);
    expect(screen.getByRole("button", { name: /Play/ })).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Seek" })).toBeInTheDocument();
    expect(screen.getByLabelText("Timecode")).toBeInTheDocument();
    expect(screen.queryByRole("slider", { name: "Preview volume" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "More playback controls" }));
    const more = screen.getByRole("group", { name: "More playback controls" });
    expect(within(more).getByRole("slider", { name: "Preview volume" })).toBeInTheDocument();
    expect(within(more).getByRole("button", { name: "Loop off" })).toBeInTheDocument();
    expect(within(more).getByRole("button", { name: /Preview speed/ })).toBeInTheDocument();
  });
});
