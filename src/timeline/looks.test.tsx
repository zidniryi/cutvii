import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { Inspector } from "@/components/layout/Inspector";
import type { Project } from "@/project/model";
import { COLOR_PRESETS_KEY, useColorPresetStore as usePresets } from "@/store/colorPresets";
import { useLookPreviewStore } from "@/store/lookPreviews";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useUiStore } from "@/store/ui";
import { expectValid, IDS, makeProject } from "@/test/makeProject";
import { colorOf, isGraded, NO_COLOR, setClipColor } from "./color";
import { addClip } from "./edit";
import { applyColorToAll, changeColor, undo } from "./editor";
import { colourClipCount, lookAt, LOOKS, matchLook, setColorOnAll } from "./looks";

/** "video" and "second" on v1, a still on v2, music on a1. */
function project(): Project {
  let p = makeProject();
  for (const [assetId, trackId, id, start] of [
    [IDS.vid, IDS.v1, "video", 0],
    [IDS.vid2, IDS.v1, "second", 12],
    [IDS.img, IDS.v2, "still", 0],
    [IDS.aud, IDS.a1, "music", 0],
  ] as const) {
    const r = addClip(p, { assetId, trackId, start, id });
    if (!r.ok) throw new Error(r.error.message);
    p = r.project;
  }
  return p;
}
const now = () => useProjectStore.getState().project;
const clip = (id: string) =>
  now()
    .tracks.flatMap((t) => t.clips)
    .find((c) => c.id === id)!;
const punch = LOOKS.find((l) => l.id === "punch")!;

beforeEach(() => {
  useProjectStore.setState({ project: project(), past: [], future: [] });
  useSelectionStore.getState().clear();
  useUiStore.setState({ notice: null, dialog: null, colorClipboard: null, colorDraft: null });
  useLookPreviewStore.setState({ pictures: {}, asked: {} });
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation((async (cmd: string, args?: { looks?: unknown[] }) => {
    if (cmd === "look_previews") return (args?.looks ?? []).map((_, i) => `/cache/looks/${i}.png`);
    return undefined;
  }) as never);
});

