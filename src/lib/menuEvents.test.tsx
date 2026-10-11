import { act, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import App from "@/App";
import { useProjectStore } from "@/store/project";
import { useUiStore } from "@/store/ui";

const handlers = new Map<string, (e: { payload: unknown }) => void>();
const menu = (id: string) => act(async () => handlers.get("menu-action")!({ payload: id }));

beforeEach(() => {
  handlers.clear();
  vi.mocked(listen).mockImplementation((async (name: string, cb: (e: { payload: unknown }) => void) => {
    handlers.set(name, cb);
    return () => handlers.delete(name);
  }) as unknown as typeof listen);
  vi.mocked(invoke).mockReset();
  useProjectStore.getState().newProject();
  useUiStore.setState({ dialog: null, newProjectOpen: false, canvasDialogOpen: false });
});

describe("native File menu", () => {
  it("New Project opens the canvas dialog", async () => {
    render(<App />);
    await waitFor(() => expect(handlers.has("menu-action")).toBe(true));
    await menu("new-project");
    expect(await screen.findByRole("dialog", { name: "New project" })).toBeInTheDocument();
  });

  it("Open Project and Save call the same backend flows as the in-app menu", async () => {
    vi.mocked(invoke).mockImplementation((async (cmd: string) =>
      cmd === "save_project" ? "/p/x.cutvii" : null) as typeof invoke);
    render(<App />);
    await waitFor(() => expect(handlers.has("menu-action")).toBe(true));

    await menu("open-project");
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("open_project", undefined));

    await menu("save-project");
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("save_project", expect.objectContaining({ saveAs: false })),
    );
    await menu("save-project-as");
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("save_project", expect.objectContaining({ saveAs: true })),
    );
  });

  it("ignores ids it does not know", async () => {
    render(<App />);
    await waitFor(() => expect(handlers.has("menu-action")).toBe(true));
    await menu("format-disk");
    expect(invoke).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("About", () => {
  it("opens CutVii's own About window from the app menu, with the tagline centred and nothing else", async () => {
    const { act, fireEvent, render, screen } = await import("@testing-library/react");
    const { AboutDialog, TAGLINE } = await import("@/components/AboutDialog");
    const { useUiStore } = await import("@/store/ui");
    const { listen } = await import("@tauri-apps/api/event");
    const { onMenuAction } = await import("./menuEvents");
    useUiStore.setState({ aboutOpen: false });
    let handler: ((e: { payload: string }) => void) | undefined;
    vi.mocked(listen).mockImplementation((async (_name: string, cb: (e: { payload: string }) => void) => {
      handler = cb;
      return () => {};
    }) as never);
    await onMenuAction();
    render(<AboutDialog />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    act(() => handler?.({ payload: "about" }));
    const dialog = screen.getByRole("dialog", { name: "CutVii" });
    expect(TAGLINE).toBe("Creative editing. Flexible workflow. On-device AI.");
    expect(screen.getByText(TAGLINE)).toBeInTheDocument();
    expect(dialog.className).toContain("text-center");
    expect(dialog).toHaveTextContent(/Version \d+\.\d+\.\d+/);
    expect(dialog).not.toHaveTextContent(/never leaves your computer|works offline/);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    act(() => handler?.({ payload: "about" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(useUiStore.getState().aboutOpen).toBe(false);
  });
});
