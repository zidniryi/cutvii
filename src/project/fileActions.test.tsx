import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import fixture from "../../fixtures/project-v8.json";
import App from "@/App";
import { createProject } from "@/project/factory";
import type { Project } from "@/project/model";
import { usePlaybackStore } from "@/store/playback";
import { selectIsDirty, useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useUiStore } from "@/store/ui";
import { IDS, makeProject } from "@/test/makeProject";
import { addAssetToTimeline, splitAtPlayhead, trimClipEdge } from "@/timeline/editor";

const mocked = vi.mocked(invoke);
type Handlers = Record<string, (args?: Record<string, unknown>) => unknown>;
function backend(handlers: Handlers) {
  mocked.mockImplementation(async (cmd, args) => {
    const h = handlers[cmd];
    if (!h) throw new Error(`unexpected command ${cmd}`);
    return h(args as Record<string, unknown> | undefined);
  });
}
const state = () => useProjectStore.getState();
const clips = (p: Project = state().project) => p.tracks.flatMap((t) => t.clips);

beforeEach(() => {
  mocked.mockReset();
  useProjectStore.getState().newProject();
  useProjectStore.setState({ project: makeProject() });
  useProjectStore.setState({ saved: state().project });
  useSelectionStore.setState({ selectedClipIds: [] });
  usePlaybackStore.setState({ playhead: 0, playing: false, mediaErrors: {} });
  useUiStore.setState({ dialog: null, notice: null });
});

describe("save", () => {
  it("writes the project, then reports clean; later edits are dirty again", async () => {
    backend({ save_project: () => "/p/my.cutvii" });
    render(<App />);
    act(() => void addAssetToTimeline(IDS.vid));
    expect(selectIsDirty(state())).toBe(true);
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();

    const sent = state().project;
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await screen.findByText("Saved · my.cutvii");

    expect(mocked).toHaveBeenCalledWith("save_project", { project: sent, saveAs: false });
    expect(selectIsDirty(state())).toBe(false);
    expect(state().filePath).toBe("/p/my.cutvii");

    act(() => void splitAtPlayhead());
    usePlaybackStore.getState().setPlayhead(3);
    act(() => void splitAtPlayhead());
    expect(selectIsDirty(state())).toBe(true);
  });

  it("edits made while saving stay unsaved; undo back to the saved state is clean", async () => {
    let finish!: (p: string) => void;
    backend({ save_project: () => new Promise<string>((r) => (finish = r)) });
    render(<App />);
    act(() => void addAssetToTimeline(IDS.vid));
    const saving = state().project;

    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    act(() => void trimClipEdge(clips()[0].id, "end", 4)); // edit during the save
    await act(async () => finish("/p/a.cutvii"));

    expect(state().saved).toBe(saving);
    expect(selectIsDirty(state())).toBe(true);
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(selectIsDirty(state())).toBe(false);
  });

  it("does nothing visible when the dialog is cancelled, and explains failures", async () => {
    backend({ save_project: () => null });
    render(<App />);
    act(() => void addAssetToTimeline(IDS.vid));
    await userEvent.click(screen.getByRole("button", { name: "File menu" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /^Save$/ }));
    await waitFor(() => expect(mocked).toHaveBeenCalled());
    expect(selectIsDirty(state())).toBe(true);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

    backend({
      save_project: () => {
        throw "invalid project: unknown asset";
      },
    });
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Could not save the project");
    expect(dialog).toHaveTextContent("invalid project: unknown asset");
    expect(dialog).toHaveTextContent("unchanged on disk");
  });
});

