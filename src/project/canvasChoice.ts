import {
  canvasFromAsset,
  canvasFromValues,
  canvasLabel,
  canvasOf,
  FALLBACK_CANVAS,
  PLATFORM_TEMPLATES,
  toNumber,
  validateCanvas,
  type Canvas,
  type CanvasErrors,
} from "./canvas";
import type { Project } from "./model";
import type { SavedTemplate } from "@/store/canvasTemplates";

/** What the user picked in the New Project / Canvas dialogs. Custom values stay as text until validated. */
export type CanvasChoice =
  | { kind: "template"; id: string }
  | { kind: "saved"; id: string }
  | { kind: "original" }
  | { kind: "custom"; width: string; height: string; fps: string };

export type ResolvedChoice =
  | {
      ok: true;
      canvas: Canvas;
      /** Original with nothing to follow yet: keep a provisional canvas until the first media arrives. */
      pending: boolean;
      /** Something the user should be told (a fallback, an adjustment). */
      note?: string;
    }
  | { ok: false; errors: CanvasErrors };

/**
 * Turn a choice into a canvas. `project` is given when changing an existing project: "Original" then
 * follows the first video already in it.
 */
export function resolveChoice(
  choice: CanvasChoice,
  saved: SavedTemplate[],
  project?: Project,
): ResolvedChoice {
  switch (choice.kind) {
    case "template": {
      const t = PLATFORM_TEMPLATES.find((x) => x.id === choice.id);
      return t
        ? { ok: true, canvas: canvasFromValues(t.width, t.height, t.fps), pending: false }
        : { ok: false, errors: { width: "Unknown template" } };
    }
    case "saved": {
      const t = saved.find((x) => x.id === choice.id);
      return t
        ? { ok: true, canvas: canvasFromValues(t.width, t.height, t.fps), pending: false }
        : { ok: false, errors: { width: "That template no longer exists" } };
    }
    case "custom": {
      const r = validateCanvas({
        width: toNumber(choice.width),
        height: toNumber(choice.height),
        fps: toNumber(choice.fps),
      });
      return r.ok ? { ok: true, canvas: r.canvas, pending: false } : r;
    }
    case "original": {
      if (!project) return { ok: true, canvas: { ...FALLBACK_CANVAS }, pending: true };
      const firstVideo = project.assets.find((a) => a.type === "video");
      if (firstVideo) {
        const o = canvasFromAsset(firstVideo);
        const note = o.notes.length ? `Adjusted: ${o.notes.join("; ")}.` : undefined;
        return {
          ok: true,
          canvas: o.canvas,
          pending: false,
          note: o.fallback ? `${o.notes[0]}. Using ${canvasLabel(o.canvas)}.` : note,
        };
      }
      if (project.assets.length === 0) return { ok: true, canvas: canvasOf(project), pending: true };
      return {
        ok: true,
        canvas: { ...FALLBACK_CANVAS },
        pending: false,
        note: `There is no video in the project yet, so the canvas is ${canvasLabel(FALLBACK_CANVAS)}.`,
      };
    }
  }
}
