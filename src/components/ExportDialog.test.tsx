import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import App from "@/App";
import { useExportStore } from "@/store/export";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { IDS, makeProject } from "@/test/makeProject";
import { addAssetToTimeline } from "@/timeline/editor";

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);
let progressHandler: ((e: { payload: { fraction: number } }) => void) | null = null;
let unlisten: ReturnType<typeof vi.fn>;

type Handler = (args?: Record<string, unknown>) => unknown;
function backend(handlers: Record<string, Handler>) {
  invokeMock.mockImplementation(async (cmd, args) => {
    const h = handlers[cmd];
    if (!h) throw new Error(`unexpected command ${cmd}`);
    return h(args as Record<string, unknown> | undefined);
  });
}
const report = {
  path: "/out/Test.mp4",
  duration: 10,
  width: 1280,
  height: 720,
  hasAudio: true,
  sizeBytes: 3 * 1024 * 1024,
  encoder: "libx264",
};

async function openDialog() {
  await userEvent.click(screen.getByRole("button", { name: /^Export$/ }));
  return screen.getByRole("dialog", { name: "Export" });
}

beforeEach(() => {
  invokeMock.mockReset();
  progressHandler = null;
  unlisten = vi.fn();
  listenMock.mockImplementation((async (_name: string, cb: typeof progressHandler) => {
    progressHandler = cb;
    return unlisten;
  }) as unknown as typeof listen);
  useExportStore.setState({
    phase: "closed",
    progress: 0,
    report: null,
    error: null,
    cancelling: false,
    session: 0,
  });
  useProjectStore.setState({ project: makeProject(), past: [], future: [] });
  useSelectionStore.setState({ selectedClipIds: [] });
});

