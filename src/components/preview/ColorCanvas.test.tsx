import { StrictMode } from "react";
import { render } from "@testing-library/react";
import { ColorCanvas } from "./ColorCanvas";

/** A stand-in for a WebGL 2 context: every call succeeds; `loseContext` is counted. */
function fakeGl() {
  const lost = vi.fn();
  const calls: Record<string, ReturnType<typeof vi.fn>> = {};
  const gl = new Proxy(
    {},
    {
      get: (_, name: string) => {
        if (name === "getExtension") return () => ({ loseContext: lost });
        return (calls[name] ??= vi.fn(() => ({})));
      },
    },
  );
  return { gl, lost, calls };
}

describe("the colour canvas", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps its GPU context through React's development double-mount, and frees it when really gone", () => {
    vi.useFakeTimers();
    const { gl, lost, calls } = fakeGl();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(gl as never);
    const lut = { size: 2, table: new Float32Array(24) };
    const view = render(
      <StrictMode>
        <ColorCanvas source={() => null} lut={lut} live={false} />
      </StrictMode>,
    );
    // development mode set the canvas up, cleaned it up and set it up again
    expect(calls.linkProgram).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(50);
    expect(lost).not.toHaveBeenCalled(); // the canvas on screen still has a live context
    expect(calls.texImage3D).toHaveBeenCalled(); // and its table was uploaded

    view.unmount();
    expect(lost).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(lost).toHaveBeenCalledTimes(1);
  });
});
