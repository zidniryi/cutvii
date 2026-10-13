import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { Inspector } from "@/components/layout/Inspector";
import { Preview } from "@/components/layout/Preview";
import { layersAt } from "@/playback/engine";
import type { Project } from "@/project/model";
import { parseProject } from "@/project/parse";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useUiStore } from "@/store/ui";
import { expectValid, IDS, makeProject } from "@/test/makeProject";
import { addClip, splitClip } from "./edit";
import { undo } from "./editor";
import { keyAt, removeKey, setKey } from "./keyframes";
import { keyTime, setClipTransform, transformAt, transformStyle, valueAt } from "./transform";

/** A video ("below") on v1 and another ("above") on v2, both from timeline 2 s. */
function project(): Project {
  let p = makeProject();
  for (const [assetId, trackId, id] of [
    [IDS.vid, IDS.v1, "below"],
    [IDS.vid2, IDS.v2, "above"],
  ]) {
    const r = addClip(p, { assetId, trackId, start: 2, id });
    if (!r.ok) throw new Error(r.error.message);
    p = r.project;
  }
  return p;
}
const clipOf = (p: Project, id = "above") => p.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!;
const ok = (r: ReturnType<typeof setKey>) => {
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
};
/** "above" slides right from source 1 s to 3 s and fades over the same time. */
const animated = () => {
  let p = ok(setKey(project(), "above", "x", 1, 0));
  p = ok(setKey(p, "above", "x", 3, 0.5));
  p = ok(setKey(p, "above", "opacity", 3, 0.2));
  return ok(setKey(p, "above", "opacity", 1, 1));
};

describe("keyframes in the project", () => {
  it("interpolates in straight lines and holds before the first and after the last key", () => {
    const keys = [
      { t: 1, v: 0 },
      { t: 3, v: 0.5 },
      { t: 4, v: -0.5 },
    ];
    expect([0, 1, 2, 3, 3.5, 4, 9].map((t) => valueAt(keys, t))).toEqual([0, 0, 0.25, 0.5, 0, -0.5, -0.5]);
    expect(valueAt([{ t: 2, v: 0.7 }], 0)).toBe(0.7);
  });

  it("keeps keys in time order, replaces the one at the same time, and is valid to save", () => {
    const p = animated();
    expect(clipOf(p).keyframes).toEqual({
      x: [
        { t: 1, v: 0 },
        { t: 3, v: 0.5 },
      ],
      opacity: [
        { t: 1, v: 1 },
        { t: 3, v: 0.2 },
      ],
    });
    expectValid(p);
    const reopened = parseProject(JSON.parse(JSON.stringify(p)));
    expect(reopened.ok && clipOf(reopened.project).keyframes).toEqual(clipOf(p).keyframes);
    // within a frame of an existing key: that key changes, no second one appears
    const again = ok(setKey(p, "above", "x", 3.01, 0.4));
    expect(clipOf(again).keyframes!.x).toEqual([
      { t: 1, v: 0 },
      { t: 3, v: 0.4 },
    ]);
    expect(ok(setKey(p, "above", "x", 3, 0.5))).toBe(p); // nothing changes
  });

  it("refuses values out of range, sound, and files with bad keys", () => {
    expect(setKey(project(), "above", "opacity", 1, 1.5).ok).toBe(false);
    expect(setKey(project(), "above", "scale", 1, 0).ok).toBe(false);
    expect(setKey(project(), "above", "x", -1, 0).ok).toBe(false);
    expect(setKey(project(), "nobody", "x", 1, 0).ok).toBe(false);
    const bad = (keys: unknown) => {
      const raw = JSON.parse(JSON.stringify(animated()));
      const clip = raw.tracks
        .flatMap((t: { clips: { id: string }[] }) => t.clips)
        .find((c: { id: string }) => c.id === "above");
      clip.keyframes = keys;
      return parseProject(raw).ok;
    };
    expect(bad({ x: [{ t: 1, v: 0 }] })).toBe(true);
    expect(bad({ x: [] })).toBe(false);
    expect(
      bad({
        x: [
          { t: 2, v: 0 },
          { t: 1, v: 0 },
        ],
      }),
    ).toBe(false); // not in time order
    expect(bad({ opacity: [{ t: 1, v: 2 }] })).toBe(false);
    expect(bad({ volume: [{ t: 1, v: 1 }] })).toBe(false); // not a property that can be animated
  });

  it("removing the last key leaves the value it had; Reset transform removes every key", () => {
    let p = ok(setKey(project(), "above", "scale", 1, 0.5));
    p = ok(removeKey(p, "above", "scale", 1));
    expect(clipOf(p).keyframes).toBeUndefined();
    expect(clipOf(p).scale).toBe(0.5);
    const reset = setClipTransform(animated(), "above", null);
    expect(reset.ok && clipOf(reset.project).keyframes).toBeUndefined();
  });

  it("follows the picture through trim, split, speed and reverse", () => {
    const clip = clipOf(animated()); // timeline 2.., source 0..
    expect(keyTime(clip, 4)).toBe(2);
    expect(transformAt(clip, 4).x).toBeCloseTo(0.25); // source 2 s: half way
    expect(transformAt(clip, 0).x).toBe(0); // before the clip: the first value
    expect(transformAt({ ...clip, speed: 2 }, 3).x).toBeCloseTo(0.25); // twice as fast: source 2 s after 1 s
    const reversed = { ...clip, sourceIn: 0, sourceOut: 4, reversed: true };
    expect(transformAt(reversed, 3).x).toBeCloseTo(0.5); // 1 s in, playing back from 4: source 3 s
    // both halves of a split keep the keys, so the movement runs on across the cut
    const split = splitClip(animated(), "above", 4, "second");
    if (!split.ok) throw new Error(split.error.message);
    expect(transformAt(clipOf(split.project, "second"), 4.5).x).toBeCloseTo(0.375);
    expect(transformAt(clipOf(split.project, "above"), 3.5).x).toBeCloseTo(0.125);
  });
});

