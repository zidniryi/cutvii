import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { Inspector } from "@/components/layout/Inspector";
import { Preview } from "@/components/layout/Preview";
import { StyleEditor } from "@/components/text/StyleEditor";
import type { Project, TextSpec } from "@/project/model";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { PREFS_KEY, useTextStyleStore } from "@/store/textStyles";
import { useUiStore } from "@/store/ui";
import { expectValid, IDS, makeProject } from "@/test/makeProject";
import { addClip } from "./edit";
import { undo } from "./editor";
import { addSubtitleClips, subtitleSpec, type DrawnSubtitle } from "./subtitles";
import { addTextClip } from "./text";
import {
  anchorOf,
  anchorPosition,
  ANCHORS,
  DEFAULT_SUBTITLE_POSITION,
  movedOnTheirOwn,
  moveTrackTexts,
  resetTrackPositions,
  SAFE_MARGIN,
  snapPosition,
  textBounds,
  trackPosition,
  trackTexts,
} from "./textPosition";

const canvas = { width: 1920, height: 1080 };
const spec: TextSpec = { content: "Hello", fontSize: 64, color: "#FFFFFF", align: "center", x: 0.4, y: 0.3 };

/** A video with three subtitle lines ("s1".."s3") on their own track, s2 selected. */
function subtitled(): Project {
  const base = addClip(makeProject(), { assetId: IDS.vid, trackId: IDS.v1, start: 0, id: "video" });
  if (!base.ok) throw new Error(base.error.message);
  const items: DrawnSubtitle[] = ["One", "Two", "Three"].map((text, i) => ({
    start: i * 2,
    duration: 1.5,
    text,
    spec: subtitleSpec(text, 1080),
    picture: `/data/text/${text}.png`,
    assetId: `a${i + 1}`,
    clipId: `s${i + 1}`,
  }));
  const r = addSubtitleClips(base.project, items, "subs");
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
}
const specOf = (clipId: string) => {
  const p = useProjectStore.getState().project;
  const clip = p.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)!;
  return p.assets.find((a) => a.id === clip.assetId)!.text!;
};
const at = (clipId: string) => ({ x: specOf(clipId).x, y: specOf(clipId).y });

beforeEach(() => {
  useTextStyleStore.getState().reset();
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation((async (cmd: string, args?: { spec?: TextSpec }) => {
    if (cmd === "render_text")
      return `/data/text/${args?.spec?.content}-${args?.spec?.x}-${args?.spec?.y}.png`;
    if (cmd === "text_fonts") return [{ family: "Noto Sans", bundled: true }];
    return undefined;
  }) as never);
});

describe("anchors", () => {
  it("only work out x / y, inside the safe margin or at the canvas edge", () => {
    for (const safe of [true, false]) {
      const margin = safe ? SAFE_MARGIN : 0;
      for (const anchor of ANCHORS) {
        const to = anchorPosition(anchor.id, spec, canvas, safe);
        expect(Object.keys(to).sort()).toEqual(["x", "y"]);
        const b = textBounds(spec, canvas, to);
        if (anchor.col === 0) expect(b.left).toBeCloseTo(margin, 2);
        if (anchor.col === 1) expect((b.left + b.right) / 2).toBeCloseTo(0.5, 2);
        if (anchor.col === 2) expect(b.right).toBeCloseTo(1 - margin, 2);
        if (anchor.row === 0) expect(b.top).toBeCloseTo(margin, 2);
        if (anchor.row === 1) expect(to.y).toBe(0.5);
        if (anchor.row === 2) expect(b.bottom).toBeCloseTo(1 - margin, 2);
        expect(anchorOf({ ...spec, ...to }, canvas, safe)).toBe(anchor.id);
      }
    }
    expect(anchorOf(spec, canvas, true)).toBeNull(); // a custom position
  });

  it("leave the alignment alone, and reach the edge the words are aligned towards", () => {
    const right = { ...spec, align: "right" as const };
    const left = { ...spec, align: "left" as const };
    const toRight = anchorPosition("bottom-right", right, canvas, true);
    expect(textBounds(right, canvas, toRight).right).toBeCloseTo(1 - SAFE_MARGIN, 2);
    const toLeft = anchorPosition("top-left", left, canvas, true);
    expect(textBounds(left, canvas, toLeft).left).toBeCloseTo(SAFE_MARGIN, 2);
    // short left-aligned words cannot reach the right edge: x stays a valid share of the canvas
    expect(anchorPosition("bottom-right", left, canvas, true).x).toBe(1);
  });
});

