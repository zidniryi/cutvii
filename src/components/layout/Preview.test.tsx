import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "@/App";
import { createProject } from "@/project/factory";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { IDS, makeProject } from "@/test/makeProject";
import { addClip } from "@/timeline/edit";
import { Preview } from "./Preview";

function load(build: (p: ReturnType<typeof makeProject>) => ReturnType<typeof makeProject>) {
  useProjectStore.setState({ project: build(makeProject()), past: [], future: [] });
}
function place(assetId: string, trackId: string, start: number, id: string, duration?: number) {
  return (p: ReturnType<typeof makeProject>) => {
    const r = addClip(p, { assetId, trackId, start, id, duration });
    if (!r.ok) throw new Error(r.error.message);
    return r.project;
  };
}
const seek = (t: number) => act(() => usePlaybackStore.getState().setPlayhead(t));
const videos = () => Array.from(document.querySelectorAll("video"));
// opacity lives on the layer wrapper (the picture inside it is positioned by the fit rules)
const layerOpacity = (v: HTMLVideoElement) => v.parentElement!.style.opacity;
const visibleVideo = () => videos().find((v) => layerOpacity(v) === "1");

beforeEach(() => {
  useProjectStore.setState({ project: createProject(), past: [], future: [] });
  useSelectionStore.setState({ selectedClipIds: [] });
  usePlaybackStore.setState({ playhead: 0, playing: false, mediaErrors: {} });
});
afterEach(() => vi.useRealTimers());

describe("Preview", () => {
  it("shows an empty state and disables play when the timeline is empty", () => {
    render(<Preview />);
    expect(screen.getByText("Preview is empty")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Play/ })).toBeDisabled();
  });

  it("follows the playhead across consecutive clips", () => {
    load((p) => place(IDS.vid2, IDS.v1, 5, "b", 4)(place(IDS.vid, IDS.v1, 0, "a", 5)(p)));
    render(<Preview />);

    seek(1);
    expect(visibleVideo()?.getAttribute("src")).toBe("asset://localhost/m/vid.mp4");

    seek(6);
    expect(visibleVideo()?.getAttribute("src")).toBe("asset://localhost/m/vid2.mp4");

    seek(20);
    expect(screen.getByText("No clip at playhead")).toBeInTheDocument();
    expect(videos()).toHaveLength(0);
  });

  it("maps the playhead into the source file and preloads the next clip paused", () => {
    load((p) => place(IDS.vid2, IDS.v1, 5, "b", 4)(place(IDS.vid, IDS.v1, 0, "a", 5)(p)));
    render(<Preview />);

    seek(4.5); // 0.5s before the cut: b is mounted but hidden
    expect(videos()).toHaveLength(2);
    const [a, b] = videos();
    expect(a.currentTime).toBeCloseTo(4.5);
    expect(layerOpacity(a)).toBe("1");
    expect(layerOpacity(b)).toBe("0");
    expect(b.currentTime).toBe(0);
  });

  it("shows the highest video track on top", () => {
    load((p) => place(IDS.vid2, IDS.v2, 0, "top", 4)(place(IDS.vid, IDS.v1, 0, "base", 10)(p)));
    render(<Preview />);
    seek(1);
    expect(videos()).toHaveLength(2);
    expect(visibleVideo()?.getAttribute("src")).toContain("vid2.mp4");
  });

  it("reports a clear error when media cannot be loaded, and clears it on load", () => {
    load(place(IDS.vid, IDS.v1, 0, "a", 5));
    render(<Preview />);
    const v = videos()[0];

    Object.defineProperty(v, "error", { configurable: true, value: { code: 4 } });
    fireEvent.error(v);
    expect(screen.getByRole("alert")).toHaveTextContent("vid.mp4 is missing, or its format is not supported");

    fireEvent.loadedData(v);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("plays: the clock advances the playhead and stops at the end", async () => {
    vi.useFakeTimers();
    load(place(IDS.vid, IDS.v1, 0, "a", 2));
    render(<Preview />);

    fireEvent.click(screen.getByRole("button", { name: /Play/ }));
    expect(usePlaybackStore.getState().playing).toBe(true);
    expect(videos()[0].play).toBeDefined();

    await act(async () => void vi.advanceTimersByTime(1000));
    // jsdom's <video> never becomes ready, so the clock first holds for MAX_MEDIA_WAIT (0.4 s), then runs
    expect(usePlaybackStore.getState().playhead).toBeGreaterThan(0.5);
    expect(usePlaybackStore.getState().playhead).toBeLessThan(0.75);

    await act(async () => void vi.advanceTimersByTime(2000));
    expect(usePlaybackStore.getState().playing).toBe(false);
    expect(usePlaybackStore.getState().playhead).toBe(2);
    expect(screen.getByLabelText("Timecode")).toHaveTextContent("00:00:02:00 / 00:00:02:00");
  });

  it("restarts from the beginning when played at the end", () => {
    load(place(IDS.vid, IDS.v1, 0, "a", 2));
    seek(2);
    render(<Preview />);
    fireEvent.click(screen.getByRole("button", { name: /Play/ }));
    expect(usePlaybackStore.getState().playhead).toBe(0);
    expect(usePlaybackStore.getState().playing).toBe(true);
  });

  it("Space toggles playback; Go to start rewinds", async () => {
    load(place(IDS.vid, IDS.v1, 0, "a", 5));
    render(<App />);
    fireEvent.keyDown(document.body, { key: " " });
    expect(usePlaybackStore.getState().playing).toBe(true);
    fireEvent.keyDown(document.body, { key: " " });
    expect(usePlaybackStore.getState().playing).toBe(false);

    seek(3);
    await userEvent.click(screen.getByRole("button", { name: /Go to start/ }));
    expect(usePlaybackStore.getState().playhead).toBe(0);
  });
});
