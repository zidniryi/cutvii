import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { Inspector } from "@/components/layout/Inspector";
import { Preview } from "@/components/layout/Preview";
import type { Project, TextSpec } from "@/project/model";
import { parseProject } from "@/project/parse";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useStylePreviewStore } from "@/store/stylePreviews";
import { useTextStyleStore } from "@/store/textStyles";
import { useUiStore } from "@/store/ui";
import { expectValid, IDS, makeProject } from "@/test/makeProject";
import { addClip, splitClip } from "./edit";
import { undo } from "./editor";
import { addTextAtPlayhead, addTextClip, applyTextStyle, setTextFade } from "./text";
import { findStyle, matchesStyle, STYLE_PRESETS, withStyle } from "./textStyles";

const plain: TextSpec = {
  content: "Hello\nworld",
  fontSize: 64,
  color: "#FFFFFF",
  bold: true,
  align: "left",
  x: 0.3,
  y: 0.8,
};
const preset = (id: string) => findStyle(id)!;

/** A video on v1 at 0..10 with a plain text ("title") over it at 2..7. */
function project(): Project {
  const base = addClip(makeProject(), { assetId: IDS.vid, trackId: IDS.v1, start: 0, id: "video" });
  if (!base.ok) throw new Error(base.error.message);
  const r = addTextClip(base.project, {
    picture: "/data/text/plain.png",
    spec: plain,
    start: 2,
    assetId: "text",
    clipId: "title",
    trackId: "new-track",
  });
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
}
const clipOf = (id = "title") =>
  useProjectStore
    .getState()
    .project.tracks.flatMap((t) => t.clips)
    .find((c) => c.id === id)!;
const specOf = (id = "title") =>
  useProjectStore.getState().project.assets.find((a) => a.id === clipOf(id).assetId)!.text!;
/** Rust draws; the picture's name tells which font it was asked for. */
function rust() {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation((async (cmd: string, args?: { spec: TextSpec }) => {
    if (cmd === "text_style_preview") {
      const label = (args as unknown as { label: string }).label;
      if (label === "Boxed") throw new Error("no picture"); // one style whose picture cannot be made
      return `/cache/styles/${label}.png`;
    }
    if (cmd === "text_fonts") return [{ family: "Noto Sans", bundled: true }];
    if (cmd === "render_text")
      return `/data/text/${args?.spec.font ?? "default"}-${args?.spec.content.length}.png`;
    return undefined;
  }) as never);
}
function load() {
  useProjectStore.getState().loadProject(project(), "/p.cutvii", []);
  usePlaybackStore.setState({ playhead: 3, playing: false });
  useSelectionStore.getState().select("title");
  useUiStore.setState({ notice: null, inspectorTab: {} });
  useStylePreviewStore.setState({ previews: {}, asked: {} });
  useTextStyleStore.getState().reset();
  rust();
}

