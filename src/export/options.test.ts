import { createProject } from "@/project/factory";
import { defaultOptions, EXPORT_MAX, fpsChoices, isEnlarged, resolutionPresets } from "./options";

describe("export options", () => {
  it("offers project size and standard heights at the project aspect ratio, all even", () => {
    const p = createProject("x", { width: 1920, height: 1080, fps: 30 });
    const presets = resolutionPresets(p);
    expect(presets.map((r) => `${r.width}x${r.height}`)).toEqual([
      "1920x1080",
      "1280x720",
      "854x480",
      "2560x1440",
      "3840x2160",
    ]);
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
    expect(resolutionPresets(hd).map((r) => r.id)).toEqual(["project", "1080p", "480p", "1440p", "2160p"]);
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

  it("offers 2K and 4K by the short side, flags sizes that enlarge the picture, and stays inside the limit", () => {
    const wide = createProject("x", { width: 1920, height: 1080 });
    const by = (p: ReturnType<typeof createProject>, id: string) =>
      resolutionPresets(p).find((r) => r.id === id);
    expect(by(wide, "1440p")).toMatchObject({ label: "2K", width: 2560, height: 1440 });
    expect(by(wide, "2160p")).toMatchObject({ label: "4K", width: 3840, height: 2160 });
    // a vertical project gets a vertical 4K, not a narrow strip
    const tall = createProject("x", { width: 1080, height: 1920 });
    expect(by(tall, "2160p")).toMatchObject({ width: 2160, height: 3840 });
    expect(by(tall, "1440p")).toMatchObject({ width: 1440, height: 2560 });
    const square = createProject("x", { width: 1080, height: 1080 });
    expect(by(square, "2160p")).toMatchObject({ width: 2160, height: 2160 });

    expect(isEnlarged(by(wide, "2160p")!, wide)).toBe(true);
    expect(isEnlarged(by(wide, "project")!, wide)).toBe(false);
    expect(isEnlarged(by(wide, "720p")!, wide)).toBe(false);
    // a project that is already 4K: 4K is its own size, listed once, not "enlarged"
    const uhd = createProject("x", { width: 3840, height: 2160 });
    expect(resolutionPresets(uhd).filter((r) => r.width === 3840)).toHaveLength(1);
    // a very wide canvas: sizes the exporter would refuse are not offered
    const banner = createProject("x", { width: 4000, height: 1000 });
    for (const r of resolutionPresets(banner)) {
      expect(r.width).toBeLessThanOrEqual(EXPORT_MAX.width);
      expect(r.height).toBeLessThanOrEqual(EXPORT_MAX.height);
      expect(r.width % 2 === 0 && r.height % 2 === 0).toBe(true);
    }
    expect(by(banner, "2160p")).toBeUndefined(); // 8640 wide: over the limit
  });
});
