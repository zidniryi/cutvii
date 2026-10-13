import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import shipped from "../../config/support.json";
import { AboutDialog } from "@/components/AboutDialog";
import { SupportDialog } from "@/components/SupportDialog";
import { TopBar } from "@/components/layout/TopBar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useUiStore } from "@/store/ui";
import { DEFAULT_TEXT, supportText } from "./config";

const ui = () =>
  render(
    <TooltipProvider>
      <TopBar />
      <SupportDialog />
    </TooltipProvider>,
  );

describe("support text", () => {
  it("follows the OS language and falls back to English", () => {
    expect(supportText("en-US").title).toBe("Support CutVii");
    expect(supportText("id-ID").title).toBe("Dukung CutVii");
    expect(supportText("id").donate).toBe("Donasi");
    expect(supportText("fr-FR")).toEqual(supportText("en"));
    expect(supportText(undefined)).toEqual(supportText("en"));
    expect(supportText("constructor")).toEqual(supportText("en")); // not a language, just a word
    expect(supportText("en")).toEqual(DEFAULT_TEXT); // the shipped English is the agreed text
  });

  it("uses the built-in text when the file is broken", () => {
    expect(supportText("en", null)).toBe(DEFAULT_TEXT);
    expect(supportText("en", { ...shipped, locales: {} })).toBe(DEFAULT_TEXT);
    const empty = { ...shipped, locales: { en: { ...shipped.locales.en, title: "  " } } };
    expect(supportText("en", empty)).toBe(DEFAULT_TEXT);
    const extra = { ...shipped, locales: { en: { ...shipped.locales.en, html: "<b>x</b>" } } };
    expect(supportText("en", extra)).toBe(DEFAULT_TEXT);
  });
});

describe("the Support CutVii popup", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
    useUiStore.setState({ supportOpen: false });
  });

  it("is closed until the gift button is clicked, and the button sits right after the AI menu", () => {
    ui();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const gift = screen.getByRole("button", { name: "Support CutVii" });
    const buttons = within(screen.getByRole("banner")).getAllByRole("button");
    const at = buttons.indexOf(gift);
    expect(buttons[at - 1]).toHaveAccessibleName(/AI/);
    expect(buttons[at + 1]).toHaveAccessibleName(/Undo/);
    expect(gift.className).not.toMatch(/accent/); // neutral, not the orange accent

    fireEvent.click(gift);
    const dialog = screen.getByRole("dialog", { name: "Support CutVii" });
    expect(within(dialog).getByText(DEFAULT_TEXT.message)).toBeInTheDocument();
    expect(within(dialog).getByText(DEFAULT_TEXT.footer)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Donate" })).toHaveFocus();
  });

  it("asks Rust for one of the two links by name, never with an address", async () => {
    ui();
    fireEvent.click(screen.getByRole("button", { name: "Support CutVii" }));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.click(dialog.getByRole("button", { name: "Donate" }));
    fireEvent.click(dialog.getByRole("button", { name: "Other ways to support" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ["open_support_link", { which: "donate" }],
      ["open_support_link", { which: "support" }],
    ]);
    expect(screen.getByRole("dialog").querySelector("a")).toBeNull(); // no links in the webview

    vi.mocked(invoke).mockRejectedValueOnce("could not open the browser: nope");
    fireEvent.click(dialog.getByRole("button", { name: "Donate" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent("could not open the browser");
  });

  it("closes with Escape or Close and gives the focus back to the button", () => {
    ui();
    const gift = screen.getByRole("button", { name: "Support CutVii" });
    gift.focus();
    fireEvent.click(gift);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(gift).toHaveFocus();
    fireEvent.click(gift);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("always shows a red dot on the gift button, also after the popup has been opened", () => {
    ui();
    expect(screen.getByTestId("support-dot")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Support CutVii" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByTestId("support-dot")).toBeInTheDocument();
  });

  it("the About window has the same two links at the bottom", async () => {
    useUiStore.setState({ aboutOpen: true });
    render(<AboutDialog />);
    const about = within(screen.getByRole("dialog"));
    fireEvent.click(about.getByRole("button", { name: "Donate" }));
    fireEvent.click(about.getByRole("button", { name: "Support CutVii" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ["open_support_link", { which: "donate" }],
      ["open_support_link", { which: "support" }],
    ]);
    useUiStore.setState({ aboutOpen: false });
  });

  it("is also in the File menu, for narrow screens", () => {
    ui();
    fireEvent.click(screen.getByRole("button", { name: "File menu" }));
    const item = screen.getByRole("menuitem", { name: "Support CutVii" });
    expect(item.className).toMatch(/sm:hidden/);
    fireEvent.click(item);
    expect(screen.getByRole("dialog", { name: "Support CutVii" })).toBeInTheDocument();
  });

  it("shows the Indonesian text on an Indonesian system", () => {
    vi.spyOn(navigator, "language", "get").mockReturnValue("id-ID");
    useUiStore.setState({ supportOpen: true });
    render(<SupportDialog />);
    expect(screen.getByRole("dialog", { name: "Dukung CutVii" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Donasi" })).toBeInTheDocument();
    vi.restoreAllMocks();
  });
});
