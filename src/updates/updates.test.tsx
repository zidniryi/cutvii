import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { SettingsDialog } from "@/components/SettingsDialog";
import { UpdateDialog } from "@/components/UpdateDialog";
import { useExportStore } from "@/store/export";
import { useUiStore } from "@/store/ui";
import {
  backgroundCheck,
  DAY_MS,
  manualCheck,
  readUpdatePrefs,
  tryShowUpdate,
  UPDATE_PREFS_KEY,
  useUpdateStore,
  writeUpdatePrefs,
} from "./updates";

const NOW = Date.UTC(2026, 9, 13, 10);
const available = (version = "0.2.0") => ({
  status: "available",
  version,
  notes: 'Fixes\n<b>bold</b> <img src=x onerror="alert(1)"> [link](https://evil.example)',
  url: `https://github.com/cutvii/cutvii/releases/tag/v${version}`,
});
const asked = () => vi.mocked(invoke).mock.calls.filter((c) => c[0] === "check_for_update").length;

beforeEach(() => {
  localStorage.removeItem(UPDATE_PREFS_KEY);
  vi.mocked(invoke).mockReset();
  useUpdateStore.setState({ offer: null, pending: null, manual: null });
  useExportStore.setState({ phase: "closed" });
  useUiStore.setState({ notice: null, settingsOpen: false });
});

