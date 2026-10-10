/// <reference types="node" />
import { readFileSync } from "node:fs";

const css = readFileSync("src/index.css", "utf8"); // vitest runs from the project root;

/** WCAG relative luminance / contrast ratio for #RRGGBB. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const token = (name: string) => {
  const m = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!m) throw new Error(`token --${name} not found`);
  return m[1];
};

describe("design token contrast (WCAG AA, 4.5:1 for text)", () => {
  const surfaces = ["bg", "surface-1", "surface-2"];

  it.each(surfaces)("primary and muted text on %s", (s) => {
    expect(ratio(token("text"), token(s))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(token("text-muted"), token(s))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(surfaces)("accent and danger/success text on %s", (s) => {
    expect(ratio(token("accent"), token(s))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(token("danger"), token(s))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(token("success"), token(s))).toBeGreaterThanOrEqual(4.5);
  });

  it("button label on the accent fill", () => {
    expect(ratio("#0b0b0c", token("accent"))).toBeGreaterThanOrEqual(4.5);
  });

  it("clip labels are readable on every clip colour", () => {
    for (const c of ["clip-video", "clip-audio", "clip-image"]) {
      expect(ratio(token("text"), token(c)), c).toBeGreaterThanOrEqual(4.5);
    }
  });
});
