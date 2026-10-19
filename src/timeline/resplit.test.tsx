import { act, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import type { Project, TextSpec } from "@/project/model";
import { parseProject } from "@/project/parse";
import { useProjectStore } from "@/store/project";
import { resetTextLines } from "@/store/textLines";
import { useTextStyleStore } from "@/store/textStyles";
import { expectValid, makeProject } from "@/test/makeProject";
import { CaptionCheck, TooLongBadge } from "@/components/inspector/CaptionCheck";
import { DEFAULT_CAPTION_LIMITS } from "./captionRules";
import { undo } from "./editor";
import { addTextClip } from "./text";
import { overLimits, replaceWithPieces, resplitTrack } from "./resplit";

const LONG =
  "Hari ini kita akan belajar cara membuat video pendek yang menarik untuk media sosial, mulai dari memilih musik yang tepat.";
const spec = (content: string): TextSpec => ({
  content,
  fontSize: 49,
  color: "#FFFFFF",
  bold: true,
  align: "center",
  x: 0.5,
  y: 0.85,
  highlight: { color: "#E5733A", lines: "last" },
});

/** On one text track: a long caption "long" at 1..10 (fades, both transitions) and a short "short" at 12..14. */
function project(): Project {
  let p = makeProject();
  for (const [clipId, content, start] of [
    ["long", LONG, 1],
    ["short", "Selamat mencoba.", 12],
  ] as const) {
    const r = addTextClip(p, {
      picture: `/data/text/${clipId}.png`,
      spec: spec(content),
      start,
      assetId: `${clipId}-asset`,
      clipId,
      trackId: "subs",
    });
    if (!r.ok) throw new Error(r.error.message);
    p = r.project;
  }
  const track = p.tracks.find((t) => t.clips.some((c) => c.id === "long"))!;
  track.clips = track.clips.map((c) =>
    c.id === "long"
      ? {
          ...c,
          sourceOut: 9,
          fadeIn: 0.5,
          fadeOut: 0.5,
          transitionIn: { kind: "dissolve", duration: 0.5 },
          transitionOut: { kind: "dissolve", duration: 0.5 },
        }
      : c,
  );
  expectValid(p);
  return p;
}

const PIECES = [
  { start: 1, end: 4, text: "Hari ini kita akan belajar\ncara membuat video pendek", lines: 2, fast: false },
  { start: 4, end: 7, text: "yang menarik\nuntuk media sosial,", lines: 2, fast: false },
  { start: 7, end: 10, text: "mulai dari memilih\nmusik yang tepat.", lines: 2, fast: false },
];

function rust(lines: (s: TextSpec) => number = (s) => (s.content === LONG ? 5 : 1)) {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation((async (
    cmd: string,
    args?: { specs?: TextSpec[]; spec?: TextSpec },
  ) => {
    if (cmd === "text_line_counts") return args!.specs!.map(lines);
    if (cmd === "split_captions") return PIECES;
    if (cmd === "render_text") return `/data/text/${args!.spec!.content.slice(0, 8)}.png`;
    return undefined;
  }) as never);
}
const calls = (cmd: string) => vi.mocked(invoke).mock.calls.filter((c) => c[0] === cmd);
const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const subsTrack = (p: Project) => p.tracks.find((t) => t.clips.some((c) => c.id === "short"))!;

beforeEach(() => {
  useTextStyleStore.getState().reset();
  resetTextLines();
  rust();
});

describe("which captions are too long", () => {
  const limits = DEFAULT_CAPTION_LIMITS.landscape;
  it("counts drawn lines, words, time and typed line length", () => {
    expect(overLimits(spec("Halo semua."), 2, 1, limits)).toBe(false);
    expect(overLimits(spec("Halo semua."), 2, 3, limits)).toBe(true);
    expect(overLimits(spec("Halo semua."), 7, 1, limits)).toBe(true);
    expect(overLimits(spec("Supercalifragilistic"), 7, 1, limits)).toBe(false); // one word may stay long
    expect(overLimits(spec("a".repeat(30) + " " + "b".repeat(13)), 2, 1, limits)).toBe(true);
    expect(overLimits({ ...spec("a ".repeat(19) + "b"), uppercase: true }, 2, 1, limits)).toBe(true);
    expect(overLimits(spec("satu dua tiga empat lima enam"), 2, 1, DEFAULT_CAPTION_LIMITS.vertical)).toBe(
      true,
    );
  });
});

describe("re-split long captions", () => {
  it("cuts only the captions above the limits, keeps text and look, and is ONE undo step", async () => {
    const before = project();
    useProjectStore.getState().loadProject(before, "/p.cutvii", []);
    expect(await resplitTrack(subsTrack(before).id)).toEqual({ ok: true, changed: 1 });

    expect(calls("split_captions")).toHaveLength(1);
    expect((calls("split_captions")[0][1] as { request: object }).request).toMatchObject({
      sources: [{ start: 1, end: 10, text: LONG }],
      limits: DEFAULT_CAPTION_LIMITS.landscape,
      endLimit: 12, // may run on into the gap, never into the next caption
      uppercase: false,
      bottom: true,
    });
    const after = useProjectStore.getState().project;
    expectValid(after);
    const clips = subsTrack(after).clips;
    expect(clips.map((c) => [c.timelineStart, c.sourceOut - c.sourceIn])).toEqual([
      [1, 3],
      [4, 3],
      [7, 3],
      [12, 5],
    ]);
    const texts = clips.map((c) => after.assets.find((a) => a.id === c.assetId)!.text!);
    expect(
      squash(
        texts
          .slice(0, 3)
          .map((t) => t.content)
          .join(" "),
      ),
    ).toBe(squash(LONG));
    // the look, per-line colour included, carries over to every piece
    for (const t of texts.slice(0, 3))
      expect(t).toMatchObject({ highlight: { lines: "last" }, y: 0.85, fontSize: 49 });
    // the first piece keeps the clip's id; transitions stay at the outer ends; fades fit each piece
    expect(clips[0].id).toBe("long");
    expect(clips[0].transitionIn).toBeDefined();
    expect(clips[0].transitionOut).toBeUndefined();
    expect(clips[2].transitionIn).toBeUndefined();
    expect(clips[2].transitionOut).toBeDefined();
    expect(clips.slice(0, 3).every((c) => c.fadeIn === 0.5 && c.fadeOut === 0.5)).toBe(true);
    expect(clips[3].id).toBe("short");

    // saved and opened again: the same
    const reopened = parseProject(JSON.parse(JSON.stringify(after)));
    expect(reopened.ok && reopened.project.tracks).toEqual(after.tracks);

    undo();
    expect(useProjectStore.getState().project).toBe(before);
  });

  it("changes nothing when every caption fits, or when Rust fails", async () => {
    const before = project();
    rust(() => 1);
    const shortOnly = {
      ...before,
      tracks: before.tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => c.id !== "long") })),
    };
    useProjectStore.getState().loadProject(shortOnly, "/p.cutvii", []);
    expect(await resplitTrack(subsTrack(shortOnly).id)).toEqual({ ok: true, changed: 0 });
    expect(useProjectStore.getState().project).toBe(shortOnly);

    useProjectStore.getState().loadProject(before, "/p.cutvii", []);
    vi.mocked(invoke).mockImplementation((async (cmd: string) => {
      if (cmd === "text_line_counts") return [5, 1];
      throw "caption limits are out of range";
    }) as never);
    expect(await resplitTrack(subsTrack(before).id)).toEqual({
      ok: false,
      reason: "Could not re-split the captions: caption limits are out of range",
    });
    expect(useProjectStore.getState().project).toBe(before);
  });

  it("refuses pieces for a clip that is gone", () => {
    const r = replaceWithPieces(project(), [
      {
        clipId: "nope",
        pieces: [{ start: 0, end: 1, text: "x", picture: "/x.png", assetId: "a", clipId: "c" }],
      },
    ]);
    expect(r.ok).toBe(false);
  });
});

describe("the Too long warning", () => {
  it("shows the drawn line count on the timeline clip and in the Text tab", async () => {
    useProjectStore.getState().loadProject(project(), "/p.cutvii", []);
    const { unmount } = render(<TooLongBadge spec={spec(LONG)} left={0} />);
    expect(await screen.findByLabelText("Too long: 5 lines")).toBeInTheDocument();
    unmount();

    render(<CaptionCheck clipId="long" spec={spec(LONG)} />);
    expect(await screen.findByRole("status")).toHaveTextContent("Too long: 5 lines");
    await act(async () => screen.getByRole("button", { name: /Re-split long captions/ }).click());
    await waitFor(() => expect(subsTrack(useProjectStore.getState().project).clips).toHaveLength(4));
  });

  it("is not shown for a caption within the limits", async () => {
    render(<TooLongBadge spec={spec("Selamat mencoba.")} left={0} />);
    await waitFor(() => expect(calls("text_line_counts")).toHaveLength(1));
    expect(screen.queryByLabelText(/Too long/)).toBeNull();
  });
});
