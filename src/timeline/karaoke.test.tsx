import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { KaraokeDialog } from "@/components/karaoke/KaraokeDialog";
import type { Project } from "@/project/model";
import { parseProject } from "@/project/parse";
import { useAiStore, type SpeechModel } from "@/store/ai";
import { useKaraokeStore } from "@/store/karaoke";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useUiStore } from "@/store/ui";
import { expectValid, IDS, makeProject } from "@/test/makeProject";
import { openKaraoke } from "./ai";
import { addClip } from "./edit";
import { undo } from "./editor";
import {
  alignLyrics,
  captionsFor,
  addInstrumental,
  createKaraoke,
  INSTRUMENTAL_TRACK_NAME,
  sungRanges,
  KARAOKE_TRACK_NAME,
  likeness,
  linesFromSegments,
  parseLrc,
  parseLyricsFile,
  parseSrt,
  pastedLines,
  wordsForMatch,
  type LyricLine,
} from "./karaoke";

/** A 20 s song ("song") on a1 from 4 s, and a still on v1. */
function project(): Project {
  let p = makeProject();
  for (const [assetId, trackId, id, start] of [
    [IDS.aud, IDS.a1, "song", 4],
    [IDS.img, IDS.v1, "still", 0],
  ] as const) {
    const r = addClip(p, { assetId, trackId, start, id });
    if (!r.ok) throw new Error(r.error.message);
    p = r.project;
  }
  return p;
}
const clipOf = (p: Project, id: string) => p.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!;
/** What the speech model "heard" in the fixture song (with a mistake or two, as it does with singing). */
const HEARD = [
  { start: 1.0, end: 3.5, text: " I walk along the river in the morning" },
  { start: 4.0, end: 6.4, text: " and the son is rising slow" },
  { start: 7.0, end: 9.0, text: " la la la" },
  { start: 10.0, end: 12.5, text: " every little bird is singing" },
  { start: 13.0, end: 15.5, text: " telling me which way to go" },
];
const LYRICS = `[Verse 1]
I walk along the river in the morning
And the sun is rising slow

Something nobody could ever recognise here
Every little bird is singing
Telling me which way to go`;
const line = (text: string, start: number, end: number): LyricLine => ({
  text,
  start,
  end,
  confidence: 1,
  low: false,
});
const MODELS: SpeechModel[] = [
  { id: "base", label: "Base", approxMb: 142, source: "https://huggingface.co/x/b.bin", installed: true },
];

describe("lyrics the user brings", () => {
  it("pasted text becomes lines, without blank lines and section labels", () => {
    expect(pastedLines(LYRICS)).toEqual([
      "I walk along the river in the morning",
      "And the sun is rising slow",
      "Something nobody could ever recognise here",
      "Every little bird is singing",
      "Telling me which way to go",
    ]);
    expect(pastedLines("  one   two \r\n(Chorus)\r\n\r\nthree")).toEqual(["one two", "three"]);
    expect(pastedLines("x\n".repeat(5000))).toHaveLength(2000); // capped
  });

  it("reads .lrc: time tags, several per line, offset, info tags and word tags", () => {
    const lrc = `[ar:Somebody]
[ti:A Song]
[offset:+500]
[00:01.50]First line
[00:04.00][00:20.00]Repeated <00:04.50>line
[00:08.25]
not a lyric line
[01:02.5]Late line`;
    expect(parseLrc(lrc)).toEqual([
      line("First line", 1, 3.5),
      line("Repeated line", 3.5, 8.5),
      line("Repeated line", 19.5, 24.5),
      line("Late line", 62, 67),
    ]);
    expect(parseLrc("nothing here")).toEqual([]);
  });

  it("reads .srt: blocks with start and end, markup removed, bad blocks skipped", () => {
    const srt = `1
00:00:01,000 --> 00:00:03,500
<i>First</i> line

2
00:00:04,000 --> 00:00:06,000
Two
rows

3
broken --> block
Nope

4
00:01:00.250 --> 00:01:02.000
{\\an8}Late`;
    expect(parseSrt(srt)).toEqual([
      line("First line", 1, 3.5),
      line("Two rows", 4, 6),
      line("Late", 60.25, 62),
    ]);
  });

  it("works out what a file is from its name or its text, and treats plain text as lyrics to match", () => {
    expect(parseLyricsFile("song.LRC", "[00:01.00]Hi").lines).toHaveLength(1);
    expect(parseLyricsFile("song.txt", "1\n00:00:01,000 --> 00:00:02,000\nHi").lines).toHaveLength(1);
    expect(parseLyricsFile("song.txt", "Just\nwords")).toEqual({ lines: [], plain: ["Just", "words"] });
    // never trusts the content: a huge or hostile file is just text that mostly does not parse
    expect(parseLyricsFile("x.lrc", "[00:01.00]" + "A".repeat(10_000)).lines[0].text).toHaveLength(300);
    expect(parseLyricsFile("x.lrc", "<script>alert(1)</script>").plain).toEqual([
      "<script>alert(1)</script>",
    ]);
  });

  it("recognised speech becomes lines as it is", () => {
    expect(linesFromSegments(HEARD)).toHaveLength(5);
    expect(linesFromSegments(HEARD)[0]).toEqual(line("I walk along the river in the morning", 1, 3.5));
  });
});