describe("the quiet update check", () => {
  it("offers a newer version once, and not again the same day", async () => {
    vi.mocked(invoke).mockResolvedValue(available());
    render(<UpdateDialog />);
    await act(() => backgroundCheck(NOW));
    const dialog = screen.getByRole("dialog", { name: "CutVii 0.2.0 is available" });
    expect(within(dialog).getByRole("button", { name: "Download" })).toHaveFocus();
    expect(readUpdatePrefs()).toMatchObject({
      lastCheck: NOW,
      shown: { version: "0.2.0", day: "2026-10-13" },
    });

    fireEvent.click(within(dialog).getByRole("button", { name: "Later" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // the same day, even if the 24 hours were up: no second popup for this version
    writeUpdatePrefs({ lastCheck: 0 });
    await act(() => backgroundCheck(NOW + 1000));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // another day it comes back
    writeUpdatePrefs({ lastCheck: 0 });
    await act(() => backgroundCheck(NOW + DAY_MS));
    expect(screen.getByRole("dialog", { name: "CutVii 0.2.0 is available" })).toBeInTheDocument();
  });

  it("asks at most once in 24 hours", async () => {
    vi.mocked(invoke).mockResolvedValue({ status: "upToDate", current: "0.1.0" });
    await backgroundCheck(NOW);
    await backgroundCheck(NOW + DAY_MS - 1);
    expect(asked()).toBe(1);
    await backgroundCheck(NOW + DAY_MS);
    expect(asked()).toBe(2);
  });

  it("makes no request at all when the setting is off", async () => {
    writeUpdatePrefs({ auto: false });
    vi.mocked(invoke).mockResolvedValue(available());
    await backgroundCheck(NOW);
    expect(invoke).not.toHaveBeenCalled();
    expect(useUpdateStore.getState()).toMatchObject({ offer: null, pending: null });
  });

  it("says nothing when the request fails, and nothing when the repository is not set", async () => {
    render(<UpdateDialog />);
    for (const answer of ["timed out", "error sending request: offline"]) {
      writeUpdatePrefs({ lastCheck: 0 });
      vi.mocked(invoke).mockRejectedValueOnce(answer);
      await act(() => backgroundCheck(NOW));
    }
    writeUpdatePrefs({ lastCheck: 0 });
    vi.mocked(invoke).mockResolvedValueOnce({ status: "placeholder" });
    await act(() => backgroundCheck(NOW));
    writeUpdatePrefs({ lastCheck: 0 });
    vi.mocked(invoke).mockResolvedValueOnce({ unexpected: true });
    await act(() => backgroundCheck(NOW));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(useUiStore.getState().notice).toBeNull();
    expect(readUpdatePrefs().lastCheck).toBe(NOW); // a failed check still counts for the 24 hours
  });

  it("keeps a skipped version hidden and shows a newer one", async () => {
    vi.mocked(invoke).mockResolvedValue(available("0.2.0"));
    render(<UpdateDialog />);
    await act(() => backgroundCheck(NOW));
    fireEvent.click(screen.getByRole("button", { name: "Skip this version" }));
    expect(readUpdatePrefs().skipped).toBe("0.2.0");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    writeUpdatePrefs({ lastCheck: 0 });
    await act(() => backgroundCheck(NOW + 3 * DAY_MS));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    vi.mocked(invoke).mockResolvedValue(available("0.3.0"));
    writeUpdatePrefs({ lastCheck: 0 });
    await act(() => backgroundCheck(NOW + 4 * DAY_MS));
    expect(screen.getByRole("dialog", { name: "CutVii 0.3.0 is available" })).toBeInTheDocument();
  });

  it("waits while an export runs or another dialog is open, then shows", async () => {
    vi.mocked(invoke).mockResolvedValue(available());
    render(<UpdateDialog />);
    useExportStore.setState({ phase: "running" });
    await act(() => backgroundCheck(NOW));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(useUpdateStore.getState().pending?.version).toBe("0.2.0");

    // the export is over, but Settings is open now
    useExportStore.setState({ phase: "closed" });
    useUiStore.setState({ settingsOpen: true });
    const settings = render(<SettingsDialog />);
    act(() => tryShowUpdate(NOW));
    expect(screen.queryByRole("dialog", { name: /is available/ })).not.toBeInTheDocument();

    settings.unmount();
    act(() => tryShowUpdate(NOW));
    expect(screen.getByRole("dialog", { name: "CutVii 0.2.0 is available" })).toBeInTheDocument();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });
});

describe("the update popup", () => {
  it("shows the release notes as plain text: no markup, no links", async () => {
    vi.mocked(invoke).mockResolvedValue(available());
    render(<UpdateDialog />);
    await act(() => backgroundCheck(NOW));
    const notes = screen.getByTestId("update-notes");
    expect(notes.textContent).toBe(available().notes);
    expect(notes.children).toHaveLength(0); // one text node: nothing was turned into elements
    expect(screen.getByRole("dialog").querySelector("a, img, b")).toBeNull();
  });

  it("Download hands the address to Rust; Escape means Later", async () => {
    vi.mocked(invoke).mockResolvedValue(available());
    render(<UpdateDialog />);
    await act(() => backgroundCheck(NOW));
    vi.mocked(invoke).mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(invoke).toHaveBeenLastCalledWith("open_release_page", { url: available().url });

    // Rust refuses an address that is not the project's: the popup stays and says so
    await act(() => manualCheck(NOW));
    vi.mocked(invoke).mockRejectedValueOnce("that is not this project's release page");
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(useUiStore.getState().notice).toMatch(/not this project's release page/));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(readUpdatePrefs().skipped).toBeNull();
  });
});

describe("a manual check", () => {
  it("says up to date, shows a result even for a skipped version, and shows errors", async () => {
    render(<UpdateDialog />);
    vi.mocked(invoke).mockResolvedValueOnce({ status: "upToDate", current: "0.1.0" });
    await act(() => manualCheck(NOW));
    expect(screen.getByRole("status")).toHaveTextContent("You are up to date. This is CutVii 0.1.0.");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    writeUpdatePrefs({ skipped: "0.2.0", lastCheck: NOW }); // skipped, and checked a minute ago
    vi.mocked(invoke).mockResolvedValueOnce(available());
    await act(() => manualCheck(NOW));
    expect(screen.getByRole("dialog", { name: "CutVii 0.2.0 is available" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Later" }));

    vi.mocked(invoke).mockRejectedValueOnce("timed out");
    await act(() => manualCheck(NOW));
    expect(screen.getByRole("alert")).toHaveTextContent("The update check failed: timed out");
    fireEvent.keyDown(window, { key: "Escape" });

    vi.mocked(invoke).mockResolvedValueOnce({ status: "placeholder" });
    await act(() => manualCheck(NOW));
    expect(screen.getByRole("status")).toHaveTextContent("not set up in this build");
  });
});

describe("Settings", () => {
  it("has the automatic check on by default and remembers when it is switched off", () => {
    useUiStore.setState({ settingsOpen: true });
    render(<SettingsDialog />);
    const box = screen.getByRole("checkbox", { name: /Check for updates automatically/ });
    expect(box).toBeChecked();
    fireEvent.click(box);
    expect(readUpdatePrefs().auto).toBe(false);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
