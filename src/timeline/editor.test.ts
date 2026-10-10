import { useProjectStore } from "@/store/project";
import { usePlaybackStore } from "@/store/playback";
import { useSelectionStore } from "@/store/selection";
import { expectValid, IDS, makeProject } from "@/test/makeProject";
import { findClip } from "./clips";
import {
  addAssetToTimeline,
  deleteSelected,
  moveClipTo,
  redo,
  splitAtPlayhead,
  trimClipEdge,
  undo,
} from "./editor";

const state = () => useProjectStore.getState();
const clipCount = () => state().project.tracks.reduce((n, t) => n + t.clips.length, 0);

beforeEach(() => {
  useProjectStore.setState({ project: makeProject(), past: [], future: [] });
  useSelectionStore.setState({ selectedClipIds: [] });
  usePlaybackStore.setState({ playhead: 0 });
});

describe("history", () => {
  it("undoes and redoes edits in order", () => {
    addAssetToTimeline(IDS.vid);
    const id = useSelectionStore.getState().selectedClipIds[0];
    moveClipTo(id, 5);
    expect(findClip(state().project, id)!.clip.timelineStart).toBe(5);

    undo();
    expect(findClip(state().project, id)!.clip.timelineStart).toBe(0);
    undo();
    expect(clipCount()).toBe(0);
    expect(useSelectionStore.getState().selectedClipIds).toEqual([]); // stale selection pruned

    redo();
    redo();
    expect(findClip(state().project, id)!.clip.timelineStart).toBe(5);
    expectValid(state().project);
  });

  it("a new edit clears the redo stack; failed and no-op edits are not recorded", () => {
    addAssetToTimeline(IDS.vid);
    const id = useSelectionStore.getState().selectedClipIds[0];
    undo();
    expect(state().future).toHaveLength(1);
    addAssetToTimeline(IDS.vid2);
    expect(state().future).toHaveLength(0);

    const before = state().past.length;
    const id2 = useSelectionStore.getState().selectedClipIds[0];
    expect(moveClipTo(id2, -1).ok).toBe(false);
    expect(moveClipTo(id2, 0).ok).toBe(true); // already at 0: no-op
    expect(state().past).toHaveLength(before);
    expect(id).not.toBe(id2);
  });

  it("undo/redo with nothing to do is harmless", () => {
    undo();
    redo();
    expect(state().past).toHaveLength(0);
  });

  it("makes media import and removal undoable too, restoring the clips", () => {
    addAssetToTimeline(IDS.vid);
    state().removeAsset(IDS.vid);
    expect(clipCount()).toBe(0);
    undo();
    expect(clipCount()).toBe(1);
  });
});

describe("editor actions", () => {
  it("adds to the first compatible track, appended after existing clips", () => {
    addAssetToTimeline(IDS.vid);
    addAssetToTimeline(IDS.vid2);
    addAssetToTimeline(IDS.aud);
    const [v1, , a1] = state().project.tracks;
    expect(v1.clips.map((c) => c.timelineStart)).toEqual([0, 10]);
    expect(a1.clips).toHaveLength(1);
  });

  it("splits selected clips at the playhead as one undo step", () => {
    addAssetToTimeline(IDS.vid); // 0..10 on v1
    addAssetToTimeline(IDS.aud); // 0..20 on a1, now selected
    usePlaybackStore.getState().setPlayhead(4);
    useSelectionStore.getState().setSelection([state().project.tracks[0].clips[0].id]);
    const before = state().past.length;

    expect(splitAtPlayhead().ok).toBe(true);
    expect(state().project.tracks[0].clips).toHaveLength(2);
    expect(state().project.tracks[2].clips).toHaveLength(1); // unselected clip untouched
    expect(state().past).toHaveLength(before + 1);

    useSelectionStore.getState().clear();
    expect(splitAtPlayhead().ok).toBe(true); // nothing selected -> every clip under the playhead
    expect(state().project.tracks[2].clips).toHaveLength(2);
    expectValid(state().project);
  });

  it("split reports an error when no clip is under the playhead", () => {
    addAssetToTimeline(IDS.vid);
    usePlaybackStore.getState().setPlayhead(50);
    const r = splitAtPlayhead();
    expect(r.ok).toBe(false);
    expect(state().past).toHaveLength(1);
  });

  it("deletes the selection in one step and trims through the store", () => {
    addAssetToTimeline(IDS.vid);
    const id = useSelectionStore.getState().selectedClipIds[0];
    trimClipEdge(id, "end", 4);
    expect(findClip(state().project, id)!.clip.sourceOut).toBe(4);

    expect(deleteSelected().ok).toBe(true);
    expect(clipCount()).toBe(0);
    expect(useSelectionStore.getState().selectedClipIds).toEqual([]);
    expect(deleteSelected().ok).toBe(false);
    undo();
    expect(clipCount()).toBe(1);
  });
});