describe("matching pasted lyrics to the song", () => {
  it("compares words without case, accents or punctuation, forgiving one wrong letter in longer words", () => {
    expect(wordsForMatch("Don't  STOP — believin', café!")).toEqual(["dont", "stop", "believin", "cafe"]);
    expect(likeness(["the", "sun", "is", "rising"], ["the", "son", "is", "rising"])).toBe(0.75); // short words must be equal
    expect(likeness(["rising", "slowly"], ["rising", "slowlly"])).toBe(1);
    expect(likeness(["a", "b"], [])).toBe(0);
  });

  it("keeps the user's words, takes the times from the song and flags what it could not find", () => {
    const lines = alignLyrics(pastedLines(LYRICS), HEARD, 20);
    // the user's text, exactly, in the user's order
    expect(lines.map((l) => l.text)).toEqual(pastedLines(LYRICS));
    expect(lines.map((l) => [l.start, l.end])).toEqual([
      [1, 3.5],
      [4, 6.4],
      [6.4, 10], // not in the song: between its neighbours
      [10, 12.5],
      [13, 15.5],
    ]);
    expect(lines.map((l) => l.low)).toEqual([false, false, true, false, false]);
    expect(lines[2].confidence).toBe(0);
    expect(lines[0].confidence).toBe(1);
    expect(lines[1].confidence).toBeGreaterThanOrEqual(0.5); // "son" was heard for "sun"
    expect(lines[1].confidence).toBeLessThan(1);
  });

  it("joins recognised pieces for a long line and never goes back in time", () => {
    const heard = [
      { start: 0, end: 2, text: "every little bird" },
      { start: 2, end: 4, text: "is singing loud" },
      { start: 5, end: 7, text: "every little bird" },
    ];
    const lines = alignLyrics(["Every little bird is singing loud", "Every little bird"], heard, 10);
    expect(lines.map((l) => [l.start, l.end])).toEqual([
      [0, 4],
      [5, 7],
    ]);
    for (let i = 1; i < lines.length; i++) expect(lines[i].start).toBeGreaterThanOrEqual(lines[i - 1].end);
  });

  it("spreads the lines evenly and flags them all when nothing matches or nothing was heard", () => {
    for (const heard of [[], [{ start: 1, end: 2, text: "completely different words" }]]) {
      const lines = alignLyrics(["one line", "two line", "three line", "four line"], heard, 20);
      expect(lines.map((l) => l.start)).toEqual([0, 5, 10, 15]);
      expect(lines.map((l) => l.end)).toEqual([5, 10, 15, 20]);
      expect(lines.every((l) => l.low && l.confidence === 0)).toBe(true);
    }
  });
});

