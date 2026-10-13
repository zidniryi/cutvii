import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { UpscalePanel } from "@/components/inspector/UpscalePanel";
import type { Project } from "@/project/model";
import { parseProject } from "@/project/parse";
import { useProjectStore } from "@/store/project";
import { useUiStore } from "@/store/ui";
import { useUpscaleStore, type UpscaleModel } from "@/store/upscale";
import { expectValid, IDS, makeProject } from "@/test/makeProject";
import { addClip } from "./edit";
import { undo } from "./editor";
import { setKey } from "./keyframes";
import { applyUpscaledPicture, applyUpscaledVideo, upscaleBlocker, upscaledSize } from "./upscale";

/** A 640x360 picture ("photo") on v1, a huge one ("huge") and a video ("video"). */
function project(): Project {
  const base = makeProject();
  let p: Project = {
    ...base,
    assets: [
      ...base.assets.filter((a) => a.id !== IDS.img),
      { id: IDS.img, path: "/m/img.png", type: "image", width: 640, height: 360 },
      { id: "big", path: "/m/big.png", type: "image", width: 4000, height: 3000 },
    ],
  };
  for (const [assetId, trackId, id, start] of [
    [IDS.img, IDS.v1, "photo", 0],
    ["big", IDS.v1, "huge", 10],
    [IDS.vid, IDS.v2, "video", 0],
  ] as const) {
    const r = addClip(p, { assetId, trackId, start, id });
    if (!r.ok) throw new Error(r.error.message);
    p = r.project;
  }
  return p;
}
const now = () => useProjectStore.getState().project;
const clipOf = (id: string) =>
  now()
    .tracks.flatMap((t) => t.clips)
    .find((c) => c.id === id)!;
const MODELS: UpscaleModel[] = [
  {
    id: "general",
    label: "General (photos and video)",
    approxMb: 4.7,
    source: "https://github.com/x/g.pth",
    installed: false,
  },
  {
    id: "animation",
    label: "Animation (drawn pictures, faster)",
    approxMb: 2.4,
    source: "https://github.com/x/a.pth",
    installed: false,
  },
];
let models: UpscaleModel[];
const calls: { cmd: string; args: Record<string, unknown> }[] = [];
let upscaleAnswer: unknown;

beforeEach(() => {
  models = structuredClone(MODELS);
  calls.length = 0;
  upscaleAnswer = { path: "/data/upscaled/abc.png", width: 1280, height: 720 };
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation((async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args: args ?? {} });
    if (cmd === "upscale_models") return models;
    if (cmd === "download_upscale_model") {
      models = models.map((m) => (m.id === args!.id ? { ...m, installed: true } : m));
      return undefined;
    }
    if (cmd === "delete_upscale_model") {
      models = models.map((m) => (m.id === args!.id ? { ...m, installed: false } : m));
      return undefined;
    }
    if (cmd === "upscale_video")
      return { path: "/data/upscaled/v.mp4", width: 1280, height: 720, duration: 3.97 };
    if (cmd === "upscale_image") {
      if (upscaleAnswer instanceof Error) throw upscaleAnswer.message;
      return upscaleAnswer;
    }
    return undefined;
  }) as never);
  useProjectStore.setState({ project: project(), past: [], future: [] });
  useUiStore.setState({ dialog: null, notice: null });
  useUpscaleStore.setState({ models: [], loaded: false, download: null, running: null });
});

describe("what can be upscaled", () => {
  it("pictures and video up to their limits", () => {
    const p = project();
    expect(upscaleBlocker(p, "photo")).toBeNull();
    expect(upscaleBlocker(p, "huge")).toMatch(/4000×3000.*up to 2048 px/);
    expect(upscaleBlocker(p, "video")).toBeNull(); // 10 s of video: allowed
    expect(upscaleBlocker(p, "nope")).toMatch(/missing/);
    expect(upscaledSize({ width: 640, height: 360 }, 4)).toEqual({ width: 2560, height: 1440 });
    expect(upscaledSize({ width: 640, height: 360 }, 2)).toEqual({ width: 1280, height: 720 });
    expect(upscaledSize({ width: 333, height: 333 }, 2)).toEqual({ width: 666, height: 666 });
    expect(upscaledSize({}, 2)).toBeNull();
  });
});

