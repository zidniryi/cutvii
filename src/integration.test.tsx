/**
 * Full user flow through the real UI and stores, with only the Rust boundary mocked:
 * import -> place -> split -> volume -> mute -> save -> keep editing -> reopen -> export.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import App from "@/App";
import { parseProject } from "@/project/parse";
import type { Project } from "@/project/model";
import { usePlaybackStore } from "@/store/playback";
import { selectIsDirty, useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useExportStore } from "@/store/export";
import { useUiStore } from "@/store/ui";

const invokeMock = vi.mocked(invoke);
const state = () => useProjectStore.getState();
const clips = (p: Project = state().project) => p.tracks.flatMap((t) => t.clips);

const VIDEO = { path: "/media/holiday.mp4", mediaType: "video", duration: 8, width: 1920, height: 1080 };
const AUDIO = { path: "/media/score.mp3", mediaType: "audio", duration: 10 };

beforeEach(() => {
  invokeMock.mockReset();
  useProjectStore.getState().newProject();
  useSelectionStore.setState({ selectedClipIds: [] });
  usePlaybackStore.setState({ playhead: 0, playing: false, mediaErrors: {} });
  useExportStore.setState({
    phase: "closed",
    session: 0,
    progress: 0,
    report: null,
    error: null,
    cancelling: false,
  });
  useUiStore.setState({ dialog: null, notice: null, sidePanel: "library" });
});

describe("end-to-end editing session", () => {
  it("import, edit, save, reopen and export keep one consistent, valid project", async () => {
    const saved: { project?: Project } = {};
    const exported: { project?: Project; options?: unknown } = {};

    invokeMock.mockImplementation((async (cmd: string, args?: Record<string, unknown>) => {
      switch (cmd) {
        case "import_media":
          return { imported: [VIDEO, AUDIO], failed: [] };
        case "save_project":
          saved.project = args!.project as Project;
          return "/projects/holiday.cutvii";
        case "open_project":
          return {
            path: "/projects/holiday.cutvii",
            project: JSON.parse(JSON.stringify(saved.project)),
            missingPaths: [],
          };
        case "export_project":
          exported.project = args!.project as Project;
          exported.options = args!.options;
          return {
            path: "/out/holiday.mp4",
            duration: 8,
            width: 1920,
            height: 1080,
            hasAudio: true,
            sizeBytes: 4_000_000,
            encoder: "libx264",
          };
        default:
          return undefined;
      }
    }) as typeof invoke);

    render(<App />);

    // --- import two files and put them on the timeline
    await userEvent.click(screen.getByRole("button", { name: "Import media" }));
    expect(await screen.findByText("holiday.mp4")).toBeInTheDocument();
    expect(screen.getByText("score.mp3")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add holiday.mp4 to timeline" }));
    await userEvent.click(screen.getByRole("button", { name: "Add score.mp3 to timeline" }));
    expect(clips()).toHaveLength(2);

    // --- split the video at 3 s using the keyboard
    const playhead = screen.getByRole("slider", { name: "Playhead position" });
    for (let i = 0; i < 3; i++) fireEvent.keyDown(playhead, { key: "ArrowRight", shiftKey: true });
    expect(usePlaybackStore.getState().playhead).toBeCloseTo(3);
    act(() => useSelectionStore.getState().clear());
    fireEvent.keyDown(document.body, { key: "s" });
    const video = state().project.tracks[0].clips;
    expect(video).toHaveLength(2);
    expect(video[0].sourceOut).toBeCloseTo(3);
    expect(video[1]).toMatchObject({ timelineStart: 3, sourceIn: 3 });

    // --- lower the volume of the second half in the inspector, mute the audio track
    const halves = screen.getAllByRole("button", { name: "holiday.mp4 clip" });
    expect(halves).toHaveLength(2);
    await userEvent.click(halves[1]);
    await userEvent.click(screen.getByRole("tab", { name: "Inspector" }));
    const percent = within(screen.getByRole("region", { name: "Inspector" })).getByLabelText(
      "Volume percent",
    );
    await userEvent.clear(percent);
    await userEvent.type(percent, "40{Enter}");
    expect(state().project.tracks[0].clips[1].volume).toBeCloseTo(0.4);

    await userEvent.click(screen.getByRole("button", { name: "Mute Audio 1" }));
    expect(state().project.tracks[1].muted).toBe(true);

    // --- save: file exists, status is clean, and what was sent is a valid project
    expect(selectIsDirty(state())).toBe(true);
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await screen.findByText("Saved · holiday.cutvii");
    expect(selectIsDirty(state())).toBe(false);
    expect(parseProject(saved.project).ok).toBe(true);
    const onDisk = state().project;

    // --- keep editing, then reopen: unsaved changes are confirmed away and the saved state returns exactly
    fireEvent.keyDown(window, { key: "Home" });
    await userEvent.click(screen.getByRole("button", { name: "Remove score.mp3 from project" }));
    expect(state().project.assets).toHaveLength(1);
    expect(selectIsDirty(state())).toBe(true);

    fireEvent.keyDown(window, { key: "o", ctrlKey: true });
    const confirm = await screen.findByRole("alertdialog");
    await userEvent.click(within(confirm).getByRole("button", { name: "Discard changes" }));
    await screen.findByText("Saved · holiday.cutvii");
    expect(state().project).toEqual(onDisk);
    expect(state().past).toHaveLength(0);
    expect(clips()).toHaveLength(4); // video halves + audio halves (nothing selected: S cuts every clip under the playhead)

    // --- export what was reopened
    await userEvent.click(screen.getByRole("button", { name: /^Export$/ }));
    await userEvent.click(
      within(screen.getByRole("dialog", { name: "Export" })).getByRole("button", { name: "Export…" }),
    );
    expect(await screen.findByText("Export complete and verified.")).toBeInTheDocument();

    expect(exported.options).toMatchObject({
      width: 1920,
      height: 1080,
      fps: 30,
      quality: "standard",
      format: "mp4",
    });
    expect(exported.project).toEqual(onDisk);
    // the volume and mute edits made earlier are exactly what gets rendered
    expect(exported.project!.tracks[0].clips[1].volume).toBeCloseTo(0.4);
    expect(exported.project!.tracks[1].muted).toBe(true);
    await waitFor(() => expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument());
  });
});