describe("lyrics on the timeline", () => {
  it("places lines by the clip's start and speed, inside the clip, and skips a reversed clip", () => {
    const clip = clipOf(project(), "song");
    const lines = [line("a", 1, 3), line("b", 3, 30)];
    expect(captionsFor(clip, lines)).toEqual([
      { start: 5, duration: 2, text: "a" },
      { start: 7, duration: 17, text: "b" }, // cut at the clip's end (24 s)
    ]);
    expect(captionsFor({ ...clip, speed: 2 }, lines)).toEqual([
      { start: 4.5, duration: 1, text: "a" },
      { start: 5.5, duration: 8.5, text: "b" },
    ]);
    expect(captionsFor({ ...clip, reversed: true }, lines)).toEqual([]);
  });
});

describe("making karaoke", () => {
  const drawn: { content: string; font?: string }[] = [];
  const made: { path: string; sourceIn: number; sourceOut: number; ranges: [number, number][] }[] = [];
  let instrumentalFails: string | null = null;
  function rust(heard: unknown = HEARD) {
    vi.mocked(invoke).mockImplementation((async (
      cmd: string,
      args?: { spec?: { content: string; font?: string } },
    ) => {
      if (cmd === "whisper_models") return MODELS;
      if (cmd === "transcribe_media") {
        if (heard instanceof Error) throw heard.message;
        return heard;
      }
      if (cmd === "render_text") {
        drawn.push({ content: args!.spec!.content, font: args!.spec!.font });
        return `/data/text/${drawn.length}.png`;
      }
      if (cmd === "make_instrumental") {
        made.push(args as never);
        if (instrumentalFails) throw `invalid input: ${instrumentalFails}`;
        return { path: "/data/karaoke/abc.m4a", duration: 20 };
      }
      if (cmd === "open_lyrics_file")
        return { name: "song.lrc", text: "[00:02.00]From a file\n[00:06.00]Second" };
      return undefined;
    }) as never);
  }
  const k = () => useKaraokeStore.getState();
  const now = () => useProjectStore.getState().project;
  beforeEach(() => {
    drawn.length = 0;
    made.length = 0;
    instrumentalFails = null;
    vi.mocked(invoke).mockReset();
    rust();
    useProjectStore.setState({ project: project(), past: [], future: [] });
    useSelectionStore.getState().clear();
    useUiStore.setState({ notice: null, dialog: null });
    useAiStore.setState({ models: MODELS, loaded: true, download: null, listening: null });
    useKaraokeStore.setState({
      open: false,
      clipId: null,
      source: "listen",
      language: "",
      model: null,
      lowerVoice: true,
      pasted: "",
      fileName: null,
      lines: [],
      busy: null,
      problem: null,
      note: null,
      heard: null,
    });
  });

  it("adds the lines in the Karaoke style on a Karaoke track as ONE undo step", async () => {
    const before = now();
    const result = await createKaraoke("song", linesFromSegments(HEARD));
    if (!result.ok) throw new Error(result.reason);
    expect(result.added).toBe(5);
    expectValid(now());
    const track = now().tracks.find((t) => t.id === result.trackId)!;
    expect(track.name).toBe(KARAOKE_TRACK_NAME);
    expect(track.type).toBe("video");
    expect(track.order).toBeGreaterThan(Math.max(...before.tracks.map((t) => t.order))); // on top
    expect(track.clips.map((c) => c.timelineStart)).toEqual([5, 8, 11, 14, 17]);
    // drawn in the bundled Karaoke style, with the words as given
    expect(drawn.map((d) => d.content)[0]).toBe("I walk along the river in the morning");
    expect(drawn.every((d) => d.font === "Barlow")).toBe(true);
    expect(now().tracks.filter((t) => t.id !== result.trackId)).toEqual(before.tracks);
    expect(useProjectStore.getState().past).toHaveLength(1);

    // save and reopen: the file round-trips
    const reopened = parseProject(JSON.parse(JSON.stringify(now())));
    expect(reopened.ok && reopened.project).toEqual(now());
    undo();
    expect(now()).toEqual(before);
  });

  it("changes nothing for a reversed clip, a picture, no lines, or a line that cannot be drawn", async () => {
    const before = now();
    expect(await createKaraoke("still", [line("a", 0, 1)])).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/no sound/),
    });
    expect(await createKaraoke("song", [])).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/no lyric lines/),
    });
    vi.mocked(invoke).mockRejectedValue("no font");
    expect(await createKaraoke("song", [line("a", 0, 1)])).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/draw the lyrics/),
    });
    expect(now()).toBe(before);

    const reversed: Project = {
      ...before,
      tracks: before.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => ({ ...c, reversed: true })) })),
    };
    useProjectStore.setState({ project: reversed });
    expect(await createKaraoke("song", [line("a", 0, 1)])).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/Reversed/),
    });
    expect(openKaraoke("song")).toBe(false);
    expect(useUiStore.getState().notice).toMatch(/Reversed/);
  });

  it("pasted lyrics: listens once, matches, flags, and a hand-set time is no longer a guess", async () => {
    expect(openKaraoke("song")).toBe(true);
    k().setSource("paste");
    await k().findLines();
    expect(k().problem).toMatch(/Paste the lyrics first/);
    k().setPasted(LYRICS);
    await k().findLines();
    expect(k().lines.map((l) => l.low)).toEqual([false, false, true, false, false]);
    expect(k().note).toMatch(/1 of 5 lines were not found/);
    // other lyrics for the same song: no second listening
    k().setPasted("Every little bird is singing");
    await k().findLines();
    expect(vi.mocked(invoke).mock.calls.filter((c) => c[0] === "transcribe_media")).toHaveLength(1);
    expect(k().lines).toMatchObject([{ start: 10, end: 12.5, low: false }]);

    k().setPasted(LYRICS);
    await k().findLines();
    k().editLine(2, { start: 7, end: 9 });
    expect(k().lines[2]).toMatchObject({ start: 7, end: 9, low: false });
    k().editLine(0, { text: "Changed words" });
    expect(k().lines[0]).toMatchObject({ text: "Changed words", start: 1 });
    k().shiftAll(-2);
    expect(k().lines.map((l) => l.start)).toEqual([0, 2, 5, 8, 11]); // never before the start
    k().removeLine(4);
    expect(k().lines).toHaveLength(4);
  });

  it("reports a failure to listen and keeps quiet when the user stops it", async () => {
    openKaraoke("song");
    rust(new Error("there is no sound to transcribe in that clip"));
    await k().findLines();
    expect(k()).toMatchObject({
      busy: null,
      problem: "there is no sound to transcribe in that clip",
      lines: [],
    });
    rust(new Error("export cancelled"));
    await k().findLines();
    expect(k()).toMatchObject({ busy: null, problem: null });
    useAiStore.setState({ models: [{ ...MODELS[0], installed: false }] });
    await k().findLines();
    expect(k().problem).toMatch(/Download a speech model/);
  });

  it("the dialog: recognise, check, add; the lines survive closing it", async () => {
    render(<KaraokeDialog />);
    expect(screen.queryByRole("dialog")).toBeNull();
    openKaraoke("song");
    const dialog = within(await screen.findByRole("dialog", { name: "Karaoke Maker" }));
    expect(dialog.getByRole("radio", { name: "Recognise from the song" })).toBeChecked();
    expect(dialog.getByRole("button", { name: /Add lines to the timeline/ })).toBeDisabled();
    expect(dialog.getByText(/a line at a time, not word by word/)).toBeInTheDocument();

    fireEvent.click(dialog.getByRole("button", { name: "Listen and write the lyrics" }));
    const list = within(await dialog.findByRole("list", { name: "Lyric lines" }));
    expect(list.getAllByRole("listitem")).toHaveLength(5);
    fireEvent.change(list.getByRole("textbox", { name: "Line 2 words" }), {
      target: { value: "And the sun is rising slow" },
    });
    fireEvent.click(list.getByRole("button", { name: "Line 1 later" }));
    expect(k().lines[0].start).toBeCloseTo(1.1);
    fireEvent.click(list.getByRole("button", { name: "Delete line 3" }));
    expect(k().lines.map((l) => l.text)).not.toContain("la la la");

    // closing keeps the work
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    openKaraoke("song");
    expect(k().lines).toHaveLength(4);

    fireEvent.click(await screen.findByRole("button", { name: "Add 4 lines to the timeline" }));
    await waitFor(() => expect(useUiStore.getState().notice).toMatch(/Added 4 lyric lines/));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(now().tracks.some((t) => t.name === KARAOKE_TRACK_NAME && t.clips.length === 4)).toBe(true);
    expect(drawn.map((d) => d.content)).toContain("And the sun is rising slow");
  });

  it("the dialog: a lyrics file gives timed lines without listening to the song", async () => {
    render(<KaraokeDialog />);
    openKaraoke("song");
    const dialog = within(await screen.findByRole("dialog", { name: "Karaoke Maker" }));
    fireEvent.click(dialog.getByRole("radio", { name: "Open a lyrics file" }));
    fireEvent.click(dialog.getByRole("button", { name: "Open a lyrics file…" }));
    await waitFor(() => expect(k().lines).toHaveLength(2));
    expect(k().lines).toMatchObject([
      { text: "From a file", start: 2, end: 6 },
      { text: "Second", start: 6, end: 11 },
    ]);
    expect(dialog.getByText(/2 timed lines read from song\.lrc/)).toBeInTheDocument();
    expect(vi.mocked(invoke).mock.calls.some((c) => c[0] === "transcribe_media")).toBe(false);
  });
});

