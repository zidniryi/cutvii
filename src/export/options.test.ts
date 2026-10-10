import { createProject } from "@/project/factory";
import { defaultOptions, fpsChoices, resolutionPresets } from "./options";

describe("export options", () => {
  it("offers project size and standard heights at the project aspect ratio, all even", () => {
    const p = createProject("x", { width: 1920, height: 1080, fps: 30 });
    const presets = resolutionPresets(p);
    expect(presets.map((r) => `${r.width}x${r.height}`)).toEqual(["1920x1080", "1280x720", "854x480"]);
    for (const r of presets) {
      expect(r.width % 2).toBe(0);
      expect(r.height % 2).toBe(0);
    }
  });

  it("keeps portrait projects portrait and removes duplicates", () => {
    const p = createProject("x", { width: 1080, height: 1920 });
    expect(resolutionPresets(p)[0]).toMatchObject({ width: 1080, height: 1920 });
    expect(resolutionPresets(p).find((r) => r.id === "720p")).toMatchObject({ width: 406, height: 720 });
    const hd = createProject("x", { width: 1280, height: 720 });
    expect(resolutionPresets(hd).map((r) => r.id)).toEqual(["project", "1080p", "480p"]);
  });

  it("rounds odd project sizes to even", () => {
    const p = createProject("x", { width: 1001, height: 563 });
    expect(resolutionPresets(p)[0]).toMatchObject({ width: 1002, height: 564 });
  });

  it("includes the project fps once and defaults to project size at standard quality", () => {
    const p = createProject("x", { fps: 29.97 });
    expect(fpsChoices(p)).toEqual([24, 25, 30, 50, 60]);
    const d = defaultOptions(createProject("x", { fps: 48 }));
    expect(d).toMatchObject({ width: 1920, height: 1080, fps: 48, quality: "standard" });
    expect(fpsChoices(createProject("x", { fps: 48 }))).toContain(48);
  });
});
