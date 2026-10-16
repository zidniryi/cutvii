import { act, render, screen } from "@testing-library/react";
import { Preview } from "@/components/layout/Preview";
import { commitImportedMedia } from "@/lib/importFlow";
import { isSeeThrough, layersAt } from "@/playback/engine";
import { MediaAssetSchema, type Project } from "@/project/model";
import { relinkAsset } from "@/project/relink";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { expectValid, IDS, makeProject } from "@/test/makeProject";
import { addClip } from "./edit";

/** v1: video 0..5; v2: the picture 1..3 over it, see-through or not. */
function build(alpha: boolean): Project {
  let p = makeProject();
  if (alpha) p = { ...p, assets: p.assets.map((a) => (a.id === IDS.img ? { ...a, alpha: true } : a)) };
  for (const [assetId, trackId, start, id, duration] of [
    [IDS.vid, IDS.v1, 0, "below", 5],
    [IDS.img, IDS.v2, 1, "sticker", 2],
  ] as const) {
    const r = addClip(p, { assetId, trackId, start, id, duration });
    if (!r.ok) throw new Error(r.error.message);
    p = r.project;
  }
  expectValid(p);
  return p;
}
const visible = (p: Project, t: number) =>
  layersAt(p, t, 0)
    .filter((l) => l.visible)
    .map((l) => l.clip.id);

beforeEach(() => {
  useSelectionStore.setState({ selectedClipIds: [] });
  usePlaybackStore.setState({ playhead: 0, playing: false, mediaErrors: {} });
});

describe("pictures with see-through pixels", () => {
  it("may only be images in the project file", () => {
    const base = { id: "x", path: "/m/x.png" };
    expect(MediaAssetSchema.safeParse({ ...base, type: "image", alpha: true }).success).toBe(true);
    expect(MediaAssetSchema.safeParse({ ...base, type: "video", alpha: true }).success).toBe(false);
  });

  it("let the video below show in the preview, an opaque picture covers it", () => {
    expect(visible(build(true), 2)).toEqual(["below", "sticker"]);
    expect(visible(build(false), 2)).toEqual(["sticker"]);
    expect(isSeeThrough(build(true).assets.find((a) => a.id === IDS.img)!)).toBe(true);
    expect(isSeeThrough(build(false).assets.find((a) => a.id === IDS.img)!)).toBe(false);
  });

  it("are drawn whole with no background of their own, whatever fit was chosen", () => {
    const p = build(true);
    p.tracks = p.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => (c.id === "sticker" ? { ...c, fitMode: "fill" as const } : c)),
    }));
    useProjectStore.setState({ project: p, past: [], future: [] });
    render(<Preview />);
    act(() => usePlaybackStore.getState().setPlayhead(2));
    const layer = screen.getByTestId("image-layer");
    expect(layer.dataset.fit).toBe("fit");
    expect(layer.style.backgroundColor).toBe("");
  });

  it("are recorded on import only when the engine found see-through pixels", () => {
    useProjectStore.setState({ project: makeProject(), past: [], future: [] });
    const yes = commitImportedMedia({
      path: "/m/sticker.png",
      mediaType: "image",
      width: 64,
      height: 64,
      alpha: true,
    });
    const no = commitImportedMedia({ path: "/m/photo.png", mediaType: "image", width: 64, height: 64 });
    expect(yes.status === "added" && yes.asset.alpha).toBe(true);
    expect(no.status === "added" && no.asset.alpha).toBeUndefined();
  });

  it("follow the new file when relinked", () => {
    const p = build(true);
    const r = relinkAsset(p, IDS.img, { path: "/m/photo.png", mediaType: "image", width: 64, height: 64 });
    expect(r.ok && r.project.assets.find((a) => a.id === IDS.img)!.alpha).toBeUndefined();
  });
});
