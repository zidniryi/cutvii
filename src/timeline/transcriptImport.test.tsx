import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { AutoClipsWizard } from "@/components/autoclips/AutoClipsWizard";
import type { Project } from "@/project/model";
import { useAiStore, type SpeechModel } from "@/store/ai";
import { searchModel, useAutoClipsStore } from "@/store/autoClips";
import { useProjectStore } from "@/store/project";
import { useUiStore } from "@/store/ui";
import { IDS, makeProject } from "@/test/makeProject";
import {
  chooseTranscript,
  clampOffset,
  DEFAULT_SETTINGS,
  durationWarning,
  searchRequest,
  type TranscriptInfo,
} from "./autoClips";
import { addClip } from "./edit";

const INFO: TranscriptInfo = {
  path: "/m/talk.json3",
  name: "talk.json3",
  format: "YouTube json3",
  lines: 220,
  wordLevel: true,
  wordReason: "",
  spanStart: 0.08,
  spanEnd: 538.48,
  hash: "abc123",
};
const MODELS: SpeechModel[] = [
  { id: "base", label: "Base", approxMb: 142, source: "https://huggingface.co/x/b.bin", installed: false },
];

function project(): Project {
  const base = makeProject();
  const r = addClip(
    {
      ...base,
      assets: [...base.assets, { id: "long", path: "/m/talk.mp4", type: "video", duration: 536.8 }],
    },
    { assetId: "long", trackId: IDS.v1, start: 0, id: "talk" },
  );
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
}

const fileSettings = { ...DEFAULT_SETTINGS, source: "file" as const, transcript: INFO };
const calls: { command: string; args: unknown }[] = [];
const auto = () => useAutoClipsStore.getState();

beforeEach(() => {
  calls.length = 0;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    calls.push({ command, args });
    if (command === "whisper_models") return MODELS;
    return null;
  });
  useProjectStore.setState({ project: project() });
  useUiStore.setState({ notice: null, dialog: null });
  useAiStore.setState({ models: MODELS, loaded: true, download: null, listening: null });
  auto().discard();
  useAutoClipsStore.setState({ open: false, clipId: "talk", settings: DEFAULT_SETTINGS });
});

describe("the search request", () => {
  it("sends the file and the offset, and needs no speech model", () => {
    const r = searchRequest(project(), "talk", { ...fileSettings, transcriptOffset: 2.5 }, "");
    expect(r.transcript).toEqual({ path: INFO.path, offset: 2.5 });
    expect(searchModel(fileSettings)).toBe("");
    expect(searchModel({ ...fileSettings, transcript: null })).toBeNull();
  });

  it("sends no transcript for Whisper, even if a file was chosen before", () => {
    const r = searchRequest(project(), "talk", { ...fileSettings, source: "whisper" }, "base");
    expect(r.transcript).toBeNull();
  });

  it("keeps the offset between -30 and 30", () => {
    expect(clampOffset(99)).toBe(30);
    expect(clampOffset(-99)).toBe(-30);
    expect(clampOffset(Number.NaN)).toBe(0);
    const r = searchRequest(project(), "talk", { ...fileSettings, transcriptOffset: 500 }, "");
    expect(r.transcript?.offset).toBe(30);
  });
});

describe("the duration check", () => {
  it("warns when the transcript clearly belongs to another video, and not otherwise", () => {
    expect(durationWarning(INFO, 0, 536.8)).toBeNull();
    expect(durationWarning(INFO, 0, undefined)).toBeNull();
    expect(durationWarning(INFO, 0, 3000)).toMatch(/ends at 538 s but the video is 3000 s/);
    expect(durationWarning(INFO, 0, 100)).toMatch(/runs to 538 s but the video is only 100 s/);
  });
});

describe("choosing a file", () => {
  it("returns what Rust says about it, or null when cancelled", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(INFO);
    expect(await chooseTranscript()).toEqual(INFO);
    vi.mocked(invoke).mockResolvedValueOnce(null);
    expect(await chooseTranscript()).toBeNull();
  });

  it("turns a refusal into a readable error", async () => {
    vi.mocked(invoke).mockRejectedValueOnce("“a.json”: the transcript file is too large (5 MB at most)");
    await expect(chooseTranscript()).rejects.toThrow(/too large/);
    vi.mocked(invoke).mockResolvedValueOnce({ nonsense: true });
    await expect(chooseTranscript()).rejects.toThrow(/unexpected/);
  });
});

