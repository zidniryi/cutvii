import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { useFocusTrap } from "./useFocusTrap";

function Harness({ open }: { open: boolean }) {
  return (
    <div>
      <button>outside</button>
      {open && <Dialog />}
    </div>
  );
}
function Dialog() {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref);
  return (
    <div ref={ref} role="dialog">
      <button>first</button>
      <button>second</button>
    </div>
  );
}

describe("useFocusTrap", () => {
  it("focuses inside, cycles Tab and Shift+Tab, and restores focus on close", async () => {
    const { rerender } = render(<Harness open={false} />);
    screen.getByRole("button", { name: "outside" }).focus();

    rerender(<Harness open />);
    expect(screen.getByRole("button", { name: "first" })).toHaveFocus();

    await userEvent.tab();
    expect(screen.getByRole("button", { name: "second" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "first" })).toHaveFocus(); // wrapped, not escaped
    await userEvent.tab({ shift: true });
    expect(screen.getByRole("button", { name: "second" })).toHaveFocus();

    rerender(<Harness open={false} />);
    expect(screen.getByRole("button", { name: "outside" })).toHaveFocus();
  });
});
