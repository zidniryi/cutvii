import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import App from "@/App";
import { StyleEditorSheet } from "@/components/text/StyleEditor";
import { editStyle, StyleList, VISIBLE_STYLES } from "@/components/text/StyleList";
import { TransportBar } from "@/components/preview/TransportBar";
import { MediaLibrary } from "@/components/layout/MediaLibrary";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { previewKey, useStylePreviewStore } from "@/store/stylePreviews";
import { useUiStore } from "@/store/ui";
import { IDS, makeProject } from "@/test/makeProject";
import { deleteSelection, selectAll, undo } from "@/timeline/editor";
import { STYLE_PRESETS } from "@/timeline/textStyles";
import { DEFAULT_STYLE, orderedStyles, PREFS_KEY, subtitleStyleOf, useTextStyleStore } from "./textStyles";

const store = () => useTextStyleStore.getState();
const ids = () => orderedStyles(store()).map((p) => p.id);
const builtIn = STYLE_PRESETS.map((p) => p.id);

beforeEach(() => {
  store().reset();
  useStylePreviewStore.setState({ previews: {}, asked: {} });
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation((async (cmd: string, args?: { label?: string }) => {
    if (cmd === "text_style_preview") return `/cache/styles/${args?.label}.png`;
    if (cmd === "text_fonts") return [{ family: "Noto Sans", bundled: true }];
    return undefined;
  }) as never);
});

