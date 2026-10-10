import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useUiStore } from "@/store/ui";
import { findClip } from "@/timeline/clips";
import { addAssetToTimeline } from "@/timeline/editor";
import { IDS, makeProject } from "@/test/makeProject";
import { Inspector } from "./Inspector";

const state = () => useProjectStore.getState();
const clipOf = (id: string) => findClip(state().project, id)!.clip;

function place(assetId: string, start?: number) {
  let id = "";
  act(() => {
    addAssetToTimeline(assetId, { start });
    id = useSelectionStore.getState().selectedClipIds[0];
  });
  return id;
}

beforeEach(() => {
  useProjectStore.setState({ project: makeProject(), past: [], future: [], missingPaths: [] });
  useSelectionStore.setState({ selectedClipIds: [] });
  useUiStore.setState({ notice: null, sidePanel: "inspector", inspectorTab: {} });
});

describe("Inspector", () => {
  it("shows nothing-selected and multi-selection states", () => {
    render(<Inspector />);
    expect(screen.getByText("Nothing selected")).toBeInTheDocument();

    const a = place(IDS.vid, 0);
    const b = place(IDS.vid2, 20);
    act(() => useSelectionStore.getState().setSelection([a, b]));
    expect(screen.getByText("2 clips selected")).toBeInTheDocument();
    expect(screen.queryByLabelText("Start (s)")).not.toBeInTheDocument();
  });

  it("shows the selected clip's real properties", () => {
    place(IDS.vid, 2);
    useUiStore.setState({ inspectorTab: { video: "info" } });
    render(<Inspector />);
    expect(screen.getByText("vid.mp4")).toBeInTheDocument();
    expect(screen.getByText("Video · Video 1")).toBeInTheDocument();
    expect(screen.getByLabelText("Start (s)")).toHaveValue(2);
    expect(screen.getByLabelText("Duration (s)")).toHaveValue(10);
    expect(screen.getByText("00:00:00:00")).toBeInTheDocument(); // source in
    expect(screen.getByText("00:00:10:00")).toBeInTheDocument(); // source out
  });

  it("moves the clip when Start is committed, and reports an overlap instead of applying it", async () => {
    const a = place(IDS.vid, 0); // 0..10
    place(IDS.vid2, 12); // 12..16
    act(() => useSelectionStore.getState().select(a));
    render(<Inspector />);
    const start = screen.getByLabelText("Start (s)");

    await userEvent.clear(start);
    await userEvent.type(start, "20{Enter}");
    expect(clipOf(a).timelineStart).toBe(20);
    expect(state().past.at(-1)?.label).toBe("Move clip");

    await userEvent.clear(screen.getByLabelText("Start (s)"));
    await userEvent.type(screen.getByLabelText("Start (s)"), "13{Enter}"); // overlaps the 12..16 clip
    expect(clipOf(a).timelineStart).toBe(20);
    expect(useUiStore.getState().notice).toMatch(/overlap/);
  });

  it("changes duration by trimming the end, clamped to the source length; Escape reverts typing", async () => {
    const a = place(IDS.vid, 0);
    render(<Inspector />);
    const dur = screen.getByLabelText("Duration (s)");

    await userEvent.clear(dur);
    await userEvent.type(dur, "4{Enter}");
    expect(clipOf(a)).toMatchObject({ sourceIn: 0, sourceOut: 4 });

    await userEvent.clear(screen.getByLabelText("Duration (s)"));
    await userEvent.type(screen.getByLabelText("Duration (s)"), "99{Enter}");
    expect(clipOf(a).sourceOut).toBe(10); // clamped to the file length

    await userEvent.type(screen.getByLabelText("Duration (s)"), "7{Escape}");
    expect(screen.getByLabelText("Duration (s)")).toHaveValue(10);
    expect(clipOf(a).sourceOut).toBe(10);
  });

  it("volume: dragging previews, release commits one undo step; values clamp to 0-200 %", async () => {
    const a = place(IDS.vid, 0);
    useUiStore.setState({ inspectorTab: { video: "audio" } });
    render(<Inspector />);
    const slider = screen.getByRole("slider", { name: "Volume" });
    const before = state().past.length;

    fireEvent.change(slider, { target: { value: "50" } });
    fireEvent.change(slider, { target: { value: "35" } });
    expect(clipOf(a).volume).toBe(1); // nothing committed while dragging
    expect(state().past).toHaveLength(before);

    fireEvent.pointerUp(slider);
    expect(clipOf(a).volume).toBeCloseTo(0.35);
    expect(state().past).toHaveLength(before + 1);
    expect(state().past.at(-1)?.label).toBe("Change volume");

    const num = screen.getByLabelText("Volume percent");
    await userEvent.clear(num);
    await userEvent.type(num, "500{Enter}");
    expect(clipOf(a).volume).toBe(2);
    expect(screen.getByText(/Above 100 %/)).toBeInTheDocument();
  });

  it("has no volume control for images, and warns when the file is missing", () => {
    place(IDS.img, 0);
    useProjectStore.setState({ missingPaths: ["/m/img.png"] });
    render(<Inspector />);
    expect(screen.queryByRole("slider", { name: "Volume" })).not.toBeInTheDocument();
    expect(screen.getByText(/The file is missing/)).toBeInTheDocument();
  });
});
