import { fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { StylePacksDialog } from "@/components/packs/StylePacksDialog";
import type { ExportOptions } from "@/export/options";
import type { ExportPreset } from "@/export/presets";
import { useFileDrop } from "@/hooks/useFileDrop";
import type { StylePreset } from "@/project/model";
import { COLOR_PRESETS_KEY, useColorPresetStore } from "@/store/colorPresets";
import { EXPORT_PRESETS_KEY, useExportPresetStore } from "@/store/exportPresets";
import { useFontStore } from "@/store/fonts";
import { useStylePackStore } from "@/store/stylePacks";
import { allStyles, PREFS_KEY, useTextStyleStore } from "@/store/textStyles";
import { useUiStore } from "@/store/ui";
import { LOOKS, type Look } from "./looks";
import {
  buildPack,
  conflictOf,
  importItems,
  isPackFile,
  mergeImported,
  missingFonts,
  parsePack,
  type PackItem,
} from "./stylePack";
import { STYLE_PRESETS } from "./textStyles";

const reel: ExportOptions = { width: 1080, height: 1920, fps: 30, quality: "high", format: "mp4" };
const myStyle: StylePreset = {
  id: "my-style-1",
  name: "Big Title",
  style: { ...STYLE_PRESETS[0].style, font: "Bebas Neue" },
  fade: 0.5,
};
const myLook: Look = { id: "my-look-1", name: "Warm Evening", adjust: LOOKS[0].adjust };
const myExport: ExportPreset = { id: "my-export-1", name: "Reel", options: reel };

const text = () => useTextStyleStore.getState();
const color = () => useColorPresetStore.getState();
const exports = () => useExportPresetStore.getState();
const packs = () => useStylePackStore.getState();

function haveOwnItems() {
  text().setMine([myStyle]);
  color().setMine([myLook]);
  exports().setMine([myExport]);
}

/** What Rust hands back for a pack file it accepted (`CheckedPack`). */
function checked(pack: ReturnType<typeof buildPack>, problems: string[] = []) {
  return {
    name: pack.name,
    author: pack.author ?? null,
    notes: pack.notes ?? null,
    textStyles: pack.textStyles as unknown[],
    colorPresets: pack.colorPresets as unknown[],
    exportPresets: pack.exportPresets as unknown[],
    problems,
  };
}
const everything = { name: "My pack", author: "", notes: "", textIds: [], colorIds: [], exportIds: [] };
const fullPack = () =>
  buildPack({
    ...everything,
    author: " Sam ",
    notes: "For reels",
    textIds: [myStyle.id],
    colorIds: [myLook.id],
    exportIds: [myExport.id],
  });

beforeEach(() => {
  localStorage.clear();
  text().reset();
  color().reset();
  exports().reset();
  packs().forgetPack();
  packs().hide();
  useUiStore.getState().setNotice(null);
  useFontStore.setState({ fonts: [{ family: "Noto Sans", bundled: true }] });
  vi.mocked(invoke).mockReset();
});

describe("a pack file", () => {
  it("round trips: export then import gives identical items", () => {
    haveOwnItems();
    const pack = fullPack();
    expect(pack).toMatchObject({ format: "cutvii-pack", version: 1, name: "My pack", author: "Sam" });
    const back = parsePack(checked(pack));
    expect(back.problems).toEqual([]);
    expect(back.items.map((i) => i.value)).toEqual([myStyle, myLook, myExport]);
    expect(back).toMatchObject({ name: "My pack", author: "Sam", notes: "For reels" });
  });

  it("holds only the user's ticked items: no built-ins, no font data, no paths", () => {
    haveOwnItems();
    const pack = buildPack({
      ...everything,
      textIds: [myStyle.id, STYLE_PRESETS[0].id],
      colorIds: [LOOKS[0].id],
      exportIds: [],
    });
    expect(pack.textStyles.map((p) => p.id)).toEqual([myStyle.id]);
    expect(pack.colorPresets).toEqual([]);
    expect(pack.exportPresets).toEqual([]);
    expect(pack).not.toHaveProperty("author");
    // a style only names its font
    expect(pack.textStyles[0].style.font).toBe("Bebas Neue");
    expect(JSON.stringify(fullPack())).not.toMatch(/path|\.ttf|\.otf|base64|https?:/i);
  });

  it("is told apart by its file name", () => {
    expect(isPackFile("Looks.CUTVII-PACK")).toBe(true);
    expect(isPackFile("clip.mp4")).toBe(false);
  });

  it("is rejected whole when it is not a pack", () => {
    for (const raw of [null, "pack", {}, { ...checked(fullPack()), name: "" }]) {
      expect(() => parsePack(raw), JSON.stringify(raw)).toThrow("This is not a CutVii style pack.");
    }
    const tooMany = { ...checked(fullPack()), textStyles: Array(201).fill(myStyle) };
    expect(() => parsePack(tooMany)).toThrow();
  });

  it("skips an invalid item with a reason and keeps the valid ones", () => {
    const raw = {
      ...checked(fullPack(), ["Rust left one out."]),
      textStyles: [myStyle, { ...myStyle, name: "Runs code", run: "rm -rf" }],
      colorPresets: [
        { ...myLook, kind: "adjust" },
        { id: "my-lut", name: "Film LUT", kind: "lut", adjust: myLook.adjust },
      ],
      exportPresets: [
        myExport,
        { ...myExport, name: "Odd", options: { ...reel, width: 1081 } },
        { ...myExport, name: "Huge", options: { ...reel, height: 8194 } },
        { ...myExport, name: "Fast", options: { ...reel, fps: 121 } },
        { ...myExport, name: "Mov", options: { ...reel, format: "mov" } },
        { ...myExport, name: "Path", options: { ...reel, output: "/etc/passwd" } },
      ],
    };
    const pack = parsePack(raw);
    expect(pack.items.map((i) => i.value.name)).toEqual(["Big Title", "Warm Evening", "Reel"]);
    expect(pack.problems).toEqual([
      "Rust left one out.",
      "Text style “Runs code” is not valid.",
      "Colour preset “Film LUT” is not valid.",
      "Export preset “Odd” is not valid.",
      "Export preset “Huge” is not valid.",
      "Export preset “Fast” is not valid.",
      "Export preset “Mov” is not valid.",
      "Export preset “Path” is not valid.",
    ]);
  });
});

describe("conflicts", () => {
  const item = (value: StylePreset): PackItem => ({ kind: "text", key: "text-0", value });

  it("are found by id or by name, whatever the case", () => {
    haveOwnItems();
    expect(conflictOf(item({ ...myStyle, id: "my-other", name: "Fresh" }))).toBe("none");
    expect(conflictOf(item(myStyle))).toBe("own");
    expect(conflictOf(item({ ...myStyle, id: "my-other", name: "BIG TITLE" }))).toBe("own");
    expect(conflictOf(item({ ...myStyle, id: STYLE_PRESETS[0].id, name: "Fresh" }))).toBe("builtin");
    expect(conflictOf(item({ ...myStyle, id: "my-other", name: STYLE_PRESETS[0].name }))).toBe("builtin");
    expect(conflictOf({ kind: "color", key: "color-0", value: { ...myLook, name: LOOKS[0].name } })).toBe(
      "own",
    );
    expect(conflictOf({ kind: "export", key: "export-0", value: myExport })).toBe("own");
  });

  it("keep both: the newcomer gets a fresh id and a numbered name", () => {
    const r = mergeImported([myStyle], STYLE_PRESETS, [{ value: myStyle, choice: "keep" }], () => "my-new");
    expect(r.next).toEqual([myStyle, { ...myStyle, id: "my-new", name: "Big Title 2", source: "imported" }]);
    expect(r).toMatchObject({ added: ["Big Title 2"], replaced: [], skipped: [] });
  });

  it("skip: nothing changes", () => {
    const r = mergeImported([myStyle], STYLE_PRESETS, [{ value: myStyle, choice: "skip" }]);
    expect(r.next).toEqual([myStyle]);
    expect(r.skipped).toEqual(["Big Title"]);
  });

  it("replace: the user's item takes the new values but keeps its id", () => {
    const incoming = { ...myStyle, id: "my-from-file", fade: 2 };
    const r = mergeImported([myStyle], STYLE_PRESETS, [{ value: incoming, choice: "replace" }]);
    expect(r.next).toEqual([{ ...incoming, id: myStyle.id, source: "imported" }]);
    expect(r.replaced).toEqual(["Big Title"]);
  });

  it("a built-in can never be overwritten, whatever is asked", () => {
    const builtIn = STYLE_PRESETS[0];
    const r = mergeImported(
      [] as StylePreset[],
      STYLE_PRESETS,
      [{ value: { ...builtIn, fade: 3 }, choice: "replace" }],
      () => "my-new",
    );
    expect(r.next).toEqual([
      { ...builtIn, fade: 3, id: "my-new", name: `${builtIn.name} 2`, source: "imported" },
    ]);
    expect(r.replaced).toEqual([]);

    // through the stores: "replace" on a built-in clash is treated as "keep both"
    const before = JSON.stringify(STYLE_PRESETS);
    packs().openDialog("import");
    useStylePackStore.setState({
      pack: {
        name: "P",
        author: null,
        notes: null,
        problems: [],
        items: [{ kind: "text", key: "text-0", value: builtIn }],
      },
      ticked: ["text-0"],
      choices: { "text-0": "replace" },
    });
    packs().importTicked();
    expect(JSON.stringify(STYLE_PRESETS)).toBe(before);
    expect(text().mine).toHaveLength(1);
    expect(text().mine[0]).toMatchObject({ name: `${builtIn.name} 2`, source: "imported" });
    expect(text().mine[0].id).not.toBe(builtIn.id);
    expect(allStyles(text()).filter((s) => s.id === builtIn.id)).toEqual([builtIn]);
  });

  it("an id that is not one of ours is never taken over as it is", () => {
    const r = mergeImported(
      [] as Look[],
      LOOKS,
      [{ value: { ...myLook, id: "sneaky" }, choice: "keep" }],
      () => "my-new",
    );
    expect(r.next[0].id).toBe("my-new");
  });
});

describe("importing", () => {
  it("names the fonts this computer does not have, once each", () => {
    const items: PackItem[] = [
      { kind: "text", key: "text-0", value: myStyle },
      { kind: "text", key: "text-1", value: { ...myStyle, id: "my-2", name: "Two" } },
      { kind: "text", key: "text-2", value: { ...myStyle, style: { ...myStyle.style, font: "noto sans" } } },
      { kind: "color", key: "color-0", value: myLook },
    ];
    expect(missingFonts(items, ["Noto Sans"])).toEqual(["Bebas Neue"]);
    expect(missingFonts(items, ["Noto Sans", "BEBAS NEUE"])).toEqual([]);
  });

  it("puts the items into the three lists, marked as imported, and they survive a restart", () => {
    const pack = parsePack(checked((haveOwnItems(), fullPack())));
    localStorage.clear();
    text().reset();
    color().reset();
    exports().reset();

    const outcome = importItems(pack.items, {});
    expect(outcome).toEqual({ added: ["Big Title", "Warm Evening", "Reel"], replaced: [], skipped: [] });
    expect(text().mine).toEqual([{ ...myStyle, source: "imported" }]);
    expect(color().mine).toEqual([{ ...myLook, source: "imported" }]);
    expect(exports().mine).toEqual([{ ...myExport, source: "imported" }]);
    // the shared lists every picker reads (Text tab, inspector Style tab, subtitle dialog)
    expect(allStyles(text()).map((s) => s.name)).toContain("Big Title");

    // save and reopen: what was written is what a fresh start reads
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!).mine).toEqual(text().mine);
    expect(localStorage.getItem(COLOR_PRESETS_KEY)).toContain("Warm Evening");
    expect(localStorage.getItem(EXPORT_PRESETS_KEY)).toContain("Reel");
    color().reset();
    exports().reset();
    expect(color().mine).toEqual([{ ...myLook, source: "imported" }]);
    expect(exports().mine).toEqual([{ ...myExport, source: "imported" }]);
  });

  it("keep both, skip and replace each do their part in one import", () => {
    haveOwnItems();
    const pack = parsePack(checked(fullPack()));
    const key = (kind: string) => pack.items.find((i) => i.kind === kind)!.key;
    useStylePackStore.setState({
      pack,
      ticked: pack.items.map((i) => i.key),
      choices: { [key("color")]: "skip", [key("export")]: "replace" },
    });
    packs().importTicked();
    expect(
      text()
        .mine.map((p) => p.name)
        .sort(),
    ).toEqual(["Big Title", "Big Title 2"]);
    expect(color().mine).toEqual([myLook]);
    expect(exports().mine).toEqual([{ ...myExport, source: "imported" }]);
    expect(useUiStore.getState().notice).toBe(
      "Style pack “My pack”: Added Big Title 2. Replaced Reel. Skipped Warm Evening.",
    );
    expect(packs()).toMatchObject({ open: false, pack: null });
  });

  it("asks for at least one ticked item", () => {
    haveOwnItems();
    useStylePackStore.setState({ pack: parsePack(checked(fullPack())), ticked: [] });
    packs().importTicked();
    expect(packs().problem).toBe("Tick at least one item to import.");
    expect(text().mine).toEqual([myStyle]);
  });

  it("shows Rust's reason when a file is refused, and says so when a pack is empty", async () => {
    vi.mocked(invoke).mockRejectedValueOnce("invalid input: The file is larger than 5 MB.");
    await packs().choosePack();
    expect(packs()).toMatchObject({ pack: null, problem: "The file is larger than 5 MB." });

    vi.mocked(invoke).mockResolvedValueOnce(null); // cancelled
    await packs().choosePack();
    expect(packs()).toMatchObject({ pack: null, problem: null });

    vi.mocked(invoke).mockResolvedValueOnce(checked(buildPack(everything)));
    await packs().choosePack();
    expect(packs().problem).toBe("This pack has nothing in it that CutVii can use.");
  });
});

