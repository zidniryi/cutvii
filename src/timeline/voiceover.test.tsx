import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { AiMenu } from "@/components/autoclips/AiMenu";
import { VoiceoverDialog } from "@/components/voiceover/VoiceoverDialog";
import type { Project } from "@/project/model";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { useUiStore } from "@/store/ui";
import { useVoiceoverStore, type TtsStatus } from "@/store/voiceover";
import { expectValid, IDS, makeProject } from "@/test/makeProject";
import { addClip } from "./edit";
import { undo } from "./editor";
import { addVoiceover, VOICEOVER_TRACK_NAME } from "./voiceover";

const ids = (n: number) => ({ asset: `va${n}`, track: `vt${n}`, clip: `vc${n}` });
const made = { path: "/data/voiceover/Halo dunia 1a2b3c4d.wav", duration: 3 };
const ok = (r: ReturnType<typeof addVoiceover>) => {
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
};
const voiceTracks = (p: Project) => p.tracks.filter((t) => t.name === VOICEOVER_TRACK_NAME);

/** `installed`: the ids of the models that are on this machine. */
const status = (...installed: string[]): TtsStatus => ({
  models: [
    {
      id: "supertonic-3",
      label: "Standard",
      hint: "Supertone's own files.",
      bytes: 401_276_744,
      hosts: ["huggingface.co/Supertone/supertonic-3"],
      installed: installed.includes("supertonic-3"),
    },
    {
      id: "supertonic-3-int8",
      label: "Compact",
      hint: "A smaller download.",
      bytes: 147_709_674,
      hosts: [
        "huggingface.co/Supertone/supertonic-3",
        "huggingface.co/csukuangfj2/sherpa-onnx-supertonic-3-tts-int8-2026-05-11",
      ],
      installed: installed.includes("supertonic-3-int8"),
    },
  ],
  source: "https://huggingface.co/Supertone/supertonic-3",
  voices: [
    { id: "F1", label: "Woman 1" },
    { id: "M1", label: "Man 1" },
  ],
  languages: [
    { id: "id", label: "Indonesian" },
    { id: "en", label: "English" },
  ],
  maxChars: 5000,
  minSpeed: 0.7,
  defaultSpeed: 1.05,
  maxSpeed: 1.6,
});

beforeEach(() => {
  localStorage.clear();
  vi.mocked(invoke).mockReset();
  useUiStore.setState({ notice: null, dialog: null });
  useVoiceoverStore.setState({
    open: false,
    status: null,
    download: null,
    running: null,
    note: null,
    model: null,
    language: "id",
    voice: "F1",
    speed: null,
  });
  useProjectStore.getState().loadProject(makeProject(), "/p.cutvii", []);
  usePlaybackStore.setState({ playhead: 2, playing: false });
});

describe("a voice-over on the timeline", () => {
  it("goes on its own audio track at the playhead, and shares that track while there is room", () => {
    const music = addClip(makeProject(), { assetId: IDS.aud, trackId: IDS.a1, start: 0, id: "music" });
    if (!music.ok) throw new Error(music.error.message);
    let p = ok(addVoiceover(music.project, made, 2, ids(1)));
    expect(voiceTracks(p)).toHaveLength(1);
    const track = voiceTracks(p)[0];
    expect(track.type).toBe("audio");
    expect(track.clips[0]).toMatchObject({ timelineStart: 2, sourceIn: 0, sourceOut: 3, volume: 1 });
    expect(p.assets.at(-1)).toEqual({ id: "va1", path: made.path, type: "audio", duration: 3 });
    expect(p.tracks.find((t) => t.id === IDS.a1)!.clips).toHaveLength(1); // the music is left alone
    expectValid(p);

    p = ok(addVoiceover(p, made, 5, ids(2))); // right after the first: same track
    expect(voiceTracks(p)).toHaveLength(1);
    expect(voiceTracks(p)[0].clips).toHaveLength(2);
    p = ok(addVoiceover(p, made, 4, ids(3))); // would overlap both: a second voice-over track
    expect(voiceTracks(p).map((t) => t.clips.length)).toEqual([2, 1]);
    expectValid(p);
    expect(addVoiceover(p, { path: made.path, duration: 0 }, 0, ids(4)).ok).toBe(false);
  });
});