describe("keyframes in the preview and the inspector", () => {
  function open(p: Project, playhead: number) {
    useProjectStore.getState().loadProject(p, "/p.cutvii", []);
    usePlaybackStore.setState({ playhead, playing: false });
    useSelectionStore.getState().select("above");
    useUiStore.setState({ notice: null, inspectorTab: {} });
  }
  const stored = () => clipOf(useProjectStore.getState().project);

  it("moves and fades the layer as the playhead moves, and shows the track below", () => {
    expect(
      layersAt(animated(), 3)
        .filter((l) => l.visible)
        .map((l) => l.clip.id),
    ).toEqual(["below", "above"]);
    expect(transformStyle(clipOf(animated()), 4)).toEqual({ transform: "translate(25%, 0%)", opacity: 0.6 });
    open(animated(), 3); // source 1 s: the first keys
    render(<Preview />);
    const above = () => screen.getAllByTestId("video-layer")[1];
    expect(above().style.transform).toBe("");
    act(() => usePlaybackStore.getState().setPlayhead(4));
    expect(above().style.transform).toBe("translate(25%, 0%)");
    expect(above().style.opacity).toBe("0.6");
    act(() => usePlaybackStore.getState().setPlayhead(5.5)); // past the last key: held
    expect(above().style.transform).toBe("translate(50%, 0%)");
  });

  it("adds a keyframe at the playhead, edits it with the slider, and removes it", () => {
    open(project(), 3); // source 1 s
    render(<Inspector />);
    const panel = within(screen.getByRole("group", { name: "Transform" }));
    const slide = (name: RegExp, value: number) => {
      const el = panel.getByRole("slider", { name });
      fireEvent.change(el, { target: { value: String(value) } });
      fireEvent.pointerUp(el);
    };
    slide(/Scale/, 50);
    expect(stored().keyframes).toBeUndefined(); // no keyframes yet: the whole clip changes
    fireEvent.click(panel.getByRole("button", { name: "Add keyframe for Scale" }));
    expect(stored().keyframes).toEqual({ scale: [{ t: 1, v: 0.5 }] });
    expect(panel.getByRole("button", { name: "Remove keyframe for Scale" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // elsewhere on the timeline the slider adds a second key instead of changing the clip
    act(() => usePlaybackStore.getState().setPlayhead(5));
    expect(panel.getByRole("button", { name: "Add keyframe for Scale" })).toBeInTheDocument();
    slide(/Scale/, 150);
    expect(stored().keyframes!.scale).toEqual([
      { t: 1, v: 0.5 },
      { t: 3, v: 1.5 },
    ]);
    expect(stored().scale).toBe(0.5);
    // in between, the slider shows the value at the playhead
    act(() => usePlaybackStore.getState().setPlayhead(4));
    expect(panel.getByRole("slider", { name: /Scale/ })).toHaveValue("100");
    expectValid(useProjectStore.getState().project);

    undo(); // the second key
    expect(stored().keyframes!.scale).toHaveLength(1);
    act(() => usePlaybackStore.getState().setPlayhead(3));
    fireEvent.click(panel.getByRole("button", { name: "Remove keyframe for Scale" }));
    expect(stored().keyframes).toBeUndefined();
    expect(keyAt(stored(), "scale", 1)).toBeUndefined();
    expect(useUiStore.getState().notice).toBeNull();
  });
});
