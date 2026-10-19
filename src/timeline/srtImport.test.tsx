import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { FileMenu } from "@/components/FileMenu";
import { useProjectStore } from "@/store/project";
import { useTextStyleStore } from "@/store/textStyles";
import { useUiStore } from "@/store/ui";
import { expectValid, makeProject } from "@/test/makeProject";
import { DEFAULT_CAPTION_LIMITS } from "./captionRules";
import { undo } from "./editor";
import { SrtImportDialog } from "@/components/SrtImportDialog";
import { usePlaybackStore } from "@/store/playback";
import { placeSrt, readSrt, shiftSubtitles, srtSubtitles, useSrtImport } from "./srtImport";

const LONG =
  "Hari ini kita akan belajar cara membuat video pendek yang menarik untuk media sosial, mulai dari memilih musik yang tepat.";
const SRT = `1
00:00:01,000 --> 00:00:03,500
<i>Halo</i> semua,
selamat datang.

2
00:00:04,000 --> 00:00:12,000
${LONG}
`;

function rust(file: { name: string; text: string } | null | Error = { name: "film.srt", text: SRT }) {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation((async (
    cmd: string,
    args?: { request?: { sources: object[] }; spec?: { content: string } },
  ) => {
    if (cmd === "open_srt_file") {
      if (file instanceof Error) throw file.message;
      return file;
    }
    // the long cue comes back in two pieces; the short one as it is
    if (cmd === "split_captions")
      return [
        { start: 1, end: 3.5, text: "Halo semua, selamat datang.", lines: 1, fast: false },
        {
          start: 4,
          end: 8,
          text: "Hari ini kita akan belajar cara membuat\nvideo pendek yang menarik untuk media sosial,",
          lines: 2,
          fast: false,
        },
        { start: 8, end: 12, text: "mulai dari memilih musik yang tepat.", lines: 1, fast: false },
      ];
    if (cmd === "render_text") return `/data/text/${args!.spec!.content.slice(0, 6)}.png`;
    return undefined;
  }) as never);
}
const calls = (cmd: string) => vi.mocked(invoke).mock.calls.filter((c) => c[0] === cmd);

beforeEach(() => {
  useTextStyleStore.getState().reset();
  useUiStore.setState({ notice: null });
  useSrtImport.setState({ file: null });
  usePlaybackStore.getState().setPlayhead(0);
  useProjectStore.getState().loadProject(makeProject(), "/p.cutvii", []);
  rust();
});

describe("importing an .srt file", () => {
  it("reads cues with their times; markup is removed and lines are joined", () => {
    expect(srtSubtitles(SRT)).toEqual([
      { start: 1, duration: 2.5, text: "Halo semua, selamat datang." },
      { start: 4, duration: 8, text: LONG },
    ]);
    expect(srtSubtitles("not a subtitle file")).toEqual([]);
  });

  it("moves every cue by the shift; before 0 is cut, and a cue that ends by then is dropped", () => {
    const subs = srtSubtitles(SRT);
    expect(shiftSubtitles(subs, 2).map((s) => [s.start, s.duration])).toEqual([
      [3, 2.5],
      [6, 8],
    ]);
    expect(shiftSubtitles(subs, -4).map((s) => [s.start, s.duration])).toEqual([[0, 8]]);
  });

  it("cuts long cues with the one splitter and adds every caption on a new track as ONE undo step", async () => {
    const before = useProjectStore.getState().project;
    const read = await readSrt();
    expect(read?.ok).toBe(true);
    if (!read?.ok) return;
    expect(await placeSrt(read.file.subtitles)).toEqual({ ok: true, added: 3 });
    expect((calls("split_captions")[0][1] as { request: object }).request).toEqual({
      sources: [
        { start: 1, end: 3.5, text: "Halo semua, selamat datang." },
        { start: 4, end: 12, text: LONG },
      ],
      limits: DEFAULT_CAPTION_LIMITS.landscape,
      language: null,
      fps: 30,
      endLimit: 12,
      uppercase: false,
      bottom: true,
    });
    const after = useProjectStore.getState().project;
    expectValid(after);
    const track = after.tracks.at(-1)!;
    expect(track.clips.map((c) => [c.timelineStart, c.sourceOut - c.sourceIn])).toEqual([
      [1, 2.5],
      [4, 4],
      [8, 4],
    ]);
    const texts = track.clips.map((c) => after.assets.find((a) => a.id === c.assetId)!.text!.content);
    expect(texts.slice(1).join(" ").replace(/\s+/g, " ")).toBe(LONG);
    undo();
    expect(useProjectStore.getState().project).toBe(before);
  });

  it("changes nothing when cancelled, empty or unreadable", async () => {
    const before = useProjectStore.getState().project;
    rust(null);
    expect(await readSrt()).toBeNull();
    rust({ name: "empty.srt", text: "hello" });
    expect(await readSrt()).toEqual({ ok: false, reason: "No subtitles were found in empty.srt" });
    rust(new Error("the file is too large (1 MB at most)"));
    expect(await readSrt()).toEqual({
      ok: false,
      reason: "Could not read the subtitles: the file is too large (1 MB at most)",
    });
    expect(calls("split_captions")).toHaveLength(0);
    expect(useProjectStore.getState().project).toBe(before);
  });
});