describe("looks", () => {
  it("are CutVii's own named sets of the Adjust values", () => {
    expect(LOOKS.length).toBeGreaterThanOrEqual(8);
    expect(new Set(LOOKS.map((l) => l.id)).size).toBe(LOOKS.length);
    expect(new Set(LOOKS.map((l) => l.name)).size).toBe(LOOKS.length);
    for (const look of LOOKS) {
      expect(isGraded(look.adjust)).toBe(true);
      expect(Object.keys(look.adjust).sort()).toEqual(Object.keys(NO_COLOR).sort());
      // a look is a legal colour for a clip
      expect(setClipColor(project(), "video", look.adjust).ok).toBe(true);
    }
  });

  it("scale with Intensity on whole-percent steps and are recognised again from a clip's values", () => {
    expect(lookAt(punch.adjust, 100)).toEqual(punch.adjust);
    expect(Object.values(lookAt(punch.adjust, 0)).every((v) => v === 0)).toBe(true);
    const half = lookAt(punch.adjust, 50);
    expect(half.contrast).toBe(0.18); // 0.35 / 2, on the sliders' steps
    expect(Object.values(half).every((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-9)).toBe(true);
    expect(matchLook(punch.adjust)).toEqual({ id: "punch", intensity: 100 });
    // neighbouring percents can round to the same values: any of them is a right answer
    const again = matchLook(lookAt(punch.adjust, 60))!;
    expect(again.id).toBe("punch");
    expect(lookAt(punch.adjust, again.intensity)).toEqual(lookAt(punch.adjust, 60));
    expect(matchLook(NO_COLOR)).toBeNull();
    expect(matchLook({ ...punch.adjust, tint: 0.77 })).toBeNull(); // changed by hand
  });

  it("replace a clip's colour as one undo step", () => {
    changeColor("video", { tint: 0.5 });
    changeColor("video", lookAt(punch.adjust, 100), true);
    expect(colorOf(clip("video"))).toEqual(punch.adjust); // the old tint is gone, not mixed in
    expect(useProjectStore.getState().past).toHaveLength(2);
    undo();
    expect(colorOf(clip("video")).tint).toBe(0.5);
  });
});

describe("colour on all clips", () => {
  it("gives every clip with a picture the same colour in one step, and leaves sound alone", () => {
    expect(colourClipCount(now())).toBe(3);
    changeColor("second", { exposure: -0.4 });
    const before = now();
    applyColorToAll(punch.adjust);
    for (const id of ["video", "second", "still"]) expect(colorOf(clip(id))).toEqual(punch.adjust);
    expect(clip("music").color).toBeUndefined();
    expectValid(now());
    undo();
    expect(now()).toEqual(before);
    // and removing it everywhere
    const cleared = setColorOnAll(now(), null);
    expect(
      cleared.ok && cleared.project.tracks.flatMap((t) => t.clips).every((c) => c.color === undefined),
    ).toBe(true);
  });
});

describe("the Looks gallery in the Color tab", () => {
  function open(id = "video") {
    useSelectionStore.getState().select(id);
    useUiStore.getState().setInspectorTab("video", "color");
    render(<Inspector />);
    return within(screen.getByRole("group", { name: "Presets" }));
  }

  it("shows a frame of the clip through every look and applies one with a click", async () => {
    const panel = open();
    // one request: the plain frame and every look, from the middle of the clip
    await waitFor(() =>
      expect(vi.mocked(invoke).mock.calls.filter((c) => c[0] === "look_previews")).toHaveLength(1),
    );
    const call = vi.mocked(invoke).mock.calls.find((c) => c[0] === "look_previews")![1] as {
      path: string;
      at: number;
      looks: unknown[];
    };
    expect(call).toMatchObject({ path: "/m/vid.mp4", at: 5 });
    expect(call.looks).toHaveLength(LOOKS.length + 1);
    await waitFor(() =>
      expect(panel.getByRole("button", { name: "Punch" }).querySelector("img")).not.toBeNull(),
    );

    expect(panel.getByRole("button", { name: "None" })).toHaveAttribute("aria-pressed", "true");
    expect(panel.getByRole("slider", { name: /Intensity/ })).toBeDisabled();
    fireEvent.click(panel.getByRole("button", { name: "Punch" }));
    expect(colorOf(clip("video"))).toEqual(punch.adjust);
    expect(panel.getByRole("button", { name: "Punch" })).toHaveAttribute("aria-pressed", "true");
    // the Adjust sliders below show the look's values
    expect(screen.getByRole("slider", { name: "Contrast" })).toHaveValue("35");

    // Intensity: the preview follows while dragging, one undo step on release
    const intensity = panel.getByRole("slider", { name: "Intensity of Punch" });
    const steps = useProjectStore.getState().past.length;
    fireEvent.change(intensity, { target: { value: "40" } });
    expect(useUiStore.getState().colorDraft).toEqual({ clipId: "video", adjust: lookAt(punch.adjust, 40) });
    expect(useProjectStore.getState().past).toHaveLength(steps);
    fireEvent.pointerUp(intensity);
    expect(colorOf(clip("video"))).toEqual(lookAt(punch.adjust, 40));
    expect(useProjectStore.getState().past).toHaveLength(steps + 1);
    expect(useUiStore.getState().colorDraft).toBeNull();

    fireEvent.click(panel.getByRole("button", { name: "None" }));
    expect(clip("video").color).toBeUndefined();
  });

  it("copies a clip's colour, pastes it on another, and applies it to all after asking", async () => {
    changeColor("video", lookAt(punch.adjust, 70), true);
    const panel = open();
    fireEvent.click(panel.getByRole("button", { name: "Copy colour" }));
    expect(useUiStore.getState().colorClipboard).toEqual(lookAt(punch.adjust, 70));

    changeColor("second", useUiStore.getState().colorClipboard, true);
    expect(colorOf(clip("second"))).toEqual(lookAt(punch.adjust, 70));
    expect(panel.getByRole("button", { name: "Paste colour" })).toBeDisabled(); // this clip already has it

    fireEvent.click(panel.getByRole("button", { name: "Apply to all clips" }));
    await waitFor(() => expect(useUiStore.getState().dialog?.title).toBe("Use this colour on all clips?"));
    expect(useUiStore.getState().dialog?.lines[0]).toMatch(/2 other clips/);
    useUiStore.getState().closeDialog(true);
    await waitFor(() => expect(colorOf(clip("still"))).toEqual(lookAt(punch.adjust, 70)));
  });
});

describe("my colour presets", () => {
  const presets = () => usePresets.getState();
  beforeEach(() => {
    localStorage.clear();
    presets().reset();
  });

  it("saves the current colour under a name, keeps it between sessions and refuses bad names", () => {
    const mine = { ...NO_COLOR, exposure: 0.3, tint: -0.2 };
    const saved = presets().save("  Evening  ", mine);
    expect("id" in saved).toBe(true);
    expect(presets().mine).toMatchObject([{ name: "Evening", adjust: mine }]);
    expect(JSON.parse(localStorage.getItem(COLOR_PRESETS_KEY)!)).toHaveLength(1);
    // a later start reads it back
    presets().reset();
    expect(presets().mine.map((p) => p.name)).toEqual(["Evening"]);

    expect(presets().save("", mine)).toEqual({ problem: "Give the preset a name." });
    expect(presets().save("evening", mine)).toMatchObject({
      problem: expect.stringMatching(/already has that name/),
    });
    expect(presets().save("Punch", mine)).toMatchObject({
      problem: expect.stringMatching(/already has that name/),
    });
    expect(presets().save("x".repeat(41), mine)).toMatchObject({
      problem: expect.stringMatching(/40 characters/),
    });
    expect(presets().save("Nothing", NO_COLOR)).toMatchObject({
      problem: expect.stringMatching(/nothing to save/),
    });
    expect(presets().mine).toHaveLength(1);
  });

  it("renames, duplicates and deletes its own, and never a built-in look", () => {
    const saved = presets().save("Evening", { ...NO_COLOR, exposure: 0.3 }) as { id: string };
    expect(presets().rename(saved.id, "Night walk")).toBeNull();
    expect(presets().rename(saved.id, "Moss")).toMatch(/already has that name/);
    expect(presets().rename("punch", "Mine now")).toMatch(/cannot be renamed/);
    const copy = presets().duplicate(saved.id)!;
    const fromBuiltIn = presets().duplicate("punch")!;
    expect(presets().mine.map((p) => p.name)).toEqual(["Night walk", "Night walk copy", "Punch copy"]);
    expect(presets().mine.find((p) => p.id === fromBuiltIn)?.adjust).toEqual(punch.adjust);
    presets().remove(copy);
    presets().remove("punch"); // not theirs: nothing happens
    expect(presets().mine.map((p) => p.name)).toEqual(["Night walk", "Punch copy"]);
    expect(LOOKS.some((l) => l.id === "punch")).toBe(true);
  });

  it("drops stored presets that are damaged or try to replace a built-in look", () => {
    localStorage.setItem(
      COLOR_PRESETS_KEY,
      JSON.stringify([
        { id: "punch", name: "Fake Punch", adjust: { ...NO_COLOR, exposure: 1 } },
        { id: "my-1", name: "Good", adjust: { ...NO_COLOR, exposure: 0.2 } },
        { id: "my-1", name: "Twice", adjust: { ...NO_COLOR, exposure: 0.4 } },
      ]),
    );
    presets().reset();
    expect(presets().mine.map((p) => p.name)).toEqual(["Good"]);
    localStorage.setItem(
      COLOR_PRESETS_KEY,
      JSON.stringify([{ id: "my-2", name: "Wild", adjust: { exposure: 9 } }]),
    );
    presets().reset();
    expect(presets().mine).toEqual([]);
    localStorage.setItem(COLOR_PRESETS_KEY, "{ not json");
    presets().reset();
    expect(presets().mine).toEqual([]);
  });

  it("exports one of its own through Rust's save dialog, by name and values only", async () => {
    const adjust = { ...NO_COLOR, contrast: 0.4 };
    const saved = presets().save("Crisp", adjust) as { id: string };
    vi.mocked(invoke).mockImplementation((async (cmd: string) =>
      cmd === "export_color_preset" ? "/out/Crisp.cutviipreset" : undefined) as never);
    expect(await presets().exportFile(saved.id)).toBe("/out/Crisp.cutviipreset");
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("export_color_preset", { name: "Crisp", adjust });
    await expect(presets().exportFile("punch")).rejects.toThrow(/own presets/);
  });

  it("works from the Color tab: save, apply to another clip with Intensity, rename and delete", async () => {
    changeColor("video", { exposure: 0.3, tint: -0.2 });
    useSelectionStore.getState().select("video");
    useUiStore.getState().setInspectorTab("video", "color");
    render(<Inspector />);
    const panel = within(screen.getByRole("group", { name: "Presets" }));
    expect(panel.queryByRole("group", { name: "My presets" })).toBeNull();

    fireEvent.click(panel.getByRole("button", { name: "Save as preset" }));
    fireEvent.change(panel.getByRole("textbox", { name: "Preset name" }), { target: { value: "Evening" } });
    fireEvent.click(panel.getByRole("button", { name: "Save" }));
    const own = within(panel.getByRole("group", { name: "My presets" }));
    // this clip is that preset now, at full strength
    expect(own.getByRole("button", { name: "Evening" })).toHaveAttribute("aria-pressed", "true");
    expect(panel.getByRole("slider", { name: "Intensity of Evening" })).toHaveValue("100");

    // its own picture was asked for
    await waitFor(() =>
      expect(
        vi.mocked(invoke).mock.calls.filter((c) => c[0] === "look_previews").length,
      ).toBeGreaterThanOrEqual(2),
    );

    fireEvent.click(own.getByRole("button", { name: "Evening options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    fireEvent.change(screen.getByRole("textbox", { name: "New name" }), { target: { value: "Dusk" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/already has that name/); // a built-in is called Dusk
    fireEvent.change(screen.getByRole("textbox", { name: "New name" }), { target: { value: "Night walk" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(own.getByRole("button", { name: "Night walk" })).toBeInTheDocument();

    // deleting the preset does not touch the clip's colour
    fireEvent.click(own.getByRole("button", { name: "Night walk options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(panel.queryByRole("group", { name: "My presets" })).toBeNull();
    expect(colorOf(clip("video"))).toMatchObject({ exposure: 0.3, tint: -0.2 });
  });
});

describe("the gallery pictures can be shown", () => {
  it("the folder Rust writes them to is one the webview may read", async () => {
    const conf = (await import("../../src-tauri/tauri.conf.json")).default as {
      app: { security: { assetProtocol: { scope: string[] } } };
    };
    expect(conf.app.security.assetProtocol.scope).toContain("$APPCACHE/look-previews/**");
  });
});

describe("importing colour presets", () => {
  const presets = () => usePresets.getState();
  const rust = (answer: unknown) =>
    vi
      .mocked(invoke)
      .mockImplementation((async (cmd: string) =>
        cmd === "import_color_presets" ? answer : undefined) as never);
  beforeEach(() => {
    localStorage.clear();
    presets().reset();
  });

  it("round-trips: what was exported comes back as the same preset", async () => {
    const adjust = { ...NO_COLOR, contrast: 0.4, tint: -0.1 };
    const saved = presets().save("Crisp", adjust) as { id: string };
    let exported: { name: string; adjust: unknown } | null = null;
    vi.mocked(invoke).mockImplementation((async (cmd: string, args: { name: string; adjust: unknown }) => {
      if (cmd === "export_color_preset") {
        exported = { name: args.name, adjust: args.adjust };
        return "/out/Crisp.cutviipreset";
      }
      if (cmd === "import_color_presets") return { presets: [exported], problems: [] };
      return undefined;
    }) as never);
    await presets().exportFile(saved.id);
    presets().remove(saved.id);
    const summary = await presets().importFiles();
    expect(summary).toEqual({ added: ["Crisp"], skipped: [], problems: [] });
    expect(presets().mine).toMatchObject([{ name: "Crisp", adjust }]);
    // importing the same file again adds nothing
    expect(await presets().importFiles()).toMatchObject({ added: [], skipped: ["Crisp"] });
    expect(presets().mine).toHaveLength(1);
  });

  it("keeps both on a name clash and never replaces a built-in look", async () => {
    presets().save("Evening", { ...NO_COLOR, exposure: 0.3 });
    rust({
      presets: [
        { name: "Evening", adjust: { ...NO_COLOR, exposure: -0.5 } },
        { name: "Punch", adjust: { ...NO_COLOR, saturation: 0.9 } },
      ],
      problems: [],
    });
    const summary = await presets().importFiles();
    expect(summary.added).toEqual(["Evening 2", "Punch 2"]);
    expect(presets().mine.map((p) => p.name)).toEqual(["Evening", "Evening 2", "Punch 2"]);
    expect(presets().mine[0].adjust.exposure).toBe(0.3); // the user's own is untouched
    expect(LOOKS.find((l) => l.id === "punch")?.adjust).toEqual(punch.adjust);
    expect(presets().mine.every((p) => p.id.startsWith("my-"))).toBe(true);
  });

  it("skips an invalid preset, keeps the valid ones and passes on why a file was refused", async () => {
    rust({
      presets: [
        { name: "Wild", adjust: { ...NO_COLOR, exposure: 7 } },
        { name: "Extra", adjust: { ...NO_COLOR, exposure: 0.2, path: "/etc/passwd" } },
        { name: "Flat", adjust: NO_COLOR },
        { name: "Good", adjust: { ...NO_COLOR, exposure: 0.2 } },
      ],
      problems: [["broken.cutviipreset", "invalid input: this is not a CutVii colour preset"]],
    });
    const summary = await presets().importFiles();
    expect(summary.added).toEqual(["Good"]);
    expect(summary.problems.map((p) => p.file)).toEqual(["broken.cutviipreset", "Wild", "Extra", "Flat"]);
    expect(presets().mine.map((p) => p.name)).toEqual(["Good"]);

    rust("nonsense");
    await expect(presets().importFiles()).rejects.toThrow(/unexpected/);
    rust({ presets: [], problems: [] }); // the dialog was dismissed
    expect(await presets().importFiles()).toEqual({ added: [], skipped: [], problems: [] });
  });

  it("is a button in the Color tab that says what happened", async () => {
    rust({
      presets: [{ name: "Shared", adjust: { ...NO_COLOR, exposure: 0.2 } }],
      problems: [["x.cutviipreset", "too large"]],
    });
    useSelectionStore.getState().select("video");
    useUiStore.getState().setInspectorTab("video", "color");
    render(<Inspector />);
    const panel = within(screen.getByRole("group", { name: "Presets" }));
    fireEvent.click(panel.getByRole("button", { name: "Import preset…" }));
    await waitFor(() =>
      expect(useUiStore.getState().notice).toMatch(/Imported Shared\. x\.cutviipreset: too large\./),
    );
    expect(
      within(panel.getByRole("group", { name: "My presets" })).getByRole("button", { name: "Shared" }),
    ).toBeInTheDocument();
  });
});
