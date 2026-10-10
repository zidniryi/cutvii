import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import App from "@/App";
import { createProject } from "@/project/factory";
import { useTemplateStore } from "@/store/canvasTemplates";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useUiStore } from "@/store/ui";

const invokeMock = vi.mocked(invoke);
const state = () => useProjectStore.getState();
const settings = () => state().project.settings;

beforeEach(() => {
  invokeMock.mockReset();
  localStorage.clear();
  useTemplateStore.setState({ templates: [] });
  useProjectStore.getState().newProject();
  useSelectionStore.setState({ selectedClipIds: [] });
  usePlaybackStore.setState({ playhead: 0, playing: false, mediaErrors: {} });
  useUiStore.setState({
    dialog: null,
    notice: null,
    canvasNotice: null,
    newProjectOpen: false,
    canvasDialogOpen: false,
  });
});

async function openNewProject() {
  await userEvent.click(screen.getByRole("button", { name: "File menu" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "New project" }));
  return screen.findByRole("dialog", { name: "New project" });
}

describe("New project dialog", () => {
  it("platform templates fill only width, height and fps", async () => {
    invokeMock.mockResolvedValue(undefined);
    render(<App />);
    const dialog = await openNewProject();

    for (const [name, w, h] of [
      ["Reel / TikTok / Story", 1080, 1920],
      ["YouTube", 1920, 1080],
      ["Instagram Post", 1080, 1350],
      ["Square", 1080, 1080],
    ] as const) {
      await userEvent.click(within(dialog).getByRole("radio", { name: new RegExp(name) }));
      expect(within(dialog).getByText(`${w}×${h} · 30 fps`)).toBeInTheDocument();
    }

    await userEvent.click(within(dialog).getByRole("radio", { name: /Instagram Post/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Create project" }));
    await waitFor(() =>
      expect(settings()).toMatchObject({ width: 1080, height: 1350, fps: 30, backgroundColor: "#000000" }),
    );
    expect(settings().canvasPending).toBeUndefined();
    expect(screen.getByRole("button", { name: "Canvas: 1080×1350 · 30 fps" })).toBeInTheDocument();
  });

  it("Original creates a project whose canvas waits for the first video", async () => {
    invokeMock.mockResolvedValue(undefined);
    render(<App />);
    const dialog = await openNewProject();
    await userEvent.click(within(dialog).getByRole("radio", { name: /Original/ }));
    expect(within(dialog).getByText("Canvas follows the first video you add")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Create project" }));

    await waitFor(() => expect(settings().canvasPending).toBe(true));
    expect(screen.getByRole("button", { name: /Canvas: Original/ })).toBeInTheDocument();
  });

  it("Custom: shows clear errors, blocks Create, and keeps the aspect ratio when locked", async () => {
    invokeMock.mockResolvedValue(undefined);
    render(<App />);
    const dialog = await openNewProject();
    await userEvent.click(within(dialog).getByRole("radio", { name: /Custom/ }));

    const width = within(dialog).getByLabelText("Width");
    const height = within(dialog).getByLabelText("Height");
    const fps = within(dialog).getByLabelText("Frame rate");
    const create = within(dialog).getByRole("button", { name: "Create project" });

    await userEvent.clear(width);
    await userEvent.type(width, "1081");
    expect(within(dialog).getByText("Width must be an even number")).toBeInTheDocument();
    expect(width).toHaveAttribute("aria-invalid", "true");
    expect(create).toBeDisabled();

    await userEvent.clear(width);
    await userEvent.type(width, "10");
    expect(within(dialog).getByText("Width must be between 16 and 8192 px")).toBeInTheDocument();

    await userEvent.clear(fps);
    await userEvent.type(fps, "240");
    expect(within(dialog).getByText("Frame rate must be between 1 and 120")).toBeInTheDocument();

    // fix everything with the lock on: 16:9 stays 16:9
    await userEvent.clear(fps);
    await userEvent.type(fps, "29.97");
    await userEvent.clear(width);
    await userEvent.type(width, "1920");
    await userEvent.clear(height);
    await userEvent.type(height, "1080");
    await userEvent.click(within(dialog).getByRole("button", { name: "Lock aspect ratio" }));
    await userEvent.clear(width);
    await userEvent.type(width, "1280");
    expect(height).toHaveValue("720");
    expect(create).toBeEnabled();

    await userEvent.click(create);
    await waitFor(() =>
      expect(settings()).toMatchObject({ width: 1280, height: 720, fpsNum: 30000, fpsDen: 1001 }),
    );
    expect(settings().fps).toBe(30000 / 1001);
  });

  it("Save as template stores it locally and offers it next time", async () => {
    invokeMock.mockResolvedValue(undefined);
    const { unmount } = render(<App />);
    let dialog = await openNewProject();
    await userEvent.click(within(dialog).getByRole("radio", { name: /Custom/ }));
    const width = within(dialog).getByLabelText("Width");
    await userEvent.clear(width);
    await userEvent.type(width, "1000");
    await userEvent.clear(within(dialog).getByLabelText("Height"));
    await userEvent.type(within(dialog).getByLabelText("Height"), "1000");

    await userEvent.type(within(dialog).getByLabelText("Save as template"), "Podcast cover");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(within(dialog).getByRole("status")).toHaveTextContent("Saved “Podcast cover”");
    expect(within(dialog).getByRole("radio", { name: /Podcast cover/ })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("cutvii.canvasTemplates.v1")!)[0]).toMatchObject({
      name: "Podcast cover",
      width: 1000,
      height: 1000,
      fps: 30,
    });

    // a fresh session reads it back from local storage
    unmount();
    useTemplateStore.setState({ templates: [] });
    const { loadTemplates } = await import("@/store/canvasTemplates");
    useTemplateStore.setState({ templates: loadTemplates() });
    render(<App />);
    dialog = await openNewProject();
    await userEvent.click(within(dialog).getByRole("radio", { name: /Podcast cover/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(settings()).toMatchObject({ width: 1000, height: 1000 }));
  });

  it("cancel leaves the current project alone", async () => {
    invokeMock.mockResolvedValue(undefined);
    render(<App />);
    const before = state().project;
    const dialog = await openNewProject();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "New project" })).not.toBeInTheDocument();
    expect(state().project).toBe(before);
  });
});

describe("Original canvas applied by the first media", () => {
  function pendingProject() {
    useProjectStore.getState().newProject(undefined, { canvasPending: true });
  }
  const importReturns = (...imported: unknown[]) => invokeMock.mockResolvedValue({ imported, failed: [] });

  it("first video sets the canvas (rotation and exact fps included) and the notice offers Undo", async () => {
    pendingProject();
    // already rotated by the probe: stored 1920x1080 with 90° metadata
    importReturns({
      path: "/m/phone.mp4",
      mediaType: "video",
      duration: 8,
      width: 1080,
      height: 1920,
      fpsNum: 30000,
      fpsDen: 1001,
    });
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Import media" }));
    await screen.findByText("phone.mp4");
    expect(settings()).toMatchObject({ width: 1080, height: 1920, fpsNum: 30000, fpsDen: 1001 });
    expect(settings().canvasPending).toBeUndefined();

    const notice = screen.getByText(/Canvas set to 1080×1920 · 29.97 fps from your first video/);
    expect(notice).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Canvas: 1080×1920 · 29.97 fps" })).toBeInTheDocument();

    // Undo reverts the canvas only; the media stays
    await userEvent.click(
      screen
        .getByRole("button", { name: "Undo", description: "" })
        .closest("[role=status]")!
        .querySelector("button")!,
    );
    expect(settings()).toMatchObject({ width: 1920, height: 1080, fps: 30, canvasPending: true });
    expect(state().project.assets).toHaveLength(1);
    expect(screen.queryByText(/Canvas set to/)).not.toBeInTheDocument();
  });

  it("odd dimensions are rounded down to even, and the notice says so", async () => {
    pendingProject();
    importReturns({
      path: "/m/odd.mp4",
      mediaType: "video",
      duration: 3,
      width: 1081,
      height: 607,
      fpsNum: 25,
      fpsDen: 1,
    });
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Import media" }));
    await screen.findByText("odd.mp4");
    expect(settings()).toMatchObject({ width: 1080, height: 606, fps: 25 });
    expect(screen.getByText(/odd size 1081×607 rounded down to even/)).toBeInTheDocument();
  });

  it("an image first falls back to 1920x1080 @ 30 and tells the user", async () => {
    pendingProject();
    importReturns({ path: "/m/photo.png", mediaType: "image", width: 4000, height: 3000 });
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Import media" }));
    await screen.findByText("photo.png");

    expect(settings()).toMatchObject({ width: 1920, height: 1080, fps: 30 });
    expect(settings().canvasPending).toBeUndefined();
    expect(
      screen.getByText(/The first media is an image, not a video, so the canvas is 1920×1080 · 30 fps/),
    ).toBeInTheDocument();
  });

  it("later imports never touch an already-decided canvas", async () => {
    pendingProject();
    importReturns({
      path: "/m/a.mp4",
      mediaType: "video",
      duration: 3,
      width: 1280,
      height: 720,
      fpsNum: 30,
      fpsDen: 1,
    });
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Import media" }));
    await screen.findByText("a.mp4");

    importReturns({
      path: "/m/b.mp4",
      mediaType: "video",
      duration: 3,
      width: 1080,
      height: 1920,
      fpsNum: 60,
      fpsDen: 1,
    });
    await userEvent.click(screen.getByRole("button", { name: "Import media" }));
    await screen.findByText("b.mp4");
    expect(settings()).toMatchObject({ width: 1280, height: 720, fps: 30 });
  });

  it("a normal (non-Original) project is never changed by imports", async () => {
    state().newProject(undefined, { width: 1080, height: 1080 });
    importReturns({
      path: "/m/a.mp4",
      mediaType: "video",
      duration: 3,
      width: 1920,
      height: 1080,
      fpsNum: 30,
      fpsDen: 1,
    });
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Import media" }));
    await screen.findByText("a.mp4");
    expect(settings()).toMatchObject({ width: 1080, height: 1080 });
    expect(useUiStore.getState().canvasNotice).toBeNull();
  });

  it("the notice drops its Undo once something else has been edited", async () => {
    pendingProject();
    importReturns({
      path: "/m/a.mp4",
      mediaType: "video",
      duration: 4,
      width: 1280,
      height: 720,
      fpsNum: 30,
      fpsDen: 1,
    });
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Import media" }));
    await screen.findByText("a.mp4");
    const banner = screen.getByText(/Canvas set to/).closest("[role=status]") as HTMLElement;
    expect(within(banner).getByRole("button", { name: "Undo" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Add a.mp4 to timeline" }));
    expect(within(banner).queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
  });
});

describe("Top-bar canvas menu", () => {
  it("changes the canvas as exactly one undoable action", async () => {
    render(<App />);
    const before = state().past.length;
    await userEvent.click(screen.getByRole("button", { name: /^Canvas: 1920×1080/ }));
    const dialog = await screen.findByRole("dialog", { name: "Canvas" });
    await userEvent.click(within(dialog).getByRole("radio", { name: /Reel/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Apply" }));

    expect(settings()).toMatchObject({ width: 1080, height: 1920 });
    expect(state().past).toHaveLength(before + 1);
    expect(state().past.at(-1)?.label).toBe("Change canvas");

    await act(async () => state().undo());
    expect(settings()).toMatchObject({ width: 1920, height: 1080 });
    expect(state().past).toHaveLength(before);
  });

  it("Original follows the first video already in the project", async () => {
    state().addAsset({
      id: "v",
      path: "/m/v.mp4",
      type: "video",
      duration: 5,
      width: 720,
      height: 1280,
      fpsNum: 24000,
      fpsDen: 1001,
    });
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: /^Canvas:/ }));
    const dialog = await screen.findByRole("dialog", { name: "Canvas" });
    await userEvent.click(within(dialog).getByRole("radio", { name: /Original/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    expect(settings()).toMatchObject({ width: 720, height: 1280, fpsNum: 24000, fpsDen: 1001 });
  });

  it("validates custom values and blocks Apply while invalid", async () => {
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: /^Canvas:/ }));
    const dialog = await screen.findByRole("dialog", { name: "Canvas" });
    const width = within(dialog).getByLabelText("Width");
    await userEvent.clear(width);
    await userEvent.type(width, "9000");
    expect(within(dialog).getByText("Width must be between 16 and 8192 px")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Apply" })).toBeDisabled();
    fireEvent.keyDown(dialog.parentElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Canvas" })).not.toBeInTheDocument();
    expect(settings().width).toBe(createProject().settings.width);
  });
});
