import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import fixtureV3 from "../../fixtures/project-v5.json";
import { Inspector } from "@/components/layout/Inspector";
import { AppDialog } from "@/components/AppDialog";
import type { Project } from "@/project/model";
import { SCHEMA_VERSION } from "@/project/model";
import { parseProject } from "@/project/parse";
import { layersAt, previewRate, sourceTimeFor, timelineTimeFor } from "@/playback/engine";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useUiStore } from "@/store/ui";
import { expectValid, IDS, makeProject } from "@/test/makeProject";
import { clipDuration, clipEnd, findClip, projectDuration } from "./clips";
import { addClip, setClipKeepPitch, setClipSpeed, splitClip, trimClip, type EditResult } from "./edit";
import { addAssetToTimeline, undo } from "./editor";

const must = (r: EditResult): Project => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  expectValid(r.project);
  return r.project;
};
const code = (r: EditResult) => (r.ok ? "ok" : r.error.code);
const clip = (p: Project, id: string) => findClip(p, id)!.clip;
/** vid (10 s) at 2 s as "c1", vid2 (4 s) at 14 s as "c2", on v1. */
function two(): Project {
  let p = must(addClip(makeProject(), { assetId: IDS.vid, trackId: IDS.v1, start: 2, id: "c1" }));
  p = must(addClip(p, { assetId: IDS.vid2, trackId: IDS.v1, start: 14, id: "c2" }));
  return p;
}

describe("setClipSpeed", () => {
  it("timeline duration is the source range divided by the speed", () => {
    const fast = must(setClipSpeed(two(), "c1", 2));
    expect(clipDuration(clip(fast, "c1"))).toBe(5);
    expect(clipEnd(clip(fast, "c1"))).toBe(7);
    expect(clip(fast, "c1")).toMatchObject({ sourceIn: 0, sourceOut: 10 }); // the source range is untouched
    expect(clip(fast, "c2").timelineStart).toBe(14); // faster never moves anything
  });

  it("slower without ripple is refused; with ripple the later clips move by exactly the overlap", () => {
    const p = two(); // c1 2..12, c2 14..18
    const refused = setClipSpeed(p, "c1", 0.5); // would be 2..22
    expect(code(refused)).toBe("needs-ripple");

    const rippled = must(setClipSpeed(p, "c1", 0.5, { ripple: true }));
    expect(clipEnd(clip(rippled, "c1"))).toBe(22);
    expect(clip(rippled, "c2").timelineStart).toBe(22); // pushed by 8 s: 22 - 14
    expect(projectDuration(rippled)).toBe(26);

    // slower but still clear of the next clip: no prompt needed
    expect(clipEnd(clip(must(setClipSpeed(p, "c1", 0.9)), "c1"))).toBeCloseTo(2 + 10 / 0.9);
  });

  it("only the same track ripples, and earlier clips never move", () => {
    let p = two();
    p = must(addClip(p, { assetId: IDS.aud, trackId: IDS.a1, start: 0, id: "music" }));
    const r = must(setClipSpeed(p, "c2", 0.25, { ripple: true }));
    expect(clip(r, "c1").timelineStart).toBe(2);
    expect(clip(r, "music").timelineStart).toBe(0);
  });

  it("validates the range, stills and unknown clips; same speed is a no-op", () => {
    const p = two();
    expect(code(setClipSpeed(p, "c1", 0.05))).toBe("out-of-range");
    expect(code(setClipSpeed(p, "c1", 11))).toBe("out-of-range");
    expect(code(setClipSpeed(p, "c1", Number.NaN))).toBe("out-of-range");
    expect(code(setClipSpeed(p, "nope", 2))).toBe("unknown-clip");
    const same = setClipSpeed(p, "c1", 1);
    expect(same.ok && same.project).toBe(p);

    const img = must(addClip(makeProject(), { assetId: IDS.img, trackId: IDS.v1, start: 0, id: "i" }));
    expect(code(setClipSpeed(img, "i", 2))).toBe("out-of-range");
    expect(clip(must(setClipKeepPitch(p, "c1", false)), "c1").keepPitch).toBe(false);
  });
});