describe("style ordering", () => {
  it("starts in the built-in order and moves a chosen style to position 1", () => {
    expect(ids()).toEqual(builtIn);
    store().use("minimal");
    store().use("boxed");
    expect(ids().slice(0, 3)).toEqual(["boxed", "minimal", "clean-caption"]);
    store().use("minimal"); // choosing it again does not list it twice
    expect(ids().slice(0, 2)).toEqual(["minimal", "boxed"]);
    expect(ids()).toHaveLength(21);
    expect(new Set(ids()).size).toBe(21);
  });

  it("is kept in local preferences, not in the project, and can be reset", () => {
    const before = JSON.stringify(useProjectStore.getState().project);
    store().use("signature");
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!).order).toEqual(["signature"]);
    expect(JSON.stringify(useProjectStore.getState().project)).toBe(before);
    expect(useProjectStore.getState().past).toHaveLength(0);
    store().resetOrder();
    expect(ids()).toEqual(builtIn);
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!).order).toEqual([]);
  });

  it("ignores ids that no longer exist", () => {
    useTextStyleStore.setState({ order: ["gone", "boxed"] });
    expect(ids()[0]).toBe("boxed");
    expect(ids()).toHaveLength(21);
  });

  it("is shared: choosing in one list reorders every other list", () => {
    const chosen: string[] = [];
    render(
      <>
        <div data-testid="a">
          <StyleList isSelected={() => false} onSelect={(p) => chosen.push(p.id)} />
        </div>
        <div data-testid="b">
          <StyleList isSelected={() => false} onSelect={() => {}} />
        </div>
      </>,
    );
    const cards = (id: string) =>
      Array.from(screen.getByTestId(id).querySelectorAll("[data-style-id]")).map((c) =>
        c.getAttribute("data-style-id"),
      );
    expect(cards("a")).toEqual(builtIn.slice(0, VISIBLE_STYLES));
    fireEvent.click(within(screen.getByTestId("a")).getByRole("button", { name: "Hot Take" }));
    expect(chosen).toEqual(["hot-take"]);
    expect(cards("a")[0]).toBe("hot-take");
    expect(cards("b")).toEqual(cards("a"));
  });

  it("shows six cards, and all styles with search, My styles and Reset order behind Show more", () => {
    const chosen: string[] = [];
    render(<StyleList isSelected={() => false} onSelect={(p) => chosen.push(p.id)} />);
    expect(document.querySelectorAll("[data-style-id]")).toHaveLength(6);
    fireEvent.click(screen.getByRole("button", { name: "Show more (21 styles)" }));
    const dialog = screen.getByRole("dialog", { name: "All styles" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("data-layout", "modal");
    expect(dialog.querySelectorAll("[data-style-id]")).toHaveLength(21);
    expect(within(dialog).getByRole("textbox", { name: "Search styles" })).toHaveFocus();

    fireEvent.change(within(dialog).getByRole("textbox", { name: "Search styles" }), {
      target: { value: " retro" },
    });
    expect(dialog.querySelectorAll("[data-style-id]")).toHaveLength(1);
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Search styles" }), {
      target: { value: "" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "My styles" }));
    expect(dialog.querySelectorAll("[data-style-id]")).toHaveLength(0);
    expect(within(dialog).getByText(/no styles of your own yet/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "My styles" }));

    expect(within(dialog).getByRole("button", { name: "Reset order" })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Retro Pixel" }));
    expect(chosen).toEqual(["retro-pixel"]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(ids()[0]).toBe("retro-pixel");

    fireEvent.click(screen.getByRole("button", { name: /Show more/ }));
    fireEvent.click(screen.getByRole("button", { name: "Reset order" }));
    expect(ids()).toEqual(builtIn);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("uses a bottom sheet on narrow screens", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    try {
      render(<StyleList isSelected={() => false} onSelect={() => {}} />);
      fireEvent.click(screen.getByRole("button", { name: /Show more/ }));
      expect(screen.getByRole("dialog", { name: "All styles" })).toHaveAttribute("data-layout", "bottom");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("the shared style system", () => {
  it("never changes a built-in style: Edit makes a copy, and rename / update / delete are refused", () => {
    const boxed = STYLE_PRESETS.find((p) => p.id === "boxed")!;
    const before = JSON.stringify(STYLE_PRESETS);
    expect(store().rename("boxed", "Mine")).toMatch(/Built-in/);
    store().update("boxed", { style: { color: "#FF0000" } });
    store().remove("boxed");
    editStyle(boxed);
    expect(JSON.stringify(STYLE_PRESETS)).toBe(before);
    expect(store().mine).toHaveLength(1);
    expect(store().mine[0]).toMatchObject({ name: "Boxed copy", style: boxed.style });
    expect(store().editingId).toBe(store().mine[0].id);
    expect(ids()).toHaveLength(22);
  });

  it("creates, duplicates, renames, edits and deletes My styles, kept between sessions", () => {
    const id = store().create()!;
    expect(store().mine[0].name).toBe("My style");
    expect(store().create()).not.toBe(id);
    expect(store().mine[1].name).toBe("My style 2"); // names stay unique
    expect(store().rename(id, "  ")).toMatch(/needs a name/);
    expect(store().rename(id, "boxed")).toMatch(/already has that name/);
    expect(store().rename(id, "x".repeat(41))).toMatch(/40 characters/);
    expect(store().rename(id, "Loud")).toBeNull();
    store().update(id, { style: { color: "#00FF88", uppercase: true }, fade: 0.3 });
    store().update(id, { style: { color: "green" } }); // invalid: ignored
    expect(store().mine[0]).toEqual({
      id,
      name: "Loud",
      style: { color: "#00FF88", uppercase: true },
      fade: 0.3,
    });
    const dup = store().create(store().mine[0])!;
    expect(store().mine.find((p) => p.id === dup)).toMatchObject({ name: "Loud copy", fade: 0.3 });

    const kept = JSON.parse(localStorage.getItem(PREFS_KEY)!);
    expect(kept.mine.map((p: { name: string }) => p.name)).toEqual(["Loud", "My style 2", "Loud copy"]);

    store().setSubtitleStyle(id);
    store().remove(id);
    expect(store().mine.map((p) => p.name)).toEqual(["My style 2", "Loud copy"]);
    expect(store().subtitleStyleId).toBeNull(); // subtitles fall back to Default
    expect(ids()).not.toContain(id);
  });

  it("edits a style in the one editor with a live preview, saved only on Save", async () => {
    const id = store().create()!;
    store().setEditing(id);
    render(<StyleEditorSheet />);
    const sheet = within(screen.getByRole("dialog", { name: "Edit style" }));
    expect(screen.getByRole("dialog", { name: "Edit style" })).toHaveAttribute("data-layout", "side");
    const preview = () => sheet.getByTestId("style-preview").getAttribute("data-preview-key");
    expect(preview()).toBe(previewKey({ color: "#FFFFFF", bold: true }, "My style"));

    fireEvent.click(sheet.getByRole("button", { name: "CAPITALS" }));
    fireEvent.click(sheet.getByRole("checkbox", { name: "Outline" }));
    const edited = {
      color: "#FFFFFF",
      bold: true,
      uppercase: true,
      outline: { color: "#000000", width: 0.08 },
    };
    expect(preview()).toBe(previewKey(edited, "My style")); // the preview follows at once
    await waitFor(() => expect(sheet.getByTestId("style-preview").querySelector("img")).not.toBeNull());
    expect(store().mine[0].style).toEqual({ color: "#FFFFFF", bold: true }); // not saved yet

    fireEvent.change(sheet.getByRole("textbox", { name: "Style name" }), { target: { value: "Boxed" } });
    fireEvent.click(sheet.getByRole("button", { name: "Save style" }));
    expect(sheet.getByRole("alert")).toHaveTextContent(/already has that name/);
    fireEvent.change(sheet.getByRole("textbox", { name: "Style name" }), { target: { value: "Shout" } });
    fireEvent.click(sheet.getByRole("button", { name: "Save style" }));
    expect(store().mine[0]).toEqual({ id, name: "Shout", style: edited });
    expect(screen.queryByRole("dialog")).toBeNull();

    // Cancel and Escape keep nothing
    act(() => store().setEditing(id));
    fireEvent.click(screen.getByRole("button", { name: "Bold" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(store().mine[0].style).toEqual(edited);
  });

  it("offers Edit / Duplicate on every card and Rename / Delete on My styles only", () => {
    const id = store().create()!;
    render(<StyleList isSelected={() => false} onSelect={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "My style options" }));
    let menu = within(screen.getByRole("menu"));
    expect(menu.getAllByRole("menuitem").map((m) => m.textContent?.trim())).toEqual([
      "Edit",
      "Duplicate",
      "Rename",
      "Delete",
    ]);
    fireEvent.click(menu.getByRole("menuitem", { name: "Rename" }));
    fireEvent.change(screen.getByRole("textbox", { name: "New name" }), { target: { value: "Fresh" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(store().mine[0].name).toBe("Fresh");

    fireEvent.click(screen.getByRole("button", { name: "Two-Tone options" }));
    menu = within(screen.getByRole("menu"));
    expect(menu.getAllByRole("menuitem").map((m) => m.textContent?.trim())).toEqual([
      "Edit a copy",
      "Duplicate",
    ]);
    fireEvent.click(menu.getByRole("menuitem", { name: "Duplicate" }));
    expect(store().mine.map((p) => p.name)).toEqual(["Fresh", "Two-Tone copy"]);

    fireEvent.click(screen.getByRole("button", { name: "Fresh options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(store().mine.map((p) => p.id)).not.toContain(id);
  });

  it("keeps subtitle customizations apart from the style, and remembers the last choice", () => {
    expect(subtitleStyleOf(store())).toMatchObject({ id: DEFAULT_STYLE, name: "Default", customised: false });
    store().setSubtitleStyle("boxed");
    const boxed = STYLE_PRESETS.find((p) => p.id === "boxed")!;
    store().setSubtitleCustom("boxed", { style: { ...boxed.style, color: "#FF0000" }, fade: 0.2 });
    expect(subtitleStyleOf(store())).toMatchObject({ id: "boxed", customised: true, fade: 0.2 });
    expect(subtitleStyleOf(store()).style.color).toBe("#FF0000");
    expect(STYLE_PRESETS.find((p) => p.id === "boxed")!.style).toEqual(boxed.style); // built-in untouched
    const kept = JSON.parse(localStorage.getItem(PREFS_KEY)!);
    expect(kept).toMatchObject({ subtitleStyleId: "boxed", subtitleCustom: { boxed: { fade: 0.2 } } });
    store().setSubtitleCustom("boxed", null);
    expect(subtitleStyleOf(store())).toMatchObject({ customised: false, style: boxed.style });
  });

  it("asks for each sample picture once, whoever shows it", async () => {
    render(
      <>
        <StyleList isSelected={() => false} onSelect={() => {}} />
        <StyleList isSelected={() => false} onSelect={() => {}} />
      </>,
    );
    await waitFor(() => expect(Object.keys(useStylePreviewStore.getState().previews)).toHaveLength(6));
    expect(vi.mocked(invoke).mock.calls.filter((c) => c[0] === "text_style_preview")).toHaveLength(6);
  });
});

describe("the left panel", () => {
  it("has a Text tab whose styles add a new text at the playhead", async () => {
    vi.mocked(invoke).mockImplementation((async (cmd: string, args?: { label?: string }) => {
      if (cmd === "text_style_preview") return `/cache/styles/${args?.label}.png`;
      if (cmd === "render_text") return "/data/text/new.png";
      return undefined;
    }) as never);
    useProjectStore.getState().loadProject(makeProject(), "/p.cutvii", []);
    useUiStore.setState({ sidePanel: "library", leftPanel: "library", notice: null });
    render(<App />);
    fireEvent.click(
      within(screen.getAllByRole("tablist", { name: "Left panel" })[0]).getByRole("tab", { name: "Text" }),
    );
    expect(useUiStore.getState()).toMatchObject({ leftPanel: "text", sidePanel: "text" });
    const panel = within(screen.getByRole("region", { name: "Text" }));
    const before = useProjectStore.getState().project.assets.length;
    fireEvent.click(panel.getByRole("button", { name: "Outline Pop" }));
    await waitFor(() => expect(useProjectStore.getState().project.assets).toHaveLength(before + 1));
    expect(useProjectStore.getState().project.assets.at(-1)!.text).toMatchObject({ font: "Poppins" });
    expect(ids()[0]).toBe("outline-pop");
    expect(useProjectStore.getState().past).toHaveLength(1);
  });
});

describe("media selection in the library", () => {
  const cards = () => screen.getAllByTestId("media-card");
  const selected = () => useSelectionStore.getState().selectedAssetIds;
  beforeEach(() => {
    useProjectStore.getState().loadProject(makeProject(), "/p.cutvii", []);
    useUiStore.setState({ sidePanel: "library", leftPanel: "library", notice: null });
    useSelectionStore.setState({
      selectedAssetIds: [],
      assetAnchor: null,
      area: "timeline",
      selectedClipIds: [],
    });
    render(<MediaLibrary />);
  });

  it("selects by click, Ctrl/Cmd-click and Shift-click", () => {
    const all = useProjectStore.getState().project.assets.map((a) => a.id);
    expect(all.length).toBeGreaterThanOrEqual(3);
    fireEvent.click(cards()[0]);
    expect(selected()).toEqual([all[0]]);
    fireEvent.click(cards()[2], { shiftKey: true });
    expect(selected()).toEqual(all.slice(0, 3));
    fireEvent.click(cards()[1], { metaKey: true });
    expect(selected()).toEqual([all[0], all[2]]);
    fireEvent.click(cards()[1], { ctrlKey: true });
    expect(selected()).toHaveLength(3);
    fireEvent.click(cards()[1]);
    expect(selected()).toEqual([all[1]]);
    expect(screen.getByRole("toolbar", { name: "Selected media" })).toHaveTextContent("1 selected");
  });

  it("selects all and deletes what is selected as one undo step", () => {
    const count = useProjectStore.getState().project.assets.length;
    fireEvent.click(cards()[0]);
    selectAll();
    expect(selected()).toHaveLength(count);
    deleteSelection();
    expect(useProjectStore.getState().project.assets).toHaveLength(0);
    expect(useProjectStore.getState().past).toHaveLength(1);
    act(() => undo());
    expect(useProjectStore.getState().project.assets).toHaveLength(count);
    // with the timeline in use, the same keys act on clips, not media
    act(() => useSelectionStore.getState().setArea("timeline"));
    selectAll();
    deleteSelection();
    expect(useProjectStore.getState().project.assets).toHaveLength(count);
    expect(IDS.vid).toBeTruthy();
  });
});

describe("full screen preview", () => {
  it("is switched by the transport button", () => {
    useUiStore.setState({ previewFull: false });
    render(<TransportBar />);
    fireEvent.click(screen.getByRole("button", { name: "Full screen" }));
    expect(useUiStore.getState().previewFull).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Exit full screen" }));
    expect(useUiStore.getState().previewFull).toBe(false);
  });
});