describe("Export dialog", () => {
  it("is unavailable until there is something on the timeline", () => {
    render(<App />);
    expect(screen.getByRole("button", { name: /^Export$/ })).toBeDisabled();
    act(() => void addAssetToTimeline(IDS.vid));
    expect(screen.getByRole("button", { name: /^Export$/ })).toBeEnabled();
  });

  it("sends the chosen options and project, shows progress, then the verified result", async () => {
    let finish!: (r: unknown) => void;
    backend({ export_project: () => new Promise((r) => (finish = r)) });
    render(<App />);
    act(() => void addAssetToTimeline(IDS.vid));
    const dialog = await openDialog();

    const pick = (group: string, name: RegExp) =>
      userEvent.click(
        within(within(dialog).getByRole("radiogroup", { name: group })).getByRole("radio", { name }),
      );
    await pick("Resolution", /^720p/);
    await pick("Frame rate", /^24 fps/);
    await pick("Quality", /^High/);
    expect(within(dialog).getByTestId("export-summary")).toHaveTextContent("1280×720 · 24 fps");

    await userEvent.click(within(dialog).getByRole("button", { name: "Export…" }));
    expect(invokeMock).toHaveBeenCalledWith("export_project", {
      project: useProjectStore.getState().project,
      options: { width: 1280, height: 720, fps: 24, quality: "high", format: "mp4" },
    });

    expect(await screen.findByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
    act(() => progressHandler!({ payload: { fraction: 0.42 } }));
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "42");
    expect(screen.getByText("Rendering… 42%")).toBeInTheDocument();

    await act(async () => finish(report));
    expect(await screen.findByText("Export complete and verified.")).toBeInTheDocument();
    expect(screen.getByText("/out/Test.mp4")).toBeInTheDocument();
    expect(screen.getByText(/1280×720 · 0:10 · 3\.0 MB · libx264/)).toBeInTheDocument();
    expect(unlisten).toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog", { name: "Export" })).not.toBeInTheDocument();
  });

  it("cancels a running export and returns to the settings", async () => {
    let fail!: (e: unknown) => void;
    backend({
      export_project: () => new Promise((_, rej) => (fail = rej)),
      cancel_export: () => {
        fail("export cancelled");
      },
    });
    render(<App />);
    act(() => void addAssetToTimeline(IDS.vid));
    const dialog = await openDialog();
    await userEvent.click(within(dialog).getByRole("button", { name: "Export…" }));

    await userEvent.click(await screen.findByRole("button", { name: "Cancel export" }));
    expect(invokeMock).toHaveBeenCalledWith("cancel_export");
    await waitFor(() => expect(screen.getByRole("button", { name: "Export…" })).toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(); // a cancel is not an error
  });

  it("returns quietly to the settings when the save dialog is dismissed", async () => {
    backend({ export_project: () => null });
    render(<App />);
    act(() => void addAssetToTimeline(IDS.vid));
    await userEvent.click(within(await openDialog()).getByRole("button", { name: "Export…" }));

    expect(await screen.findByRole("button", { name: "Export…" })).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the failure reason and can go back to adjust settings", async () => {
    backend({
      export_project: () => {
        throw "media file is missing: /m/vid.mp4";
      },
    });
    render(<App />);
    act(() => void addAssetToTimeline(IDS.vid));
    await userEvent.click(within(await openDialog()).getByRole("button", { name: "Export…" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The export did not finish.");
    expect(alert).toHaveTextContent("media file is missing: /m/vid.mp4");
    expect(alert).toHaveTextContent("left untouched");

    await userEvent.click(screen.getByRole("button", { name: "Back to settings" }));
    expect(screen.getByRole("radiogroup", { name: "Resolution" })).toBeInTheDocument();
  });

  it("closes with Escape while idle but not while rendering", async () => {
    backend({ export_project: () => new Promise(() => {}) });
    render(<App />);
    act(() => void addAssetToTimeline(IDS.vid));
    await openDialog();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Export" })).not.toBeInTheDocument();

    await userEvent.click(within(await openDialog()).getByRole("button", { name: "Export…" }));
    await screen.findByRole("progressbar");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Export" })).toBeInTheDocument();
  });

  it("exports audio only: video settings disappear and the format is sent", async () => {
    backend({
      export_project: () => ({ ...report, path: "/out/Test.m4a", width: 0, height: 0, encoder: "aac" }),
    });
    render(<App />);
    act(() => void addAssetToTimeline(IDS.vid));
    const dialog = await openDialog();

    await userEvent.click(within(dialog).getByRole("radio", { name: /^Audio, M4A/ }));
    expect(within(dialog).queryByRole("radiogroup", { name: "Resolution" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("radiogroup", { name: "Quality" })).not.toBeInTheDocument();
    expect(within(dialog).getByTestId("export-summary")).toHaveTextContent("M4A · AAC 192 kb/s");

    await userEvent.click(within(dialog).getByRole("button", { name: "Export…" }));
    expect(invokeMock).toHaveBeenCalledWith(
      "export_project",
      expect.objectContaining({ options: expect.objectContaining({ format: "m4a" }) }),
    );
    expect(await screen.findByText("Export complete and verified.")).toBeInTheDocument();
    expect(screen.getByText(/Audio · 0:10 · 3\.0 MB · aac/)).toBeInTheDocument();
  });

  it("offers WAV and returns to video settings when switching back", async () => {
    render(<App />);
    act(() => void addAssetToTimeline(IDS.vid));
    const dialog = await openDialog();
    await userEvent.click(within(dialog).getByRole("radio", { name: /lossless/ }));
    expect(within(dialog).getByTestId("export-summary")).toHaveTextContent("WAV · 16-bit PCM");
    await userEvent.click(within(dialog).getByRole("radio", { name: /^Video, MP4/ }));
    expect(within(dialog).getByRole("radiogroup", { name: "Resolution" })).toBeInTheDocument();
  });

  it("Open folder asks Rust to reveal the exported file, and shows why if it cannot", async () => {
    let reveals = 0;
    backend({
      export_project: () => report,
      reveal_last_export: () => {
        reveals += 1;
        if (reveals === 2) throw "the exported file is no longer there (moved or deleted)";
      },
    });
    render(<App />);
    act(() => void addAssetToTimeline(IDS.vid));
    await userEvent.click(within(await openDialog()).getByRole("button", { name: "Export…" }));
    await screen.findByText("Export complete and verified.");

    await userEvent.click(screen.getByRole("button", { name: "Open folder" }));
    expect(invokeMock).toHaveBeenCalledWith("reveal_last_export"); // no path is sent from the webview
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Open folder" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("no longer there");
  });
});
