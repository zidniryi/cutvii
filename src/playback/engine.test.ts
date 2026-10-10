import { expectValid, IDS, makeProject } from "@/test/makeProject";
import { addClip } from "@/timeline/edit";
import type { Project } from "@/project/model";
import { DRIFT_SECONDS, layerKey, layersAt, mediaErrorMessage, planSync, sourceTimeFor } from "./engine";

function build(): Project {
  let p = makeProject();
  const add = (assetId: string, trackId: string, start: number, id: string, duration?: number) => {
    const r = addClip(p, { assetId, trackId, start, id, duration });
    if (!r.ok) throw new Error(r.error.message);
    p = r.project;
  };
  add(IDS.vid, IDS.v1, 0, "a", 5); // v1: 0..5
  add(IDS.vid2, IDS.v1, 5, "b", 4); // v1: 5..9 (touching a)
  add(IDS.img, IDS.v2, 2, "overlay", 2); // v2: 2..4, above v1
  add(IDS.aud, IDS.a1, 1, "music", 10); // a1: 1..11
  expectValid(p);
  return p;
}

const ids = (p: Project, t: number, h?: number) =>
  layersAt(p, t, h).map((l) => `${l.clip.id}:${l.role}${l.visible ? ":visible" : ""}`);

describe("layersAt", () => {
  const p = build();

  it("picks the clip under the playhead, with audio, and none past the end", () => {
    expect(ids(p, 0.5, 0)).toEqual(["a:active:visible"]);
    expect(ids(p, 1.5, 0)).toEqual(["a:active:visible", "music:active"]);
    expect(ids(p, 11.5, 0)).toEqual([]);
  });

  it("makes the highest video track the visible one", () => {
    expect(ids(p, 3, 0)).toEqual(["a:active", "overlay:active:visible", "music:active"]);
  });

  it("switches at the exact boundary between touching clips", () => {
    expect(ids(p, 4.999, 0)).toContain("a:active:visible");
    expect(ids(p, 5, 0)).toContain("b:active:visible");
    expect(ids(p, 5, 0)).not.toContain("a:active:visible");
  });

  it("mounts upcoming clips inside the preload horizon only", () => {
    expect(ids(p, 4.5, 1)).toContain("b:upcoming");
    expect(ids(p, 3.0, 1)).not.toContain("b:upcoming");
  });

  it("does not show hidden tracks, and skips clips whose asset is gone", () => {
    const hidden: Project = {
      ...p,
      tracks: p.tracks.map((t) => (t.id === IDS.v2 ? { ...t, hidden: true } : t)),
    };
    expect(ids(hidden, 3, 0)).toContain("a:active:visible");
    const noAsset: Project = { ...p, assets: p.assets.filter((a) => a.id !== IDS.vid) };
    expect(ids(noAsset, 1, 0)).not.toContain("a:active:visible");
  });

  it("layer keys change only when the set or visibility changes", () => {
    const key = (t: number) => layersAt(p, t, 0).map(layerKey).join("|");
    expect(key(0.5)).toBe(key(0.9));
    expect(key(0.5)).not.toBe(key(1.5));
  });
});

describe("sourceTimeFor", () => {
  it("maps timeline time into the source and clamps to the used range", () => {
    const clip = { timelineStart: 10, sourceIn: 2, sourceOut: 6 } as Parameters<typeof sourceTimeFor>[0];
    expect(sourceTimeFor(clip, 11)).toBe(3);
    expect(sourceTimeFor(clip, 5)).toBe(2);
    expect(sourceTimeFor(clip, 99)).toBe(6);
  });
});

describe("planSync", () => {
  const base = { role: "active", playing: true, paused: false, currentTime: 3, desired: 3 } as const;

  it("leaves a healthy playing element alone", () => {
    expect(planSync(base)).toEqual({});
    expect(planSync({ ...base, currentTime: 3 + DRIFT_SECONDS - 0.01 })).toEqual({});
  });

  it("corrects drift and starts a paused element while playing", () => {
    expect(planSync({ ...base, currentTime: 3 + DRIFT_SECONDS + 0.1 })).toEqual({ seekTo: 3 });
    expect(planSync({ ...base, paused: true, currentTime: 3 })).toEqual({ play: true });
    expect(planSync({ ...base, paused: true, currentTime: 0 })).toEqual({ seekTo: 3, play: true });
  });

  it("pauses and seeks precisely when not playing (scrubbing)", () => {
    expect(planSync({ ...base, playing: false, currentTime: 1 })).toEqual({ pause: true, seekTo: 3 });
    expect(planSync({ ...base, playing: false, paused: true, currentTime: 3.01 })).toEqual({});
  });

  it("keeps upcoming clips paused at their start", () => {
    expect(planSync({ ...base, role: "upcoming", currentTime: 0, desired: 2 })).toEqual({
      pause: true,
      seekTo: 2,
    });
  });
});

describe("mediaErrorMessage", () => {
  it("explains the common codes", () => {
    expect(mediaErrorMessage(4)).toMatch(/missing|not supported/);
    expect(mediaErrorMessage(3)).toMatch(/decoded/);
    expect(mediaErrorMessage(undefined)).toMatch(/could not be played/);
  });
});