describe("snapping while dragging", () => {
  it("pulls onto the centre lines when close, and not when far", () => {
    expect(snapPosition({ x: 0.508, y: 0.492 }, spec, canvas, true)).toEqual({
      x: 0.5,
      y: 0.5,
      vertical: [0.5],
      horizontal: [0.5],
    });
    expect(snapPosition({ x: 0.56, y: 0.42 }, spec, canvas, true)).toEqual({
      x: 0.56,
      y: 0.42,
      vertical: [],
      horizontal: [],
    });
  });

  it("pulls the edges of the words onto the safe margin only when it is on", () => {
    const top = anchorPosition("top-left", spec, canvas, true);
    const near = { x: 0.112, y: 0.079 };
    expect(Math.abs(near.x - top.x)).toBeLessThan(0.015);
    expect(snapPosition(near, spec, canvas, true)).toEqual({
      ...top,
      vertical: [SAFE_MARGIN],
      horizontal: [SAFE_MARGIN],
    });
    expect(snapPosition(near, spec, canvas, false)).toMatchObject({ ...near, vertical: [], horizontal: [] });
  });

  it("shows the guides in the preview and saves the snapped place as one undo step", async () => {
    const base = addClip(makeProject(), { assetId: IDS.vid, trackId: IDS.v1, start: 0, id: "video" });
    if (!base.ok) throw new Error(base.error.message);
    const r = addTextClip(base.project, {
      picture: "/data/text/t.png",
      spec: { ...spec, x: 0.3, y: 0.3 },
      start: 0,
      assetId: "text",
      clipId: "title",
      trackId: "tt",
    });
    if (!r.ok) throw new Error(r.error.message);
    useProjectStore.getState().loadProject(r.project, "/p.cutvii", []);
    usePlaybackStore.setState({ playhead: 1, playing: false });
    render(<Preview />);
    const stage = screen.getByTestId("preview-stage");
    stage.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1000, height: 500, right: 1000, bottom: 500, x: 0, y: 0 }) as DOMRect;
    expect(screen.queryByTestId("position-guides")).toBeNull();
    fireEvent.pointerDown(stage, { button: 0, clientX: 300, clientY: 150, pointerId: 1 });
    fireEvent.pointerMove(stage, { clientX: 495, clientY: 252, pointerId: 1 }); // nearly the middle
    const guides = screen.getByTestId("position-guides");
    expect(guides.querySelector('[data-guide="safe-zone"]')).not.toBeNull();
    expect(guides.querySelector('[data-guide="vertical-0.5"]')).not.toBeNull();
    expect(guides.querySelector('[data-guide="horizontal-0.5"]')).not.toBeNull();
    fireEvent.pointerUp(stage, { pointerId: 1 });
    await waitFor(() => expect(at("title")).toEqual({ x: 0.5, y: 0.5 }));
    expect(useProjectStore.getState().past).toHaveLength(1);

    // Alt moves freely; with the safe margin off there is no safe-zone guide
    useTextStyleStore.getState().setSafeMargin(false);
    fireEvent.pointerDown(stage, { button: 0, clientX: 500, clientY: 250, pointerId: 2 });
    fireEvent.pointerMove(stage, { clientX: 505, clientY: 255, pointerId: 2, altKey: true });
    expect(screen.getByTestId("position-guides").children).toHaveLength(0);
    fireEvent.pointerUp(stage, { pointerId: 2 });
    await waitFor(() => expect(at("title")).toEqual({ x: 0.505, y: 0.51 }));
  });
});