describe("the Transcript row", () => {
  const open = () => {
    useAutoClipsStore.setState({ open: true, step: 1, clipId: "talk" });
    render(<AutoClipsWizard />);
  };

  it("offers Whisper by default and an Import file choice", () => {
    open();
    expect(screen.getByRole("radio", { name: "Transcribe with Whisper" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "Import file" }));
    expect(auto().settings.source).toBe("file");
    expect(screen.getByRole("button", { name: /Choose file/ })).toBeInTheDocument();
    // no file yet: the search cannot start, and says why
    expect(screen.getByRole("button", { name: /Find clips/ })).toBeDisabled();
  });

  it("shows the file facts, the word timing and a working offset field", async () => {
    open();
    fireEvent.click(screen.getByRole("radio", { name: "Import file" }));
    vi.mocked(invoke).mockResolvedValueOnce(INFO);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Choose file/ })));
    const facts = await screen.findByLabelText("Transcript file");
    expect(facts).toHaveTextContent("talk.json3");
    expect(facts).toHaveTextContent("YouTube json3");
    expect(facts).toHaveTextContent("220");
    expect(facts).toHaveTextContent("0:00 to 8:58");
    expect(facts).toHaveTextContent("Found");
    fireEvent.change(screen.getByLabelText("Offset, seconds"), { target: { value: "99" } });
    expect(auto().settings.transcriptOffset).toBe(30);
    expect(screen.getByRole("button", { name: /Find clips/ })).toBeEnabled();
  });

  it("says why there is no word timing, and warns about a mismatched video without blocking", async () => {
    open();
    fireEvent.click(screen.getByRole("radio", { name: "Import file" }));
    const plain = { ...INFO, wordLevel: false, wordReason: "this format has only line times", spanEnd: 40 };
    vi.mocked(invoke).mockResolvedValueOnce(plain);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Choose file/ })));
    expect(await screen.findByLabelText("Transcript file")).toHaveTextContent("only line times");
    expect(screen.getByText(/may belong to another video/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Find clips/ })).toBeEnabled();
  });

  it("shows a bad file's message and keeps the old choice", async () => {
    open();
    fireEvent.click(screen.getByRole("radio", { name: "Import file" }));
    vi.mocked(invoke).mockRejectedValueOnce("“x.json”: this file is not a transcript");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Choose file/ })));
    expect(await screen.findByRole("alert")).toHaveTextContent("not a transcript");
    expect(auto().settings.transcript).toBeNull();
  });

  it("searches with the file and never asks for a model download", async () => {
    useAutoClipsStore.setState({ settings: { ...fileSettings, transcriptOffset: -1 } });
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      calls.push({ command, args });
      return command === "find_clips_in_media"
        ? { clips: [], sentences: [], fromCache: false, notice: "none" }
        : MODELS;
    });
    await act(async () => auto().start());
    await waitFor(() => expect(auto().status).toBe("ready"));
    const sent = calls.find((c) => c.command === "find_clips_in_media")!.args as {
      request: { transcript: unknown; model: string };
    };
    expect(sent.request.transcript).toEqual({ path: INFO.path, offset: -1 });
    expect(sent.request.model).toBe("");
    expect(calls.some((c) => /download/.test(c.command))).toBe(false);
  });
});

describe("transcripts next to the video", () => {
  const other: TranscriptInfo = {
    ...INFO,
    path: "/m/talk.srt",
    name: "talk.srt",
    format: "SubRip (.srt)",
    wordLevel: false,
  };
  const near = (answer: unknown) =>
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      calls.push({ command, args });
      if (command === "find_transcripts_near") {
        if (answer instanceof Error) throw answer.message;
        return answer;
      }
      return command === "whisper_models" ? MODELS : null;
    });
  const open = () => {
    useAutoClipsStore.setState({ open: true, step: 1, clipId: "talk" });
    render(<AutoClipsWizard />);
  };

  it("asks only about the video's own path", async () => {
    near([INFO, other]);
    open();
    await screen.findByText(/next to the video/);
    const ask = calls.find((c) => c.command === "find_transcripts_near")!;
    expect(ask.args).toEqual({ path: "/m/talk.mp4" });
  });

  it("only suggests: Whisper stays selected until the user presses Use", async () => {
    near([INFO, other]);
    open();
    const hint = await screen.findByText(/next to the video \(and 1 more\)/);
    expect(hint).toHaveTextContent("Found talk.json3 next to the video (and 1 more)");
    expect(auto().settings.source).toBe("whisper");
    expect(auto().settings.transcript).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Use talk.json3/ }));
    expect(auto().settings.source).toBe("file");
    expect(auto().settings.transcript).toEqual(INFO);
    // the chosen file is shown, and the user can switch to the other one
    const pick = await screen.findByLabelText("Transcript files next to the video");
    fireEvent.change(pick, { target: { value: other.path } });
    expect(auto().settings.transcript?.name).toBe("talk.srt");
  });

  it("shows nothing and no error when nothing is found or the folder cannot be read", async () => {
    near([]);
    open();
    await waitFor(() => expect(calls.some((c) => c.command === "find_transcripts_near")).toBe(true));
    expect(screen.queryByText(/next to the video/)).toBeNull();
    cleanup();
    near(new Error("the folder cannot be read"));
    open();
    await waitFor(() => expect(calls.filter((c) => c.command === "find_transcripts_near")).toHaveLength(2));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("radio", { name: "Import file" })).toBeEnabled();
  });
});