describe("the Style packs dialog", () => {
  it("export: offers only the user's own items and saves the ticked ones", async () => {
    haveOwnItems();
    vi.mocked(invoke).mockResolvedValue("/Users/me/My pack.cutvii-pack");
    packs().openDialog("export");
    render(<StylePacksDialog />);
    expect(screen.queryByText(STYLE_PRESETS[0].name)).toBeNull();
    const save = screen.getByRole("button", { name: /Save pack with 3 items/ });
    expect(save).toBeDisabled(); // no name yet
    fireEvent.click(screen.getByRole("checkbox", { name: /Warm Evening/ }));
    fireEvent.change(screen.getByLabelText("Pack name"), { target: { value: "My pack" } });
    fireEvent.click(screen.getByRole("button", { name: /Save pack with 2 items/ }));
    await waitFor(() => expect(useUiStore.getState().notice).toMatch(/Style pack saved as/));
    expect(invoke).toHaveBeenCalledWith("export_style_pack", {
      pack: buildPack({ ...everything, textIds: [myStyle.id], exportIds: [myExport.id] }),
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("export: shows why saving failed and stays open", async () => {
    haveOwnItems();
    vi.mocked(invoke).mockRejectedValue("invalid input: The pack name is not usable.");
    packs().openDialog("export");
    render(<StylePacksDialog />);
    fireEvent.change(screen.getByLabelText("Pack name"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: /Save pack/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The pack name is not usable.");
  });

  it("import: previews the pack, its missing fonts, clashes and left-out items before anything is added", async () => {
    haveOwnItems();
    const raw = {
      ...checked(fullPack(), ["Text style “Broken” is not valid."]),
      name: "<img src=x onerror=alert(1)>",
      textStyles: [myStyle, { ...STYLE_PRESETS[0], style: STYLE_PRESETS[0].style }],
    };
    vi.mocked(invoke).mockImplementation(async (cmd) => (cmd === "open_style_pack" ? raw : []));
    packs().openDialog("import");
    render(<StylePacksDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Choose a pack file…" }));

    // names from the file are plain text, never markup
    expect(await screen.findByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText("2 text styles · 1 colour presets · 1 export presets")).toBeInTheDocument();
    expect(screen.getByText(/Bebas Neue/)).toBeInTheDocument();
    expect(screen.getByText(/Left out \(1\)/)).toBeInTheDocument();
    expect(screen.getByText("Text style “Broken” is not valid.")).toBeInTheDocument();

    const options = (name: string) =>
      within(screen.getByLabelText(`What to do with ${name}`))
        .getAllByRole("option")
        .map((o) => o.textContent);
    expect(options("Big Title")).toEqual(["Keep both (rename)", "Skip", "Replace mine"]);
    expect(options(STYLE_PRESETS[0].name)).toEqual(["Keep both (rename)", "Skip"]);
    expect(text().mine).toEqual([myStyle]); // nothing added yet

    fireEvent.change(screen.getByLabelText("What to do with Big Title"), { target: { value: "skip" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Import Warm Evening" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Import Reel" }));
    fireEvent.click(screen.getByRole("button", { name: "Import 2 items" }));
    expect(text().mine.map((p) => p.name)).toEqual(["Big Title", `${STYLE_PRESETS[0].name} 2`]);
    expect(color().mine).toEqual([myLook]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("import: Select none disables the button; Escape closes", () => {
    haveOwnItems();
    useStylePackStore.setState({
      open: true,
      tab: "import",
      pack: parsePack(checked(fullPack())),
      ticked: [],
    });
    render(<StylePacksDialog />);
    expect(screen.getByRole("button", { name: "Import 0 items" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    expect(screen.getByRole("button", { name: "Import 3 items" })).toBeEnabled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("a pack dropped on the window", () => {
  type Handler = (e: { payload: unknown }) => void;
  async function dropper() {
    const handlers: Record<string, Handler> = {};
    vi.mocked(listen).mockImplementation(async (event, handler) => {
      handlers[event as string] = handler as unknown as Handler;
      return () => {};
    });
    renderHook(() => useFileDrop());
    await waitFor(() => expect(handlers["files-dropped"]).toBeDefined());
    return (files: { id: number; name: string }[]) =>
      handlers["files-dropped"]({ payload: { files, x: 5, y: 5 } });
  }

  it("opens the import preview and is not imported as media", async () => {
    haveOwnItems();
    const raw = checked(fullPack());
    vi.mocked(invoke).mockImplementation(async (cmd) => (cmd === "read_dropped_pack" ? raw : undefined));
    const drop = await dropper();
    drop([{ id: 7, name: "Shared.cutvii-pack" }]);
    await waitFor(() => expect(packs().pack?.name).toBe("My pack"));
    expect(packs()).toMatchObject({ open: true, tab: "import" });
    expect(packs().ticked).toHaveLength(3);
    expect(invoke).toHaveBeenCalledWith("read_dropped_pack", { id: 7 });
    expect(invoke).not.toHaveBeenCalledWith("import_dropped_file", expect.anything());
  });

  it("shows the reason when the dropped file is broken", async () => {
    vi.mocked(invoke).mockRejectedValue("invalid input: This is not a CutVii style pack.");
    const drop = await dropper();
    drop([{ id: 8, name: "broken.cutvii-pack" }]);
    await waitFor(() => expect(packs().problem).toBe("This is not a CutVii style pack."));
    expect(packs()).toMatchObject({ open: true, tab: "import", pack: null });
  });
});
