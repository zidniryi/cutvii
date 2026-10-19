import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { Inspector } from "@/components/layout/Inspector";
import type { Project } from "@/project/model";
import { useAiStore, type SpeechModel } from "@/store/ai";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useUiStore } from "@/store/ui";
import { expectValid, IDS, makeProject } from "@/test/makeProject";
import { addClip, deleteClip } from "./edit";
import { useTextStyleStore } from "@/store/textStyles";
import { aiKindOf, aiTarget, openAiTools } from "./ai";
import { findStyle, matchesStyle, withStyle } from "./textStyles";
import { undo } from "./editor";
import {
  addSubtitleClips,
  generateSubtitles,
  subtitleSpec,
  subtitlesFor,
  subtitleWrap,
  type DrawnSubtitle,
} from "./subtitles";

/** A 10 s video ("video") on v1 at 2..12. */
function project(): Project {
  const r = addClip(makeProject(), { assetId: IDS.vid, trackId: IDS.v1, start: 2, id: "video" });
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
}
const clipOf = (p: Project, id = "video") => p.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!;
const SEGMENTS = [
  { start: 0.5, end: 2, text: " Hello there. " },
  { start: 2, end: 4.5, text: "This is CutVii." },
];
const MODELS: SpeechModel[] = [
  {
    id: "tiny",
    label: "Tiny",
    approxMb: 75,
    source: "https://huggingface.co/x/ggml-tiny.bin",
    installed: false,
  },
  {
    id: "base",
    label: "Base",
    approxMb: 142,
    source: "https://huggingface.co/x/ggml-base.bin",
    installed: false,
  },
];

