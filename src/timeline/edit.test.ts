import type { Project } from "@/project/model";
import { expectValid, IDS, makeProject } from "@/test/makeProject";
import { clipEnd, findClip, projectDuration } from "./clips";
import {
  addClip,
  deleteClip,
  moveClip,
  setClipVolume,
  setTrackFlag,
  splitClip,
  trimClip,
  type EditResult,
  addTrack,
  firstFreeStart,
  setClipFit,
} from "./edit";

function must(r: EditResult): Project {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  expectValid(r.project);
  return r.project;
}
const code = (r: EditResult) => (r.ok ? "ok" : r.error.code);
const clip = (p: Project, id: string) => findClip(p, id)!.clip;

/** vid (10s) placed at 2s on v1 with id "c1". */
function withClip(): Project {
  return must(addClip(makeProject(), { assetId: IDS.vid, trackId: IDS.v1, start: 2, id: "c1" }));
}

describe("addClip", () => {
  it("places the full asset with default transform", () => {
    const c = clip(withClip(), "c1");
    expect(c).toMatchObject({
      timelineStart: 2,
      sourceIn: 0,
      sourceOut: 10,
      volume: 1,
      scale: 1,
      opacity: 1,
    });
  });

  it("gives images a default duration", () => {
    const p = must(addClip(makeProject(), { assetId: IDS.img, trackId: IDS.v1, start: 0, id: "i" }));
    expect(clip(p, "i").sourceOut).toBe(5);
  });

  it("rejects wrong track type, overlap, unknown ids and negative start", () => {
    const p = withClip();
    expect(code(addClip(p, { assetId: IDS.aud, trackId: IDS.v1, start: 20 }))).toBe("incompatible-track");
    expect(code(addClip(p, { assetId: IDS.vid, trackId: IDS.a1, start: 0 }))).toBe("incompatible-track");
    expect(code(addClip(p, { assetId: IDS.vid2, trackId: IDS.v1, start: 5 }))).toBe("overlap");
    expect(code(addClip(p, { assetId: "nope", trackId: IDS.v1, start: 30 }))).toBe("unknown-asset");
    expect(code(addClip(p, { assetId: IDS.vid, trackId: "nope", start: 30 }))).toBe("unknown-track");
    expect(code(addClip(p, { assetId: IDS.vid2, trackId: IDS.v1, start: -1 }))).toBe("out-of-range");
  });

  it("allows touching clips and overlap across tracks", () => {
    let p = withClip();
    p = must(addClip(p, { assetId: IDS.vid2, trackId: IDS.v1, start: 12, id: "c2" }));
    p = must(addClip(p, { assetId: IDS.vid2, trackId: IDS.v2, start: 5, id: "c3" }));
    expect(p.tracks[0].clips.map((c) => c.id)).toEqual(["c1", "c2"]);
  });
});

describe("moveClip", () => {
  it("moves within a track and keeps clips sorted by start", () => {
    let p = withClip(); // c1: 2..12
    p = must(addClip(p, { assetId: IDS.vid2, trackId: IDS.v1, start: 20, id: "c2" }));
    p = must(moveClip(p, "c1", { start: 25 }));
    expect(p.tracks[0].clips.map((c) => c.id)).toEqual(["c2", "c1"]);
    expect(clip(p, "c1").timelineStart).toBe(25);
  });

  it("moves to another compatible track and updates trackId", () => {
    const p = must(moveClip(withClip(), "c1", { start: 1, trackId: IDS.v2 }));
    expect(clip(p, "c1").trackId).toBe(IDS.v2);
    expect(p.tracks[0].clips).toHaveLength(0);
  });

  it("rejects overlap, wrong track type and negative start", () => {
    let p = withClip();
    p = must(addClip(p, { assetId: IDS.vid2, trackId: IDS.v1, start: 20, id: "c2" }));
    expect(code(moveClip(p, "c2", { start: 11 }))).toBe("overlap");
    expect(code(moveClip(p, "c1", { start: 0, trackId: IDS.a1 }))).toBe("incompatible-track");
    expect(code(moveClip(p, "c1", { start: -0.5 }))).toBe("out-of-range");
    expect(code(moveClip(p, "zzz", { start: 0 }))).toBe("unknown-clip");
  });

  it("moving a clip onto its own old position is not an overlap, and no-ops keep the same project", () => {
    const p = withClip();
    const r = moveClip(p, "c1", { start: 2 });
    expect(r.ok && r.project).toBe(p);
    expect(code(moveClip(p, "c1", { start: 5 }))).toBe("ok");
  });
});