describe("open", () => {
  const opened = (project: unknown, missingPaths: string[] = []) => ({
    path: "/p/opened.cutvii",
    project,
    missingPaths,
  });

  it("round-trips the exact editing state through JSON", async () => {
    render(<App />);
    act(() => void addAssetToTimeline(IDS.vid));
    act(() => void addAssetToTimeline(IDS.aud));
    const first = clips()[0].id;
    act(() => void trimClipEdge(first, "end", 6));
    usePlaybackStore.getState().setPlayhead(2);
    useSelectionStore.getState().setSelection([first]);
    act(() => void splitAtPlayhead());
    const before = state().project;

    const onDisk = JSON.parse(JSON.stringify(before));
    useProjectStore.getState().newProject();
    backend({ open_project: () => opened(onDisk) });
    await userEvent.click(screen.getByRole("button", { name: "File menu" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Open/ }));
    await screen.findByText("Saved · opened.cutvii");

    expect(state().project).toEqual(before);
    expect(state().past).toHaveLength(0); // history does not survive a reload
    expect(selectIsDirty(state())).toBe(false);
  });

  it("flags missing media, offers relink, and relinking is undoable", async () => {
    backend({
      open_project: () => opened(fixture, ["/media/music.mp3"]),
      relink_media: () => ({ path: "/new/music.mp3", mediaType: "audio", duration: 120 }),
    });
    render(<App />);
    fireEvent.keyDown(window, { key: "o", ctrlKey: true });

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Some media files are missing");
    expect(dialog).toHaveTextContent("music.mp3");
    await userEvent.click(within(dialog).getByRole("button", { name: "OK" }));

    const library = screen.getByRole("region", { name: "Media" });
    expect(within(library).getAllByText(/Missing — file not found/)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "music.mp3 clip" })).toHaveAttribute(
      "title",
      expect.stringContaining("not found"),
    );

    await userEvent.click(within(library).getByRole("button", { name: "Relink music.mp3" }));
    await waitFor(() =>
      expect(within(library).queryByText(/Missing — file not found/)).not.toBeInTheDocument(),
    );
    expect(state().project.assets.find((a) => a.id === "asset-audio")).toMatchObject({
      path: "/new/music.mp3",
      duration: 120,
    });
    expect(selectIsDirty(state())).toBe(true);

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(state().project.assets.find((a) => a.id === "asset-audio")!.path).toBe("/media/music.mp3");
    expect(within(library).getAllByText(/Missing — file not found/)).toHaveLength(1);
  });

  it("refuses a bad replacement and keeps the project as it was", async () => {
    backend({
      open_project: () => opened(fixture, ["/media/music.mp3"]),
      relink_media: () => ({ path: "/new/clip.mp4", mediaType: "video", duration: 10 }),
    });
    render(<App />);
    fireEvent.keyDown(window, { key: "o", ctrlKey: true });
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "OK" }));
    const before = state().project;

    await userEvent.click(screen.getByRole("button", { name: "Relink music.mp3" }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent(
      "original is audio but the chosen file is video",
    );
    expect(state().project).toBe(before);
  });

  it("shows a readable message for a file that fails validation", async () => {
    const broken = structuredClone(fixture) as Record<string, unknown>;
    (broken.settings as Record<string, unknown>).fps = -5;
    backend({ open_project: () => opened(broken) });
    render(<App />);
    fireEvent.keyDown(window, { key: "o", ctrlKey: true });

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("can't be opened");
    expect(dialog).toHaveTextContent("settings.fps");
    expect(state().filePath).toBeNull();
  });

  it("shows backend errors (bad JSON, newer version) instead of failing silently", async () => {
    backend({
      open_project: () => {
        throw "this project was saved by a newer CutVii (schema version 9, this app supports up to 1)";
      },
    });
    render(<App />);
    fireEvent.keyDown(window, { key: "o", ctrlKey: true });
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("newer CutVii");
  });

  it("asks before discarding unsaved changes", async () => {
    backend({ open_project: () => opened(fixture) });
    render(<App />);
    act(() => void addAssetToTimeline(IDS.vid));

    fireEvent.keyDown(window, { key: "o", ctrlKey: true });
    let dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Discard unsaved changes?");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    // nothing was opened (the inspector of the new clip may ask Rust for its own things)
    expect(mocked).not.toHaveBeenCalledWith("open_project");
    expect(mocked).not.toHaveBeenCalledWith("open_project", expect.anything());
    expect(clips()).toHaveLength(1);

    fireEvent.keyDown(window, { key: "o", ctrlKey: true });
    dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Discard changes" }));
    await screen.findByText("Saved · opened.cutvii");
    expect(state().project.name).toBe("Fixture project");
  });
});

describe("new project", () => {
  it("starts clean, forgets the file path and resets the session", async () => {
    backend({ forget_project_path: () => undefined });
    useProjectStore.getState().loadProject(createProject("Old"), "/p/old.cutvii", []);
    usePlaybackStore.getState().setPlayhead(9);
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "File menu" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "New project" }));
    await userEvent.click(
      within(await screen.findByRole("dialog", { name: "New project" })).getByRole("button", {
        name: "Create project",
      }),
    );
    await waitFor(() => expect(state().filePath).toBeNull());

    expect(mocked).toHaveBeenCalledWith("forget_project_path", undefined);
    expect(state().project.name).toBe("Untitled project");
    expect(usePlaybackStore.getState().playhead).toBe(0);
    expect(screen.getByText("New project")).toBeInTheDocument();
  });
});
