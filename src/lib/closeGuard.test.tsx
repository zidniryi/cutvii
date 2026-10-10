import { getCurrentWindow } from "@tauri-apps/api/window";
import { render, screen, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "@/App";
import { useProjectStore } from "@/store/project";
import { useUiStore } from "@/store/ui";
import { createProject } from "@/project/factory";
import { IDS, makeProject } from "@/test/makeProject";
import { addAssetToTimeline } from "@/timeline/editor";

type Handler = (e: { preventDefault: () => void }) => Promise<void>;
let handler: Handler;
const destroy = vi.fn();

beforeEach(() => {
  destroy.mockReset();
  vi.mocked(getCurrentWindow).mockReturnValue({
    onCloseRequested: vi.fn(async (cb: Handler) => {
      handler = cb;
      return () => {};
    }),
    destroy,
  } as unknown as ReturnType<typeof getCurrentWindow>);
  useUiStore.setState({ dialog: null });
  useProjectStore.getState().newProject();
  useProjectStore.setState({ project: makeProject() });
  useProjectStore.setState({ saved: useProjectStore.getState().project });
});

async function mountApp() {
  render(<App />);
  await vi.waitFor(() => expect(handler).toBeTypeOf("function"));
}

describe("close guard", () => {
  it("lets a clean project close without asking", async () => {
    await mountApp();
    const preventDefault = vi.fn();
    await handler({ preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("asks first when there are unsaved changes; cancel keeps the window, confirm closes it", async () => {
    await mountApp();
    act(() => void addAssetToTimeline(IDS.vid));

    const preventDefault = vi.fn();
    let closing!: Promise<void>;
    act(() => {
      closing = handler({ preventDefault });
    });
    expect(preventDefault).toHaveBeenCalled();
    let dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Quit without saving?");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await closing;
    expect(destroy).not.toHaveBeenCalled();

    act(() => {
      closing = handler({ preventDefault });
    });
    dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Quit without saving" }));
    await closing;
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("new project state is clean", () => {
    useProjectStore.getState().newProject();
    expect(useProjectStore.getState().project).toBe(useProjectStore.getState().saved);
    expect(createProject().assets).toHaveLength(0);
  });
});
