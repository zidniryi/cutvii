import { fireEvent, render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import type { Project } from "@/project/model";
import { useProjectStore } from "@/store/project";
import { PREFS_KEY, useTextStyleStore } from "@/store/textStyles";
import { expectValid, IDS, makeProject } from "@/test/makeProject";
import { CaptionLimitsFields } from "@/components/inspector/CaptionLimitsFields";
import { addClip } from "./edit";
import { canvasShape, CAPTION_RANGES, CaptionLimitsSchema, DEFAULT_CAPTION_LIMITS } from "./captionRules";
import { generateSubtitles } from "./subtitles";

/** A 10 s video ("video") on v1 at 2..12, on a canvas of `width` x `height`. */
function project(width = 1920, height = 1080): Project {
  const base = makeProject();
  const r = addClip(
    { ...base, settings: { ...base.settings, width, height } },
    { assetId: IDS.vid, trackId: IDS.v1, start: 2, id: "video" },
  );
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
}

const LONG = "Hari ini kita akan belajar cara membuat video pendek yang menarik untuk media sosial.";

/** Rust's answers: one long segment, cut by `split_captions` into two pieces. */
function rust() {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation((async (cmd: string, args?: { spec?: { content: string } }) => {
    if (cmd === "transcribe_media") return [{ start: 0, end: 6, text: LONG }];
    if (cmd === "split_captions")
      return [
        {
          start: 2,
          end: 5,
          text: "Hari ini kita akan belajar\ncara membuat video pendek",
          lines: 2,
          fast: false,
        },
        { start: 5, end: 8, text: "yang menarik\nuntuk media sosial.", lines: 2, fast: false },
      ];
    if (cmd === "render_text") return `/data/text/${args?.spec?.content}.png`;
    return undefined;
  }) as never);
}
const request = () =>
  (
    vi.mocked(invoke).mock.calls.find((c) => c[0] === "split_captions")![1] as {
      request: Record<string, unknown>;
    }
  ).request;

beforeEach(() => {
  useTextStyleStore.getState().reset();
  rust();
});

describe("caption limits", () => {
  it("start from the canvas shape and are checked against their ranges", () => {
    expect(canvasShape(1920, 1080)).toBe("landscape");
    expect(canvasShape(1080, 1080)).toBe("square");
    expect(canvasShape(1080, 1350)).toBe("square");
    expect(canvasShape(1080, 1920)).toBe("vertical");
    expect(DEFAULT_CAPTION_LIMITS.landscape).toMatchObject({
      maxLines: 2,
      maxChars: 42,
      maxSeconds: 6,
      minSeconds: 1,
      maxCps: 20,
    });
    expect(DEFAULT_CAPTION_LIMITS.square.maxChars).toBe(32);
    expect(DEFAULT_CAPTION_LIMITS.vertical).toMatchObject({ maxChars: 24, maxWords: 5 });
    const ok = DEFAULT_CAPTION_LIMITS.landscape;
    expect(CaptionLimitsSchema.safeParse({ ...ok, maxLines: CAPTION_RANGES.maxLines[1] + 1 }).success).toBe(
      false,
    );
    expect(CaptionLimitsSchema.safeParse({ ...ok, maxChars: 5 }).success).toBe(false);
    expect(CaptionLimitsSchema.safeParse({ ...ok, maxCps: Number.NaN }).success).toBe(false);
    expect(CaptionLimitsSchema.safeParse({ ...ok, minSeconds: 5, maxSeconds: 2 }).success).toBe(false);
    expect(CaptionLimitsSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });

  it("are kept per canvas shape and read back after a restart; invalid ones are not kept", async () => {
    const own = { ...DEFAULT_CAPTION_LIMITS.vertical, maxChars: 20 };
    useTextStyleStore.getState().setCaptionLimits("vertical", own);
    useTextStyleStore.getState().setCaptionLimits("landscape", { ...own, maxLines: 99 });
    expect(useTextStyleStore.getState().captionLimits).toEqual({ vertical: own });
    const kept = localStorage.getItem(PREFS_KEY)!;

    vi.resetModules();
    localStorage.setItem(PREFS_KEY, kept);
    const fresh = await import("@/store/textStyles");
    expect(fresh.useTextStyleStore.getState().captionLimits).toEqual({ vertical: own });
    // a tampered entry is dropped on reading, not trusted
    localStorage.setItem(PREFS_KEY, kept.replace('"maxChars":20', '"maxChars":2000'));
    vi.resetModules();
    const again = await import("@/store/textStyles");
    expect(again.useTextStyleStore.getState().captionLimits).toEqual({});
  });

  it("can be changed in the subtitle step; a value out of range is refused", () => {
    render(<CaptionLimitsFields width={1080} height={1920} />);
    const chars = screen.getByRole("spinbutton", { name: /Characters a line/ });
    expect(chars).toHaveValue(24);
    fireEvent.change(chars, { target: { value: "30" } });
    fireEvent.blur(chars);
    expect(useTextStyleStore.getState().captionLimits.vertical?.maxChars).toBe(30);
    const lines = screen.getByRole("spinbutton", { name: /Lines at most/ });
    fireEvent.change(lines, { target: { value: "12" } });
    fireEvent.blur(lines);
    expect(screen.getByRole("alert")).toHaveTextContent("Use 1 to 4.");
    expect(useTextStyleStore.getState().captionLimits.vertical?.maxLines).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: /Reset to the starting limits/ }));
    expect(useTextStyleStore.getState().captionLimits).toEqual({});
  });
});

