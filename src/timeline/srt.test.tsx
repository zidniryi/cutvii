import { fireEvent, render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { Timeline } from "@/components/layout/Timeline";
import type { Project } from "@/project/model";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useUiStore } from "@/store/ui";
import { IDS, makeProject } from "@/test/makeProject";
import { addClip } from "./edit";
import { parseSrt } from "./karaoke";
import { exportSrt, formatSrt, srtTime, subtitleCues, textTrackOf } from "./srt";

/** A text on `trackId` from `start` for `length` seconds. */
function withText(p: Project, id: string, trackId: string, start: number, length: number, content: string) {
  const asset = {
    id: `asset-${id}`,
    path: `/text/${id}.png`,
    type: "image" as const,
    text: { content, fontSize: 64, color: "#FFFFFF", bold: true, align: "center" as const, x: 0.5, y: 0.9 },
  };
  // added out of the way first: a new picture clip is longer than these texts
  const far = 1000 + p.assets.length * 100;
  const r = addClip({ ...p, assets: [...p.assets, asset] }, { assetId: asset.id, trackId, start: far, id });
  if (!r.ok) throw new Error(r.error.message);
  return {
    ...r.project,
    tracks: r.project.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) =>
        c.id === id ? { ...c, timelineStart: start, sourceIn: 0, sourceOut: length } : c,
      ),
    })),
  };
}
/** A video on v1, two subtitles on v2 (added out of order) and a title on v1 after the video. */
function project(): Project {
  const video = addClip(makeProject(), { assetId: IDS.vid, trackId: IDS.v1, start: 0, id: "video" });
  if (!video.ok) throw new Error(video.error.message);
  let p = withText(video.project, "second", IDS.v2, 3.5, 2.25, "  Apa kabar?\n\n  Baik.  ");
  p = withText(p, "first", IDS.v2, 1, 1.5, "Halo dunia");
  p = withText(p, "blank", IDS.v2, 8, 1, "   ");
  return withText(p, "title", IDS.v1, 12, 2, "The end");
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  useUiStore.getState().setNotice(null);
});

describe("subtitles as .srt", () => {
  it("writes times as HH:MM:SS,mmm", () => {
    expect([0, 1.5, 59.9996, 3723.042, -1].map(srtTime)).toEqual([
      "00:00:00,000",
      "00:00:01,500",
      "00:01:00,000",
      "01:02:03,042",
      "00:00:00,000",
    ]);
  });

  it("makes one cue per text of a track, in time order, without empty texts or blank lines", () => {
    const p = project();
    expect(textTrackOf(p, "first")).toBe(IDS.v2);
    expect(textTrackOf(p, "video")).toBeNull();
    const text = formatSrt(subtitleCues(p, IDS.v2));
    expect(text).toBe(
      "1\n00:00:01,000 --> 00:00:02,500\nHalo dunia\n\n2\n00:00:03,500 --> 00:00:05,750\nApa kabar?\nBaik.\n",
    );
    // every track: the title on the other track comes last
    expect(subtitleCues(p).map((c) => c.text)).toEqual(["Halo dunia", "Apa kabar?\nBaik.", "The end"]);
    expect(formatSrt([{ start: 2, end: 2, text: "gone" }])).toBe("");
    // CutVii's own .srt reader gets the same lines back
    expect(parseSrt(text).map((l) => [l.start, l.end, l.text])).toEqual([
      [1, 2.5, "Halo dunia"],
      [3.5, 5.75, "Apa kabar? Baik."],
    ]);
  });

  it("saves through Rust under the project's name and says how many were saved", async () => {
    useProjectStore.getState().loadProject({ ...project(), name: "Liburan" }, "/p.cutvii", []);
    vi.mocked(invoke).mockResolvedValue("/Users/me/Liburan.srt");
    expect(await exportSrt("first")).toBe("/Users/me/Liburan.srt");
    expect(invoke).toHaveBeenCalledWith("export_srt", {
      name: "Liburan",
      text: formatSrt(subtitleCues(project(), IDS.v2)),
    });
    expect(useUiStore.getState().notice).toBe("Saved 2 subtitles to /Users/me/Liburan.srt");

    // no text clip given (or a clip that is not text): every text on the timeline
    await exportSrt("video");
    expect(vi.mocked(invoke).mock.calls[1][1]).toEqual({
      name: "Liburan",
      text: formatSrt(subtitleCues(project())),
    });
  });

  it("stays quiet when the dialog is dismissed, and explains a failure or an empty timeline", async () => {
    useProjectStore.getState().loadProject(project(), "/p.cutvii", []);
    vi.mocked(invoke).mockResolvedValueOnce(null);
    expect(await exportSrt()).toBeNull();
    expect(useUiStore.getState().notice).toBeNull();
    vi.mocked(invoke).mockRejectedValueOnce("io error: disk full");
    expect(await exportSrt()).toBeNull();
    expect(useUiStore.getState().notice).toContain("disk full");

    vi.mocked(invoke).mockClear();
    useProjectStore.getState().loadProject(makeProject(), "/p.cutvii", []);
    expect(await exportSrt()).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
    expect(useUiStore.getState().notice).toMatch(/no text/);
  });

  it("has a Subtitles button in the timeline toolbar that opens the clip's subtitle tools", () => {
    useProjectStore.getState().loadProject(project(), "/p.cutvii", []);
    useUiStore.setState({ inspectorTab: {} });
    render(<Timeline />);
    fireEvent.click(screen.getByRole("button", { name: "Auto subtitles" }));
    expect(useSelectionStore.getState().selectedClipIds).toEqual(["video"]); // the clip with speech
    expect(useUiStore.getState().inspectorTab.video).toBe("ai");
  });

  it("is offered in the menu of a text clip only", () => {
    useProjectStore.getState().loadProject(project(), "/p.cutvii", []);
    vi.mocked(invoke).mockResolvedValue(null);
    render(<Timeline />);
    fireEvent.contextMenu(document.querySelector('[data-clip-id="video"]')!);
    expect(screen.queryByRole("menuitem", { name: /Export subtitles/ })).toBeNull();
    fireEvent.contextMenu(document.querySelector('[data-clip-id="first"]')!);
    fireEvent.click(screen.getByRole("menuitem", { name: /Export subtitles/ }));
    expect(invoke).toHaveBeenCalledWith("export_srt", expect.objectContaining({ name: "Test" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
