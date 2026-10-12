import { fireEvent, render, screen, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { StyleList } from "@/components/text/StyleList";
import { StylePresetSchema } from "@/project/model";
import { FIRST_STYLE, FIRST_STYLE_KEY, useAutoClipsStore } from "@/store/autoClips";
import { CLIPPER_TAG, hasTag, STYLE_PRESETS, styleLimit, WORD_TIMING_TAG } from "@/timeline/textStyles";
import { orderedStyles, PREFS_KEY, subtitleStyleOf, useTextStyleStore } from "./textStyles";

const store = () => useTextStyleStore.getState();
const CLIPPER = [
  "hype-bar",
  "podcast-clean",
  "quote-card",
  "money-green",
  "shock-pop",
  "orange-cut",
  "headline-blue",
  "glitch-split",
  "story-time",
  "word-slam",
];

beforeEach(() => {
  localStorage.clear();
  store().reset();
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation((async (cmd: string, args?: { label?: string }) =>
    cmd === "text_style_preview" ? `/cache/styles/${args?.label}.png` : undefined) as never);
});

describe("the ten styles for short clips", () => {
  it("are styles 22 to 31, tagged clipper, each with a font and its own name", () => {
    expect(STYLE_PRESETS).toHaveLength(31);
    expect(STYLE_PRESETS.slice(21).map((p) => p.id)).toEqual(CLIPPER);
    expect(STYLE_PRESETS.filter((p) => hasTag(p, CLIPPER_TAG)).map((p) => p.id)).toEqual(CLIPPER);
    expect(STYLE_PRESETS.slice(0, 21).every((p) => p.tags === undefined)).toBe(true);
    expect(STYLE_PRESETS.slice(21).every((p) => typeof p.style.font === "string")).toBe(true);
    expect(new Set(STYLE_PRESETS.map((p) => p.name)).size).toBe(31);
  });

  it("says when a style wants word timing and shows plain captions instead", () => {
    const timed = STYLE_PRESETS.filter((p) => hasTag(p, WORD_TIMING_TAG)).map((p) => p.id);
    expect(timed).toEqual(["hype-bar", "word-slam"]);
    expect(styleLimit(STYLE_PRESETS.find((p) => p.id === "hype-bar")!)).toMatch(/plain captions/);
    expect(styleLimit(STYLE_PRESETS.find((p) => p.id === "orange-cut")!)).toBeNull();
    // the style itself is an ordinary static look: nothing in it needs word times to draw
    expect(Object.keys(STYLE_PRESETS.find((p) => p.id === "hype-bar")!.style).sort()).toEqual([
      "color",
      "font",
      "outline",
      "uppercase",
    ]);
  });

  it("older style files and My styles without tags still load", () => {
    const old = { id: "x", name: "Old", style: { color: "#FFFFFF" } };
    expect(StylePresetSchema.parse(old).tags).toBeUndefined();
    expect(StylePresetSchema.safeParse({ ...old, tags: ["clipper"] }).success).toBe(true);
    expect(StylePresetSchema.safeParse({ ...old, tags: "clipper" }).success).toBe(false);
    // preferences saved before tags existed
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({
        mine: [{ id: "mine-1", name: "Mine", style: { color: "#00FF88" } }],
        order: ["mine-1"],
      }),
    );
    store().reset();
    const id = store().create();
    expect(id).toBeTruthy();
    expect(orderedStyles(store()).some((p) => p.id === id)).toBe(true);
  });
});

describe("the shared style picker", () => {
  it("lists all 31 plus My styles, and exactly the tagged ones under Good for short clips", () => {
    const mine = store().create();
    store().resetOrder();
    render(<StyleList isSelected={() => false} onSelect={() => {}} />);
    expect(document.querySelectorAll("[data-style-id]")).toHaveLength(6); // the compact grid
    fireEvent.click(screen.getByRole("button", { name: "Show more (32 styles)" }));
    const dialog = screen.getByRole("dialog", { name: "All styles" });
    expect(dialog.querySelectorAll("[data-style-id]")).toHaveLength(32);
    expect(dialog.querySelector(`[data-style-id="${mine}"]`)).not.toBeNull();

    const chip = within(dialog).getByRole("button", { name: "Good for short clips" });
    expect(chip).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(chip);
    const shown = Array.from(dialog.querySelectorAll("[data-style-id]")).map((el) =>
      el.getAttribute("data-style-id"),
    );
    expect([...shown].sort()).toEqual([...CLIPPER].sort());
    // the two word-timing styles say what they do for now
    expect(within(dialog).getAllByText("Plain for now")).toHaveLength(2);
    expect(within(dialog).getByRole("button", { name: "Hype Bar" })).toHaveAttribute(
      "title",
      expect.stringMatching(/plain captions/),
    );
    fireEvent.click(chip);
    expect(dialog.querySelectorAll("[data-style-id]")).toHaveLength(32);
  });

  it("keeps the most recently used order with the new styles", () => {
    store().use("orange-cut");
    store().use("quote-card");
    const order = orderedStyles(store()).map((p) => p.id);
    expect(order.slice(0, 3)).toEqual(["quote-card", "orange-cut", "clean-caption"]);
    expect(new Set(order).size).toBe(31);
  });
});

