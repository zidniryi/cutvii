import {
  clampPps,
  contentWidth,
  MAX_PPS,
  MIN_PPS,
  ROW_HEIGHT,
  rulerLabel,
  rulerStep,
  rulerTicks,
  timelineDropTarget,
  trackIndexAt,
  visibleClips,
} from "./geometry";
import type { TimelineClip } from "@/project/model";

const clip = (id: string, start: number, len: number): TimelineClip => ({
  id,
  assetId: "a",
  trackId: "t",
  timelineStart: start,
  sourceIn: 0,
  sourceOut: len,
  volume: 1,
  x: 0,
  y: 0,
  scale: 1,
  opacity: 1,
});

describe("geometry", () => {
  it("clamps zoom", () => {
    expect(clampPps(1)).toBe(MIN_PPS);
    expect(clampPps(9999)).toBe(MAX_PPS);
    expect(clampPps(50)).toBe(50);
  });

  it("picks a label step that keeps labels apart", () => {
    expect(rulerStep(50)).toBe(2); // 2s * 50px = 100px
    expect(rulerStep(400)).toBe(0.2);
    expect(rulerStep(4)).toBe(30);
    for (const pps of [4, 10, 50, 120, 480]) expect(rulerStep(pps) * pps).toBeGreaterThanOrEqual(80);
  });

  it("generates ticks only in range, with every fifth major", () => {
    const ticks = rulerTicks(50, 10, 20);
    expect(ticks[0].time).toBeLessThanOrEqual(10);
    expect(ticks[ticks.length - 1].time).toBeGreaterThanOrEqual(20);
    expect(
      ticks.filter((t) => t.major).every((t) => Math.abs(t.time / 2 - Math.round(t.time / 2)) < 1e-9),
    ).toBe(true);
    expect(ticks.length).toBeLessThan(40);
  });

  it("labels whole and sub-second steps", () => {
    expect(rulerLabel(75, 5)).toBe("1:15");
    expect(rulerLabel(1.5, 0.5)).toBe("0:01.5");
    expect(rulerLabel(1.99999, 0.1)).toBe("0:02.0");
  });

  it("windows clips to the visible range", () => {
    const clips = [clip("a", 0, 5), clip("b", 10, 5), clip("c", 100, 5)];
    expect(visibleClips(clips, 4, 12).map((c) => c.id)).toEqual(["a", "b"]);
    expect(visibleClips(clips, 50, 60)).toEqual([]);
  });

  it("maps y to a track row, clamped", () => {
    expect(trackIndexAt(100, 100, 3)).toBe(0);
    expect(trackIndexAt(100 + ROW_HEIGHT + 1, 100, 3)).toBe(1);
    expect(trackIndexAt(5000, 100, 3)).toBe(2);
    expect(trackIndexAt(0, 100, 3)).toBe(0);
    expect(trackIndexAt(0, 0, 0)).toBe(-1);
  });

  it("keeps a tail after the last clip", () => {
    expect(contentWidth(0, 800, 50)).toBe(800);
    expect(contentWidth(100, 800, 50)).toBe(5500);
  });
});

describe("timelineDropTarget", () => {
  const area = { left: 0, top: 500, right: 1200, bottom: 800 };
  const lanes = { left: 112, top: 528 };
  const tracks = ["v1", "a1"];

  it("maps the pointer to a lane and a time", () => {
    expect(timelineDropTarget(112 + 150, 528 + 10, area, lanes, tracks, 50)).toEqual({
      kind: "track",
      trackId: "v1",
      time: 3,
    });
    expect(timelineDropTarget(112 + 50, 528 + ROW_HEIGHT + 5, area, lanes, tracks, 50)).toEqual({
      kind: "track",
      trackId: "a1",
      time: 1,
    });
  });

  it("empty space below the lanes means a new track", () => {
    expect(timelineDropTarget(300, 528 + ROW_HEIGHT * 2 + 20, area, lanes, tracks, 50)).toMatchObject({
      kind: "new-track",
    });
    expect(timelineDropTarget(300, 600, area, lanes, [], 50)).toMatchObject({ kind: "new-track" });
  });

  it("the ruler and the header column still resolve sensibly", () => {
    expect(timelineDropTarget(300, 510, area, lanes, tracks, 50)).toMatchObject({
      kind: "track",
      trackId: "v1",
    }); // on the ruler
    expect(timelineDropTarget(40, 540, area, lanes, tracks, 50)).toMatchObject({ time: 0 }); // left of time 0
  });

  it("is null outside the timeline or when it is not laid out", () => {
    expect(timelineDropTarget(300, 200, area, lanes, tracks, 50)).toBeNull();
    expect(
      timelineDropTarget(0, 0, { left: 0, top: 0, right: 0, bottom: 0 }, { left: 0, top: 0 }, tracks, 50),
    ).toBeNull();
  });
});
