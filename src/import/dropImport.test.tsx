import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import App from "@/App";
import { useImportsStore } from "@/store/imports";
import { useProjectStore } from "@/store/project";
import { usePlaybackStore } from "@/store/playback";
import { useSelectionStore } from "@/store/selection";
import { useUiStore } from "@/store/ui";

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);
const handlers = new Map<string, (e: { payload: unknown }) => void>();
const emit = (name: string, payload: unknown) => act(() => handlers.get(name)!({ payload }));

type Deferred = { resolve: (v: unknown) => void; reject: (e: unknown) => void };
let calls: Map<number, Deferred>;
let order: number[];

const media = (name: string, extra: Record<string, unknown> = {}) => ({
  path: `/drop/${name}`,
  mediaType: "video",
  duration: 5,
  width: 1280,
  height: 720,
  fpsNum: 30,
  fpsDen: 1,
  ...extra,
});

beforeEach(() => {
  handlers.clear();
  calls = new Map();
  order = [];
  listenMock.mockImplementation((async (name: string, cb: (e: { payload: unknown }) => void) => {
    handlers.set(name, cb);
    return () => handlers.delete(name);
  }) as unknown as typeof listen);
  invokeMock.mockReset();
  invokeMock.mockImplementation((async (cmd: string, args?: { id: number }) => {
    if (cmd !== "import_dropped_file") return undefined;
    order.push(args!.id);
    return new Promise<unknown>((resolve, reject) => calls.set(args!.id, { resolve, reject }));
  }) as typeof invoke);

  useProjectStore.getState().newProject();
  useImportsStore.setState({ jobs: [], hovering: false });
  useSelectionStore.setState({ selectedClipIds: [] });
  usePlaybackStore.setState({ playhead: 0, playing: false, mediaErrors: {} });
  useUiStore.setState({ canvasNotice: null, sidePanel: "library", dialog: null, notice: null });
});

const settle = async () => act(async () => void (await Promise.resolve()));