describe("trimClip", () => {
  it("trimming the start advances sourceIn and keeps the end fixed", () => {
    const p = must(trimClip(withClip(), "c1", "start", 5));
    const c = clip(p, "c1");
    expect(c).toMatchObject({ timelineStart: 5, sourceIn: 3, sourceOut: 10 });
    expect(clipEnd(c)).toBeCloseTo(12);
  });

  it("trimming the end shortens sourceOut", () => {
    const c = clip(must(trimClip(withClip(), "c1", "end", 6)), "c1");
    expect(c).toMatchObject({ timelineStart: 2, sourceIn: 0, sourceOut: 4 });
  });

  it("clamps the end to the source length and the start to source in = 0", () => {
    let p = must(trimClip(withClip(), "c1", "end", 100));
    expect(clip(p, "c1").sourceOut).toBe(10);
    p = must(trimClip(p, "c1", "start", 0)); // would need negative sourceIn
    expect(clip(p, "c1")).toMatchObject({ timelineStart: 2, sourceIn: 0 });
  });

  it("clamps against neighbours instead of overlapping them", () => {
    let p = withClip(); // c1: 2..12
    p = must(addClip(p, { assetId: IDS.vid2, trackId: IDS.v1, start: 14, id: "c2" })); // 14..18
    p = must(trimClip(p, "c1", "end", 6)); // 2..8
    p = must(trimClip(p, "c1", "end", 50));
    expect(clipEnd(clip(p, "c1"))).toBeCloseTo(12); // back to source limit, not into c2
    p = must(trimClip(p, "c2", "start", 3)); // c2 trimmed start: clamp at c1's end (12) and sourceIn>=0 (14)
    expect(clip(p, "c2").timelineStart).toBeCloseTo(14);
    p = must(trimClip(p, "c2", "end", 100));
    expect(clip(p, "c2").sourceOut).toBe(4);
  });

  it("never goes below one frame", () => {
    const c = clip(must(trimClip(withClip(), "c1", "end", 0)), "c1");
    expect(c.sourceOut - c.sourceIn).toBeCloseTo(1 / 30);
  });

  it("images can be extended freely", () => {
    let p = must(addClip(makeProject(), { assetId: IDS.img, trackId: IDS.v1, start: 0, id: "i" }));
    p = must(trimClip(p, "i", "end", 60));
    expect(clip(p, "i").sourceOut).toBe(60);
  });
});

describe("splitClip", () => {
  it("creates two contiguous clips covering the original range", () => {
    let p = must(trimClip(withClip(), "c1", "start", 4)); // timeline 4..12, sourceIn 2
    p = must(splitClip(p, "c1", 7, "right"));
    const l = clip(p, "c1");
    const r = clip(p, "right");
    expect(l).toMatchObject({ timelineStart: 4, sourceIn: 2, sourceOut: 5 });
    expect(r).toMatchObject({ timelineStart: 7, sourceIn: 5, sourceOut: 10 });
    expect(clipEnd(l)).toBeCloseTo(r.timelineStart);
    expect(projectDuration(p)).toBeCloseTo(12);
  });

  it("rejects splits on or outside the edges", () => {
    const p = withClip();
    expect(code(splitClip(p, "c1", 2))).toBe("out-of-range");
    expect(code(splitClip(p, "c1", 12))).toBe("out-of-range");
    expect(code(splitClip(p, "c1", 50))).toBe("out-of-range");
    expect(code(splitClip(p, "nope", 5))).toBe("unknown-clip");
  });
});

