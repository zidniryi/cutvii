import { act, fireEvent, render } from "@testing-library/react";
import { Preview } from "@/components/layout/Preview";
import { BEAT_TABLE } from "./beatFx";
import { clipBeats, frameAt, look, params, pulses, setupFor } from "./beatFxMath";
import { addClip } from "./edit";
import type { BeatEffect } from "@/project/model";
import { useBeatSafety } from "@/store/beatSafety";
import { useBeatStore } from "@/store/beats";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { useUiStore } from "@/store/ui";
import { IDS, makeProject } from "@/test/makeProject";
import type { BeatGrid } from "./beats";

const ID = "0123456789abcdef";
const GRID: BeatGrid = {
  version: 1,
  start: 0,
  end: 10,
  bpm: 120,
  offset: 0.25,
  clarity: 0.9,
  clear: true,
  steady: true,
  beats: Array.from({ length: 20 }, (_, i) => 0.25 + i * 0.5),
};
const fx = (kind: BeatEffect["kind"], intensity: number, everyNthBeat: 1 | 2 | 4 | 8 = 1, more = {}) =>
  ({ kind, intensity, everyNthBeat, offsetMs: 0, ...more }) as BeatEffect;

describe("beat effects: the preview's numbers are the export's", () => {
  /** The same rows are asserted in Rust (`the_preview_gets_the_same_numbers` in export/beatfx.rs). */
  it("match the Rust engine on a case with all four effects", () => {
    const list = pulses(
      [
        fx("zoom", 1),
        fx("shake", 0.8, 2, { offsetMs: 40, easing: "linear" }),
        fx("flash", 1, 1, { easing: "in-out" }),
        fx("glitch", 0.9),
      ],
      clipBeats(GRID, undefined, { sourceIn: 0, sourceOut: 10, speed: 1 }),
      true,
    );
    const want = [
      [0.1, 540, 960, 0, 0, 0, 0],
      [0.25, 622, 1104, 41, 72, 0, 10],
      [0.3, 616, 1096, 34, 59, 217, 5],
      [0.45, 562, 998, 10, 23, 0, 0],
      [0.52, 546, 970, 3, 4, 0, 0],
      [0.75, 622, 1104, 41, 72, 0, 10],
      [0.8, 600, 1066, 30, 53, 217, 5],
      [1.27, 612, 1088, 36, 64, 102, 8],
      [1.6, 540, 960, 0, 0, 0, 0],
    ];
    for (const [t, ...row] of want) {
      const p = params(frameAt(list, t), 540, 960);
      expect([p.scaledW, p.scaledH, p.x, p.y, p.flash, p.split], `at ${t} s`).toEqual(row);
    }
  });

  it("show an effect at the beat, not between beats, and nothing at strength 0", () => {
    const at = (list: BeatEffect[], t: number) =>
      look({ pulses: pulses(list, [1, 2], true), w: 320, h: 180 }, t);
    expect(at([fx("zoom", 1)], 1).transform).toContain("scale(1.15");
    expect(at([fx("zoom", 1)], 1.5).transform).toBeUndefined();
    expect(at([fx("zoom", 1)], 0.5).transform).toBeUndefined();
    expect(at([fx("zoom", 0)], 1).transform).toBeUndefined();
    // capped at 0.5 by Reduce flashing: mix = 0.5 (amount) * 0.5 (cap) * 0.5 (half way, linear)
    expect(at([fx("flash", 1, 1, { easing: "linear" })], 1.075).flash).toBeCloseTo(0.125, 2);
  });

  it("follow trim and speed, skip reversed clips, and cap a flash with Reduce flashing", () => {
    const clip = { sourceIn: 1, sourceOut: 5, speed: 2 };
    expect(clipBeats(GRID, undefined, clip)).toHaveLength(8);
    expect(clipBeats(GRID, undefined, clip)[0]).toBeCloseTo(0.125);
    const strong = pulses([fx("flash", 1)], [0, 0.25, 0.5, 0.75, 1], true);
    expect(strong[0].intensity).toBe(BEAT_TABLE.reduceFlashing.maxFlashIntensity);
    expect(strong[0].triggers).toEqual([0, 0.5, 1]);
    expect(pulses([fx("flash", 1)], [0, 0.25], false)[0].triggers).toEqual([0, 0.25]);
  });
});

describe("beat effects on the preview canvas", () => {
  const frame = () => document.querySelector('[data-role="beat-frame"]');
  const inner = () => document.querySelector<HTMLElement>('[data-role="beat-inner"]');
  const seek = (t: number) => act(() => usePlaybackStore.getState().setPlayhead(t));

  function load(effects: BeatEffect[], extra: Record<string, unknown> = {}) {
    const r = addClip(makeProject(), { assetId: IDS.vid, trackId: IDS.v1, start: 0, id: "c" });
    if (!r.ok) throw new Error(r.error.message);
    const p = {
      ...r.project,
      assets: r.project.assets.map((a) => (a.id === IDS.vid ? { ...a, width: 320, height: 180 } : a)),
      tracks: r.project.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => ({ ...c, beatFx: { effects, gridId: ID }, ...extra })),
      })),
    };
    useProjectStore.setState({ project: p, past: [], future: [] });
  }
  beforeEach(() => {
    useBeatStore.setState({ grids: { [ID]: GRID }, running: null });
    useBeatSafety.setState({ reduceFlashing: true });
    useUiStore.setState({ beatPreview: true });
    usePlaybackStore.setState({ playhead: 0, playing: false, mediaErrors: {} });
  });

  it("zooms at the beat and is plain between beats", () => {
    load([fx("zoom", 1)]);
    render(<Preview />);
    seek(0.25);
    expect(frame()).not.toBeNull();
    expect(inner()!.style.transform).toContain("scale(1.15");
    expect(document.querySelector("video")!.parentElement).toBe(inner());
    seek(0.65); // 0.4 s after the beat at 0.25, 0.1 s before the next
    expect(inner()!.style.transform).toBe("");
  });

  it("flashes white and splits the colours, and 'Preview on canvas' off draws neither", () => {
    load([fx("flash", 1, 1, { easing: "linear" }), fx("glitch", 1)]);
    render(<Preview />);
    seek(0.3);
    const flash = document.querySelector<HTMLElement>('[data-role="beat-flash"]')!;
    expect(Number(flash.style.opacity)).toBeGreaterThan(0.1);
    expect(inner()!.style.filter).toMatch(/url\(.?#beat-split-/);
    expect(document.querySelector("feOffset")).not.toBeNull();
    act(() => useUiStore.getState().setBeatPreview(false));
    expect(frame()).toBeNull();
    expect(document.querySelector("video")).not.toBeNull();
  });

  it("is not used for a clip without a detected grid, a reversed clip or intensity 0", () => {
    load([fx("zoom", 0)]);
    render(<Preview />);
    seek(0.25);
    expect(frame()).toBeNull();
    expect(
      setupFor(
        useProjectStore.getState().project.tracks[0].clips[0],
        { type: "video", width: 320, height: 180 },
        undefined,
        true,
      ),
    ).toBeNull();
    fireEvent.click(document.body);
  });
});
