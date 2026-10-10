import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { useProjectStore } from "./store/project";
import { useUiStore } from "./store/ui";
import { createProject } from "./project/factory";
import { makeProject } from "./test/makeProject";
import { addAssetToTimeline } from "./timeline/editor";

beforeEach(() => {
  useUiStore.setState({ sidePanel: "library" });
  useProjectStore.setState({ project: createProject(), past: [], future: [] });
});

describe("app shell", () => {
  it("renders every region with an empty state", () => {
    render(<App />);
    for (const name of ["Media", "Preview", "Inspector", "Timeline"]) {
      expect(screen.getByRole("region", { name })).toBeInTheDocument();
    }
    expect(screen.getByText("No media yet")).toBeInTheDocument();
    expect(screen.getByText("Nothing selected")).toBeInTheDocument();
  });

  it("disables unimplemented controls instead of faking them", () => {
    render(<App />);
    expect(screen.getByRole("button", { name: /export/i })).toBeDisabled(); // empty timeline
    expect(screen.getByRole("button", { name: /^Canvas: 1920×1080 · 30 fps$/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled(); // nothing to undo yet
  });

  it("switches side panel tabs", async () => {
    render(<App />);
    await userEvent.click(screen.getByRole("tab", { name: "Inspector" }));
    expect(useUiStore.getState().sidePanel).toBe("inspector");
    expect(screen.getByRole("tab", { name: "Inspector" })).toHaveAttribute("aria-selected", "true");
  });

  it("top bar undo/redo reflect and drive the edit history", async () => {
    useProjectStore.setState({ project: makeProject() });
    render(<App />);
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();

    act(() => void addAssetToTimeline("vid"));
    const undo = screen.getByRole("button", { name: "Undo Add clip" });
    expect(undo).toBeEnabled();
    await userEvent.click(undo);
    expect(useProjectStore.getState().project.tracks.flatMap((t) => t.clips)).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "Redo Add clip" }));
    expect(useProjectStore.getState().project.tracks.flatMap((t) => t.clips)).toHaveLength(1);
  });
});
