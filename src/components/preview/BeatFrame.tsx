import { useId, type CSSProperties, type ReactNode } from "react";
import type { Look } from "@/timeline/beatFxMath";

/**
 * The picture of a clip with beat effects: a clipping frame (the fitted, cropped picture), the picture
 * inside it zoomed / shaken by `look.transform`, a white mix for a flash and, for a glitch, red and blue
 * moved apart by an SVG filter. The export does the same on the same picture before it is fitted.
 */
export function BeatFrame({
  look,
  style,
  children,
}: {
  look: Look;
  /** Where the frame sits (the fitted picture's rectangle). */
  style: CSSProperties;
  children: ReactNode;
}) {
  const id = useId().replace(/:/g, "");
  const split = look.split > 0;
  return (
    <div data-role="beat-frame" className="absolute overflow-hidden" style={style}>
      <div
        data-role="beat-inner"
        className="absolute inset-0"
        style={{
          transformOrigin: "0 0",
          transform: look.transform,
          filter: split ? `url(#beat-split-${id})` : undefined,
        }}
      >
        {children}
      </div>
      {look.flash > 0 && (
        <div data-role="beat-flash" className="absolute inset-0 bg-white" style={{ opacity: look.flash }} />
      )}
      {split && (
        <svg width="0" height="0" className="absolute" aria-hidden>
          <filter
            id={`beat-split-${id}`}
            x="0"
            y="0"
            width="1"
            height="1"
            primitiveUnits="objectBoundingBox"
            colorInterpolationFilters="sRGB"
          >
            <feColorMatrix
              in="SourceGraphic"
              type="matrix"
              values="1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0"
              result="r"
            />
            <feColorMatrix
              in="SourceGraphic"
              type="matrix"
              values="0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 1 0"
              result="g"
            />
            <feColorMatrix
              in="SourceGraphic"
              type="matrix"
              values="0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0"
              result="b"
            />
            <feOffset in="r" dx={look.split} dy="0" result="r2" />
            <feOffset in="b" dx={-look.split} dy="0" result="b2" />
            <feBlend in="r2" in2="g" mode="screen" result="rg" />
            <feBlend in="rg" in2="b2" mode="screen" />
          </filter>
        </svg>
      )}
    </div>
  );
}