describe("using the upscaled picture", () => {
  const picture = { path: "/data/upscaled/abc.png", width: 1280, height: 720 };

  it("points the clip at a new media entry and keeps everything else, as one undo step", () => {
    const before = now();
    const result = useProjectStore
      .getState()
      .execute({ label: "Upscale", apply: (p) => applyUpscaledPicture(p, "photo", picture, "up-1") });
    expect(result.ok).toBe(true);
    expectValid(now());
    expect(now().assets.find((a) => a.id === "up-1")).toEqual({ id: "up-1", type: "image", ...picture });
    expect(clipOf("photo")).toEqual({
      ...before.tracks.flatMap((t) => t.clips).find((c) => c.id === "photo")!,
      assetId: "up-1",
    });
    // the original picture stays in the library, and every other clip is untouched
    expect(now().assets.some((a) => a.id === IDS.img)).toBe(true);
    expect(clipOf("video")).toBe(before.tracks.flatMap((t) => t.clips).find((c) => c.id === "video"));
    // save and reopen
    const reopened = parseProject(JSON.parse(JSON.stringify(now())));
    expect(reopened.ok && reopened.project).toEqual(now());
    undo();
    expect(now()).toEqual(before);
  });

  it("reuses the upscaled file when it is already in the project, and refuses video and text", () => {
    const first = applyUpscaledPicture(project(), "photo", picture, "up-1");
    if (!first.ok) throw new Error(first.error.message);
    const again = applyUpscaledPicture(first.project, "photo", picture, "up-2");
    expect(again.ok && again.project).toBe(first.project); // nothing to do
    expect(first.project.assets.filter((a) => a.path === picture.path)).toHaveLength(1);
    expect(applyUpscaledPicture(project(), "video", picture, "x").ok).toBe(false);
    expect(applyUpscaledPicture(project(), "gone", picture, "x").ok).toBe(false);
  });
});

describe("the Upscale with AI panel", () => {
  function open(id = "photo") {
    const clip = clipOf(id);
    const asset = now().assets.find((a) => a.id === clip.assetId)!;
    render(<UpscalePanel clip={clip} asset={asset} />);
    return within(screen.getByRole("group", { name: "Upscale with AI" }));
  }

  it("needs a model first, and downloads it only after the user agrees (with the licence said)", async () => {
    const panel = open();
    const download = await panel.findByRole("button", { name: "Download model (about 4.7 MB)…" });
    expect(panel.queryByRole("button", { name: /^Upscale/ })).toBeNull();
    expect(panel.getByText("640×360 → 1280×720")).toBeInTheDocument(); // 2× by default

    fireEvent.click(download);
    await waitFor(() => expect(useUiStore.getState().dialog?.title).toBe("Download the upscale model?"));
    const lines = useUiStore.getState().dialog!.lines.join(" ");
    expect(lines).toMatch(/about 4\.7 MB.*github\.com/);
    expect(lines).toMatch(/states no separate licence/);
    expect(lines).toMatch(/never uploaded/);
    useUiStore.getState().closeDialog(false);
    await waitFor(() => expect(useUiStore.getState().dialog).toBeNull());
    expect(calls.some((c) => c.cmd === "download_upscale_model")).toBe(false);

    fireEvent.click(panel.getByRole("button", { name: "Download model (about 4.7 MB)…" }));
    await waitFor(() => expect(useUiStore.getState().dialog).not.toBeNull());
    useUiStore.getState().closeDialog(true);
    await panel.findByRole("button", { name: "Upscale 2×" });
    expect(calls.filter((c) => c.cmd === "download_upscale_model").map((c) => c.args)).toEqual([
      { id: "general" },
    ]);
  });

  it("upscales with the chosen model and size, then the clip uses the result (one undo step)", async () => {
    models = models.map((m) => ({ ...m, installed: true }));
    const panel = open();
    fireEvent.click(await panel.findByRole("radio", { name: "4×" }));
    expect(panel.getByText("640×360 → 2560×1440")).toBeInTheDocument();
    fireEvent.click(panel.getByRole("radio", { name: /^Animation/ }));
    upscaleAnswer = { path: "/data/upscaled/big.png", width: 2560, height: 1440 };
    fireEvent.click(panel.getByRole("button", { name: "Upscale 4×" }));
    await waitFor(() => expect(panel.getByRole("status")).toHaveTextContent(/now uses the enlarged picture/));
    expect(calls.find((c) => c.cmd === "upscale_image")?.args).toEqual({
      path: "/m/img.png",
      modelId: "animation",
      factor: 4,
    });
    const asset = now().assets.find((a) => a.id === clipOf("photo").assetId)!;
    expect(asset).toMatchObject({ path: "/data/upscaled/big.png", width: 2560, height: 1440, type: "image" });
    expect(useProjectStore.getState().past).toHaveLength(1);
    expect(useProjectStore.getState().past[0].label).toBe("Upscale 4× with AI");
  });

  it("changes nothing when it fails, is stopped, or Rust answers nonsense", async () => {
    models = models.map((m) => ({ ...m, installed: true }));
    const before = now();
    const store = useUpscaleStore.getState();
    upscaleAnswer = new Error("invalid input: the picture could not be read");
    expect(await store.upscaleClip("photo", "general", 2)).toBe("the picture could not be read");
    upscaleAnswer = new Error("export cancelled");
    expect(await store.upscaleClip("photo", "general", 2)).toBe("Stopped. Nothing was changed.");
    upscaleAnswer = { path: 5 };
    expect(await store.upscaleClip("photo", "general", 2)).toMatch(/could not be made/);
    // never sent to Rust at all: too large, or text
    const sent = calls.filter((c) => c.cmd === "upscale_image").length;
    expect(await store.upscaleClip("huge", "general", 2)).toMatch(/up to 2048 px/);
    expect(calls.filter((c) => c.cmd === "upscale_image")).toHaveLength(sent);
    expect(now()).toBe(before);
    expect(useUpscaleStore.getState().running).toBeNull();
  });

  it("says why instead of offering it for a picture that is too large", () => {
    const panel = open("huge");
    expect(panel.getByText(/up to 2048 px/)).toBeInTheDocument();
    expect(panel.queryByRole("button", { name: /Download|Upscale/ })).toBeNull();
  });
});

