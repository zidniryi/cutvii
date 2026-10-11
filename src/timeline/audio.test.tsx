import { fireEvent, render, screen, within } from "@testing-library/react";
import { Inspector } from "@/components/layout/Inspector";
import { Preview } from "@/components/layout/Preview";
import { layersAt, pickLead } from "@/playback/engine";
import type { Project } from "@/project/model";
import { parseProject } from "@/project/parse";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useUiStore } from "@/store/ui";
import { useWaveformStore } from "@/store/waveforms";
import { expectValid, IDS, makeProject } from "@/test/makeProject";
import { detachAudio, fadeGain, fadesOf, setClipSound } from "./audio";
import { addClip, moveClip } from "./edit";
import { undo } from "./editor";

/** A 10 s video ("video") on v1 at 2..12 and a still ("still") on v2. One empty audio track (a1). */
function project(): Project {
  let p = makeProject();
  for (const [assetId, trackId, id, start] of [
    [IDS.vid, IDS.v1, "video", 2],
    [IDS.img, IDS.v2, "still", 20],
  ] as const) {
    const r = addClip(p, { assetId, trackId, start, id });
    if (!r.ok) throw new Error(r.error.message);
    p = r.project;
  }
  return p;
}
const clipOf = (p: Project, id: string) => p.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!;
const ok = (r: ReturnType<typeof setClipSound>) => {
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
};
const detached = (p = project()) => ok(detachAudio(p, "video", { clipId: "sound", trackId: "new-audio" }));

describe("clip sound in the project", () => {
  it("stores mute and fades only when they are set, and checks them in project files", () => {
    const p = ok(setClipSound(project(), "video", { muted: true, fadeIn: 1.5 }));
    expectValid(p);
    expect(clipOf(p, "video")).toMatchObject({ muted: true, fadeIn: 1.5 });
    expect("fadeOut" in clipOf(p, "video")).toBe(false);
    const back = ok(setClipSound(p, "video", { muted: false, fadeIn: 0 }));
    expect("muted" in clipOf(back, "video") || "fadeIn" in clipOf(back, "video")).toBe(false);
    expect(setClipSound(back, "video", { fadeOut: 0 })).toEqual({ ok: true, project: back }); // not an edit

    expect(setClipSound(p, "video", { fadeIn: -1 })).toMatchObject({
      ok: false,
      error: { code: "out-of-range" },
    });
    expect(setClipSound(p, "video", { fadeOut: 61 })).toMatchObject({ ok: false });
    expect(setClipSound(p, "still", { muted: true })).toMatchObject({ ok: false }); // a still has no sound
    const errors = (change: object) => {
      const copy = structuredClone(p);
      Object.assign(clipOf(copy, "video"), change);
      const r = parseProject(copy);
      return r.ok ? [] : r.errors;
    };
    expect(errors({ fadeIn: 60, fadeOut: 0.25, muted: false })).toHaveLength(0);
    expect(errors({ fadeIn: 61 })).not.toHaveLength(0);
    expect(errors({ fadeOut: -0.1 })).not.toHaveLength(0);
    expect(errors({ muted: "yes" })).not.toHaveLength(0);
  });

  it("fits fades to the clip and ramps in a straight line", () => {
    const c = { ...clipOf(project(), "video"), fadeIn: 2, fadeOut: 4 }; // 2..12
    expect(fadesOf(c)).toEqual({ fadeIn: 2, fadeOut: 4 });
    expect([2, 3, 4, 7, 8, 10, 11, 12].map((t) => fadeGain(c, t))).toEqual([0, 0.5, 1, 1, 1, 0.5, 0.25, 0]);
    expect(fadeGain(clipOf(project(), "video"), 2)).toBe(1); // no fades: full from the first sample
    // longer than the clip: the fade-in first, the fade-out gets what is left
    expect(fadesOf({ ...c, fadeIn: 8, fadeOut: 8 })).toEqual({ fadeIn: 8, fadeOut: 2 });
    expect(fadesOf({ ...c, fadeIn: 30, fadeOut: 5 })).toEqual({ fadeIn: 10, fadeOut: 0 });
    // at 2x the clip is 5 s on the timeline, and fades are timeline seconds
    expect(fadesOf({ ...c, speed: 2, fadeIn: 4, fadeOut: 4 })).toEqual({ fadeIn: 4, fadeOut: 1 });
  });
});