describe("choosing the speech model", () => {
  it("shows sizes people can read, and karaoke listens with the largest model on this computer", async () => {
    const { modelSize } = await import("@/store/ai");
    const { karaokeModel } = await import("@/store/karaoke");
    expect(modelSize(75)).toBe("75 MB");
    expect(modelSize(466)).toBe("466 MB");
    expect(modelSize(1463)).toBe("1.4 GB");
    expect(modelSize(2952)).toBe("2.9 GB");
    const model = (id: string, approxMb: number, installed: boolean): SpeechModel => ({
      id,
      label: id,
      approxMb,
      source: "https://huggingface.co/x",
      installed,
    });
    useAiStore.setState({
      models: [model("tiny", 75, true), model("small", 466, true), model("medium", 1463, false)],
    });
    useKaraokeStore.setState({ model: null });
    expect(karaokeModel()).toBe("small"); // medium is not downloaded
    useKaraokeStore.getState().setModel("tiny");
    expect(karaokeModel()).toBe("tiny");
    useKaraokeStore.getState().setModel("medium"); // chosen but not here: the largest that is
    expect(karaokeModel()).toBe("small");
    useAiStore.setState({ models: [model("tiny", 75, false)] });
    expect(karaokeModel()).toBeNull();
    useKaraokeStore.setState({ model: null });
  });
});

