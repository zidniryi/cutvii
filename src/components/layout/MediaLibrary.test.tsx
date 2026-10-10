import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@/components/ui/tooltip";
import { createProject } from "@/project/factory";
import { useProjectStore } from "@/store/project";
import { MediaLibrary } from "./MediaLibrary";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke, convertFileSrc: (p: string) => `asset://${p}` }));

const video = { path: "/media/holiday.mp4", mediaType: "video", duration: 75, width: 1920, height: 1080 };
const audio = { path: "/media/song.mp3", mediaType: "audio", duration: 10 };

function setup() {
  return render(
    <TooltipProvider>
      <MediaLibrary />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  invoke.mockReset();
  useProjectStore.setState({ project: createProject() });
});

describe("MediaLibrary", () => {
  it("imports files, lists them and filters by search", async () => {
    invoke.mockResolvedValue({ imported: [video, audio], failed: [] });
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Import media" }));

    expect(await screen.findByText("holiday.mp4")).toBeInTheDocument();
    expect(screen.getByText("Video · 1:15")).toBeInTheDocument();
    expect(screen.getByText("Imported 2 files.")).toBeInTheDocument();

    await userEvent.type(screen.getByRole("searchbox", { name: "Search media" }), "song");
    expect(screen.queryByText("holiday.mp4")).not.toBeInTheDocument();
    expect(screen.getByText("song.mp3")).toBeInTheDocument();
  });

  it("skips duplicates and reports per-file failures", async () => {
    invoke.mockResolvedValue({
      imported: [video],
      failed: [{ path: "/media/bad.mp4", error: "file has no video stream" }],
    });
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Import media" }));
    await screen.findByText("holiday.mp4");
    expect(screen.getByText("bad.mp4: file has no video stream")).toBeInTheDocument();

    invoke.mockResolvedValue({ imported: [video], failed: [] });
    await userEvent.click(screen.getByRole("button", { name: "Import media" }));
    expect(await screen.findByText("holiday.mp4 is already in the project.")).toBeInTheDocument();
    expect(useProjectStore.getState().project.assets).toHaveLength(1);
  });

  it("shows a clear error when the media engine is unavailable", async () => {
    invoke.mockRejectedValue("ffmpeg not found. Install FFmpeg or set CUTVII_FFMPEG.");
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Import media" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("ffmpeg not found");
  });

  it("removes an asset from the project", async () => {
    invoke.mockResolvedValue({ imported: [video], failed: [] });
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Import media" }));
    await userEvent.click(await screen.findByRole("button", { name: "Remove holiday.mp4 from project" }));
    await waitFor(() => expect(useProjectStore.getState().project.assets).toHaveLength(0));
    expect(screen.getByText("No media yet")).toBeInTheDocument();
  });

  it("stays quiet when the picker is cancelled", async () => {
    invoke.mockResolvedValue({ imported: [], failed: [] });
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Import media" }));
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
