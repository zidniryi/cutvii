import fixture from "../../fixtures/project-v5.json";
import {
  canvasFromAsset,
  canvasFromValues,
  canvasLabel,
  FALLBACK_CANVAS,
  lockedSide,
  PLATFORM_TEMPLATES,
  rationalFromFps,
  toNumber,
  validateCanvas,
  withCanvas,
} from "./canvas";
import { parseProject } from "./parse";
import { createProject } from "./factory";

const video = (w: number, h: number, fpsNum?: number, fpsDen?: number) => ({
  type: "video" as const,
  width: w,
  height: h,
  fpsNum,
  fpsDen,
});

describe("Original: canvas from the first video", () => {
  it("uses the displayed size, so a rotated phone video gives a portrait canvas", () => {
    // the Rust probe already swapped a 1920x1080 clip with 90° rotation metadata to 1080x1920
    const r = canvasFromAsset(video(1080, 1920, 30, 1));
    expect(r.fallback).toBe(false);
    expect(r.canvas).toMatchObject({ width: 1080, height: 1920, fps: 30 });
  });

  it("falls back to 1920x1080 @ 30 and says why when the first media is an image or audio", () => {
    const img = canvasFromAsset({ type: "image", width: 4000, height: 3000 });
    expect(img.fallback).toBe(true);
    expect(img.canvas).toEqual(FALLBACK_CANVAS);
    expect(img.notes[0]).toMatch(/image/);

    const audio = canvasFromAsset({ type: "audio" });
    expect(audio.fallback).toBe(true);
    expect(audio.notes[0]).toMatch(/audio/);
  });

  it("rounds odd dimensions down to even and reports it", () => {
    const r = canvasFromAsset(video(1081, 607, 25, 1));
    expect(r.canvas).toMatchObject({ width: 1080, height: 606 });
    expect(r.notes.join(" ")).toMatch(/odd size 1081×607 rounded down/);
    // already even: no note
    expect(canvasFromAsset(video(1920, 1080, 30, 1)).notes).toEqual([]);
  });

  it("keeps a fractional frame rate as an exact rational", () => {
    const r = canvasFromAsset(video(1920, 1080, 30000, 1001));
    expect(r.canvas.fpsNum).toBe(30000);
    expect(r.canvas.fpsDen).toBe(1001);
    expect(r.canvas.fps).toBe(30000 / 1001); // not 29.97
    expect(r.canvas.fps).not.toBe(29.97);
    expect(canvasFromAsset(video(1280, 720, 24000, 1001)).canvas).toMatchObject({
      fpsNum: 24000,
      fpsDen: 1001,
    });
  });

  it("uses 30 fps, with a note, when the rate is unknown or outside 1-120", () => {
    const unknown = canvasFromAsset(video(1920, 1080));
    expect(unknown.canvas).toMatchObject({ fps: 30, fpsNum: 30, fpsDen: 1 });
    expect(unknown.notes.join(" ")).toMatch(/unknown/);

    const slowMo = canvasFromAsset(video(1920, 1080, 240, 1));
    expect(slowMo.canvas.fps).toBe(30);
    expect(slowMo.notes.join(" ")).toMatch(/outside 1–120/);
  });

  it("scales oversized video into the 8192 px limit and rejects tiny sizes", () => {
    const big = canvasFromAsset(video(16384, 8192, 30, 1));
    expect(big.canvas).toMatchObject({ width: 8192, height: 4096 });
    expect(big.notes.join(" ")).toMatch(/scaled down/);

    const tiny = canvasFromAsset(video(12, 12, 30, 1));
    expect(tiny.fallback).toBe(true);
  });

  it("every detected canvas is accepted by the project schema", () => {
    for (const a of [video(1081, 607, 30000, 1001), video(1080, 1920, 25, 1), { type: "image" as const }]) {
      const c = canvasFromAsset(a).canvas;
      const p = withCanvas(parseOk(), c);
      expect(parseProject(p).ok, JSON.stringify(c)).toBe(true);
    }
  });
});

function parseOk() {
  const r = parseProject(fixture);
  if (!r.ok) throw new Error("fixture invalid");
  return r.project;
}