describe("detach audio", () => {
  it("puts the sound on a free audio track as its own clip and mutes the video clip", () => {
    const start = ok(setClipSound(project(), "video", { fadeOut: 1 }));
    const withSpeed = {
      ...start,
      tracks: start.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => (c.id === "video" ? { ...c, volume: 0.5, scale: 0.5, x: 0.2 } : c)),
      })),
    };
    const p = detached(withSpeed);
    expectValid(p);
    expect(clipOf(p, "video")).toMatchObject({ muted: true, scale: 0.5 }); // the picture is untouched
    const sound = clipOf(p, "sound");
    expect(sound).toMatchObject({
      assetId: IDS.vid,
      trackId: IDS.a1,
      timelineStart: 2,
      sourceIn: 0,
      sourceOut: 10,
      volume: 0.5,
      fadeOut: 1,
      scale: 1,
      x: 0,
    });
    expect(sound.muted).toBeUndefined();
    expect(p.tracks).toHaveLength(3); // no new track was needed

    // already detached (or muted): nothing more to take
    expect(detachAudio(p, "video", { clipId: "x", trackId: "y" })).toMatchObject({ ok: false });
    expect(detachAudio(p, "sound", { clipId: "x", trackId: "y" })).toMatchObject({ ok: false });
    expect(detachAudio(p, "still", { clipId: "x", trackId: "y" })).toMatchObject({ ok: false });
  });

  it("adds an audio track when none is free at that time", () => {
    const busy = addClip(project(), { assetId: IDS.aud, trackId: IDS.a1, start: 0, id: "music" }); // 0..20
    if (!busy.ok) throw new Error("setup");
    const p = detached(busy.project);
    expectValid(p);
    const track = p.tracks.find((t) => t.id === "new-audio")!;
    expect(track).toMatchObject({ type: "audio", name: "Audio 2" });
    expect(track.clips.map((c) => c.id)).toEqual(["sound"]);
  });

  it("keeps the detached sound on audio tracks and out of the picture", () => {
    const p = detached();
    expect(moveClip(p, "sound", { start: 0, trackId: IDS.v2 })).toMatchObject({
      ok: false,
      error: { code: "incompatible-track" },
    });
    expect(moveClip(p, "sound", { start: 0 })).toMatchObject({ ok: true });
    const layers = layersAt(p, 3, 0);
    expect(layers.filter((l) => l.visible).map((l) => l.clip.id)).toEqual(["video"]);
    expect(pickLead(layers)?.clip.id).toBe("sound"); // sound leads playback, like any audio clip
  });
});

describe("clip sound in the preview and the inspector", () => {
  function open(p: Project, selected: string, playhead = 3) {
    useProjectStore.getState().loadProject(p, "/p.cutvii", []);
    usePlaybackStore.setState({ playhead, playing: false, volume: 1, muted: false });
    useSelectionStore.getState().select(selected);
    useUiStore.setState({ notice: null, inspectorTab: { video: "audio" } });
    useWaveformStore.setState({ entries: {} });
  }
  const stored = (id: string) => clipOf(useProjectStore.getState().project, id);

  it("plays detached sound as audio and applies mute and fades to what is heard", () => {
    const p = ok(setClipSound(detached(), "sound", { fadeIn: 2 })); // sound at 2..12, fading in until 4
    open(p, "sound");
    const { container } = render(<Preview />);
    const audio = container.querySelector("audio")!;
    const video = container.querySelector("video")!;
    expect(audio.getAttribute("src")).toBe("asset://localhost/m/vid.mp4");
    expect(screen.getAllByTestId("video-layer")).toHaveLength(1); // the sound is not a second picture
    expect(audio.volume).toBeCloseTo(0.5); // half-way through the fade-in at 3 s
    expect(audio.muted).toBe(false);
    expect(video.muted).toBe(true); // the video clip was muted by the detach
  });

  it("mutes, fades and detaches from the Audio tab", () => {
    open(project(), "video");
    render(<Inspector />);
    const panel = within(screen.getByRole("group", { name: "Sound" }));

    const fadeIn = panel.getByRole("spinbutton", { name: "Fade in (s)" });
    fireEvent.change(fadeIn, { target: { value: "1.5" } });
    expect(stored("video").fadeIn).toBeUndefined(); // applied on Enter or leaving the field
    fireEvent.keyDown(fadeIn, { key: "Enter" });
    expect(stored("video").fadeIn).toBe(1.5);
    const fadeOut = panel.getByRole("spinbutton", { name: "Fade out (s)" });
    fireEvent.change(fadeOut, { target: { value: "99" } });
    fireEvent.blur(fadeOut);
    expect(stored("video").fadeOut).toBe(10); // no longer than the clip

    fireEvent.click(panel.getByRole("button", { name: "Mute this clip" }));
    expect(stored("video").muted).toBe(true);
    expect(panel.getByRole("button", { name: "Detach audio" })).toBeDisabled(); // nothing to detach while muted
    fireEvent.click(panel.getByRole("button", { name: "Muted" }));
    expect(stored("video").muted).toBeUndefined();

    fireEvent.click(panel.getByRole("button", { name: "Detach audio" }));
    const after = useProjectStore.getState().project;
    expectValid(after);
    const sound = after.tracks.find((t) => t.id === IDS.a1)!.clips[0];
    expect(sound).toMatchObject({ assetId: IDS.vid, timelineStart: 2, fadeIn: 1.5, fadeOut: 10 });
    expect(stored("video").muted).toBe(true);
    expect(useSelectionStore.getState().selectedClipIds).toEqual([sound.id]);
    // the new clip is treated as audio: no picture tab, and nothing left to detach
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Audio", "Speed", "Info"]);
    expect(screen.queryByRole("button", { name: "Detach audio" })).not.toBeInTheDocument();

    undo(); // one step takes the whole detach back
    expect(useProjectStore.getState().project.tracks.find((t) => t.id === IDS.a1)!.clips).toHaveLength(0);
    expect(stored("video").muted).toBeUndefined();
    expect(useUiStore.getState().notice).toBeNull();
  });

  it("does not offer to detach sound a video does not have", () => {
    open(project(), "video");
    useWaveformStore.setState({ entries: { "/m/vid.mp4": { status: "none" } } });
    render(<Inspector />);
    expect(screen.getByRole("button", { name: "Detach audio" })).toBeDisabled();
    expect(screen.getByText("This video has no sound.")).toBeInTheDocument();
  });
});
