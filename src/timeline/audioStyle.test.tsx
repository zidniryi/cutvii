import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Inspector } from "@/components/layout/Inspector";
import { confirmDialog } from "@/lib/dialog";
import type { Project } from "@/project/model";
import { parseProject } from "@/project/parse";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useUiStore } from "@/store/ui";
import { expectValid, IDS, makeProject } from "@/test/makeProject";
import { currentChoice, setAudioStyle, STYLE_PRESETS } from "./audioStyle";
import { clipEnd } from "./clips";
import { addClip } from "./edit";
import { undo } from "./editor";

vi.mock("@/lib/dialog", () => ({ confirmDialog: vi.fn() }));

/** A 20 s music clip "song" on the audio track at 0..20, and a second one "next" at 30. */
function project(): Project {
  let p = makeProject();
  for (const [id, start] of [
    ["song", 0],
    ["next", 30],
  ] as const) {
    const r = addClip(p, { assetId: IDS.aud, trackId: IDS.a1, start, id });
    if (!r.ok) throw new Error(r.error.message);
    p = r.project;
  }
  return p;
}
const clipOf = (p: Project, id: string) => p.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!;
const stored = (id = "song") => clipOf(useProjectStore.getState().project, id);
const ok = (r: ReturnType<typeof setAudioStyle>) => {
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
};

describe("setAudioStyle", () => {
  it("makes the tempo the clip's speed, keeps the pitch, and Off puts everything back", () => {
    const p0 = project();
    const sped = ok(setAudioStyle(p0, "song", STYLE_PRESETS.sped));
    const c = clipOf(sped, "song");
    expect(c.speed).toBe(1.25);
    expect(c.keepPitch).toBeUndefined(); // true is the default
    expect(c.audioStyle).toEqual({ preset: "sped", pitch: 125, reverb: 0, bass: 0, baseSpeed: 1 });
    expect(clipEnd(c)).toBeCloseTo(16); // 20 s at 1.25x
    expectValid(sped);

    const off = ok(setAudioStyle(sped, "song", null));
    expect(clipOf(off, "song").audioStyle).toBeUndefined();
    expect(clipOf(off, "song").speed ?? 1).toBe(1);
    expect(clipEnd(clipOf(off, "song"))).toBeCloseTo(20);
  });

  it("remembers the speed from before the first style, even when styles are switched", () => {
    let p = ok(setAudioStyle(project(), "song", { ...STYLE_PRESETS.bass, tempo: 100 }));
    p = ok(
      setAudioStyle(ok(setAudioStyle(p, "song", STYLE_PRESETS.slowed)), "song", {
        ...STYLE_PRESETS.sped,
        tempo: 110,
      }),
    );
    expect(clipOf(p, "song").audioStyle?.baseSpeed).toBe(1);
    expect(clipOf(ok(setAudioStyle(p, "song", null)), "song").speed ?? 1).toBe(1);
    expect(currentChoice(clipOf(p, "song"))?.tempo).toBe(110);
  });

  it("uses the overlap rule: a slower clip that would run into the next one needs room", () => {
    const tight = ok(setAudioStyle(project(), "song", { ...STYLE_PRESETS.slowed, tempo: 80 })); // 25 s: fits
    expect(clipEnd(clipOf(tight, "song"))).toBeCloseTo(25);
    const r = setAudioStyle(project(), "song", { ...STYLE_PRESETS.slowed, tempo: 50 }); // 40 s: runs into 30
    expect(!r.ok && r.error.code).toBe("needs-ripple");
    const moved = ok(
      setAudioStyle(project(), "song", { ...STYLE_PRESETS.slowed, tempo: 50 }, { ripple: true }),
    );
    expect(clipOf(moved, "next").timelineStart).toBeCloseTo(40);
  });

  it("refuses pictures' tracks, out-of-range values and files that break the limits", () => {
    const added = addClip(makeProject(), { assetId: IDS.vid, trackId: IDS.v1, start: 0, id: "pic" });
    if (!added.ok) throw new Error(added.error.message);
    const withVideo = added.project;
    expect(setAudioStyle(withVideo, "pic", STYLE_PRESETS.sped).ok).toBe(false);
    expect(setAudioStyle(project(), "song", { ...STYLE_PRESETS.sped, tempo: 300 }).ok).toBe(false);
    expect(setAudioStyle(project(), "song", { ...STYLE_PRESETS.sped, pitch: 10 }).ok).toBe(false);
    expect(setAudioStyle(project(), "song", { ...STYLE_PRESETS.bass, bass: 20 }).ok).toBe(false);
    expect(setAudioStyle(project(), "song", { ...STYLE_PRESETS.sped, reverb: 2 }).ok).toBe(false);
    const raw = JSON.parse(JSON.stringify(ok(setAudioStyle(project(), "song", STYLE_PRESETS.bass))));
    raw.tracks.flatMap((t: { clips: object[] }) => t.clips)[0].audioStyle.bass = 99;
    expect(parseProject(raw).ok).toBe(false);
  });
});

