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