describe("lowering the singer's voice", () => {
  const MODELS2: SpeechModel[] = [
    {
      id: "base",
      label: "Base (fast)",
      approxMb: 142,
      source: "https://huggingface.co/x/b.bin",
      installed: true,
    },
    {
      id: "medium",
      label: "Medium (slow)",
      approxMb: 1463,
      source: "https://huggingface.co/x/m.bin",
      installed: false,
    },
  ];
  const asked: Record<string, unknown>[] = [];
  let fails: string | null = null;
  const k = () => useKaraokeStore.getState();
  const now = () => useProjectStore.getState().project;
  beforeEach(() => {
    asked.length = 0;
    fails = null;
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation((async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "whisper_models") return MODELS2;
      if (cmd === "render_text") return "/data/text/line.png";
      if (cmd === "make_instrumental") {
        asked.push(args!);
        if (fails) throw `invalid input: ${fails}`;
        return { path: "/data/karaoke/abc.m4a", duration: 20 };
      }
      return undefined;
    }) as never);
    useProjectStore.setState({ project: project(), past: [], future: [] });
    useUiStore.setState({ notice: null, dialog: null });
    useAiStore.setState({ models: MODELS2, loaded: true, download: null, listening: null });
    useKaraokeStore.setState({
      open: true,
      clipId: "song",
      source: "listen",
      model: null,
      lowerVoice: true,
      lines: [line("one", 1, 3), line("two", 5, 8)],
      busy: null,
      problem: null,
      note: null,
    });
  });

  it("the copy goes under the song at its place and speed, and the song is muted, not changed", () => {
    const p = project();
    const fast: Project = {
      ...p,
      tracks: p.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => (c.id === "song" ? { ...c, speed: 2, volume: 0.5 } : c)),
      })),
    };
    const r = addInstrumental(
      fast,
      "song",
      { path: "/data/karaoke/a.m4a", duration: 20 },
      { asset: "ia", track: "it", clip: "ic" },
    );
    if (!r.ok) throw new Error(r.error.message);
    expectValid(r.project);
    const track = r.project.tracks.find((t) => t.id === "it")!;
    expect(track).toMatchObject({ name: INSTRUMENTAL_TRACK_NAME, type: "audio" });
    expect(track.clips).toMatchObject([
      { id: "ic", assetId: "ia", timelineStart: 4, sourceIn: 0, sourceOut: 20, speed: 2, volume: 0.5 },
    ]);
    expect(r.project.assets.find((a) => a.id === "ia")).toEqual({
      id: "ia",
      path: "/data/karaoke/a.m4a",
      type: "audio",
      duration: 20,
    });
    const song = clipOf(r.project, "song");
    expect(song).toEqual({ ...clipOf(fast, "song"), muted: true });
    expect(
      addInstrumental(p, "gone", { path: "/x.m4a", duration: 1 }, { asset: "a", track: "t", clip: "c" }).ok,
    ).toBe(false);
    expect(sungRanges([line("a", 1, 3), line("b", 5, 5)])).toEqual([[1, 3]]);
    // lines close together are one stretch; only a long instrumental gap splits it
    expect(sungRanges([line("c", 40, 44), line("a", 1, 3), line("b", 9, 12), line("d", 45, 50)])).toEqual([
      [1, 12],
      [40, 50],
    ]);
    expect(sungRanges([])).toEqual([]);
  });

  it("lyrics and the lowered-voice copy are added together as ONE undo step", async () => {
    const before = now();
    await k().create();
    expect(k().problem).toBeNull();
    // Rust was asked for the part of the file the clip uses, with the sung stretches
    expect(asked).toEqual([
      {
        path: "/m/aud.mp3",
        sourceIn: 0,
        sourceOut: 20,
        ranges: [[1, 8]], // one stretch: the singer does not come back between the lines
      },
    ]);
    expect(now().tracks.map((t) => t.name)).toEqual(
      expect.arrayContaining(["Karaoke", INSTRUMENTAL_TRACK_NAME]),
    );
    expect(clipOf(now(), "song").muted).toBe(true);
    expectValid(now());
    expect(useProjectStore.getState().past).toHaveLength(1);
    expect(useUiStore.getState().notice).toMatch(/lowered-voice copy/);
    undo();
    expect(now()).toEqual(before);
  });

  it("adds nothing when the voice cannot be lowered, says why, and works with the box unticked", async () => {
    const before = now();
    fails = "this recording is mono, so the voice cannot be lowered this way";
    await k().create();
    expect(k().problem).toMatch(/could not be lowered: this recording is mono/);
    expect(k().open).toBe(true);
    expect(now()).toBe(before);

    k().setLowerVoice(false);
    await k().create();
    expect(asked).toHaveLength(1); // not asked again
    expect(now().tracks.some((t) => t.name === "Karaoke")).toBe(true);
    expect(now().tracks.some((t) => t.name === INSTRUMENTAL_TRACK_NAME)).toBe(false);
    expect(clipOf(now(), "song").muted).toBeUndefined();
  });

  it("the dialog lets the model be chosen and downloaded, with its size, only after asking", async () => {
    render(<KaraokeDialog />);
    const dialog = within(await screen.findByRole("dialog", { name: "Karaoke Maker" }));
    expect(dialog.getByRole("checkbox", { name: /Lower the singer's voice/ })).toBeChecked();
    const picker = dialog.getByRole("combobox", { name: "Speech model" });
    expect(within(picker).getByRole("option", { name: "Base · 142 MB" })).toBeInTheDocument();
    expect(
      within(picker).getByRole("option", { name: "Medium · 1.4 GB · not downloaded" }),
    ).toBeInTheDocument();
    expect(picker).toHaveValue("base");
    expect(dialog.queryByRole("button", { name: /Download Medium/ })).toBeNull();

    fireEvent.change(picker, { target: { value: "medium" } });
    const download = dialog.getByRole("button", { name: "Download Medium (about 1.4 GB)…" });
    // not downloaded: listening still uses a model that is here
    expect(dialog.getByRole("button", { name: "Listen and write the lyrics" })).toBeEnabled();
    fireEvent.click(download);
    await waitFor(() => expect(useUiStore.getState().dialog?.title).toBe("Download the speech model?"));
    expect(useUiStore.getState().dialog?.lines[0]).toMatch(/about 1\.4 GB/);
    useUiStore.getState().closeDialog(false); // declined: nothing is downloaded
    expect(vi.mocked(invoke).mock.calls.some((c) => c[0] === "download_whisper_model")).toBe(false);
  });
});

describe("how the lyrics look", () => {
  const drawn: { font?: string; color: string }[] = [];
  const k = () => useKaraokeStore.getState();
  const now = () => useProjectStore.getState().project;
  beforeEach(() => {
    drawn.length = 0;
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation((async (
      cmd: string,
      args?: { spec?: { font?: string; color: string } },
    ) => {
      if (cmd === "render_text") {
        drawn.push({ font: args!.spec!.font, color: args!.spec!.color });
        return "/data/text/line.png";
      }
      if (cmd === "text_style_preview") return "/cache/style.png";
      return undefined;
    }) as never);
    useProjectStore.setState({ project: project(), past: [], future: [] });
    useUiStore.setState({ notice: null, dialog: null });
    useAiStore.setState({ models: [], loaded: true, download: null, listening: null });
    useKaraokeStore.setState({
      open: true,
      clipId: "song",
      source: "file",
      model: null,
      lowerVoice: false,
      styleId: "karaoke",
      lines: [line("one", 1, 5), line("two", 6, 6.3)],
      busy: null,
      problem: null,
      note: null,
    });
  });

  it("lines fade in and out, a short line for at most a third of its time", async () => {
    await k().create();
    const track = now().tracks.find((t) => t.name === "Karaoke")!;
    expect(track.clips[0]).toMatchObject({ fadeIn: 0.25, fadeOut: 0.25 });
    expect(track.clips[1].fadeIn).toBeCloseTo(0.1); // 0.3 s long
    expectValid(now());
  });

  it("uses the style chosen in the dialog, and the Karaoke style when that one is gone", async () => {
    render(<KaraokeDialog />);
    const dialog = within(await screen.findByRole("dialog", { name: "Karaoke Maker" }));
    const styles = within(dialog.getByRole("group", { name: "Styles" }));
    fireEvent.click(styles.getAllByRole("button", { pressed: false })[0]);
    const chosen = k().styleId;
    expect(chosen).not.toBe("karaoke");
    fireEvent.click(dialog.getByRole("button", { name: "Add 2 lines to the timeline" }));
    await waitFor(() => expect(now().tracks.some((t) => t.name === "Karaoke")).toBe(true));
    const { STYLE_PRESETS } = await import("./textStyles");
    const preset = STYLE_PRESETS.find((p) => p.id === chosen)!;
    expect(drawn.every((d) => d.color === preset.style.color && d.font === preset.style.font)).toBe(true);

    const { karaokeStyle } = await import("@/store/karaoke");
    expect(karaokeStyle("deleted-style").id).toBe("karaoke");
  });
});
