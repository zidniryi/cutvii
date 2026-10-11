import { act, fireEvent, render, screen } from "@testing-library/react";
import { useUiStore } from "@/store/ui";
import { NOTICE_MS, NoticeToast } from "./NoticeToast";

describe("notice toast", () => {
  beforeEach(() => useUiStore.setState({ notice: null }));
  afterEach(() => vi.useRealTimers());

  it("shows the whole message, and goes away on its own or when dismissed", () => {
    vi.useFakeTimers();
    render(<NoticeToast />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    const long = "Add a video or audio clip to the timeline to use the AI tools";
    act(() => useUiStore.getState().setNotice(long));
    const toast = screen.getByRole("status");
    expect(toast).toHaveTextContent(long);
    expect(toast.className).not.toContain("truncate"); // never cut off

    act(() => vi.advanceTimersByTime(NOTICE_MS - 100));
    expect(screen.getByRole("status")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(useUiStore.getState().notice).toBeNull();

    // a newer message replaces the one showing and gets its own full time
    act(() => useUiStore.getState().setNotice("first"));
    act(() => vi.advanceTimersByTime(NOTICE_MS - 500));
    act(() => useUiStore.getState().setNotice("second"));
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByRole("status")).toHaveTextContent("second");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
