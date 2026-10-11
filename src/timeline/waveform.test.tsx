import { act, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { ClipWaveform } from "@/components/timeline/ClipWaveform";
import type { TimelineClip } from "@/project/model";
import { useWaveformStore } from "@/store/waveforms";
import { parseWaveform, pickLevel, waveColumns, waveWindow, type Waveform } from "./waveform";

/** A file in the layout Rust writes: levels of `rates`, the finest holding `base`. */
function waveFile(base: number[], rates = [200, 50, 12.5, 3.125]): ArrayBuffer {
  const levels = [base];
  while (levels.length < rates.length) {
    const prev = levels[levels.length - 1];
    const next: number[] = [];
    for (let i = 0; i < prev.length; i += 4) next.push(Math.max(...prev.slice(i, i + 4)));
    levels.push(next);
  }
  const header = 12 + rates.length * 8;
  const buffer = new ArrayBuffer(header + levels.reduce((n, l) => n + l.length, 0));
  const view = new DataView(buffer);
  [..."CVWF"].forEach((c, i) => view.setUint8(i, c.charCodeAt(0)));
  view.setUint32(4, 1, true);
  view.setUint32(8, rates.length, true);
  let offset = header;
  levels.forEach((level, i) => {
    view.setFloat32(12 + i * 8, rates[i], true);
    view.setUint32(16 + i * 8, level.length, true);
    new Uint8Array(buffer, offset, level.length).set(level);
    offset += level.length;
  });
  return buffer;
}

/** 4 s at 200 peaks/s: the level rises one step per second (51, 102, 153, 204). */
const ramp = () => Array.from({ length: 800 }, (_, i) => (Math.floor(i / 200) + 1) * 51);
const clip = (over: Partial<TimelineClip> = {}): TimelineClip => ({
  id: "c",
  assetId: "a",
  trackId: "t",
  timelineStart: 0,
  sourceIn: 0,
  sourceOut: 4,
  volume: 1,
  x: 0,
  y: 0,
  scale: 1,
  opacity: 1,
  ...over,
});
const near = (values: Float32Array, expected: number[]) =>
  expect([...values].map((v) => Math.round(v * 100) / 100)).toEqual(expected);

describe("waveform file", () => {
  it("reads every level and rejects anything else", () => {
    const wave = parseWaveform(waveFile([1, 9, 3, 4, 5]));
    expect(wave.levels.map((l) => [l.rate, [...l.peaks]])).toEqual([
      [200, [1, 9, 3, 4, 5]],
      [50, [9, 5]],
      [12.5, [9]],
      [3.125, [9]],
    ]);
    expect(() => parseWaveform(new ArrayBuffer(4))).toThrow();
    expect(() => parseWaveform(new TextEncoder().encode("not a waveform at all").buffer)).toThrow();
    expect(() => parseWaveform(waveFile([1, 2, 3]).slice(0, 44))).toThrow(/truncated/);
  });

  it("picks the coarsest level with two peaks for every column", () => {
    const wave = parseWaveform(waveFile(ramp()));
    expect(pickLevel(wave, 1 / 480).rate).toBe(200); // zoomed right in: finest
    expect(pickLevel(wave, 1 / 50).rate).toBe(200);
    expect(pickLevel(wave, 1 / 20).rate).toBe(50);
    expect(pickLevel(wave, 1 / 4).rate).toBe(12.5);
    expect(pickLevel(wave, 2.5).rate).toBe(3.125); // 10x speed at the widest zoom
  });
});

describe("clip bars", () => {
  // a single level keeps the expected numbers exact
  const wave: Waveform = parseWaveform(waveFile(ramp(), [200]));

  it("follows trim, speed, direction and volume", () => {
    // one column per second
    near(waveColumns(wave, clip(), 1, 0, 4), [0.2, 0.4, 0.6, 0.8]);
    near(waveColumns(wave, clip({ sourceIn: 1, sourceOut: 3 }), 1, 0, 2), [0.4, 0.6]);
    near(waveColumns(wave, clip({ reversed: true }), 1, 0, 4), [0.8, 0.6, 0.4, 0.2]);
    near(waveColumns(wave, clip({ sourceIn: 1, reversed: true }), 1, 0, 3), [0.8, 0.6, 0.4]);
    // 2x: each column covers two seconds of source and shows the louder one
    near(waveColumns(wave, clip({ speed: 2 }), 1, 0, 2), [0.4, 0.8]);
    near(waveColumns(wave, clip({ speed: 0.5 }), 1, 0, 8), [0.2, 0.2, 0.4, 0.4, 0.6, 0.6, 0.8, 0.8]);
    near(waveColumns(wave, clip({ volume: 0.5 }), 1, 0, 4), [0.1, 0.2, 0.3, 0.4]);
    near(waveColumns(wave, clip({ volume: 2 }), 1, 0, 4), [0.4, 0.8, 1, 1]); // clipped at full height
    near(waveColumns(wave, clip({ volume: 0 }), 1, 0, 4), [0, 0, 0, 0]);
  });

  it("draws a window of the clip and nothing past its end", () => {
    near(waveColumns(wave, clip(), 1, 2, 6), [0.6, 0.8, 0, 0]);
    // same picture whichever window it is cut into
    const whole = waveColumns(wave, clip({ sourceIn: 0.3 }), 100, 0, 370);
    const part = waveColumns(wave, clip({ sourceIn: 0.3 }), 100, 120, 300);
    expect([...part]).toEqual([...whole.slice(120, 300)]);
  });

  it("limits the drawn slice to tiles around the viewport", () => {
    expect(waveWindow(0, 300, 0, 1000)).toEqual({ from: 0, to: 300 });
    expect(waveWindow(1000, 50_000, 20_000, 21_000)).toEqual({ from: 18_944, to: 20_480 });
    expect(waveWindow(1000, 50_000, 20_100, 21_100)).toEqual({ from: 18_944, to: 20_480 }); // small scroll: unchanged
    expect(waveWindow(5000, 300, 0, 1000)).toBeNull();
    expect(waveWindow(0, 300, 2000, 3000)).toBeNull();
  });
});

describe("waveform loading", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    useWaveformStore.setState({ entries: {} });
    vi.mocked(invoke).mockReset();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());
  const entry = (path: string) => useWaveformStore.getState().entries[path];

  it("analyses two files at a time and asks once per file", async () => {
    const release: (() => void)[] = [];
    vi.mocked(invoke).mockImplementation(
      () => new Promise((resolve) => release.push(() => resolve(null))) as never,
    );
    const { ensure } = useWaveformStore.getState();
    ["/a.mp3", "/b.mp3", "/c.mp3", "/a.mp3"].forEach(ensure);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenCalledWith("prepare_waveform", { path: "/a.mp3" });
    expect(entry("/c.mp3")).toEqual({ status: "loading" });

    release[0]();
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(3));
    expect(entry("/a.mp3")).toEqual({ status: "none" }); // no audio in the file
    release[1]();
    release[2]();
    await waitFor(() => expect(entry("/c.mp3")).toEqual({ status: "none" }));
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it("loads the peaks from the cached file, not over IPC", async () => {
    vi.mocked(invoke).mockResolvedValue("/cache/waveforms/abc.wf");
    fetchMock.mockResolvedValue({ ok: true, arrayBuffer: async () => waveFile([10, 20]) });
    useWaveformStore.getState().ensure("/a.mp3");
    await waitFor(() => expect(entry("/a.mp3")?.status).toBe("ready"));
    expect(fetchMock).toHaveBeenCalledWith("asset://localhost/cache/waveforms/abc.wf");
    const ready = entry("/a.mp3");
    expect(ready.status === "ready" && [...ready.data.levels[0].peaks]).toEqual([10, 20]);
  });

  it("marks a file as failed when Rust or the file read fails, and keeps going", async () => {
    vi.mocked(invoke).mockRejectedValueOnce("ffmpeg not found").mockResolvedValue("/cache/x.wf");
    fetchMock.mockResolvedValue({ ok: false, status: 403 });
    useWaveformStore.getState().ensure("/a.mp3");
    useWaveformStore.getState().ensure("/b.mp3");
    await waitFor(() => expect(entry("/b.mp3")).toEqual({ status: "failed" }));
    expect(entry("/a.mp3")).toEqual({ status: "failed" });
  });
});