describe("the Import subtitles dialog", () => {
  function openFromMenu() {
    render(
      <>
        <FileMenu />
        <SrtImportDialog />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: /File/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Import subtitles \(\.srt\)/ }));
  }

  it("opens after the file is picked, shows the cues, and imports them moved to the playhead", async () => {
    openFromMenu();
    const dialog = await screen.findByRole("dialog", { name: /Import subtitles · film\.srt/ });
    expect(dialog).toHaveTextContent("2 subtitles; the first starts at 0:01.0 on the timeline");
    expect(screen.getByRole("list", { name: "First subtitles" })).toHaveTextContent(
      "0:01.0–0:03.5Halo semua, selamat datang.",
    );
    expect(screen.getByRole("group", { name: "Subtitle look" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "3 · Caption length" })).toBeInTheDocument();

    usePlaybackStore.getState().setPlayhead(10);
    fireEvent.click(screen.getByRole("button", { name: "First subtitle at the playhead" }));
    expect(screen.getByRole("textbox", { name: /Move all subtitles by/ })).toHaveValue("9");
    expect(dialog).toHaveTextContent("the first starts at 0:10.0 on the timeline (+0:09.0)");

    fireEvent.click(screen.getByRole("button", { name: "Import 2 subtitles" }));
    await waitFor(() => expect(useUiStore.getState().notice).toBe("Imported 3 subtitles on a new track"));
    expect(screen.queryByRole("dialog")).toBeNull();
    const request = (calls("split_captions")[0][1] as { request: { sources: { start: number }[] } }).request;
    expect(request.sources.map((s) => s.start)).toEqual([10, 13]);
  });

  it("a typed shift moves the times; Cancel adds nothing", async () => {
    const before = useProjectStore.getState().project;
    openFromMenu();
    const dialog = await screen.findByRole("dialog");
    const field = screen.getByRole("textbox", { name: /Move all subtitles by/ });
    fireEvent.change(field, { target: { value: "-2,5" } });
    fireEvent.blur(field);
    expect(dialog).toHaveTextContent("the first starts at 0:00.0 on the timeline (−0:02.5)");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls("split_captions")).toHaveLength(0);
    expect(useProjectStore.getState().project).toBe(before);
  });

  it("says why when the file has no subtitles, and no dialog opens", async () => {
    rust({ name: "empty.srt", text: "hello" });
    openFromMenu();
    await waitFor(() => expect(useUiStore.getState().notice).toBe("No subtitles were found in empty.srt"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
