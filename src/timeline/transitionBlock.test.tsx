import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { Timeline } from "@/components/layout/Timeline";
import type { Project } from "@/project/model";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useUiStore } from "@/store/ui";
import { IDS, makeProject } from "@/test/makeProject";
import { addClip } from "./edit";
import { deleteSelection, undo } from "./editor";
import { setClipTransition } from "./transitions";

/** "first" at 0..4 and "second" right after it at 4..8 on v1; "second" comes in with a dissolve (1 s). */
function project(): Project {
  let p = makeProject();
  for (const [assetId, id, start] of [
    [IDS.vid, "first", 0],
    [IDS.vid2, "second", 4],
  ] as const) {
    const r = addClip(p, { assetId, trackId: IDS.v1, start, id });
    if (!r.ok) throw new Error(r.error.message);
    p = {
      ...r.project,
      tracks: r.project.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => (c.id === id ? { ...c, sourceIn: 0, sourceOut: 4 } : c)),
      })),
    };
  }
  const t = setClipTransition(p, "second", { kind: "dissolve", duration: 1 });
  if (!t.ok) throw new Error(t.error.message);
  const o = setClipTransition(t.project, "second", { kind: "dissolve", duration: 0.5 }, "out");
  if (!o.ok) throw new Error(o.error.message);
  return o.project;
}
const stored = (id: string) =>
  useProjectStore
    .getState()
    .project.tracks.flatMap((t) => t.clips)
    .find((c) => c.id === id);
const clipEl = (id: string) => document.querySelector<HTMLElement>(`[data-clip-id="${id}"]`)!;

beforeEach(() => {
  useSelectionStore.getState().clear();
  useUiStore.setState({ selectedTransition: null, transitionWay: "in" });
  useProjectStore.getState().loadProject(project(), "/p.cutvii", []);
});

describe("a transition as a block of its own", () => {
  it("is not part of the clip it sits over, and is placed over the end it belongs to", () => {
    render(<Timeline />);
    const inBlock = screen.getByTestId("transition-in-mark");
    const outBlock = screen.getByTestId("transition-out-mark");
    expect(clipEl("second").contains(inBlock)).toBe(false);
    expect(clipEl("second").contains(outBlock)).toBe(false);

    // "second" is 200 px wide at 50 px/s, starting at 200 px: the way in is 50 px at its start, the way out
    // 25 px ending where the clip ends
    expect(parseFloat(inBlock.style.left)).toBeCloseTo(200);
    expect(parseFloat(inBlock.style.width)).toBeCloseTo(50);
    expect(parseFloat(outBlock.style.left)).toBeCloseTo(200 + 200 - 25);
    expect(parseFloat(outBlock.style.width)).toBeCloseTo(25);
  });

  it("is picked by a click, and Delete then removes only the transition", () => {
    render(<Timeline />);
    fireEvent.click(screen.getByTestId("transition-in-mark"));
    expect(useUiStore.getState().selectedTransition).toEqual({ clipId: "second", way: "in" });
    expect(screen.getByTestId("transition-in-mark")).toHaveAttribute("aria-pressed", "true");

    act(() => {
      deleteSelection(); // what the Delete key and the trash button do
    });
    expect(stored("second")).toBeDefined(); // the clip stays
    expect(stored("second")!.transitionIn).toBeUndefined();
    expect(stored("second")!.transitionOut).toBeDefined(); // the other end is untouched
    expect(screen.queryByTestId("transition-in-mark")).not.toBeInTheDocument();
    expect(useUiStore.getState().selectedTransition).toBeNull();

    undo();
    expect(stored("second")!.transitionIn).toEqual({ kind: "dissolve", duration: 1 });
  });

  it("can be removed with the ✕ that shows on the picked block", () => {
    render(<Timeline />);
    expect(
      within(screen.getByTestId("transition-in-mark")).queryByRole("button", { name: "Remove transition" }),
    ).toBeNull();
    fireEvent.click(screen.getByTestId("transition-in-mark"));
    fireEvent.click(screen.getByTestId("transition-in-remove"));
    expect(stored("second")!.transitionIn).toBeUndefined();
    expect(stored("second")).toBeDefined();
  });

  it("leaves Delete to the clip once the clip itself is pressed", () => {
    render(<Timeline />);
    fireEvent.click(screen.getByTestId("transition-in-mark"));
    expect(useUiStore.getState().selectedTransition).not.toBeNull();

    fireEvent.pointerDown(clipEl("second"), { button: 0, clientX: 300, clientY: 20 });
    fireEvent.pointerUp(window);
    expect(useUiStore.getState().selectedTransition).toBeNull();
    deleteSelection();
    expect(stored("second")).toBeUndefined(); // the whole clip went
  });

  it("is not picked any more once another clip is selected", () => {
    render(<Timeline />);
    fireEvent.click(screen.getByTestId("transition-in-mark"));
    useSelectionStore.getState().select("first");
    deleteSelection();
    expect(stored("first")).toBeUndefined();
    expect(stored("second")!.transitionIn).toBeDefined();
  });
});
