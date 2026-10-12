import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { ExportDialog } from "@/components/ExportDialog";
import { useExportStore } from "@/store/export";
import { EXPORT_PRESETS_KEY, useExportPresetStore } from "@/store/exportPresets";
import { useProjectStore } from "@/store/project";
import { IDS, makeProject } from "@/test/makeProject";
import { addClip } from "@/timeline/edit";
import type { ExportOptions } from "./options";
import { describeOptions, ExportOptionsSchema, ExportPresetSchema, sameOptions } from "./presets";

const reel: ExportOptions = { width: 1080, height: 1920, fps: 30, quality: "high", format: "mp4" };
const presets = () => useExportPresetStore.getState();

beforeEach(() => {
  localStorage.clear();
  presets().reset();
  vi.mocked(invoke).mockReset();
});

describe("export preset values", () => {
  it("accepts what CutVii can export and nothing else", () => {
    expect(ExportOptionsSchema.safeParse(reel).success).toBe(true);
    const bad: Partial<Record<keyof ExportOptions, unknown>>[] = [
      { width: 1081 }, // odd
      { width: 14 },
      { height: 8194 },
      { width: 1080.5 },
      { fps: 0 },
      { fps: 121 },
      { fps: Number.NaN },
      { quality: "ultra" },
      { format: "mov" },
    ];
    for (const change of bad) {
      expect(ExportOptionsSchema.safeParse({ ...reel, ...change }).success, JSON.stringify(change)).toBe(
        false,
      );
    }
    // nothing extra rides along: no paths, no commands
    expect(ExportOptionsSchema.safeParse({ ...reel, output: "/etc/passwd" }).success).toBe(false);
    expect(ExportPresetSchema.safeParse({ id: "a", name: "A", options: reel, run: "x" }).success).toBe(false);
    expect(ExportOptionsSchema.safeParse({ ...reel, fps: 29.97 }).success).toBe(true);
  });

  it("describes and compares settings", () => {
    expect(describeOptions(reel)).toBe("1080×1920 · 30 fps · High · MP4");
    expect(describeOptions({ ...reel, format: "mp3" })).toBe("MP3 sound");
    expect(sameOptions(reel, { ...reel })).toBe(true);
    expect(sameOptions(reel, { ...reel, quality: "draft" })).toBe(false);
  });
});

describe("my export presets", () => {
  it("saves, keeps between sessions, renames and deletes, and refuses bad names and values", () => {
    const saved = presets().save("  Reel  ", reel) as { id: string };
    expect(presets().mine).toMatchObject([{ name: "Reel", options: reel }]);
    presets().reset(); // a later start
    expect(presets().mine.map((p) => p.name)).toEqual(["Reel"]);

    expect(presets().save("", reel)).toEqual({ problem: "Give the preset a name." });
    expect(presets().save("reel", reel)).toMatchObject({
      problem: expect.stringMatching(/already has that name/),
    });
    expect(presets().save("x".repeat(41), reel)).toMatchObject({
      problem: expect.stringMatching(/40 characters/),
    });
    expect(presets().save("Odd", { ...reel, width: 1081 })).toMatchObject({
      problem: expect.stringMatching(/cannot be saved/),
    });

    presets().save("Square", { ...reel, height: 1080 });
    expect(presets().rename(saved.id, "Square")).toMatch(/already has that name/);
    expect(presets().rename(saved.id, "TikTok")).toBeNull();
    expect(presets().rename("gone", "X")).toMatch(/no longer exists/);
    presets().remove(saved.id);
    expect(presets().mine.map((p) => p.name)).toEqual(["Square"]);
    expect(JSON.parse(localStorage.getItem(EXPORT_PRESETS_KEY)!)).toHaveLength(1);
  });

  it("drops stored presets that are damaged, out of range or repeated", () => {
    localStorage.setItem(
      EXPORT_PRESETS_KEY,
      JSON.stringify([
        { id: "a", name: "Good", options: reel },
        { id: "a", name: "Same id", options: reel },
        { id: "b", name: "Huge", options: { ...reel, width: 99998 } },
        { id: "c", name: "Extra", options: { ...reel, shell: "rm -rf" } },
        "nonsense",
      ]),
    );
    presets().reset();
    expect(presets().mine.map((p) => p.name)).toEqual(["Good"]);
    localStorage.setItem(EXPORT_PRESETS_KEY, "{ not json");
    presets().reset();
    expect(presets().mine).toEqual([]);
  });
});

describe("presets in the Export dialog", () => {
  function open() {
    const r = addClip(makeProject(), { assetId: IDS.vid, trackId: IDS.v1, start: 0, id: "video" });
    if (!r.ok) throw new Error(r.error.message);
    useProjectStore.setState({ project: r.project, past: [], future: [] });
    useExportStore.setState({
      phase: "settings",
      progress: 0,
      report: null,
      error: null,
      cancelling: false,
      session: 1,
    });
    render(<ExportDialog />);
    return within(screen.getByRole("dialog", { name: "Export" }));
  }

  it("saves the current settings, applies a preset with one press, renames and deletes it", () => {
    const dialog = open();
    const mine = within(dialog.getByRole("group", { name: "My export presets" }));
    expect(mine.getByText(/None yet/)).toBeInTheDocument();

    // choose something other than the defaults and save it
    fireEvent.click(dialog.getByRole("radio", { name: /^High/ }));
    fireEvent.click(mine.getByRole("button", { name: "Save as preset" }));
    fireEvent.change(mine.getByRole("textbox", { name: "Preset name" }), { target: { value: "Best" } });
    fireEvent.click(mine.getByRole("button", { name: "Save" }));
    expect(presets().mine).toMatchObject([{ name: "Best", options: { quality: "high", format: "mp4" } }]);
    expect(mine.getByRole("button", { name: "Best" })).toHaveAttribute("aria-pressed", "true");
    expect(mine.getByRole("button", { name: "Save as preset" })).toBeDisabled(); // already saved

    // change away, then one press brings the preset's settings back
    fireEvent.click(dialog.getByRole("radio", { name: /^Draft/ }));
    expect(mine.getByRole("button", { name: "Best" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(mine.getByRole("button", { name: "Best" }));
    expect(dialog.getByRole("radio", { name: /^High/ })).toBeChecked();

    fireEvent.click(mine.getByRole("button", { name: "Rename “Best”" }));
    fireEvent.change(mine.getByRole("textbox", { name: "Preset name" }), { target: { value: "Final" } });
    fireEvent.click(mine.getByRole("button", { name: "Rename" }));
    expect(mine.getByRole("button", { name: "Final" })).toBeInTheDocument();
    fireEvent.click(mine.getByRole("button", { name: "Delete preset Final" }));
    expect(presets().mine).toEqual([]);
  });

  it("shows a preset's unusual size and frame rate as real choices, and exports exactly those", async () => {
    presets().save("Reel 48", { ...reel, fps: 48 });
    const dialog = open();
    fireEvent.click(dialog.getByRole("button", { name: "Reel 48" }));
    expect(dialog.getByRole("radio", { name: "Preset size, 1080×1920" })).toBeChecked();
    expect(dialog.getByRole("radio", { name: "48 fps" })).toBeChecked();
    expect(dialog.getByTestId("export-summary")).toHaveTextContent("1080×1920 · 48 fps");
    vi.mocked(invoke).mockResolvedValue(null);
    fireEvent.click(dialog.getByRole("button", { name: /^Export/ }));
    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith(
        "export_project",
        expect.objectContaining({ options: { ...reel, fps: 48 } }),
      ),
    );
  });
});
