import { SAFE_MARGIN } from "@/timeline/textPosition";

/** Guide lines over the preview while a text is dragged: the safe zone, and the lines it snapped onto. */
export function PositionGuides({
  safe,
  vertical,
  horizontal,
}: {
  safe: boolean;
  vertical: number[];
  horizontal: number[];
}) {
  const pct = (share: number) => `${share * 100}%`;
  return (
    <div data-testid="position-guides" aria-hidden className="pointer-events-none absolute inset-0 z-30">
      {safe && (
        <div
          data-guide="safe-zone"
          className="absolute border border-dashed border-white/40"
          style={{ inset: pct(SAFE_MARGIN) }}
        />
      )}
      {vertical.map((x) => (
        <div
          key={`v${x}`}
          data-guide={`vertical-${x}`}
          className="absolute inset-y-0 w-px bg-accent"
          style={{ left: pct(x) }}
        />
      ))}
      {horizontal.map((y) => (
        <div
          key={`h${y}`}
          data-guide={`horizontal-${y}`}
          className="absolute inset-x-0 h-px bg-accent"
          style={{ top: pct(y) }}
        />
      ))}
    </div>
  );
}
