import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { IDS, makeProject } from "@/test/makeProject";
import { addClip } from "@/timeline/edit";
import { MAX_MEDIA_WAIT, setMediaClock, startClock, type MediaClock } from "./controller";

const head = () => usePlaybackStore.getState().playhead;
let stop: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  const r = addClip(makeProject(), { assetId: IDS.vid, trackId: IDS.v1, start: 0, id: "c" }); // 10 s
  if (!r.ok) throw new Error("setup");
  useProjectStore.setState({ project: r.project });
  usePlaybackStore.setState({ playhead: 0, playing: true, mediaErrors: {} });
});
afterEach(() => {
  stop?.();
  setMediaClock(null);
  vi.useRealTimers();
});
const run = (clock: MediaClock | null, ms: number) => {
  setMediaClock(clock);
  stop = startClock();
  vi.advanceTimersByTime(ms);
};

describe("playback clock", () => {
  it("runs on the wall clock when nothing is leading (gaps, stills)", () => {
    run(null, 1000);
    expect(head()).toBeGreaterThan(0.9);
    expect(head()).toBeLessThan(1.1);
  });

  it("follows the media element's own time instead of the wall clock", () => {
    // the video decodes slowly: after 1 s of wall time it has only shown 0.5 s
    let mediaTime = 0;
    setMediaClock(() => ({ time: mediaTime }));
    stop = startClock();
    for (let i = 0; i < 10; i++) {
      mediaTime += 0.05;
      vi.advanceTimersByTime(100);
    }
    expect(head()).toBeCloseTo(0.5, 1); // the playhead stayed with the picture: no re-seek needed
  });

  it("holds while the media is starting or buffering, but not forever", () => {
    run(() => "waiting", (MAX_MEDIA_WAIT - 0.1) * 1000);
    expect(head()).toBe(0);
    vi.advanceTimersByTime(600);
    expect(head()).toBeGreaterThan(0.3); // gave up waiting and moved on
  });

  it("never moves backwards when the picture is slightly behind", () => {
    usePlaybackStore.setState({ playhead: 2 });
    run(() => ({ time: 1.9 }), 300);
    expect(head()).toBe(2);
  });

  it("ignores media that is far from the playhead (the user seeked) and stops at the end", () => {
    usePlaybackStore.setState({ playhead: 5 });
    run(() => ({ time: 1 }), 500);
    expect(head()).toBeGreaterThan(5.4);

    stop();
    usePlaybackStore.setState({ playhead: 9.9, playing: true });
    run(() => ({ time: 10.2 }), 100);
    expect(head()).toBe(10);
    expect(usePlaybackStore.getState().playing).toBe(false);
  });
});
