import { render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { Inspector } from "@/components/layout/Inspector";
import { Preview } from "@/components/layout/Preview";
import { assetName } from "@/lib/media";
import { layersAt } from "@/playback/engine";
import { SCHEMA_VERSION, type Project, type TextSpec } from "@/project/model";
import { parseProject } from "@/project/parse";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useUiStore } from "@/store/ui";
import { expectValid, IDS, makeProject } from "@/test/makeProject";
import { addClip } from "./edit";
import { undo } from "./editor";
import { addTextAtPlayhead, addTextClip, defaultTextSpec, textTrackFor } from "./text";

const spec: TextSpec = {
  content: "Hello\nworld",
  fontSize: 64,
  color: "#FFFFFF",
  bold: true,
  x: 0.5,
  y: 0.5,
};
const PICTURE = "/data/text/abc.png";

/** A 10 s video on v1 from 0, with text added at `start`. */
function withText(start: number): Project {
  const base = addClip(makeProject(), { assetId: IDS.vid, trackId: IDS.v1, start: 0, id: "video" });
  if (!base.ok) throw new Error(base.error.message);
  const r = addTextClip(base.project, {
    picture: PICTURE,
    spec,
    start,
    assetId: "text",
    clipId: "title",
    trackId: "new-track",
  });
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
}
const visible = (p: Project, t: number) =>
  layersAt(p, t, 0)
    .filter((l) => l.visible)
    .map((l) => l.clip.id);

describe("text in the project file", () => {
  it("is schema version 5: an image asset may carry text, nothing else may", () => {
    expect(SCHEMA_VERSION).toBe(5);
    const p = withText(2);
    expectValid(p);
    expect(p.assets.at(-1)).toMatchObject({
      type: "image",
      path: PICTURE,
      width: 1920,
      height: 1080,
      text: spec,
    });

    const errors = (change: (p: Project) => void) => {
      const copy = structuredClone(p);
      change(copy);
      const r = parseProject(copy);
      return r.ok ? [] : r.errors;
    };
    expect(errors((c) => (c.assets[0].text = spec)).join()).toMatch(/only an image asset can be text/);
    expect(errors((c) => (c.assets.at(-1)!.text!.content = "  "))).not.toHaveLength(0);
    expect(errors((c) => (c.assets.at(-1)!.text!.fontSize = 4))).not.toHaveLength(0);
    expect(errors((c) => (c.assets.at(-1)!.text!.color = "white"))).not.toHaveLength(0);
    expect(errors((c) => (c.assets.at(-1)!.text!.x = 1.2))).not.toHaveLength(0);
    expect(errors((c) => Object.assign(c.assets.at(-1)!.text!, { font: "Arial" }))).not.toHaveLength(0);
  });

  it("is named after its first line", () => {
    expect(assetName({ path: PICTURE, text: spec })).toBe("Hello");
    expect(assetName({ path: "/m/clip.mp4" })).toBe("clip.mp4");
  });

  it("starts at a size that suits the canvas", () => {
    expect(defaultTextSpec(1080)).toMatchObject({ content: "Text", fontSize: 97, align: "center", x: 0.5 });
    expect(defaultTextSpec(40).fontSize).toBe(8);
  });
});

describe("placing text", () => {
  it("uses the top video track when it is free, otherwise a new track above everything", () => {
    const p = makeProject(); // v1 (order 0), v2 (order 1), a1
    expect(textTrackFor(p, 0, 5)).toBe(IDS.v2);
    const busy = addClip(p, { assetId: IDS.vid2, trackId: IDS.v2, start: 3, id: "x" }); // 3..7
    if (!busy.ok) throw new Error("setup");
    expect(textTrackFor(busy.project, 0, 5)).toBeNull(); // 0..5 would overlap
    expect(textTrackFor(busy.project, 7, 5)).toBe(IDS.v2);
    expect(textTrackFor({ ...p, tracks: p.tracks.filter((t) => t.type === "audio") }, 0, 5)).toBeNull();

    const added = addTextClip(busy.project, {
      picture: PICTURE,
      spec,
      start: 4,
      assetId: "text",
      clipId: "title",
      trackId: "new-track",
    });
    if (!added.ok) throw new Error(added.error.message);
    expectValid(added.project);
    const track = added.project.tracks.find((t) => t.id === "new-track")!;
    expect(track.type).toBe("video");
    expect(track.order).toBeGreaterThan(Math.max(...p.tracks.map((t) => t.order)));
    expect(track.clips).toMatchObject([{ id: "title", assetId: "text", timelineStart: 4, sourceOut: 5 }]);
  });
});