describe("text style presets", () => {
  it("are the twenty-one bundled styles, each valid and with its own id and name", () => {
    expect(STYLE_PRESETS).toHaveLength(21);
    expect(STYLE_PRESETS.slice(0, 3).map((p) => p.id)).toEqual(["clean-caption", "two-tone", "outline-pop"]);
    expect(new Set(STYLE_PRESETS.map((p) => p.id)).size).toBe(21);
    expect(new Set(STYLE_PRESETS.map((p) => p.name)).size).toBe(21);
    expect(STYLE_PRESETS.every((p) => typeof p.style.font === "string")).toBe(true);
    // the three box shapes, a highlighted line, capitals and a fade are all in use
    expect(preset("boxed").style.box?.shape).toBe("rect");
    expect(preset("highlighter").style.box?.shape).toBe("per-line");
    expect(preset("hot-take").style).toMatchObject({ uppercase: true, box: { shape: "jagged" } });
    expect(preset("two-tone").style.highlight).toEqual({ color: "#FFD233", lines: "last" });
    expect(preset("lyric-fade").fade).toBeGreaterThan(0);
    expect(preset("minimal").style).toEqual({ font: "Work Sans", color: "#F2F0ED" });
  });

  it("restyle a text without touching its words, size, alignment or place", () => {
    const boxed = withStyle(plain, preset("boxed").style);
    expect(boxed).toMatchObject({ content: "Hello\nworld", fontSize: 64, align: "left", x: 0.3, y: 0.8 });
    expect(boxed.box).toEqual(preset("boxed").style.box);
    expect(matchesStyle(boxed, preset("boxed").style)).toBe(true);
    expect(matchesStyle(plain, preset("boxed").style)).toBe(false);

    // going on to another style leaves nothing of the previous one behind
    const minimal = withStyle(boxed, preset("minimal").style);
    expect("box" in minimal || "bold" in minimal || "uppercase" in minimal).toBe(false);
    expect(Object.values(minimal)).not.toContain(undefined);
    expect(matchesStyle(minimal, preset("minimal").style)).toBe(true);
    // every styled text is a valid project value
    for (const p of STYLE_PRESETS) {
      const styled = project();
      styled.assets.find((a) => a.id === "text")!.text = withStyle(plain, p.style);
      expectValid(styled);
    }
  });

  it("rejects style values outside their limits in project files", () => {
    const errors = (text: unknown) => {
      const p = project();
      Object.assign(
        p.assets.find((a) => a.id === "text")!,
        { text },
      );
      const r = parseProject(p);
      return r.ok ? [] : r.errors;
    };
    const boxed = withStyle(plain, preset("boxed").style);
    expect(errors(boxed)).toHaveLength(0);
    expect(errors({ ...boxed, box: { ...boxed.box, shape: "star" } })).not.toHaveLength(0);
    expect(errors({ ...boxed, box: { ...boxed.box, opacity: 2 } })).not.toHaveLength(0);
    expect(errors({ ...plain, outline: { color: "#000000", width: 0 } })).not.toHaveLength(0);
    expect(
      errors({ ...plain, shadow: { color: "black", blur: 0.1, x: 0, y: 0, opacity: 1 } }),
    ).not.toHaveLength(0);
    expect(errors({ ...plain, highlight: { color: "#FFD233", lines: "third" } })).not.toHaveLength(0);
    expect(errors({ ...plain, glow: true })).not.toHaveLength(0);
  });
});

describe("restyling a text clip", () => {
  beforeEach(load);

  it("is ONE undo step, including the fade a style brings or takes away", async () => {
    expect(await applyTextStyle("title", preset("lyric-fade"))).toBeNull();
    expect(invoke).toHaveBeenCalledWith(
      "render_text",
      expect.objectContaining({ spec: withStyle(plain, preset("lyric-fade").style) }),
    );
    expect(matchesStyle(specOf(), preset("lyric-fade").style)).toBe(true);
    expect(clipOf()).toMatchObject({ fadeIn: 0.5, fadeOut: 0.5 });
    expectValid(useProjectStore.getState().project);
    expect(useProjectStore.getState().past).toHaveLength(1);

    // a style without a fade removes it again, also in one step
    expect(await applyTextStyle("title", preset("boxed"))).toBeNull();
    expect("fadeIn" in clipOf() || "fadeOut" in clipOf()).toBe(false);
    expect(useProjectStore.getState().past).toHaveLength(2);
    undo();
    expect(clipOf()).toMatchObject({ fadeIn: 0.5, fadeOut: 0.5 });
    expect(matchesStyle(specOf(), preset("lyric-fade").style)).toBe(true);
    undo();
    expect(specOf()).toEqual(plain);
    expect("fadeIn" in clipOf()).toBe(false);
  });

  it("only restyles the clip it was asked to, even when a split left two clips sharing one text", async () => {
    const split = splitClip(project(), "title", 4, "second-half");
    if (!split.ok) throw new Error(split.error.message);
    useProjectStore.getState().loadProject(split.project, "/p.cutvii", []);
    await applyTextStyle("second-half", preset("hot-take"));
    expect(specOf("second-half").uppercase).toBe(true);
    expect(specOf("title")).toEqual(plain);
    expectValid(useProjectStore.getState().project);
  });

  it("adds a new text already in a style, with its fade", async () => {
    await addTextAtPlayhead(preset("lyric-fade"));
    const added = useProjectStore.getState().project.assets.at(-1)!;
    expect(matchesStyle(added.text!, preset("lyric-fade").style)).toBe(true);
    expect(added.text).toMatchObject({ content: "Text", x: 0.5, y: 0.5 });
    const clip = clipOf(useSelectionStore.getState().selectedClipIds[0]);
    expect(clip).toMatchObject({ assetId: added.id, fadeIn: 0.5, fadeOut: 0.5 });
    expectValid(useProjectStore.getState().project);
    expect(useProjectStore.getState().past).toHaveLength(1);
  });

  it("sets a text's fade on its own, within limits", () => {
    const p = project();
    const faded = setTextFade(p, "title", 1.5);
    if (!faded.ok) throw new Error(faded.error.message);
    const clip = faded.project.tracks.flatMap((t) => t.clips).find((c) => c.id === "title")!;
    expect(clip).toMatchObject({ fadeIn: 1.5, fadeOut: 1.5 });
    expect(setTextFade(faded.project, "title", 1.5)).toEqual({ ok: true, project: faded.project });
    expect(setTextFade(p, "title", -1)).toMatchObject({ ok: false, error: { code: "out-of-range" } });
    expect(setTextFade(p, "video", 1)).toMatchObject({ ok: false }); // not a text
  });
});

