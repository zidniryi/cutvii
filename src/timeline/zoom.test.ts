import { DEFAULT_PPS, MAX_PPS, MIN_PPS } from "./geometry";
import {
  canZoomIn,
  canZoomOut,
  fitPps,
  playheadAnchor,
  wheelZoomFactor,
  zoomAround,
  zoomPercent,
  ZOOM_STEP,
} from "./zoom";

const timeAt = (x: number, pps: number, scrollLeft: number) => (scrollLeft + x) / pps;

describe("zoomAround", () => {
  it("keeps the time under the anchor fixed when zooming in and out", () => {
    for (const [pps, next, scroll, anchor] of [
      [50, 100, 400, 300],
      [50, 20, 1200, 650],
      [120, 480, 3000, 10],
      [200, 60, 5000, 900],
    ]) {
      const before = timeAt(anchor, pps, scroll);
      const r = zoomAround(pps, next, scroll, anchor);
      expect(timeAt(anchor, r.pps, r.scrollLeft)).toBeCloseTo(before, 6);
    }
  });

  it("clamps to the min and max zoom, still anchored", () => {
    const inMax = zoomAround(400, 99999, 2000, 500);
    expect(inMax.pps).toBe(MAX_PPS);
    expect(timeAt(500, inMax.pps, inMax.scrollLeft)).toBeCloseTo(timeAt(500, 400, 2000), 6);
    expect(zoomAround(10, 0.001, 0, 100).pps).toBe(MIN_PPS);
    expect(canZoomIn(MAX_PPS)).toBe(false);
    expect(canZoomOut(MIN_PPS)).toBe(false);
    expect(canZoomIn(DEFAULT_PPS) && canZoomOut(DEFAULT_PPS)).toBe(true);
  });

  it("never scrolls before the start: near time 0 the anchor gives way instead", () => {
    const r = zoomAround(100, 20, 0, 500); // time 5 s at x=500; at 20 pps that is x=100 with scroll 0
    expect(r.scrollLeft).toBe(0);
  });

  it("repeated in/out steps return to where they started", () => {
    let s = { pps: 50, scrollLeft: 700 };
    for (let i = 0; i < 4; i++) s = zoomAround(s.pps, s.pps * ZOOM_STEP, s.scrollLeft, 320);
    for (let i = 0; i < 4; i++) s = zoomAround(s.pps, s.pps / ZOOM_STEP, s.scrollLeft, 320);
    expect(s.pps).toBeCloseTo(50, 6);
    expect(s.scrollLeft).toBeCloseTo(700, 4);
  });
});

describe("anchors, wheel and fit", () => {
  it("anchors at the playhead when visible, else at the viewport centre", () => {
    expect(playheadAnchor(4, 50, 100, 800)).toBe(100);
    expect(playheadAnchor(100, 50, 0, 800)).toBe(400);
    expect(playheadAnchor(0, 50, 500, 800)).toBe(400);
  });

  it("wheel up zooms in, down zooms out, and one event is bounded", () => {
    expect(wheelZoomFactor(-10)).toBeGreaterThan(1);
    expect(wheelZoomFactor(10)).toBeLessThan(1);
    expect(wheelZoomFactor(0)).toBe(1);
    expect(wheelZoomFactor(-100000)).toBe(wheelZoomFactor(-60));
    expect(wheelZoomFactor(-10) * wheelZoomFactor(10)).toBeCloseTo(1, 9);
  });

  it("fit shows the whole project and clamps", () => {
    expect(fitPps(90, 1000)).toBeCloseTo(10); // 90 s + 10 s tail in 1000 px
    expect(fitPps(1, 100000)).toBe(MAX_PPS);
    expect(fitPps(100000, 500)).toBe(MIN_PPS);
    expect(fitPps(0, 1000)).toBe(DEFAULT_PPS);
    expect(zoomPercent(DEFAULT_PPS)).toBe(100);
    expect(zoomPercent(DEFAULT_PPS * 2)).toBe(200);
  });
});
