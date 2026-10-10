import { expectValid, IDS, makeProject } from "@/test/makeProject";
import { addClip } from "@/timeline/edit";
import type { Project } from "./model";
import { relinkAsset } from "./relink";

function withClip(): Project {
  const r = addClip(makeProject(), { assetId: IDS.vid, trackId: IDS.v1, start: 0, duration: 8, id: "c" });
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
}
const media = {
  path: "/new/place/vid.mp4",
  mediaType: "video" as const,
  duration: 10,
  width: 1280,
  height: 720,
};

describe("relinkAsset", () => {
  it("points the asset at the new file and refreshes its metadata, keeping clips intact", () => {
    const p = withClip();
    const r = relinkAsset(p, IDS.vid, { ...media, thumbnailPath: "/cache/t.jpg" });
    if (!r.ok) throw new Error(r.reason);
    expectValid(r.project);
    expect(r.project.assets.find((a) => a.id === IDS.vid)).toEqual({
      id: IDS.vid,
      path: "/new/place/vid.mp4",
      type: "video",
      duration: 10,
      width: 1280,
      height: 720,
      thumbnailPath: "/cache/t.jpg",
    });
    expect(r.project.tracks).toBe(p.tracks);
  });

  it("rejects a different media type", () => {
    const r = relinkAsset(withClip(), IDS.vid, { ...media, mediaType: "audio" });
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.reason).toMatch(/original is video but the chosen file is audio/);
  });

  it("rejects a file shorter than the part of it that clips use", () => {
    const r = relinkAsset(withClip(), IDS.vid, { ...media, duration: 5 });
    expect(!r.ok && r.reason).toMatch(/5\.0s long.*8\.0s/);
  });

  it("accepts a longer file, and ignores duration for images", () => {
    expect(relinkAsset(withClip(), IDS.vid, { ...media, duration: 8 }).ok).toBe(true);
    const img = relinkAsset(makeProject(), IDS.img, {
      path: "/x/new.png",
      mediaType: "image",
      width: 10,
      height: 10,
    });
    expect(img.ok).toBe(true);
  });

  it("rejects a file that is already another asset, and unknown assets", () => {
    const r = relinkAsset(withClip(), IDS.vid, { ...media, path: "/m/aud.mp3" });
    expect(!r.ok && r.reason).toMatch(/already in the project/);
    expect(relinkAsset(withClip(), "nope", media).ok).toBe(false);
  });
});