describe("moving a track of texts", () => {
  beforeEach(() => {
    useProjectStore.getState().loadProject(subtitled(), "/p.cutvii", []);
    usePlaybackStore.setState({ playhead: 2.5, playing: false });
    useSelectionStore.getState().select("s2");
    useUiStore.setState({ notice: null, inspectorTab: {} });
  });

  it("moves every line in ONE undo step", async () => {
    expect(await moveTrackTexts("s2", { x: 0.5, y: 0.2 })).toBeNull();
    expect(["s1", "s2", "s3"].map(at)).toEqual(Array(3).fill({ x: 0.5, y: 0.2 }));
    expectValid(useProjectStore.getState().project);
    expect(useProjectStore.getState().past).toHaveLength(1);
    undo();
    expect(["s1", "s2", "s3"].map(at)).toEqual(Array(3).fill(DEFAULT_SUBTITLE_POSITION));
  });

  it("keeps a line that was moved on its own until Reset to style", async () => {
    render(<Inspector />);
    const position = () => within(screen.getByRole("group", { name: "Position" }));
    // moved alone: an override
    fireEvent.click(position().getByRole("radio", { name: "Top centre" }));
    await waitFor(() => expect(at("s2").y).toBeLessThan(0.2));
    const own = at("s2");
    expect(at("s1")).toEqual(DEFAULT_SUBTITLE_POSITION);
    const texts = () => trackTexts(useProjectStore.getState().project, "s1");
    expect(trackPosition(texts())).toEqual(DEFAULT_SUBTITLE_POSITION);
    expect(movedOnTheirOwn(texts()).map((t) => t.clip.id)).toEqual(["s2"]);
    expect(screen.getByText("1 moved on its own")).toBeInTheDocument();

    // a track-wide move from another line leaves it alone
    expect(await moveTrackTexts("s1", { x: 0.5, y: 0.6 })).toBeNull();
    expect([at("s1"), at("s3")]).toEqual(Array(2).fill({ x: 0.5, y: 0.6 }));
    expect(at("s2")).toEqual(own);

    const steps = useProjectStore.getState().past.length;
    fireEvent.click(screen.getByRole("button", { name: "Reset to style" }));
    await waitFor(() => expect(at("s2")).toEqual({ x: 0.5, y: 0.6 }));
    expect(useProjectStore.getState().past).toHaveLength(steps + 1);
    expect(movedOnTheirOwn(texts())).toHaveLength(0);
    expect(await resetTrackPositions("s1")).toBeNull(); // nothing left to do: no empty undo step
    expect(useProjectStore.getState().past).toHaveLength(steps + 1);
  });

  it("moves the whole track from the inspector when Move all is on, by anchor or by number", async () => {
    render(<Inspector />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Move all 3 texts on this track" }));
    const x = screen.getByRole("spinbutton", { name: "X (%)" });
    fireEvent.change(x, { target: { value: "30" } });
    fireEvent.keyDown(x, { key: "Enter" });
    await waitFor(() => expect(["s1", "s2", "s3"].map((id) => at(id).x)).toEqual([0.3, 0.3, 0.3]));
    expect(useProjectStore.getState().past).toHaveLength(1);
    expect(specOf("s1").align).toBe("center"); // alignment is a separate control

    fireEvent.click(screen.getByRole("button", { name: "Reset position" }));
    await waitFor(() => expect(at("s2")).toEqual({ x: 0.5, y: 0.5 }));
    expect(useProjectStore.getState().past).toHaveLength(2);
  });
});

describe("the Position group in the style editor", () => {
  it("is the same control, with Safe margin on by default and remembered", () => {
    const moves: unknown[] = [];
    render(
      <StyleEditor
        value={{ style: { color: "#FFFFFF" } }}
        label="Default"
        onChange={() => {}}
        position={{
          spec: subtitleSpec("A line of subtitles", 1080),
          canvas,
          resetTo: DEFAULT_SUBTITLE_POSITION,
          onChange: (to) => moves.push(to),
        }}
      />,
    );
    const position = within(screen.getByRole("group", { name: "Position" }));
    expect(position.getAllByRole("radio")).toHaveLength(9);
    expect(position.getByRole("checkbox", { name: "Safe margin" })).toBeChecked();
    expect(position.getByRole("button", { name: "Reset position" })).toBeDisabled();
    fireEvent.click(position.getByRole("radio", { name: "Top centre" }));
    fireEvent.click(position.getByRole("checkbox", { name: "Safe margin" }));
    fireEvent.click(position.getByRole("radio", { name: "Top centre" }));
    const [inside, edge] = moves as { x: number; y: number }[];
    expect(inside.x).toBe(0.5);
    expect(inside.y - edge.y).toBeCloseTo(SAFE_MARGIN, 3);
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!).safeMargin).toBe(false);
  });

  it("has a Font size for subtitles, kept in local preferences and used for new subtitles", () => {
    const sizes: number[] = [];
    render(
      <StyleEditor
        value={{ style: { color: "#FFFFFF" } }}
        label="Default"
        onChange={() => {}}
        size={{ value: 0.045, min: 0.02, max: 0.2, canvasHeight: 1080, onChange: (v) => sizes.push(v) }}
      />,
    );
    const slider = screen.getByRole("slider", { name: "Font size" });
    expect(slider).toHaveValue("4.5");
    expect(screen.getByText("49 px (4.5%)")).toBeInTheDocument();
    fireEvent.change(slider, { target: { value: "8" } });
    expect(sizes).toEqual([0.08]);

    useTextStyleStore.getState().setSubtitleSize(0.08);
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!).subtitleSize).toBe(0.08);
    expect(subtitleSpec("Hi", 1080, DEFAULT_SUBTITLE_POSITION, 0.08).fontSize).toBe(86);
    expect(subtitleSpec("Hi", 1080).fontSize).toBe(49); // the usual size without a choice
    useTextStyleStore.getState().setSubtitleSize(5);
    expect(useTextStyleStore.getState().subtitleSize).toBe(0.2); // kept within limits
  });

  it("keeps the subtitle position in local preferences and puts new subtitles there", () => {
    useTextStyleStore.getState().setSubtitlePosition({ x: 0.5, y: 0.12 });
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!).subtitlePosition).toEqual({ x: 0.5, y: 0.12 });
    expect(subtitleSpec("Hi", 1080, useTextStyleStore.getState().subtitlePosition!)).toMatchObject({
      x: 0.5,
      y: 0.12,
      align: "center",
    });
    useTextStyleStore.getState().setSubtitlePosition({ x: 2, y: 0 });
    expect(useTextStyleStore.getState().subtitlePosition).toBeNull(); // out of range: back to the usual place
  });
});