describe("deleteClip", () => {
  it("removes only that clip", () => {
    let p = withClip();
    p = must(addClip(p, { assetId: IDS.vid2, trackId: IDS.v1, start: 20, id: "c2" }));
    p = must(deleteClip(p, "c1"));
    expect(p.tracks[0].clips.map((c) => c.id)).toEqual(["c2"]);
    expect(code(deleteClip(p, "c1"))).toBe("unknown-clip");
  });
});

describe("setClipVolume / setTrackFlag", () => {
  it("sets volume within 0..200 % and is a no-op when unchanged", () => {
    const p = withClip();
    const loud = must(setClipVolume(p, "c1", 1.5));
    expect(clip(loud, "c1").volume).toBe(1.5);
    const same = setClipVolume(loud, "c1", 1.5);
    expect(same.ok && same.project).toBe(loud);
    expect(code(setClipVolume(p, "c1", 2.5))).toBe("out-of-range");
    expect(code(setClipVolume(p, "c1", -0.1))).toBe("out-of-range");
    expect(code(setClipVolume(p, "c1", Number.NaN))).toBe("out-of-range");
    expect(code(setClipVolume(p, "nope", 1))).toBe("unknown-clip");
  });

  it("toggles mute and hide on one track only", () => {
    const p = must(setTrackFlag(makeProject(), IDS.v1, "muted", true));
    expect(p.tracks.map((t) => t.muted)).toEqual([true, false, false]);
    const h = must(setTrackFlag(p, IDS.v2, "hidden", true));
    expect(h.tracks.map((t) => t.hidden)).toEqual([false, true, false]);
    expect(code(setTrackFlag(p, "nope", "muted", true))).toBe("unknown-track");
  });
});

describe("image fit, new tracks, free slots", () => {
  it("setClipFit stores the mode and is a no-op for the default", () => {
    const p = must(addClip(makeProject(), { assetId: IDS.img, trackId: IDS.v1, start: 0, id: "i" }));
    const same = setClipFit(p, "i", "fit");
    expect(same.ok && same.project).toBe(p);
    expect(clip(must(setClipFit(p, "i", "blur")), "i").fit).toBe("blur");
    expect(code(setClipFit(p, "nope", "fill"))).toBe("unknown-clip");
  });

  it("images default to 5 s and can be stretched to any length", () => {
    let p = must(addClip(makeProject(), { assetId: IDS.img, trackId: IDS.v1, start: 0, id: "i" }));
    expect(clip(p, "i").sourceOut).toBe(5);
    p = must(trimClip(p, "i", "end", 3600));
    expect(clip(p, "i").sourceOut).toBe(3600);
  });

  it("addTrack appends on top with a numbered name", () => {
    const p = must(addTrack(makeProject(), "video", "new"));
    const t = p.tracks.at(-1)!;
    expect(t).toMatchObject({ id: "new", name: "Video 3", type: "video", muted: false, hidden: false });
    expect(t.order).toBeGreaterThan(Math.max(...makeProject().tracks.map((x) => x.order)));
    expect(must(addTrack(p, "audio")).tracks.at(-1)!.name).toBe("Audio 2");
  });

  it("firstFreeStart slides past whatever is in the way", () => {
    let p = withClip(); // c1: 2..12
    p = must(addClip(p, { assetId: IDS.vid2, trackId: IDS.v1, start: 12, id: "c2" })); // 12..16
    const clips = p.tracks[0].clips;
    expect(firstFreeStart(clips, 0, 1)).toBe(0); // fits before c1
    expect(firstFreeStart(clips, 0, 5)).toBe(16); // too long for the gap: after both
    expect(firstFreeStart(clips, 5, 2)).toBe(16);
    expect(firstFreeStart(clips, 20, 2)).toBe(20);
    expect(firstFreeStart([], -3, 2)).toBe(0);
  });
});