describe("subtitle timing", () => {
  it("places speech on the timeline by the clip's start and speed", () => {
    const clip = clipOf(project());
    expect(subtitlesFor(clip, SEGMENTS)).toEqual([
      { start: 2.5, duration: 1.5, text: "Hello there." },
      { start: 4, duration: 2.5, text: "This is CutVii." },
    ]);
    // at 2x everything happens twice as fast
    expect(subtitlesFor({ ...clip, speed: 2 }, SEGMENTS)).toEqual([
      { start: 2.25, duration: 0.75, text: "Hello there." },
      { start: 3, duration: 1.25, text: "This is CutVii." },
    ]);
  });

  it("never overlaps, stays inside the clip, and drops what cannot be read", () => {
    const clip = clipOf(project()); // 2..12
    const got = subtitlesFor(clip, [
      { start: 3, end: 6, text: "second (given out of order)" },
      { start: 0, end: 4, text: "first" }, // overlaps the next one
      { start: 6, end: 6.05, text: "blink" }, // too short
      { start: 7, end: 8, text: "   " }, // nothing said
      { start: 9, end: 30, text: "runs past the end" },
    ]);
    expect(got).toEqual([
      { start: 2, duration: 4, text: "first" },
      { start: 6, duration: 2, text: "second (given out of order)" },
      { start: 11, duration: 1, text: "runs past the end" },
    ]);
    expect(subtitlesFor({ ...clip, reversed: true }, SEGMENTS)).toEqual([]);
  });

  it("styles subtitles for the canvas", () => {
    expect(subtitleSpec("Hi", 1080)).toMatchObject({ content: "Hi", fontSize: 49, y: 0.88, align: "center" });
    expect(subtitleSpec("Hi", 100).fontSize).toBe(8);
  });

  it("keeps subtitles inside a picture narrower than the canvas, whatever the canvas", () => {
    const clip = clipOf(project());
    const portrait = { width: 1080, height: 1920 };
    const wide = { width: 1920, height: 1080 };
    // a picture that fills the canvas: the usual text width
    expect(subtitleWrap({ ...clip, fitMode: "fit" }, wide, 1920, 1080)).toBeUndefined();
    expect(subtitleWrap({ ...clip, fitMode: "fit" }, portrait, 1080, 1920)).toBeUndefined();
    expect(subtitleWrap({ ...clip, fitMode: "fill" }, portrait, 1920, 1080)).toBeUndefined();
    expect(subtitleWrap(clip, { width: undefined, height: undefined }, 1920, 1080)).toBeUndefined();
    // a portrait video shown whole on a wide canvas covers 31.6 % of its width; subtitles take 90 % of that
    expect(subtitleWrap({ ...clip, fitMode: "fit" }, portrait, 1920, 1080)).toBeCloseTo(0.285, 3);
    expect(subtitleWrap({ ...clip, fitMode: "blur-bg" }, portrait, 1920, 1080)).toBeCloseTo(0.285, 3);
    // on a square canvas, and when the picture is scaled down or cropped
    expect(subtitleWrap({ ...clip, fitMode: "fit" }, portrait, 1080, 1080)).toBeCloseTo(0.506, 3);
    expect(subtitleWrap({ ...clip, fitMode: "fit", scale: 0.5 }, wide, 1920, 1080)).toBeCloseTo(0.45, 3);
    const cropped = { left: 0.25, right: 0.25, top: 0, bottom: 0 };
    expect(subtitleWrap({ ...clip, fitMode: "fit", crop: cropped }, wide, 1920, 1080)).toBeCloseTo(0.45, 3);
    // never so narrow that every word is its own line
    expect(subtitleWrap({ ...clip, fitMode: "fit", scale: 0.1 }, wide, 1920, 1080)).toBe(0.2);

    const spec = subtitleSpec("Hello", 1080, undefined, undefined, 0.285);
    expect(spec.wrap).toBe(0.285);
    expect(subtitleSpec("Hello", 1080)).not.toHaveProperty("wrap");
    // restyling a subtitle keeps its width
    expect(withStyle(spec, findStyle("highlighter")!.style).wrap).toBe(0.285);
  });

  it("adds them as text clips on a new top track in one step", () => {
    const p = project();
    const items: DrawnSubtitle[] = subtitlesFor(clipOf(p), SEGMENTS).map((s, i) => ({
      ...s,
      spec: subtitleSpec(s.text, 1080),
      picture: `/data/text/${i}.png`,
      assetId: `text-${i}`,
      clipId: `sub-${i}`,
    }));
    const r = addSubtitleClips(p, items, "subs");
    if (!r.ok) throw new Error(r.error.message);
    expectValid(r.project);
    const track = r.project.tracks.find((t) => t.id === "subs")!;
    expect(track.type).toBe("video");
    expect(track.order).toBeGreaterThan(Math.max(...p.tracks.map((t) => t.order)));
    expect(track.clips).toMatchObject([
      { id: "sub-0", assetId: "text-0", timelineStart: 2.5, sourceOut: 1.5 },
      { id: "sub-1", assetId: "text-1", timelineStart: 4, sourceOut: 2.5 },
    ]);
    expect(r.project.assets.at(-1)).toMatchObject({ type: "image", text: { content: "This is CutVii." } });
    expect(addSubtitleClips(p, [], "subs")).toEqual({ ok: true, project: p });
  });
});

/** What `split_captions` answers when nothing needs cutting: every source as one caption. */
const passThrough = (args: unknown) =>
  (args as { request: { sources: { start: number; end: number; text: string }[] } }).request.sources.map(
    (s) => ({ ...s, lines: 1, fast: false }),
  );