describe("the AI menu in the top bar", () => {
  it("opens the Voice-over dialog", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => (cmd === "tts_status" ? status() : undefined));
    render(<AiMenu />);
    fireEvent.click(screen.getByRole("button", { name: /AI/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: /Voice-over from text/ }));
    });
    expect(useVoiceoverStore.getState().open).toBe(true);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("the Voice-over dialog", () => {
  it("asks before downloading the model, and downloads nothing when the answer is no", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => (cmd === "tts_status" ? status() : undefined));
    act(() => useVoiceoverStore.getState().show());
    render(<VoiceoverDialog />);
    fireEvent.click(await screen.findByRole("button", { name: /Download the voice model/ }));
    const question = await waitFor(() => {
      const dialog = useUiStore.getState().dialog;
      if (!dialog) throw new Error("no question yet");
      return dialog;
    });
    expect(question.lines.join(" ")).toMatch(/Standard.*401 MB.*huggingface\.co/);
    expect(question.lines.join(" ")).toMatch(/OpenRAIL-M/);
    expect(question.lines.join(" ")).toMatch(/never uploaded/);
    await act(async () => question.resolve(false));
    expect(invoke).not.toHaveBeenCalledWith("download_tts_model", expect.anything());
    expect(screen.queryByRole("textbox")).toBeNull(); // nothing to type into without the model
  });

  it("offers two sizes to download, says what each speaks, and names the other two as coming soon", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => (cmd === "tts_status" ? status() : undefined));
    act(() => useVoiceoverStore.getState().show());
    render(<VoiceoverDialog />);
    const models = within(await screen.findByRole("radiogroup", { name: "Voice model" }));
    expect(models.getByRole("radio", { name: "Standard, 401 MB" })).toBeChecked();
    const compact = models.getByRole("radio", { name: "Compact, 148 MB" });
    expect(models.getAllByText("Coming soon")).toHaveLength(2);
    expect(models.getByText("English only: no Indonesian")).toBeInTheDocument();
    expect(models.getAllByRole("radio")).toHaveLength(2); // the planned ones cannot be chosen

    fireEvent.click(compact);
    expect(compact).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: /Download the voice model/ }));
    await waitFor(() => expect(useUiStore.getState().dialog).not.toBeNull());
    const lines = useUiStore.getState().dialog!.lines.join(" ");
    expect(lines).toMatch(/Compact.*148 MB/);
    expect(lines).toMatch(/sherpa-onnx project, not by Supertone/); // who made the smaller files
    await act(async () => useUiStore.getState().dialog!.resolve(true));
    expect(invoke).toHaveBeenCalledWith("download_tts_model", { id: "supertonic-3-int8" });
  });

  it("downloads after a yes and then offers the text field", async () => {
    const installed: string[] = [];
    vi.mocked(invoke).mockImplementation(async (cmd, args) => {
      if (cmd === "download_tts_model") installed.push((args as { id: string }).id);
      return cmd === "tts_status" ? status(...installed) : undefined;
    });
    act(() => useVoiceoverStore.getState().show());
    render(<VoiceoverDialog />);
    fireEvent.click(await screen.findByRole("button", { name: /Download the voice model/ }));
    await waitFor(() => expect(useUiStore.getState().dialog).not.toBeNull());
    await act(async () => useUiStore.getState().dialog!.resolve(true));
    expect(invoke).toHaveBeenCalledWith("download_tts_model", { id: "supertonic-3" });
    expect(await screen.findByLabelText("Words to speak")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("The voice model is ready.");
  });

  it("speaks the text with the chosen language, voice and speed and adds it as one undo step", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) =>
      cmd === "tts_status" ? status("supertonic-3-int8") : cmd === "speak_text" ? made : undefined,
    );
    act(() => useVoiceoverStore.getState().show());
    render(<VoiceoverDialog />);
    const add = await screen.findByRole("button", { name: /Add voice-over at playhead/ });
    expect(add).toBeDisabled(); // nothing typed
    fireEvent.change(screen.getByLabelText("Words to speak"), { target: { value: "Halo dunia" } });
    fireEvent.change(screen.getByLabelText("Language"), { target: { value: "en" } });
    fireEvent.change(screen.getByLabelText("Voice"), { target: { value: "M1" } });
    await act(async () => {
      fireEvent.click(add);
    });
    expect(invoke).toHaveBeenCalledWith("speak_text", {
      modelId: "supertonic-3-int8", // the one that is downloaded
      text: "Halo dunia",
      language: "en",
      voice: "M1",
      speed: 1.05,
    });
    const project = useProjectStore.getState().project;
    expect(voiceTracks(project)[0].clips[0]).toMatchObject({ timelineStart: 2, sourceOut: 3 });
    expectValid(project);
    expect(JSON.parse(localStorage.getItem("cutvii.voiceover.v1")!)).toMatchObject({
      language: "en",
      voice: "M1",
    });
    undo();
    expect(voiceTracks(useProjectStore.getState().project)).toHaveLength(0);
    expect(useProjectStore.getState().project.assets.some((a) => a.path === made.path)).toBe(false);
  });

  it("says why when the voice could not be made, and adds nothing", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "speak_text") throw "invalid input: the voice model is damaged; download it again";
      return cmd === "tts_status" ? status("supertonic-3") : undefined;
    });
    act(() => useVoiceoverStore.getState().show());
    render(<VoiceoverDialog />);
    fireEvent.change(await screen.findByLabelText("Words to speak"), { target: { value: "Halo" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Add voice-over at playhead/ }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent("the voice model is damaged");
    expect(voiceTracks(useProjectStore.getState().project)).toHaveLength(0);
  });
});
