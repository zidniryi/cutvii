import fixture from "../../fixtures/project-v6.json";
import { createProject } from "./factory";
import { SCHEMA_VERSION, type MediaAsset } from "./model";
import { addAsset, removeAsset } from "./ops";
import { parseProject } from "./parse";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Draft = Record<string, any>;

const clone = () => structuredClone(fixture) as Draft;

function errorsFor(mutate: (p: Draft) => void): string[] {
  const p = clone();
  mutate(p);
  const r = parseProject(p);
  return r.ok ? [] : r.errors;
}

describe("parseProject", () => {
  it("accepts the shared fixture", () => {
    expect(parseProject(fixture).ok).toBe(true);
  });

  it("accepts a freshly created project", () => {
    expect(parseProject(createProject()).ok).toBe(true);
  });

  it("rejects unknown fields and wrong schemaVersion", () => {
    expect(errorsFor((p) => (p.extra = 1))).not.toHaveLength(0);
    expect(errorsFor((p) => (p.schemaVersion = SCHEMA_VERSION + 1))).not.toHaveLength(0);
  });

  it.each([
    [
      "sourceOut <= sourceIn",
      (p: Draft) => (p.tracks[0].clips[0].sourceOut = 1),
      "sourceOut must be greater",
    ],
    ["unknown asset", (p: Draft) => (p.tracks[0].clips[0].assetId = "nope"), "unknown asset"],
    ["trackId mismatch", (p: Draft) => (p.tracks[0].clips[0].trackId = "other"), "does not match its track"],
    [
      "image on audio track",
      (p: Draft) => (p.tracks[1].clips[0].assetId = "asset-image"),
      "cannot be placed on an audio track",
    ],
    [
      "audio on video track",
      (p: Draft) => (p.tracks[0].clips[0].assetId = "asset-audio"),
      "cannot be placed on a video track",
    ],
    ["past asset duration", (p: Draft) => (p.tracks[0].clips[0].sourceOut = 99), "exceeds asset duration"],
    ["duplicate clip id", (p: Draft) => (p.tracks[1].clips[0].id = "clip-1"), "duplicate clip id"],
    ["bad opacity", (p: Draft) => (p.tracks[0].clips[0].opacity = 1.5), "opacity"],
    ["bad color", (p: Draft) => (p.settings.backgroundColor = "red"), "#RRGGBB"],
  ])("rejects %s", (_name, mutate, expected) => {
    expect(errorsFor(mutate).join("\n")).toContain(expected);
  });
});

describe("asset operations", () => {
  const asset: MediaAsset = { id: "a1", path: "/m/a.mp4", type: "video", duration: 5 };

  it("guards against duplicate imports by path", () => {
    const first = addAsset(createProject(), asset);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = addAsset(first.project, { ...asset, id: "a2" });
    expect(second).toMatchObject({ ok: false, reason: "duplicate" });
    expect(first.project.assets).toHaveLength(1);
  });

  it("removing an asset also removes its clips, and the result stays valid", () => {
    const project = parseProject(fixture);
    if (!project.ok) throw new Error("fixture invalid");
    const next = removeAsset(project.project, "asset-video");
    expect(next.assets.map((a) => a.id)).not.toContain("asset-video");
    expect(next.tracks[0].clips.map((c) => c.id)).toEqual(["clip-2"]);
    expect(parseProject(next).ok).toBe(true);
  });
});