describe("subtitles from the AI tab", () => {
  /** What Rust has on disk and answers; `models` is mutated by a successful download. */
  let models: SpeechModel[];
  function rust(answers: Record<string, unknown> = {}) {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation((async (
      cmd: string,
      args?: { id?: string; spec?: { content: string } },
    ) => {
      if (cmd in answers) {
        const answer = answers[cmd];
        if (answer instanceof Error) throw answer.message;
        return answer;
      }
      if (cmd === "whisper_models") return models;
      if (cmd === "download_whisper_model") {
        models = models.map((m) => (m.id === args?.id ? { ...m, installed: true } : m));
        return undefined;
      }
      if (cmd === "delete_whisper_model") {
        models = models.map((m) => (m.id === args?.id ? { ...m, installed: false } : m));
        return undefined;
      }
      if (cmd === "transcribe_media") return SEGMENTS;
      if (cmd === "render_text") return `/data/text/${args?.spec?.content}.png`;
      if (cmd === "split_captions") return passThrough(args);
      return undefined;
    }) as never);
  }
  function open() {
    useProjectStore.getState().loadProject(project(), "/p.cutvii", []);
    usePlaybackStore.setState({ playhead: 3, playing: false });
    useSelectionStore.getState().select("video");
    useUiStore.setState({ notice: null, dialog: null, inspectorTab: { video: "ai" } });
    useAiStore.setState({ models: [], loaded: false, download: null, listening: null });
    render(<Inspector />);
    return within(screen.getByRole("group", { name: "Subtitles from speech" }));
  }
  const calls = (cmd: string) => vi.mocked(invoke).mock.calls.filter((c) => c[0] === cmd);
  beforeEach(() => {
    models = structuredClone(MODELS);
  });

  it("needs a model first, and downloads one only after the user agrees", async () => {
    rust();
    const panel = open();
    const downloadButton = await panel.findByRole("button", { name: /Download model \(about 142 MB\)/ });
    expect(panel.getByRole("button", { name: "Generate subtitles" })).toBeDisabled();
    expect(panel.getByRole("radio", { name: "Base, 142 MB" })).toBeChecked(); // the middle model by default

    // asked first: saying no downloads nothing
    fireEvent.click(downloadButton);
    await waitFor(() => expect(useUiStore.getState().dialog?.title).toBe("Download the speech model?"));
    expect(useUiStore.getState().dialog?.lines.join(" ")).toMatch(
      /about 142 MB.*huggingface\.co.*never uploaded/,
    );
    act(() => useUiStore.getState().closeDialog(false));
    await waitFor(() => expect(useUiStore.getState().dialog).toBeNull());
    expect(calls("download_whisper_model")).toHaveLength(0);

    // saying yes downloads exactly the chosen model
    fireEvent.click(downloadButton);
    await waitFor(() => expect(useUiStore.getState().dialog).not.toBeNull());
    act(() => useUiStore.getState().closeDialog(true));
    expect(await panel.findByText("This model is on this computer.")).toBeInTheDocument();
    expect(calls("download_whisper_model")).toEqual([["download_whisper_model", { id: "base" }]]);
    expect(panel.getByRole("radio", { name: "Base, 142 MB, downloaded" })).toBeChecked();
    // another model can be chosen; it has its own download
    fireEvent.click(panel.getByRole("radio", { name: "Tiny, 75 MB" }));
    expect(panel.getByRole("button", { name: /Download model \(about 75 MB\)/ })).toBeInTheDocument();
    expect(panel.getByRole("button", { name: "Generate subtitles" })).toBeDisabled();
    fireEvent.click(panel.getByRole("radio", { name: "Base, 142 MB, downloaded" }));
    expect(panel.getByRole("button", { name: "Generate subtitles" })).toBeEnabled();
    expect(panel.getByRole("status")).toHaveTextContent("The speech model is ready.");

    // and it can be taken off the computer again
    fireEvent.click(panel.getByRole("button", { name: "Remove this model from this computer" }));
    expect(await panel.findByRole("button", { name: /Download model/ })).toBeInTheDocument();
  });

  it("shows the download as it goes, lets it be cancelled, and explains a failure", async () => {
    rust({ download_whisper_model: new Error("the download failed: no connection") });
    const panel = open();
    fireEvent.click(await panel.findByRole("button", { name: /Download model/ }));
    await waitFor(() => expect(useUiStore.getState().dialog).not.toBeNull());
    act(() => useUiStore.getState().closeDialog(true));
    expect(await panel.findByRole("alert")).toHaveTextContent(
      "Could not download the model: the download failed: no connection",
    );

    // while a download runs, Rust's progress events drive the bar
    act(() =>
      useAiStore.setState({ download: { id: "base", received: 37 * 1024 * 1024, total: 148 * 1024 * 1024 } }),
    );
    expect(panel.getByText("Downloading… 37 of 148 MB")).toBeInTheDocument();
    expect(panel.getByRole("progressbar", { name: "Download" })).toHaveAttribute("aria-valuenow", "25");
    fireEvent.click(panel.getByRole("button", { name: "Cancel download" }));
    expect(calls("cancel_ai_job")).toHaveLength(1);
  });

  it("turns the clip's speech into editable text clips, as one undoable step", async () => {
    models[1].installed = true;
    rust();
    const panel = open();
    fireEvent.change(await panel.findByRole("combobox", { name: "Language spoken" }), {
      target: { value: "id" },
    });
    fireEvent.click(panel.getByRole("button", { name: "Generate subtitles" }));
    expect(await panel.findByRole("status")).toHaveTextContent(/Added 2 subtitles on a new track/);

    expect(calls("transcribe_media")).toEqual([
      ["transcribe_media", { path: "/m/vid.mp4", sourceIn: 0, sourceOut: 10, model: "base", language: "id" }],
    ]);
    expect(calls("render_text")).toHaveLength(2);
    const after = useProjectStore.getState().project;
    expectValid(after);
    const track = after.tracks.at(-1)!;
    expect(track.clips.map((c) => [c.timelineStart, c.sourceOut])).toEqual([
      [2.5, 1.5],
      [4, 2.5],
    ]);
    expect(after.assets.filter((a) => a.text).map((a) => a.text!.content)).toEqual([
      "Hello there.",
      "This is CutVii.",
    ]);
    expect(useProjectStore.getState().past).toHaveLength(1);
    undo();
    expect(useProjectStore.getState().project.tracks).toHaveLength(3);
    expect(useAiStore.getState().listening).toBeNull();
  });

  it("makes the subtitles in the style chosen in the AI tab, Default unless another is picked", async () => {
    models[1].installed = true;
    rust();
    useTextStyleStore.getState().reset();
    const panel = open();
    const styles = within(await panel.findByRole("group", { name: "Styles" }));
    expect(panel.getByRole("button", { name: "Default" })).toHaveAttribute("aria-pressed", "true");

    // Lyric Fade is not among the first six: it is chosen from "Show more"
    fireEvent.click(styles.getByRole("button", { name: /Show more/ }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "All styles" })).getByRole("button", { name: "Lyric Fade" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(styles.getByRole("button", { name: "Lyric Fade" })).toHaveAttribute("aria-pressed", "true");
    expect(useTextStyleStore.getState().subtitleStyleId).toBe("lyric-fade"); // remembered
    fireEvent.click(panel.getByRole("button", { name: "Generate subtitles" }));
    expect(await panel.findByRole("status")).toHaveTextContent(/Added 2 subtitles/);

    const after = useProjectStore.getState().project;
    expectValid(after);
    const lyric = findStyle("lyric-fade")!;
    const texts = after.assets.filter((a) => a.text).map((a) => a.text!);
    expect(texts).toHaveLength(2);
    for (const text of texts) {
      expect(matchesStyle(text, lyric.style)).toBe(true);
      expect(text).toMatchObject({ y: 0.88, fontSize: 49 }); // still placed and sized as subtitles
    }
    // the style's fade comes along, and one undo takes everything back
    expect(after.tracks.at(-1)!.clips.every((c) => c.fadeIn === 0.5 && c.fadeOut === 0.5)).toBe(true);
    expect(useProjectStore.getState().past).toHaveLength(1);
    undo();
    expect(useProjectStore.getState().project.assets.filter((a) => a.text)).toHaveLength(0);

    // back to Default: the plain subtitle look, no fade
    fireEvent.click(panel.getByRole("button", { name: "Default" }));
    fireEvent.click(panel.getByRole("button", { name: "Generate subtitles" }));
    await waitFor(() =>
      expect(useProjectStore.getState().project.assets.filter((a) => a.text)).toHaveLength(2),
    );
    const plain = useProjectStore.getState().project;
    expect(plain.assets.find((a) => a.text)!.text).toEqual(subtitleSpec("Hello there.", 1080));
    expect(plain.tracks.at(-1)!.clips.some((c) => "fadeIn" in c)).toBe(false);
  });

  it("reuses the empty top track left by deleted subtitles instead of piling up tracks", () => {
    const item = (id: string): DrawnSubtitle => ({
      start: 1,
      duration: 1,
      text: "Hi",
      spec: subtitleSpec("Hi", 1080),
      picture: "/data/text/hi.png",
      assetId: `a-${id}`,
      clipId: id,
    });
    const first = addSubtitleClips(project(), [item("one")], "subs");
    if (!first.ok) throw new Error(first.error.message);
    const count = first.project.tracks.length;
    const emptied = deleteClip(first.project, "one");
    if (!emptied.ok) throw new Error(emptied.error.message);
    const again = addSubtitleClips(emptied.project, [item("two")], "subs-2");
    if (!again.ok) throw new Error(again.error.message);
    expect(again.project.tracks).toHaveLength(count);
    expect(again.project.tracks.find((t) => t.id === "subs")!.clips.map((c) => c.id)).toEqual(["two"]);
    // a top track that is in use is left alone
    const third = addSubtitleClips(again.project, [item("three")], "subs-3");
    if (!third.ok) throw new Error(third.error.message);
    expect(third.project.tracks).toHaveLength(count + 1);
    expectValid(third.project);
  });

  it("shortens a style's fade on a subtitle too brief to hold it", () => {
    const p = project();
    const item: DrawnSubtitle = {
      start: 2,
      duration: 0.6,
      text: "Hi",
      spec: subtitleSpec("Hi", 1080),
      picture: "/data/text/hi.png",
      assetId: "t",
      clipId: "s",
      fade: 0.5,
    };
    const r = addSubtitleClips(p, [item], "subs");
    if (!r.ok) throw new Error(r.error.message);
    const clip = r.project.tracks.find((t) => t.id === "subs")!.clips[0];
    expect(clip.fadeIn).toBeCloseTo(0.2);
    expectValid(r.project);
  });

  it("changes nothing when no speech is found, recognition fails, or it is stopped", async () => {
    const before = project();
    const run = async (answers: Record<string, unknown>) => {
      rust(answers);
      useProjectStore.getState().loadProject(before, "/p.cutvii", []);
      const result = await generateSubtitles("video", "base", null);
      expect(useProjectStore.getState().project).toBe(before);
      return result;
    };
    expect(await run({ transcribe_media: [] })).toEqual({
      ok: false,
      reason: "No speech was found in this clip",
    });
    expect(await run({ transcribe_media: new Error("export cancelled") })).toEqual({
      ok: false,
      reason: "export cancelled",
    });
    expect(await run({ render_text: new Error("boom") })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/Could not draw.*boom/),
    });
    expect(await generateSubtitles("nope", "base", null)).toMatchObject({ ok: false });
    // automatic language detection sends no language at all
    rust();
    await generateSubtitles("video", "tiny", null);
    expect(calls("transcribe_media")[0][1]).toMatchObject({ model: "tiny", language: null });
  });
});