describe("Style in the Audio tab", () => {
  function open(p: Project) {
    useProjectStore.getState().loadProject(p, "/p.cutvii", []);
    usePlaybackStore.setState({ playhead: 0, playing: false, volume: 1, muted: false });
    useSelectionStore.getState().select("song");
    useUiStore.setState({ notice: null, inspectorTab: { audio: "audio" } });
  }
  const group = () => within(screen.getByRole("group", { name: "Sound style" }));
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(confirmDialog).mockReset();
    vi.mocked(confirmDialog).mockResolvedValue(true);
    open(project());
  });

  it("asks about copyright once, applies a style as one undo step, and Off undoes it", async () => {
    render(<Inspector />);
    fireEvent.click(group().getByRole("radio", { name: "Sped up" }));
    await waitFor(() => expect(stored().audioStyle?.preset).toBe("sped"));
    expect(confirmDialog).toHaveBeenCalledTimes(1);
    expect(vi.mocked(confirmDialog).mock.calls[0][0].lines?.join(" ")).toMatch(
      /does not remove its copyright/,
    );

    fireEvent.click(group().getByRole("radio", { name: "Bass boost" }));
    await waitFor(() => expect(stored().audioStyle?.preset).toBe("bass"));
    expect(confirmDialog).toHaveBeenCalledTimes(1); // not asked again
    expect(stored().speed ?? 1).toBe(1);

    fireEvent.click(group().getByRole("radio", { name: "Off" }));
    await waitFor(() => expect(stored().audioStyle).toBeUndefined());
    undo();
    expect(stored().audioStyle?.preset).toBe("bass");
    undo();
    expect(stored().audioStyle?.preset).toBe("sped");
    expect(stored().speed).toBe(1.25);
  });

  it("changes nothing when the copyright note is not accepted", async () => {
    vi.mocked(confirmDialog).mockResolvedValue(false);
    render(<Inspector />);
    fireEvent.click(group().getByRole("radio", { name: "Slowed + reverb" }));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalled());
    expect(stored().audioStyle).toBeUndefined();
    expect(stored().speed).toBeUndefined();
  });

  it("offers to move the following clips when the sound gets longer", async () => {
    vi.mocked(confirmDialog).mockResolvedValue(true);
    open(project());
    render(<Inspector />);
    fireEvent.click(group().getByRole("radio", { name: "Custom" }));
    await waitFor(() => expect(stored().audioStyle?.preset).toBe("custom"));
    fireEvent.change(screen.getByLabelText("Tempo"), { target: { value: "50" } });
    fireEvent.pointerUp(screen.getByLabelText("Tempo"));
    await waitFor(() => expect(stored("next").timelineStart).toBeCloseTo(40));
    expect(stored().speed).toBe(0.5);
    expect(vi.mocked(confirmDialog).mock.calls.some((c) => c[0].title === "Move the following clips?")).toBe(
      true,
    );
  });

  it("is not shown for a clip on a video track", () => {
    const r = addClip(makeProject(), { assetId: IDS.vid, trackId: IDS.v1, start: 0, id: "song" });
    if (!r.ok) throw new Error(r.error.message);
    open(r.project);
    useUiStore.setState({ inspectorTab: { video: "audio" } });
    render(<Inspector />);
    expect(screen.queryByRole("group", { name: "Sound style" })).toBeNull();
  });
});