describe("text in the preview", () => {
  it("shows text together with the first picture under it, and hides what that picture covers", () => {
    const p = withText(2); // video on v1 0..10, text on v2 2..7
    expect(visible(p, 1)).toEqual(["video"]);
    expect(visible(p, 3)).toEqual(["video", "title"]);

    // an opaque clip above the text covers it, like any other picture
    const above = addClip(
      { ...p, tracks: [...p.tracks, { ...p.tracks[0], id: "v3", name: "Video 3", order: 9, clips: [] }] },
      { assetId: IDS.vid2, trackId: "v3", start: 3, id: "cover" },
    );
    if (!above.ok) throw new Error(above.error.message);
    expect(visible(above.project, 4)).toEqual(["cover"]);
    expect(visible(above.project, 2.5)).toEqual(["video", "title"]);

    // two texts stacked over a video: all three show; text alone shows on its own
    const second = addTextClip(p, {
      picture: "/data/text/def.png",
      spec,
      start: 2,
      assetId: "text2",
      clipId: "subtitle",
      trackId: "v4",
    });
    if (!second.ok) throw new Error(second.error.message);
    expect(visible(second.project, 3)).toEqual(["video", "title", "subtitle"]);
    expect(visible(withText(12), 13)).toEqual(["title"]);
  });

  it("draws the text picture over the video with no background of its own", () => {
    useProjectStore.getState().loadProject(withText(2), "/p.cutvii", []);
    usePlaybackStore.setState({ playhead: 3, playing: false });
    render(<Preview />);
    const text = screen.getByTestId("text-layer");
    expect(text).toHaveAttribute("src", `asset://localhost${PICTURE}`);
    expect(text.style.backgroundColor).toBe("");
    expect(Number(text.style.zIndex)).toBeGreaterThan(Number(screen.getByTestId("video-layer").style.zIndex));
    expect(screen.getByTestId("video-layer")).toHaveStyle({ opacity: "1" });
    expect(screen.queryByTestId("image-layer")).not.toBeInTheDocument();
  });
});

describe("Add text", () => {
  beforeEach(() => {
    useProjectStore.getState().loadProject(makeProject(), "/p.cutvii", []);
    usePlaybackStore.setState({ playhead: 1.5, playing: false });
    useSelectionStore.getState().clear();
    useUiStore.getState().setNotice(null);
    vi.mocked(invoke).mockReset();
  });

  it("draws the default text in Rust and adds it at the playhead as one undoable step", async () => {
    vi.mocked(invoke).mockResolvedValue(PICTURE);
    await addTextAtPlayhead();
    expect(invoke).toHaveBeenCalledWith("render_text", {
      spec: defaultTextSpec(1080),
      width: 1920,
      height: 1080,
    });
    const { project } = useProjectStore.getState();
    expectValid(project);
    const asset = project.assets.at(-1)!;
    expect(asset).toMatchObject({ path: PICTURE, type: "image", text: { content: "Text" } });
    const clip = project.tracks.find((t) => t.id === IDS.v2)!.clips[0];
    expect(clip).toMatchObject({ assetId: asset.id, timelineStart: 1.5 });
    expect(useSelectionStore.getState().selectedClipIds).toEqual([clip.id]);

    // the inspector shows what works for text: no fit, background, sound or speed controls
    render(<Inspector />);
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Info"]);
    expect(screen.getByText("Text", { selector: "span" })).toBeInTheDocument();

    undo();
    const undone = useProjectStore.getState().project;
    expect(undone.assets).toHaveLength(4);
    expect(undone.tracks.every((t) => t.clips.length === 0)).toBe(true);
  });

  it("says why when the text cannot be drawn, and changes nothing", async () => {
    vi.mocked(invoke).mockRejectedValue("invalid input: invalid canvas size");
    const before = useProjectStore.getState().project;
    await addTextAtPlayhead();
    await waitFor(() => expect(useUiStore.getState().notice).toMatch(/Could not add text: .*canvas size/));
    expect(useProjectStore.getState().project).toBe(before);
  });
});
