import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { Inspector } from "@/components/layout/Inspector";
import type { Project } from "@/project/model";
import { useLookPreviewStore } from "@/store/lookPreviews";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useUiStore } from "@/store/ui";
import { expectValid, IDS, makeProject } from "@/test/makeProject";
import { colorOf, isGraded, NO_COLOR, setClipColor } from "./color";
import { addClip } from "./edit";
import { applyColorToAll, changeColor, undo } from "./editor";
import { colourClipCount, lookAt, LOOKS, matchLook, setColorOnAll } from "./looks";

/** "video" and "second" on v1, a still on v2, music on a1. */
function project(): Project {
  let p = makeProject();
  for (const [assetId, trackId, id, start] of [
    [IDS.vid, IDS.v1, "video", 0],
    [IDS.vid2, IDS.v1, "second", 12],
    [IDS.img, IDS.v2, "still", 0],
    [IDS.aud, IDS.a1, "music", 0],
  ] as const) {
    const r = addClip(p, { assetId, trackId, start, id });
    if (!r.ok) throw new Error(r.error.message);
    p = r.project;
  }
  return p;
}
const now = () => useProjectStore.getState().project;
const clip = (id: string) =>
  now()
    .tracks.flatMap((t) => t.clips)
    .find((c) => c.id === id)!;
const punch = LOOKS.find((l) => l.id === "punch")!;

beforeEach(() => {
  useProjectStore.setState({ project: project(), past: [], future: [] });
  useSelectionStore.getState().clear();
  useUiStore.setState({ notice: null, dialog: null, colorClipboard: null, colorDraft: null });
  useLookPreviewStore.setState({ pictures: {}, asked: {} });
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation((async (cmd: string, args?: { looks?: unknown[] }) => {
    if (cmd === "look_previews") return (args?.looks ?? []).map((_, i) => `/cache/looks/${i}.png`);
    return undefined;
  }) as never);
});