describe("trim and split at a different speed", () => {
  it("trims map timeline seconds to source seconds through the speed", () => {
    let p = must(setClipSpeed(two(), "c1", 2)); // timeline 2..7, source 0..10
    p = must(trimClip(p, "c1", "end", 5)); // 3 timeline s = 6 source s
    expect(clip(p, "c1")).toMatchObject({ sourceIn: 0, sourceOut: 6 });
    p = must(trimClip(p, "c1", "start", 3)); // 1 timeline s = 2 source s
    expect(clip(p, "c1")).toMatchObject({ timelineStart: 3, sourceIn: 2, sourceOut: 6 });
    p = must(trimClip(p, "c1", "end", 100)); // clamps at the end of the file: (10-2)/2 = 4 s long
    expect(clip(p, "c1").sourceOut).toBe(10);
    expect(clipEnd(clip(p, "c1"))).toBe(7);
  });

  it("split keeps both halves contiguous in time and in the source", () => {
    let p = must(setClipSpeed(two(), "c1", 0.5, { ripple: true })); // timeline 2..22
    p = must(splitClip(p, "c1", 8, "right")); // 6 timeline s in = 3 source s
    expect(clip(p, "c1")).toMatchObject({ sourceIn: 0, sourceOut: 3, speed: 0.5 });
    expect(clip(p, "right")).toMatchObject({ timelineStart: 8, sourceIn: 3, sourceOut: 10, speed: 0.5 });
    expect(clipEnd(clip(p, "right"))).toBe(22);
  });
});

describe("preview mapping", () => {
  it("maps the playhead into the source through the speed, and back", () => {
    const p = must(setClipSpeed(two(), "c1", 2)); // timeline 2..7
    const c = clip(p, "c1");
    expect(sourceTimeFor(c, 4)).toBe(4); // 2 s in at 2x = 4 s of source
    expect(timelineTimeFor(c, 4)).toBe(4);
    expect(timelineTimeFor(c, 10)).toBe(7);
    expect(layersAt(p, 6.9, 0).map((l) => l.clip.id)).toEqual(["c1"]);
    expect(layersAt(p, 7.1, 0)).toEqual([]); // the shorter clip really ends at 7
  });

  it("clamps what the preview can play and says whether it is exact", () => {
    expect(previewRate(1)).toEqual({ rate: 1, exact: true });
    expect(previewRate(4)).toEqual({ rate: 4, exact: true });
    expect(previewRate(8)).toEqual({ rate: 4, exact: false });
    expect(previewRate(0.1)).toEqual({ rate: 0.25, exact: false });
  });
});

describe("project format", () => {
  it("is schema version 5, with speed validated in project files", () => {
    expect(SCHEMA_VERSION).toBe(5);
    expect(parseProject(fixtureV3).ok).toBe(true);
    const bad = structuredClone(fixtureV3) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    bad.tracks[0].clips[0].speed = 20;
    const r = parseProject(bad);
    expect(!r.ok && r.errors.join(" ")).toMatch(/Speed must be between 0\.1× and 10×/);
    const old = { ...fixtureV3, schemaVersion: 1 };
    expect(parseProject(old).ok).toBe(false); // v1 files are upgraded by the Rust migration before they get here
  });
});