describe("ClipWaveform", () => {
  const fillRect = vi.fn();
  const ctx = { setTransform: vi.fn(), clearRect: vi.fn(), fillRect, fillStyle: "" };
  beforeEach(() => {
    fillRect.mockReset();
    vi.mocked(invoke).mockReset();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it("shows a flat line while loading, then draws separate bars", () => {
    useWaveformStore.setState({ entries: { "/a.mp3": { status: "loading" } } });
    const view = (c: TimelineClip, muted = false) => (
      <ClipWaveform path="/a.mp3" clip={c} pps={3} from={0} to={12} muted={muted} />
    );
    const { rerender } = render(view(clip()));
    expect(screen.getByTestId("waveform-placeholder")).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled(); // already requested

    act(() =>
      useWaveformStore.setState({
        entries: { "/a.mp3": { status: "ready", data: parseWaveform(waveFile(ramp(), [200])) } },
      }),
    );
    expect(screen.queryByTestId("waveform-placeholder")).not.toBeInTheDocument();
    expect(screen.getByTestId("waveform")).toHaveStyle({ left: "0px", width: "12px" });
    const heights = () => fillRect.mock.calls.map((c) => Math.round(c[3] as number));
    expect(heights()).toEqual([10, 19, 29, 38]); // 0.2..0.8 of the 48px drawing height
    // 2px bars every 3px, centred vertically
    expect(fillRect.mock.calls.map((c) => [c[0], c[2]])).toEqual([
      [0, 2],
      [3, 2],
      [6, 2],
      [9, 2],
    ]);
    expect(fillRect.mock.calls[3][1]).toBeCloseTo((56 - 38.4) / 2);
    const loud = ctx.fillStyle;

    fillRect.mockReset();
    rerender(view(clip({ volume: 0, reversed: true }), true));
    expect(heights()).toEqual([2, 2, 2, 2]); // silent: a row of dots
    expect(ctx.fillStyle).not.toBe(loud); // muted track is drawn faint
  });

  it("draws nothing for a file without audio", () => {
    useWaveformStore.setState({ entries: { "/v.mp4": { status: "none" } } });
    const { container } = render(
      <ClipWaveform path="/v.mp4" clip={clip()} pps={1} from={0} to={4} muted={false} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