describe("upscaling a video clip", () => {
  /** "video" trimmed to source 2..6 with a slide keyed at source 1 s and 4 s. */
  function trimmed(): Project {
    let p = project();
    p = {
      ...p,
      assets: p.assets.map((a) => (a.id === IDS.vid ? { ...a, width: 640, height: 360 } : a)),
      tracks: p.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => (c.id === "video" ? { ...c, sourceIn: 2, sourceOut: 6, speed: 2 } : c)),
      })),
    };
    for (const [t, v] of [
      [1, 0],
      [4, 0.6],
    ] as const) {
      const r = setKey(p, "video", "x", t, v);
      if (!r.ok) throw new Error(r.error.message);
      p = r.project;
    }
    return p;
  }
  const video = { path: "/data/upscaled/v.mp4", width: 1280, height: 720, duration: 3.97 };

  it("refuses video that is too large or too long, and sound", () => {
    const p = trimmed();
    expect(upscaleBlocker(p, "video")).toBeNull();
    const large = {
      ...p,
      assets: p.assets.map((a) => (a.id === IDS.vid ? { ...a, width: 1920, height: 1080 } : a)),
    };
    expect(upscaleBlocker(large, "video")).toMatch(/1920×1080.*up to 1280 px/);
    const long = {
      ...p,
      assets: p.assets.map((a) => (a.id === IDS.vid ? { ...a, duration: 500 } : a)),
      tracks: p.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => (c.id === "video" ? { ...c, sourceIn: 0, sourceOut: 300 } : c)),
      })),
    };
    expect(upscaleBlocker(long, "video")).toMatch(/300 s.*up to 100 s/);
  });

  it("points the clip at the new file, which starts at 0, and keeps the movement on the same pictures", () => {
    const r = applyUpscaledVideo(trimmed(), "video", video, "new");
    if (!r.ok) throw new Error(r.error.message);
    expectValid(r.project);
    const clip = r.project.tracks.flatMap((t) => t.clips).find((c) => c.id === "video")!;
    expect(clip).toMatchObject({ assetId: "new", sourceIn: 0, sourceOut: 3.97, speed: 2 });
    expect(r.project.assets.find((a) => a.id === "new")).toEqual({
      id: "new",
      path: "/data/upscaled/v.mp4",
      type: "video",
      duration: 3.97,
      width: 1280,
      height: 720,
    });
    // the key at source 1 s was before the stretch: the clip starts with the value it had at 2 s (0.2);
    // the key at source 4 s is now 2 s into the new file
    expect(clip.keyframes!.x![0].t).toBe(0);
    expect(clip.keyframes!.x![0].v).toBeCloseTo(0.2);
    expect(clip.keyframes!.x![1]).toEqual({ t: 2, v: 0.6 });
    expect(r.project.assets.some((a) => a.id === IDS.vid)).toBe(true); // the original stays in the library
    // a picture is not a video, and the other way round
    expect(applyUpscaledVideo(trimmed(), "photo", video, "n").ok).toBe(false);
  });

  it("runs from the panel on the stretch the clip uses, as one undo step", async () => {
    models = models.map((m) => ({ ...m, installed: true }));
    useProjectStore.setState({ project: trimmed(), past: [], future: [] });
    const clip = clipOf("video");
    render(<UpscalePanel clip={clip} asset={now().assets.find((a) => a.id === IDS.vid)!} />);
    const panel = within(screen.getByRole("group", { name: "Upscale with AI" }));
    expect(panel.getByText(/frame by frame/)).toBeInTheDocument();
    fireEvent.click(await panel.findByRole("button", { name: /^Upscale/ }));
    await waitFor(() => expect(panel.getByRole("status")).toHaveTextContent(/now uses the enlarged video/));
    expect(calls.find((c) => c.cmd === "upscale_video")?.args).toEqual({
      path: "/m/vid.mp4",
      modelId: "general",
      factor: 2,
      sourceIn: 2,
      sourceOut: 6,
    });
    expect(clipOf("video")).toMatchObject({ sourceIn: 0, sourceOut: 3.97 });
    undo();
    expect(clipOf("video")).toMatchObject({ assetId: IDS.vid, sourceIn: 2, sourceOut: 6 });
  });
});