describe("Speed panel", () => {
  function setup(build: () => void) {
    useProjectStore.setState({ project: makeProject(), past: [], future: [] });
    useSelectionStore.setState({ selectedClipIds: [] });
    useUiStore.setState({
      notice: null,
      dialog: null,
      sidePanel: "inspector",
      inspectorTab: { video: "speed", audio: "speed" },
    });
    act(build);
    return render(
      <>
        <Inspector />
        <AppDialog />
      </>,
    );
  }
  const state = () => useProjectStore.getState();
  const first = () => state().project.tracks[0].clips[0];

  it("presets change the speed in one undo step and the label shows old → new", async () => {
    setup(() => void addAssetToTimeline(IDS.vid)); // 10 s
    const panel = screen.getByRole("region", { name: "Speed" });
    expect(within(panel).getByTestId("speed-duration")).toHaveTextContent("Duration: 10.00 s → 10.00 s");
    expect(within(panel).getByRole("button", { name: "1×" })).toHaveAttribute("aria-pressed", "true");

    const before = state().past.length;
    await userEvent.click(within(panel).getByRole("button", { name: "2×" }));
    expect(first().speed).toBe(2);
    expect(state().past).toHaveLength(before + 1);
    expect(within(panel).getByTestId("speed-duration")).toHaveTextContent("Duration: 10.00 s → 5.00 s");
    expect(screen.getByLabelText("Duration (s)")).toHaveValue(5);

    act(() => undo());
    expect(first().speed).toBeUndefined();
  });

  it("custom value: live label while typing, validation, commit on Enter", async () => {
    setup(() => void addAssetToTimeline(IDS.vid));
    const panel = screen.getByRole("region", { name: "Speed" });
    const input = within(panel).getByLabelText("Custom");

    await userEvent.clear(input);
    await userEvent.type(input, "4");
    expect(within(panel).getByTestId("speed-duration")).toHaveTextContent("→ 2.50 s"); // before committing
    expect(first().speed).toBeUndefined();

    await userEvent.clear(input);
    await userEvent.type(input, "20");
    expect(within(panel).getByRole("alert")).toHaveTextContent("between 0.1× and 10×");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(first().speed).toBeUndefined(); // invalid values are never applied

    await userEvent.clear(screen.getByLabelText("Custom"));
    await userEvent.type(screen.getByLabelText("Custom"), "8{Enter}");
    expect(first().speed).toBe(8);
    expect(screen.getByText(/Sound is muted above 4×/)).toBeInTheDocument();
    expect(
      screen.getByText(/preview can only play at 4× here; the export uses the real 8×/),
    ).toBeInTheDocument();
  });

  it("slowing into the next clip asks: cancel keeps everything, Move clips ripples", async () => {
    setup(() => {
      addAssetToTimeline(IDS.vid2, { start: 0 }); // 0..4
      addAssetToTimeline(IDS.vid, { start: 4 }); // 4..14
      useSelectionStore.getState().setSelection([state().project.tracks[0].clips[0].id]);
    });
    await userEvent.click(
      within(screen.getByRole("region", { name: "Speed" })).getByRole("button", { name: "0.5×" }),
    );
    let dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Move the following clips?");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(first().speed).toBeUndefined();
    expect(state().project.tracks[0].clips[1].timelineStart).toBe(4);

    await userEvent.click(
      within(screen.getByRole("region", { name: "Speed" })).getByRole("button", { name: "0.5×" }),
    );
    dialog = await screen.findByRole("alertdialog");
    const before = state().past.length;
    await userEvent.click(within(dialog).getByRole("button", { name: "Move clips" }));
    expect(first().speed).toBe(0.5);
    expect(state().project.tracks[0].clips[1].timelineStart).toBe(8);
    expect(state().past).toHaveLength(before + 1); // speed + ripple are one undo step
    expectValid(state().project);
  });

  it("Keep pitch toggles and is undoable; images have no speed panel", async () => {
    setup(() => void addAssetToTimeline(IDS.vid));
    const box = screen.getByRole("checkbox", { name: "Keep pitch" });
    expect(box).toBeChecked();
    await userEvent.click(box);
    expect(first().keepPitch).toBe(false);
    act(() => undo());
    expect(first().keepPitch).toBeUndefined();
  });

  it("images have no speed panel", () => {
    setup(() => void addAssetToTimeline(IDS.img));
    expect(screen.queryByRole("region", { name: "Speed" })).not.toBeInTheDocument();
  });
});
