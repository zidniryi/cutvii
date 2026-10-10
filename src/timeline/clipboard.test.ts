import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { expectValid, IDS, makeProject } from "@/test/makeProject";
import { copySelected, cutSelected, pasteAtPlayhead, pasteClips, useClipboardStore } from "./clipboard";
import { addAssetToTimeline, undo } from "./editor";
import { resolveShortcut } from "./shortcuts";

const state = () => useProjectStore.getState();
const lane = (i: number) => state().project.tracks[i].clips;

beforeEach(() => {
  useProjectStore.setState({ project: makeProject(), past: [], future: [] });
  useSelectionStore.setState({ selectedClipIds: [] });
  usePlaybackStore.setState({ playhead: 0 });
  useClipboardStore.setState({ items: [] });
});

describe("clip clipboard", () => {
  it("cut removes the selection in one undo step and keeps it for pasting", () => {
    addAssetToTimeline(IDS.vid); // 0..10 on v1, selected
    const before = state().past.length;
    expect(cutSelected().ok).toBe(true);
    expect(lane(0)).toHaveLength(0);
    expect(state().past).toHaveLength(before + 1);
    expect(state().past.at(-1)?.label).toBe("Cut clip");
    expect(useSelectionStore.getState().selectedClipIds).toEqual([]);

    undo();
    expect(lane(0)).toHaveLength(1);
    expect(cutSelected().ok).toBe(false); // nothing selected after undo pruned it
  });

  it("copy + paste puts a new clip at the playhead on the same track, sliding past what is there", () => {
    addAssetToTimeline(IDS.vid2); // 0..4
    expect(copySelected()).toBe(1);
    usePlaybackStore.setState({ playhead: 2 }); // inside the original
    expect(pasteAtPlayhead().ok).toBe(true);

    expect(lane(0).map((c) => c.timelineStart)).toEqual([0, 4]);
    expect(new Set(lane(0).map((c) => c.id)).size).toBe(2); // a new id, not a shared one
    expect(useSelectionStore.getState().selectedClipIds).toEqual([lane(0)[1].id]);
    expectValid(state().project);

    usePlaybackStore.setState({ playhead: 20 });
    pasteAtPlayhead(); // the clipboard survives a paste
    expect(lane(0).map((c) => c.timelineStart)).toEqual([0, 4, 20]);
  });

  it("several clips keep their spacing and their own tracks", () => {
    addAssetToTimeline(IDS.vid2, { start: 1 }); // v1: 1..5
    const a = useSelectionStore.getState().selectedClipIds[0];
    addAssetToTimeline(IDS.aud, { start: 3 }); // a1: 3..23
    const b = useSelectionStore.getState().selectedClipIds[0];
    useSelectionStore.getState().setSelection([a, b]);
    copySelected();

    const r = pasteClips(
      state().project,
      useClipboardStore.getState().items,
      30,
      (() => {
        let n = 0;
        return () => `p${n++}`;
      })(),
    )!;
    const starts = r.project.tracks.map((t) => t.clips.map((c) => c.timelineStart));
    expect(starts[0]).toEqual([1, 30]); // video copy at the paste time
    expect(starts[2]).toEqual([3, 32]); // audio copy keeps the 2 s offset
    expectValid(r.project);
  });

  it("paste does nothing useful when the clipboard is empty or the media is gone", () => {
    expect(pasteAtPlayhead().ok).toBe(false);
    addAssetToTimeline(IDS.vid);
    copySelected();
    state().removeAsset(IDS.vid);
    expect(pasteAtPlayhead().ok).toBe(false);
  });

  it("Ctrl/Cmd+X, C and V are recognised, and left to the field while typing", () => {
    const k = (key: string, typing = false) =>
      resolveShortcut(
        { key, ctrlKey: false, metaKey: true, shiftKey: false, altKey: false },
        { typing, onButton: false },
      )?.action ?? null;
    expect([k("x"), k("c"), k("v")]).toEqual(["cut", "copy", "paste"]);
    expect([k("x", true), k("c", true), k("v", true)]).toEqual([null, null, null]);
  });
});