describe("OS drag & drop into the library", () => {
  it("shows a drop overlay while dragging and hides it afterwards", async () => {
    render(<App />);
    await waitFor(() => expect(handlers.has("file-drop-hover")).toBe(true));
    expect(screen.queryByTestId("drop-overlay")).not.toBeInTheDocument();
    emit("file-drop-hover", { active: true });
    expect(screen.getByTestId("drop-overlay")).toHaveTextContent("Drop files to import");
    emit("file-drop-hover", { active: false });
    expect(screen.queryByTestId("drop-overlay")).not.toBeInTheDocument();
  });

  it("creates placeholder cards at once, reads two at a time, and swaps in real cards in drop order", async () => {
    render(<App />);
    await waitFor(() => expect(handlers.has("files-dropped")).toBe(true));
    emit("files-dropped", {
      files: [
        { id: 1, name: "one.mp4" },
        { id: 2, name: "two.mp4" },
        { id: 3, name: "three.mp4" },
      ],
      x: 0,
      y: 0,
    });

    const cards = () => screen.getAllByTestId("import-placeholder");
    expect(cards()).toHaveLength(3);
    expect(cards().map((c) => c.dataset.state)).toEqual(["reading", "reading", "queued"]);
    expect(within(cards()[2]).getByText("Waiting…")).toBeInTheDocument();
    expect(order).toEqual([1, 2]); // only two reads started

    // the second file finishes first: nothing is committed out of order
    await act(async () => calls.get(2)!.resolve(media("two.mp4")));
    expect(screen.queryByText("two.mp4", { selector: "p[title]" })).toBeInTheDocument();
    expect(useProjectStore.getState().project.assets).toHaveLength(0);
    expect(order).toEqual([1, 2, 3]); // and the freed slot started the third

    await act(async () => calls.get(1)!.resolve(media("one.mp4")));
    await act(async () => calls.get(3)!.resolve(media("three.mp4")));

    await waitFor(() => expect(screen.queryAllByTestId("import-placeholder")).toHaveLength(0));
    expect(useProjectStore.getState().project.assets.map((a) => a.path)).toEqual([
      "/drop/one.mp4",
      "/drop/two.mp4",
      "/drop/three.mp4",
    ]);
    expect(screen.getByRole("list", { name: "Media files" })).toBeInTheDocument();
  });

  it("explains unsupported files and keeps the rest of the drop going", async () => {
    render(<App />);
    await waitFor(() => expect(handlers.has("files-dropped")).toBe(true));
    emit("files-dropped", {
      files: [
        { id: 11, name: "notes.docx" },
        { id: 12, name: "ok.mp4" },
      ],
      x: 0,
      y: 0,
    });

    await act(async () =>
      calls.get(11)!.reject("“notes.docx” is not a supported file type (.docx). Supported: mp4, mov, mkv."),
    );
    await act(async () => calls.get(12)!.resolve(media("ok.mp4")));

    const card = await screen.findByTestId("import-placeholder");
    expect(card.dataset.state).toBe("failed");
    expect(card).toHaveTextContent("notes.docx");
    expect(card).toHaveTextContent("is not a supported file type (.docx)");
    expect(useProjectStore.getState().project.assets.map((a) => a.path)).toEqual(["/drop/ok.mp4"]);

    await userEvent.click(within(card).getByRole("button", { name: "Dismiss notes.docx" }));
    expect(screen.queryByTestId("import-placeholder")).not.toBeInTheDocument();
  });

  it("skips a file that is already in the project and says so", async () => {
    render(<App />);
    await waitFor(() => expect(handlers.has("files-dropped")).toBe(true));
    useProjectStore.getState().addAsset({ id: "x", path: "/drop/same.mp4", type: "video", duration: 5 });

    emit("files-dropped", { files: [{ id: 21, name: "same.mp4" }], x: 0, y: 0 });
    await act(async () => calls.get(21)!.resolve(media("same.mp4")));

    const card = await screen.findByTestId("import-placeholder");
    expect(card.dataset.state).toBe("skipped");
    expect(card).toHaveTextContent("Already in the project");
    expect(useProjectStore.getState().project.assets).toHaveLength(1);
  });

  it("the first dropped file decides an Original canvas, once, with an Undo notice", async () => {
    useProjectStore.getState().newProject(undefined, { canvasPending: true });
    render(<App />);
    await waitFor(() => expect(handlers.has("files-dropped")).toBe(true));
    emit("files-dropped", {
      files: [
        { id: 31, name: "portrait.mp4" },
        { id: 32, name: "wide.mp4" },
      ],
      x: 0,
      y: 0,
    });
    // the second file is read first, yet the first dropped one still wins
    await act(async () => calls.get(32)!.resolve(media("wide.mp4", { width: 1920, height: 1080 })));
    await act(async () => calls.get(31)!.resolve(media("portrait.mp4", { width: 1080, height: 1920 })));

    await waitFor(() => expect(useProjectStore.getState().project.settings.width).toBe(1080));
    const s = useProjectStore.getState().project.settings;
    expect(s).toMatchObject({ width: 1080, height: 1920 });
    expect(s.canvasPending).toBeUndefined();
    expect(screen.getByText(/Canvas set to 1080×1920 · 30 fps from your first video/)).toBeInTheDocument();
  });

  it("ignores an empty drop and does not block the rest of the UI while reading", async () => {
    render(<App />);
    await waitFor(() => expect(handlers.has("files-dropped")).toBe(true));
    emit("files-dropped", { files: [], x: 0, y: 0 });
    expect(screen.queryAllByTestId("import-placeholder")).toHaveLength(0);

    emit("files-dropped", { files: [{ id: 41, name: "slow.mp4" }], x: 0, y: 0 });
    // the app stays interactive while the file is being read
    await userEvent.click(screen.getByRole("tab", { name: "Inspector" }));
    expect(useUiStore.getState().sidePanel).toBe("inspector");
    await act(async () => calls.get(41)!.resolve(media("slow.mp4")));
    await settle();
    expect(useProjectStore.getState().project.assets).toHaveLength(1);
  });

  it("a drop switches the narrow layout to the Media tab", async () => {
    useUiStore.setState({ sidePanel: "inspector" });
    render(<App />);
    await waitFor(() => expect(handlers.has("files-dropped")).toBe(true));
    emit("file-drop-hover", { active: true });
    expect(useUiStore.getState().sidePanel).toBe("library");
    emit("file-drop-hover", { active: false });
  });
});
