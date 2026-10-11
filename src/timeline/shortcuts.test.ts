import { resolveShortcut, SHORTCUT_LABELS, type KeyLike } from "./shortcuts";

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});
const idle = { typing: false, onButton: false };
const act = (e: KeyLike, ctx = idle) => resolveShortcut(e, ctx)?.action ?? null;

describe("resolveShortcut", () => {
  it("maps the editing keys", () => {
    expect(act(key(" "))).toBe("play-pause");
    expect(act(key("s"))).toBe("split");
    expect(act(key("S", { shiftKey: true }))).toBe("split");
    expect(act(key("Delete"))).toBe("delete");
    expect(act(key("Backspace"))).toBe("delete");
    expect(act(key("ArrowLeft"))).toBe("seek-back");
    expect(act(key("ArrowRight", { shiftKey: true }))).toBe("seek-forward-second");
    expect(act(key("Home"))).toBe("home");
  });

  it("treats Ctrl and Cmd the same, and Shift as the variant", () => {
    for (const mod of [{ ctrlKey: true }, { metaKey: true }]) {
      expect(act(key("s", mod))).toBe("save");
      expect(act(key("S", { ...mod, shiftKey: true }))).toBe("save-as");
      expect(act(key("z", mod))).toBe("undo");
      expect(act(key("z", { ...mod, shiftKey: true }))).toBe("redo");
      expect(act(key("y", mod))).toBe("redo");
      expect(act(key("o", mod))).toBe("open");
    }
  });

  it("zoom keys: = and + zoom in, - zooms out, 0 fits", () => {
    const m = { metaKey: true };
    expect(act(key("=", m))).toBe("zoom-in");
    expect(act(key("+", { ...m, shiftKey: true }))).toBe("zoom-in");
    expect(act(key("-", m))).toBe("zoom-out");
    expect(act(key("0", m))).toBe("zoom-fit");
    expect(act(key("="))).toBeNull(); // no modifier: not a shortcut
  });

  it("a modifier changes the meaning: Cmd+S saves, it does not split", () => {
    expect(act(key("s", { metaKey: true }))).not.toBe("split");
    expect(act(key("ArrowLeft", { ctrlKey: true }))).toBeNull();
    expect(act(key("s", { altKey: true }))).toBeNull();
    expect(act(key("s", { ctrlKey: true, altKey: true }))).toBeNull(); // AltGr combinations on some layouts
  });

  it("while typing, editing keys are left to the field but save and zoom still work", () => {
    const typing = { typing: true, onButton: false };
    for (const k of [" ", "s", "Delete", "Backspace", "ArrowLeft", "Home"])
      expect(act(key(k), typing)).toBeNull();
    expect(act(key("z", { metaKey: true }), typing)).toBeNull(); // the field's own undo
    expect(act(key("s", { metaKey: true }), typing)).toBe("save");
    expect(act(key("=", { ctrlKey: true }), typing)).toBe("zoom-in");
    expect(act(key("0", { ctrlKey: true }), typing)).toBe("zoom-fit");
  });

  it("Space on a focused button is left to the button; every match asks to prevent the default", () => {
    expect(act(key(" "), { typing: false, onButton: true })).toBeNull();
    expect(act(key("s"), { typing: false, onButton: true })).toBe("split");
    expect(resolveShortcut(key("s", { metaKey: true }), idle)).toEqual({
      action: "save",
      preventDefault: true,
    });
    expect(resolveShortcut(key("q"), idle)).toBeNull();
  });

  it("has a tooltip label for every action", () => {
    expect(SHORTCUT_LABELS.save).toBe("Ctrl/⌘ S");
    expect(Object.values(SHORTCUT_LABELS).every((l) => l.length > 0)).toBe(true);
  });
});

describe("select all", () => {
  it("Ctrl/Cmd + A selects every clip, but is left to a text field while typing", async () => {
    expect(act(key("a", { metaKey: true }))).toBe("select-all");
    expect(act(key("A", { ctrlKey: true }))).toBe("select-all");
    expect(act(key("a"))).toBeNull(); // a plain "a" is not a shortcut
    expect(act(key("a", { metaKey: true }), { typing: true, onButton: false })).toBeNull();

    const { useProjectStore } = await import("@/store/project");
    const { useSelectionStore } = await import("@/store/selection");
    const { IDS, makeProject } = await import("@/test/makeProject");
    const { addClip } = await import("./edit");
    const { selectAllClips } = await import("./editor");
    let p = makeProject();
    for (const [assetId, trackId, id, start] of [
      [IDS.vid, IDS.v1, "a", 0],
      [IDS.vid2, IDS.v2, "b", 2],
      [IDS.aud, IDS.a1, "c", 0],
    ] as const) {
      const r = addClip(p, { assetId, trackId, start, id });
      if (!r.ok) throw new Error(r.error.message);
      p = r.project;
    }
    useProjectStore.getState().loadProject(p, "/p.cutvii", []);
    useSelectionStore.getState().select("b");
    selectAllClips();
    expect([...useSelectionStore.getState().selectedClipIds].sort()).toEqual(["a", "b", "c"]);
    useProjectStore.getState().loadProject(makeProject(), "/p.cutvii", []);
    selectAllClips();
    expect(useSelectionStore.getState().selectedClipIds).toEqual([]);
  });
});
