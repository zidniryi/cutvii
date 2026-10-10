import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import App from "@/App";
import { parseProject } from "@/project/parse";
import { useImportsStore } from "@/store/imports";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useTimelineViewStore } from "@/store/timelineView";
import { useUiStore } from "@/store/ui";
import { ROW_HEIGHT } from "@/timeline/geometry";

const handlers = new Map<string, (e: { payload: unknown }) => void>();
const state = () => useProjectStore.getState();
const LANES = { left: 112, top: 528 };
const AREA = { left: 0, top: 500, right: 1200, bottom: 800 };
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

const media = (name: string, extra: Record<string, unknown> = {}) => ({
  path: `/drop/${name}`,
  mediaType: "video",
  duration: 4,
  width: 1280,
  height: 720,
  fpsNum: 30,
  fpsDen: 1,
  ...extra,
});
let results: Record<number, unknown>;

beforeEach(() => {
  handlers.clear();
  vi.mocked(listen).mockImplementation((async (name: string, cb: (e: { payload: unknown }) => void) => {
    handlers.set(name, cb);
    return () => handlers.delete(name);
  }) as unknown as typeof listen);
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation((async (cmd: string, args?: { id: number }) =>
    cmd === "import_dropped_file" ? results[args!.id] : undefined) as typeof invoke);

  // jsdom has no layout: give the timeline a position on screen
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this.hasAttribute("data-timeline-area")) return rect(AREA);
    if (this.hasAttribute("data-timeline-lanes")) return rect(LANES);
    return original.call(this);
  };
  restore = () => (Element.prototype.getBoundingClientRect = original);

  useProjectStore.getState().newProject();
  useImportsStore.setState({ jobs: [], hovering: false });
  useSelectionStore.setState({ selectedClipIds: [] });
  usePlaybackStore.setState({ playhead: 0, playing: false, mediaErrors: {} });
  useTimelineViewStore.setState({ pps: 50, snapping: true });
  useUiStore.setState({ canvasNotice: null, sidePanel: "library", dialog: null, notice: null });
});
afterEach(() => restore());

async function dropAt(x: number, y: number, files: { id: number; name: string }[]) {
  await waitFor(() => expect(handlers.has("files-dropped")).toBe(true));
  await act(async () => {
    handlers.get("files-dropped")!({ payload: { files, x, y } });
    await new Promise((r) => setTimeout(r, 0));
  });
}
const lane = (i: number) => LANES.top + ROW_HEIGHT * i + 10;
const xAt = (seconds: number) => LANES.left + seconds * 50;