describe("the Auto clips default style", () => {
  it("starts with Orange Cut the first time, then remembers what was used last", () => {
    expect(FIRST_STYLE).toBe("orange-cut");
    useAutoClipsStore.getState().openWizard("clip");
    expect(subtitleStyleOf(store()).id).toBe("orange-cut");
    expect(localStorage.getItem(FIRST_STYLE_KEY)).toBe("1");
    // the user picks another: opening again leaves it alone
    store().setSubtitleStyle("podcast-clean");
    useAutoClipsStore.getState().hide();
    useAutoClipsStore.getState().openWizard("clip");
    expect(subtitleStyleOf(store()).id).toBe("podcast-clean");
    // and going back to Default is respected too
    store().setSubtitleStyle(null);
    useAutoClipsStore.getState().openWizard("clip");
    expect(store().subtitleStyleId).toBeNull();
  });

  it("does not replace a subtitle style chosen before Auto clips was ever opened", () => {
    store().setSubtitleStyle("boxed");
    useAutoClipsStore.getState().openWizard("clip");
    expect(subtitleStyleOf(store()).id).toBe("boxed");
  });
});

describe("saving a text's look as a style", () => {
  it("keeps the look, not the words, size or place, and refuses bad or taken names", async () => {
    const { styleOfSpec, matchesStyle } = await import("@/timeline/textStyles");
    const spec = {
      content: "Hello",
      fontSize: 80,
      color: "#FFE14A",
      bold: true,
      uppercase: false,
      font: "Anton",
      outline: { color: "#000000", width: 0.1 },
      align: "center" as const,
      x: 0.3,
      y: 0.7,
    };
    const style = styleOfSpec(spec);
    expect(style).toEqual({
      color: "#FFE14A",
      bold: true,
      font: "Anton",
      outline: { color: "#000000", width: 0.1 },
    });
    expect(matchesStyle(spec, style)).toBe(true);

    const saved = store().saveAs("  My yellow  ", style, 0.4);
    expect("id" in saved).toBe(true);
    expect(store().mine).toMatchObject([{ name: "My yellow", style, fade: 0.4 }]);
    // newest first in every list, and kept between sessions
    expect(orderedStyles(store())[0].name).toBe("My yellow");
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!).mine).toHaveLength(1);

    expect(store().saveAs("", style)).toEqual({ problem: "A style needs a name" });
    expect(store().saveAs("my yellow", style)).toMatchObject({
      problem: expect.stringMatching(/already has that name/),
    });
    expect(store().saveAs("Orange Cut", style)).toMatchObject({
      problem: expect.stringMatching(/already has that name/),
    });
    expect(store().saveAs("x".repeat(41), style)).toMatchObject({
      problem: expect.stringMatching(/40 characters/),
    });
    expect(store().saveAs("Broken", { color: "yellow" })).toEqual({
      problem: "This look cannot be saved as a style",
    });
    expect(store().mine).toHaveLength(1);
  });

  it("is offered in the Text tab for a look that is not a style yet", async () => {
    const { StyleGallery } = await import("@/components/inspector/StyleGallery");
    const spec = { content: "Hi", fontSize: 60, color: "#12AB34", bold: true, x: 0.5, y: 0.5 };
    const view = render(<StyleGallery clipId="t" spec={spec} />);
    fireEvent.click(screen.getByRole("button", { name: "Save as style" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Style name" }), {
      target: { value: "Green note" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(store().mine.map((p) => p.name)).toEqual(["Green note"]);
    // now it IS a style: there is nothing new to save
    expect(screen.getByRole("button", { name: "Save as style" })).toBeDisabled();
    view.unmount();

    const plain = STYLE_PRESETS[0];
    render(
      <StyleGallery clipId="t" spec={{ content: "Hi", fontSize: 60, x: 0.5, y: 0.5, ...plain.style }} />,
    );
    expect(screen.getByRole("button", { name: "Save as style" })).toBeDisabled();
  });
});