describe("auto subtitles are cut into captions", () => {
  it("sends every segment through the one splitter with the canvas limits and adds its pieces", async () => {
    useProjectStore.getState().loadProject(project(), "/p.cutvii", []);
    expect(await generateSubtitles("video", "base", "id")).toEqual({ ok: true, added: 2 });
    expect(request()).toEqual({
      sources: [{ start: 2, end: 8, text: LONG }],
      limits: DEFAULT_CAPTION_LIMITS.landscape,
      language: "id",
      fps: 30,
      endLimit: 12,
      uppercase: false,
      bottom: true,
    });
    const after = useProjectStore.getState().project;
    expectValid(after);
    const track = after.tracks.at(-1)!;
    expect(track.clips.map((c) => [c.timelineStart, c.sourceOut])).toEqual([
      [2, 3],
      [5, 3],
    ]);
    const texts = after.assets.filter((a) => a.text).map((a) => a.text!.content);
    expect(texts.join(" ").replace(/\s+/g, " ")).toBe(LONG);
  });

  it("uses the tall limits on a vertical canvas, the user's own limits, and fewer characters for capitals", async () => {
    useProjectStore.getState().loadProject(project(1080, 1920), "/p.cutvii", []);
    await generateSubtitles("video", "base", null);
    expect(request()).toMatchObject({ limits: DEFAULT_CAPTION_LIMITS.vertical, language: null });

    rust();
    const own = { ...DEFAULT_CAPTION_LIMITS.vertical, maxLines: 1 };
    const style = { color: "#FFFFFF", uppercase: true };
    await generateSubtitles("video", "base", "en", undefined, { style }, { x: 0.5, y: 0.2 }, undefined, own);
    expect(request()).toMatchObject({ limits: own, uppercase: true, bottom: false, language: "en" });
  });

  it("changes nothing when the splitter refuses", async () => {
    const before = project();
    useProjectStore.getState().loadProject(before, "/p.cutvii", []);
    vi.mocked(invoke).mockImplementation((async (cmd: string) => {
      if (cmd === "transcribe_media") return [{ start: 0, end: 6, text: LONG }];
      if (cmd === "split_captions") throw "caption limits are out of range";
      return undefined;
    }) as never);
    expect(await generateSubtitles("video", "base", "id")).toEqual({
      ok: false,
      reason: "Could not cut the subtitles into captions: caption limits are out of range",
    });
    expect(useProjectStore.getState().project).toBe(before);
  });
});