describe("the Styles gallery", () => {
  beforeEach(load);
  const gallery = () => within(screen.getByRole("group", { name: "Styles" }));

  it("shows six styles with their pictures, and marks the one in use", async () => {
    render(<Inspector />);
    const cards = () =>
      Array.from(gallery().getByRole("button", { name: "Two-Tone" }).closest(".grid")!.children).map((c) =>
        c.getAttribute("data-style-id"),
      );
    expect(cards()).toEqual(STYLE_PRESETS.slice(0, 6).map((p) => p.id));
    await waitFor(() =>
      expect(gallery().getByRole("button", { name: "Two-Tone" }).querySelector("img")).toHaveAttribute(
        "src",
        "asset://localhost/cache/styles/Two-Tone.png",
      ),
    );
    // a style whose picture could not be made still has a card
    expect(gallery().getByRole("button", { name: "Boxed" })).toHaveTextContent("Aa");

    fireEvent.click(gallery().getByRole("button", { name: "Highlighter" }));
    await waitFor(() => expect(matchesStyle(specOf(), preset("highlighter").style)).toBe(true));
    expect(gallery().getByRole("button", { name: "Highlighter" })).toHaveAttribute("aria-pressed", "true");
    expect(gallery().getAllByRole("button", { pressed: true })).toHaveLength(1);
    expect(cards()[0]).toBe("highlighter"); // and it moved to the front
    expect(specOf().content).toBe("Hello\nworld");
    expect(useProjectStore.getState().past).toHaveLength(1);
  });

  it("lets the fade be set by hand in the Text section", async () => {
    render(<Inspector />);
    const fade = screen.getByRole("spinbutton", { name: "Fade in and out (s)" });
    expect(fade).toHaveValue(0);
    fireEvent.change(fade, { target: { value: "0.8" } });
    fireEvent.keyDown(fade, { key: "Enter" });
    expect(clipOf()).toMatchObject({ fadeIn: 0.8, fadeOut: 0.8 });
    fireEvent.change(fade, { target: { value: "0" } });
    fireEvent.blur(fade);
    expect("fadeIn" in clipOf()).toBe(false);
  });
});

describe("a fading text in the preview", () => {
  it("is more or less see-through as the playhead moves through it", () => {
    const faded = setTextFade(project(), "title", 1); // the text runs 2..7
    if (!faded.ok) throw new Error(faded.error.message);
    useProjectStore.getState().loadProject(faded.project, "/p.cutvii", []);
    usePlaybackStore.setState({ playhead: 2.25, playing: false });
    render(<Preview />);
    const text = () => screen.getByTestId("text-layer");
    expect(Number(text().style.opacity)).toBeCloseTo(0.25);
    act(() => usePlaybackStore.setState({ playhead: 4 }));
    expect(Number(text().style.opacity)).toBe(1);
    act(() => usePlaybackStore.setState({ playhead: 6.5 }));
    expect(Number(text().style.opacity)).toBeCloseTo(0.5);
  });
});