describe("Custom canvas validation", () => {
  const ok = (w: unknown, h: unknown, f: unknown) => validateCanvas({ width: w, height: h, fps: f });

  it("accepts the limits themselves", () => {
    for (const [w, h, f] of [
      [16, 16, 1],
      [8192, 8192, 120],
      [1080, 1920, 29.97],
    ] as const) {
      expect(ok(w, h, f).ok, `${w}x${h}@${f}`).toBe(true);
    }
  });

  it("rejects odd sizes with a clear message per field", () => {
    const r = ok(1921, 1081, 30);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.width).toBe("Width must be an even number");
      expect(r.errors.height).toBe("Height must be an even number");
      expect(r.errors.fps).toBeUndefined();
    }
  });

  it("rejects sizes outside 16-8192 px and fps outside 1-120", () => {
    const r = ok(14, 8194, 0.5);
    expect(!r.ok && r.errors).toEqual({
      width: "Width must be between 16 and 8192 px",
      height: "Height must be between 16 and 8192 px",
      fps: "Frame rate must be between 1 and 120",
    });
    expect(!ok(1920, 1080, 121).ok).toBe(true);
  });

  it("rejects non-numbers and fractional sizes", () => {
    expect(toNumber("")).toBeNaN();
    const r = ok(toNumber(""), 1080.5, toNumber("abc"));
    expect(!r.ok && r.errors.width).toBe("Width must be a number");
    expect(!r.ok && r.errors.height).toBe("Height must be a whole number");
    expect(!r.ok && r.errors.fps).toBe("Frame rate must be a number");
  });

  it("returns an exact rational for NTSC-style input", () => {
    const r = ok(1920, 1080, 29.97);
    expect(r.ok && r.canvas).toMatchObject({ fpsNum: 30000, fpsDen: 1001 });
    expect(rationalFromFps(25)).toEqual({ num: 25, den: 1 });
    expect(rationalFromFps(12.5)).toEqual({ num: 25, den: 2 });
    expect(rationalFromFps(23.976)).toEqual({ num: 24000, den: 1001 });
  });

  it("aspect lock keeps the ratio and returns even numbers", () => {
    expect(lockedSide(1280, 16 / 9, "width")).toBe(720);
    expect(lockedSide(1080, 9 / 16, "width")).toBe(1920);
    expect(lockedSide(1000, 16 / 9, "width") % 2).toBe(0); // 562.5 -> 562
    expect(lockedSide(1000, 4 / 5, "height") % 2).toBe(0);
    expect(lockedSide(720, 16 / 9, "height")).toBe(1280);
  });
});

describe("platform templates", () => {
  it("are exactly the four requested, filling only size and frame rate", () => {
    expect(PLATFORM_TEMPLATES.map((t) => [t.id, t.width, t.height])).toEqual([
      ["reel", 1080, 1920],
      ["youtube", 1920, 1080],
      ["instagram-post", 1080, 1350],
      ["square", 1080, 1080],
    ]);
    for (const t of PLATFORM_TEMPLATES) {
      expect(Object.keys(t).sort()).toEqual(["fps", "height", "id", "name", "ratio", "width"]);
      expect(validateCanvas(t).ok).toBe(true);
    }
    expect(canvasLabel(canvasFromValues(1080, 1920, 30))).toBe("1080×1920 · 30 fps");
  });
});

describe("project schema canvas rules", () => {
  const withSettings = (patch: Record<string, unknown>) => {
    const p = structuredClone(fixture) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    Object.assign(p.settings, patch);
    return parseProject(p);
  };

  it("enforces limits and parity in project files too", () => {
    expect(withSettings({ width: 1921 }).ok).toBe(false);
    expect(withSettings({ height: 8194 }).ok).toBe(false);
    expect(withSettings({ fps: 121 }).ok).toBe(false);
    const r = withSettings({ width: 15 });
    expect(!r.ok && r.errors.join(" ")).toMatch(/settings\.width: Width must be between 16 and 8192 px/);
  });

  it("checks the exact rate matches fps and that both parts are present", () => {
    expect(withSettings({ fps: 30000 / 1001, fpsNum: 30000, fpsDen: 1001 }).ok).toBe(true);
    expect(withSettings({ fps: 30, fpsNum: 30000, fpsDen: 1001 }).ok).toBe(false);
    expect(withSettings({ fpsNum: 30 }).ok).toBe(false);
    expect(withSettings({ canvasPending: true }).ok).toBe(true);
    expect(createProject().settings.canvasPending).toBeUndefined();
  });
});
