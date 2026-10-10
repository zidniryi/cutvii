import { expectValid, IDS, makeProject } from "@/test/makeProject";
import { addClip } from "./edit";
import { quantizeToFrame, snapClipMove, snapTime } from "./snap";

function project() {
  const r = addClip(makeProject(), { assetId: IDS.vid, trackId: IDS.v1, start: 2, id: "c1" }); // 2..12
  if (!r.ok) throw new Error("setup");
  expectValid(r.project);
  return r.project;
}

describe("snapTime", () => {
  it("snaps to clip edges, playhead and zero within the threshold", () => {
    const p = project();
    const opts = { playhead: 20, threshold: 0.2 };
    expect(snapTime(p, 2.1, opts)).toEqual({ time: 2, snappedTo: "clip-start" });
    expect(snapTime(p, 11.9, opts)).toEqual({ time: 12, snappedTo: "clip-end" });
    expect(snapTime(p, 20.15, opts)).toEqual({ time: 20, snappedTo: "playhead" });
    expect(snapTime(p, 0.1, opts)).toEqual({ time: 0, snappedTo: "zero" });
  });

  it("falls back to the frame grid when nothing is in range", () => {
    const r = snapTime(project(), 5.016, { playhead: 20, threshold: 0.05 });
    expect(r.snappedTo).toBeNull();
    expect(r.time).toBeCloseTo(quantizeToFrame(5.016, 30));
    expect(r.time).toBeCloseTo(5.0, 1);
  });

  it("picks the nearest target when several are in range", () => {
    expect(snapTime(project(), 2.04, { playhead: 2.1, threshold: 0.5 })).toEqual({
      time: 2,
      snappedTo: "clip-start",
    });
  });

  it("ignores the dragged clip's own edges", () => {
    const r = snapTime(project(), 2.05, { playhead: 20, threshold: 0.2, excludeClipId: "c1" });
    expect(r.snappedTo).toBeNull();
  });
});

describe("snapClipMove", () => {
  it("snaps the moving clip's start to another clip's end", () => {
    const p = project();
    const moving = { id: "m", sourceIn: 0, sourceOut: 4 };
    expect(snapClipMove(p, moving, 12.1, { playhead: 50, threshold: 0.2 })).toEqual({
      time: 12,
      snappedTo: "clip-end",
    });
  });

  it("snaps the moving clip's end to another clip's start", () => {
    const p = project();
    const moving = { id: "m", sourceIn: 0, sourceOut: 1 }; // wants 0.9..1.9, end near 2
    const r = snapClipMove(p, moving, 0.95, { playhead: 50, threshold: 0.2 });
    expect(r.snappedTo).toBe("clip-start");
    expect(r.time).toBeCloseTo(1);
  });

  it("never returns a negative start", () => {
    const p = project();
    expect(
      snapClipMove(p, { id: "m", sourceIn: 0, sourceOut: 1 }, -3, { playhead: 50, threshold: 0.1 }).time,
    ).toBe(0);
  });
});
