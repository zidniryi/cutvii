import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { Inspector } from "@/components/layout/Inspector";
import { channelLabel, formatBitRate, formatBytes, useMediaDetailsStore } from "@/store/mediaDetails";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useUiStore } from "@/store/ui";
import { IDS, makeProject } from "@/test/makeProject";
import { addClip } from "@/timeline/edit";

const DETAILS = {
  videoCodec: "h264",
  audioCodec: "aac",
  audioChannels: 2,
  sampleRate: 48000,
  bitRate: 8_123_456,
  container: "QuickTime / MOV",
  sizeBytes: 12_582_912,
};

function open(missing: string[] = []) {
  const p = addClip(makeProject(), { assetId: IDS.vid, trackId: IDS.v1, start: 0, id: "video" });
  if (!p.ok) throw new Error(p.error.message);
  useProjectStore.getState().loadProject(p.project, "/p.cutvii", missing);
  useSelectionStore.getState().select("video");
  useUiStore.setState({ inspectorTab: { video: "info" }, dialog: null });
  useMediaDetailsStore.setState({ entries: {} });
  return render(<Inspector />);
}
/** Rust answers per command. */
function rust(answers: Record<string, unknown>) {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation((async (cmd: string) => {
    const answer = answers[cmd];
    if (answer instanceof Error) throw answer.message;
    return answer;
  }) as never);
}
/** The value shown next to a label in the facts list (tabs can carry the same word). */
const fact = (label: string) =>
  screen.getAllByText(label).find((el) => el.tagName === "DT")?.nextElementSibling?.textContent;

describe("clip info", () => {
  it("formats sizes, bit rates and channel layouts for reading", () => {
    expect([0, 900, 1536, 12_582_912, 250 * 1024 * 1024, 3.5 * 1024 ** 3].map(formatBytes)).toEqual([
      "0 B",
      "900 B",
      "1.5 KB",
      "12.0 MB",
      "250 MB",
      "3.5 GB",
    ]);
    expect([128_000, 8_123_456].map(formatBitRate)).toEqual(["128 kbit/s", "8.1 Mbit/s"]);
    expect([1, 2, 6, 4].map(channelLabel)).toEqual(["mono", "stereo", "5.1", "4 channels"]);
  });

  it("shows what the file is, read once from Rust", async () => {
    rust({ media_details: DETAILS });
    open();
    expect(screen.getByText("Reading the file…")).toBeInTheDocument();
    await waitFor(() => expect(fact("Video codec")).toBe("H264"));
    expect(fact("Audio")).toBe("AAC · stereo · 48 kHz");
    expect(fact("File size")).toBe("12.0 MB");
    expect(fact("Bit rate")).toBe("8.1 Mbit/s");
    expect(fact("Container")).toBe("QuickTime / MOV");
    expect(fact("File")).toBe("/m/vid.mp4");
    expect(screen.queryByText("Reading the file…")).not.toBeInTheDocument();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("media_details", { path: "/m/vid.mp4" });
  });

  it("says when a video has no sound, and when the details cannot be read", async () => {
    rust({ media_details: { videoCodec: "hevc", sizeBytes: 1024 } });
    const first = open();
    await waitFor(() => expect(fact("Audio")).toBe("none"));
    first.unmount();

    rust({ media_details: new Error("ffprobe could not read file") });
    open();
    expect(await screen.findByText("The file's details could not be read.")).toBeInTheDocument();
    expect(fact("File")).toBe("/m/vid.mp4"); // the location is still shown
  });

  it("shows the file in the file manager, and reports when that fails", async () => {
    rust({ media_details: DETAILS, reveal_media: undefined });
    open();
    const show = screen.getByRole("button", { name: /Show in (Finder|folder)/ });
    fireEvent.click(show);
    expect(invoke).toHaveBeenCalledWith("reveal_media", { path: "/m/vid.mp4" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    rust({ media_details: DETAILS, reveal_media: new Error("invalid input: the source file is missing") });
    fireEvent.click(show);
    expect(await screen.findByRole("alert")).toHaveTextContent("the source file is missing");
  });

  it("replaces the media with a file picked in Rust and reads the new file's details", async () => {
    rust({
      media_details: DETAILS,
      relink_media: { path: "/m/better.mp4", mediaType: "video", duration: 30, width: 3840, height: 2160 },
    });
    open();
    await waitFor(() => expect(fact("File")).toBe("/m/vid.mp4"));
    fireEvent.click(screen.getByRole("button", { name: "Replace media…" }));
    await waitFor(() => expect(fact("File")).toBe("/m/better.mp4"));
    expect(useProjectStore.getState().project.assets.find((a) => a.id === IDS.vid)).toMatchObject({
      path: "/m/better.mp4",
      width: 3840,
    });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("media_details", { path: "/m/better.mp4" }));
    expect(useProjectStore.getState().past).toHaveLength(1); // one undo step
  });

  it("for a missing file: no details are asked for, it cannot be shown, but it can be replaced", () => {
    rust({ media_details: DETAILS });
    open(["/m/vid.mp4"]);
    expect(screen.getByText(/This file was not found/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Show in (Finder|folder)/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Replace media…" })).toBeEnabled();
    expect(invoke).not.toHaveBeenCalled();
  });
});