describe("OS drop onto the timeline", () => {
  it("imports the file and places a clip on the lane and time under the pointer", async () => {
    results = { 1: media("a.mp4") };
    render(<App />);
    await dropAt(xAt(3), lane(0), [{ id: 1, name: "a.mp4" }]);

    await waitFor(() => expect(state().project.tracks[0].clips).toHaveLength(1));
    expect(state().project.assets.map((a) => a.path)).toEqual(["/drop/a.mp4"]);
    expect(state().project.tracks[0].clips[0]).toMatchObject({ timelineStart: 3, sourceOut: 4 });
    expect(parseProject(state().project).ok).toBe(true);
  });

  it("snaps to the playhead and lines several files up one after another", async () => {
    usePlaybackStore.setState({ playhead: 2 });
    results = { 1: media("a.mp4"), 2: media("b.mp4", { duration: 6 }) };
    render(<App />);
    await dropAt(xAt(2.1), lane(0), [
      { id: 1, name: "a.mp4" },
      { id: 2, name: "b.mp4" },
    ]);

    await waitFor(() => expect(state().project.tracks[0].clips).toHaveLength(2));
    expect(state().project.tracks[0].clips.map((c) => c.timelineStart)).toEqual([2, 6]); // 2.1 snapped to 2; b after a
  });

  it("puts audio on an audio lane even when dropped on a video lane, and images at 5 s", async () => {
    results = {
      1: { path: "/drop/song.mp3", mediaType: "audio", duration: 9 },
      2: { path: "/drop/pic.png", mediaType: "image", width: 800, height: 600 },
    };
    render(<App />);
    await dropAt(xAt(1), lane(0), [
      { id: 1, name: "song.mp3" },
      { id: 2, name: "pic.png" },
    ]);

    await waitFor(() => expect(state().project.tracks.flatMap((t) => t.clips)).toHaveLength(2));
    const [video, audio] = state().project.tracks;
    expect(audio.clips[0]).toMatchObject({ timelineStart: 1, sourceOut: 9 });
    expect(video.clips[0]).toMatchObject({ timelineStart: 1, sourceIn: 0, sourceOut: 5 });
  });

  it("empty space below the lanes creates a new track, undone together with the clip", async () => {
    results = { 1: media("a.mp4") };
    render(<App />);
    await dropAt(xAt(0), lane(2) + 20, [{ id: 1, name: "a.mp4" }]);

    await waitFor(() => expect(state().project.tracks).toHaveLength(3));
    const added = state().project.tracks[2];
    expect(added).toMatchObject({ type: "video", name: "Video 2" });
    expect(added.clips).toHaveLength(1);
    expect(screen.getByRole("group", { name: "Video 2 lane" })).toBeInTheDocument();

    act(() => state().undo());
    expect(state().project.tracks).toHaveLength(2);
    expect(state().project.assets).toHaveLength(1); // the import is its own step
  });

  it("never overlaps: a drop onto an occupied spot slides to the next free one", async () => {
    results = { 1: media("a.mp4"), 2: media("b.mp4") };
    render(<App />);
    await dropAt(xAt(0), lane(0), [{ id: 1, name: "a.mp4" }]); // 0..4
    await waitFor(() => expect(state().project.tracks[0].clips).toHaveLength(1));
    await dropAt(xAt(2), lane(0), [{ id: 2, name: "b.mp4" }]); // wants 2, taken

    await waitFor(() => expect(state().project.tracks[0].clips).toHaveLength(2));
    expect(state().project.tracks[0].clips[1].timelineStart).toBe(4);
  });

  it("a file already in the library still becomes a clip; a drop elsewhere only imports", async () => {
    results = { 1: media("a.mp4"), 2: media("a.mp4"), 3: media("c.mp4") };
    render(<App />);
    await dropAt(10, 10, [{ id: 1, name: "a.mp4" }]); // over the library
    await waitFor(() => expect(state().project.assets).toHaveLength(1));
    expect(state().project.tracks.flatMap((t) => t.clips)).toHaveLength(0);

    await dropAt(xAt(1), lane(0), [{ id: 2, name: "a.mp4" }]);
    await waitFor(() => expect(state().project.tracks[0].clips).toHaveLength(1));
    expect(state().project.assets).toHaveLength(1);
    expect(screen.queryByTestId("import-placeholder")).not.toBeInTheDocument();
  });
});

describe("image clips", () => {
  it("fit / fill / blur are set in the inspector, shown in the preview, and undoable", async () => {
    results = { 1: { path: "/drop/pic.png", mediaType: "image", width: 800, height: 600 } };
    render(<App />);
    await dropAt(xAt(0), lane(0), [{ id: 1, name: "pic.png" }]);
    await waitFor(() => expect(state().project.tracks[0].clips).toHaveLength(1));

    const layer = () => screen.getByTestId("image-layer");
    const chips = () =>
      within(
        within(screen.getByRole("region", { name: "Inspector" })).getByRole("radiogroup", {
          name: "Fit to canvas",
        }),
      );
    expect(layer().dataset.fit).toBe("fill"); // the default: never shown at native size
    expect(layer().querySelectorAll("img")).toHaveLength(1);

    await userEvent.click(screen.getByRole("tab", { name: "Inspector" }));
    expect(chips().getByRole("radio", { name: "Fill" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(chips().getByRole("radio", { name: "Fit" }));
    expect(state().project.tracks[0].clips[0].fitMode).toBe("fit");
    expect(layer().dataset.fit).toBe("fit");

    await userEvent.click(chips().getByRole("radio", { name: "Blur" }));
    const imgs = layer().querySelectorAll("img");
    expect(imgs).toHaveLength(2); // blurred copy behind, sharp picture in front
    expect(imgs[0].style.filter).toContain("blur");
    expect(parseProject(state().project).ok).toBe(true);

    act(() => state().undo());
    expect(state().project.tracks[0].clips[0].fitMode).toBe("fit");
    expect(state().past.at(-1)?.label).toBe("Change fit to canvas");
  });
});