describe("finding the AI tools", () => {
  /** "video" (v1, 2..12), a still on v2 at 0..5, and music on a1 at 20..40. */
  function load() {
    let p = project();
    for (const [assetId, trackId, id, start] of [
      [IDS.img, IDS.v2, "still", 0],
      [IDS.aud, IDS.a1, "music", 20],
    ] as const) {
      const r = addClip(p, { assetId, trackId, start, id });
      if (!r.ok) throw new Error(r.error.message);
      p = r.project;
    }
    useProjectStore.getState().loadProject(p, "/p.cutvii", []);
    return p;
  }
  beforeEach(() => {
    load();
    useSelectionStore.getState().clear();
    usePlaybackStore.setState({ playhead: 3, playing: false });
    useUiStore.setState({
      notice: null,
      inspectorTab: { video: "video" },
      sidePanel: "library",
      inspectorFocus: null,
    });
    useAiStore.setState({ models: MODELS, loaded: true, download: null, listening: null });
  });
  const selected = () => useSelectionStore.getState().selectedClipIds;

  it("picks the clip the tools apply to: selected, else under the playhead, else the first with sound", () => {
    const p = useProjectStore.getState().project;
    expect(aiKindOf(p, "still")).toBeNull(); // a still has no speech
    expect(aiTarget(p, ["music"], 3)).toBe("music");
    expect(aiTarget(p, ["still"], 3)).toBe("video"); // the still is selected, the video is under the playhead
    expect(aiTarget(p, [], 25)).toBe("music");
    expect(aiTarget(p, [], 15)).toBe("video"); // nothing there: the first clip with sound
    const stills = {
      ...p,
      tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => c.id === "still") })),
    };
    expect(aiTarget(stills, ["still"], 3)).toBeUndefined();
  });

  it("the AI button always lands on the AI tab, focused and at its top", () => {
    useSelectionStore.getState().select("still"); // the inspector is showing a still's Video tab
    const view = render(<Inspector />);
    expect(screen.queryByRole("tab", { name: "AI" })).not.toBeInTheDocument();

    act(() => void openAiTools());
    expect(selected()).toEqual(["video"]);
    expect(useUiStore.getState()).toMatchObject({ inspectorTab: { video: "ai" }, sidePanel: "inspector" });
    const tab = screen.getByRole("tab", { name: "AI" });
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect(tab).toHaveFocus();
    expect(screen.getByRole("group", { name: "Subtitles from speech" })).toBeInTheDocument();
    expect(screen.getByRole("tabpanel").scrollTop).toBe(0);

    // from a scrolled-down Video tab of the same clip: the tab changes and starts at the top again
    fireEvent.click(screen.getByRole("tab", { name: "Video" }));
    screen.getByRole("tabpanel").scrollTop = 400;
    act(() => void openAiTools());
    expect(screen.getByRole("tab", { name: "AI" })).toHaveFocus();
    expect(screen.getByRole("tabpanel").scrollTop).toBe(0);
    // asking again while already there still brings the focus back
    (document.activeElement as HTMLElement).blur();
    act(() => void openAiTools());
    expect(screen.getByRole("tab", { name: "AI" })).toHaveFocus();

    // what is planned is shown as not available yet, never as a working control
    const more = within(screen.getByRole("group", { name: "More AI tools" }));
    expect(more.getAllByText("Coming soon")).toHaveLength(3);
    expect(more.queryByRole("button")).not.toBeInTheDocument();
    view.unmount();
  });

  it("can be asked for a particular clip, and says what is missing on a timeline without sound", () => {
    expect(openAiTools("music")).toBe(true);
    expect(selected()).toEqual(["music"]);
    expect(useUiStore.getState().inspectorTab).toMatchObject({ audio: "ai" });

    useProjectStore.getState().loadProject(makeProject(), "/p.cutvii", []);
    useSelectionStore.getState().clear();
    expect(openAiTools()).toBe(false);
    expect(useUiStore.getState().notice).toBe(
      "Add a video or audio clip to the timeline to use the AI tools",
    );
  });
});