describe("looks", () => {
  it("are CutVii's own named sets of the Adjust values", () => {
    expect(LOOKS.length).toBeGreaterThanOrEqual(8);
    expect(new Set(LOOKS.map((l) => l.id)).size).toBe(LOOKS.length);
    expect(new Set(LOOKS.map((l) => l.name)).size).toBe(LOOKS.length);
    for (const look of LOOKS) {
      expect(isGraded(look.adjust)).toBe(true);
      expect(Object.keys(look.adjust).sort()).toEqual(Object.keys(NO_COLOR).sort());
      // a look is a legal colour for a clip
      expect(setClipColor(project(), "video", look.adjust).ok).toBe(true);
    }
  });

  it("scale with Intensity on whole-percent steps and are recognised again from a clip's values", () => {
    expect(lookAt(punch.adjust, 100)).toEqual(punch.adjust);
    expect(Object.values(lookAt(punch.adjust, 0)).every((v) => v === 0)).toBe(true);
    const half = lookAt(punch.adjust, 50);
    expect(half.contrast).toBe(0.18); // 0.35 / 2, on the sliders' steps
    expect(Object.values(half).every((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-9)).toBe(true);
    expect(matchLook(punch.adjust)).toEqual({ id: "punch", intensity: 100 });
    // neighbouring percents can round to the same values: any of them is a right answer
    const again = matchLook(lookAt(punch.adjust, 60))!;
    expect(again.id).toBe("punch");
    expect(lookAt(punch.adjust, again.intensity)).toEqual(lookAt(punch.adjust, 60));
    expect(matchLook(NO_COLOR)).toBeNull();
    expect(matchLook({ ...punch.adjust, tint: 0.77 })).toBeNull(); // changed by hand
  });

  it("replace a clip's colour as one undo step", () => {
    changeColor("video", { tint: 0.5 });
    changeColor("video", lookAt(punch.adjust, 100), true);
    expect(colorOf(clip("video"))).toEqual(punch.adjust); // the old tint is gone, not mixed in
    expect(useProjectStore.getState().past).toHaveLength(2);
    undo();
    expect(colorOf(clip("video")).tint).toBe(0.5);
  });
});

describe("colour on all clips", () => {
  it("gives every clip with a picture the same colour in one step, and leaves sound alone", () => {
    expect(colourClipCount(now())).toBe(3);
    changeColor("second", { exposure: -0.4 });
    const before = now();
    applyColorToAll(punch.adjust);
    for (const id of ["video", "second", "still"]) expect(colorOf(clip(id))).toEqual(punch.adjust);
    expect(clip("music").color).toBeUndefined();
    expectValid(now());
    undo();
    expect(now()).toEqual(before);
    // and removing it everywhere
    const cleared = setColorOnAll(now(), null);
    expect(
      cleared.ok && cleared.project.tracks.flatMap((t) => t.clips).every((c) => c.color === undefined),
    ).toBe(true);
  });
});

describe("the Looks gallery in the Color tab", () => {
  function open(id = "video") {
    useSelectionStore.getState().select(id);
    useUiStore.getState().setInspectorTab("video", "color");
    render(<Inspector />);
    return within(screen.getByRole("group", { name: "Looks" }));
  }

  it("shows a frame of the clip through every look and applies one with a click", async () => {
    const panel = open();
    // one request: the plain frame and every look, from the middle of the clip
    await waitFor(() =>
      expect(vi.mocked(invoke).mock.calls.filter((c) => c[0] === "look_previews")).toHaveLength(1),
    );
    const call = vi.mocked(invoke).mock.calls.find((c) => c[0] === "look_previews")![1] as {
      path: string;
      at: number;
      looks: unknown[];
    };
    expect(call).toMatchObject({ path: "/m/vid.mp4", at: 5 });
    expect(call.looks).toHaveLength(LOOKS.length + 1);
    await waitFor(() =>
      expect(panel.getByRole("button", { name: "Punch" }).querySelector("img")).not.toBeNull(),
    );

    expect(panel.getByRole("button", { name: "None" })).toHaveAttribute("aria-pressed", "true");
    expect(panel.getByRole("slider", { name: /Intensity/ })).toBeDisabled();
    fireEvent.click(panel.getByRole("button", { name: "Punch" }));
    expect(colorOf(clip("video"))).toEqual(punch.adjust);
    expect(panel.getByRole("button", { name: "Punch" })).toHaveAttribute("aria-pressed", "true");
    // the Adjust sliders below show the look's values
    expect(screen.getByRole("slider", { name: "Contrast" })).toHaveValue("35");

    // Intensity: the preview follows while dragging, one undo step on release
    const intensity = panel.getByRole("slider", { name: "Intensity of Punch" });
    const steps = useProjectStore.getState().past.length;
    fireEvent.change(intensity, { target: { value: "40" } });
    expect(useUiStore.getState().colorDraft).toEqual({ clipId: "video", adjust: lookAt(punch.adjust, 40) });
    expect(useProjectStore.getState().past).toHaveLength(steps);
    fireEvent.pointerUp(intensity);
    expect(colorOf(clip("video"))).toEqual(lookAt(punch.adjust, 40));
    expect(useProjectStore.getState().past).toHaveLength(steps + 1);
    expect(useUiStore.getState().colorDraft).toBeNull();

    fireEvent.click(panel.getByRole("button", { name: "None" }));
    expect(clip("video").color).toBeUndefined();
  });

  it("copies a clip's colour, pastes it on another, and applies it to all after asking", async () => {
    changeColor("video", lookAt(punch.adjust, 70), true);
    const panel = open();
    fireEvent.click(panel.getByRole("button", { name: "Copy colour" }));
    expect(useUiStore.getState().colorClipboard).toEqual(lookAt(punch.adjust, 70));

    changeColor("second", useUiStore.getState().colorClipboard, true);
    expect(colorOf(clip("second"))).toEqual(lookAt(punch.adjust, 70));
    expect(panel.getByRole("button", { name: "Paste colour" })).toBeDisabled(); // this clip already has it

    fireEvent.click(panel.getByRole("button", { name: "Apply to all clips" }));
    await waitFor(() => expect(useUiStore.getState().dialog?.title).toBe("Use this colour on all clips?"));
    expect(useUiStore.getState().dialog?.lines[0]).toMatch(/2 other clips/);
    useUiStore.getState().closeDialog(true);
    await waitFor(() => expect(colorOf(clip("still"))).toEqual(lookAt(punch.adjust, 70)));
  });
});
