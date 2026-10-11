/** Text and titles: a text clip is an image asset whose picture CutVii draws from its `text` properties. */
import { invoke } from "@tauri-apps/api/core";
import {
  TextSpecSchema,
  type MediaAsset,
  type Project,
  type StylePreset,
  type TextSpec,
  type TimelineClip,
} from "@/project/model";
import { withStyle } from "./textStyles";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useUiStore } from "@/store/ui";
import { clipEnd, EPS } from "./clips";
import { addClip, addTrack, DEFAULT_IMAGE_DURATION, type EditResult } from "./edit";

export const TEXT_FONT_LIMITS = { min: 8, max: 2000 } as const;
/** New text is this tall, as a share of the canvas height. */
const DEFAULT_FONT_SHARE = 0.09;

export function defaultTextSpec(canvasHeight: number): TextSpec {
  const size = Math.round(canvasHeight * DEFAULT_FONT_SHARE);
  return {
    content: "Text",
    fontSize: Math.min(TEXT_FONT_LIMITS.max, Math.max(TEXT_FONT_LIMITS.min, size)),
    color: "#FFFFFF",
    bold: true,
    align: "center",
    x: 0.5,
    y: 0.5,
  };
}

/**
 * Where new text goes: the top video track when it is free for the whole clip, otherwise a new track above
 * everything (null), so text never ends up underneath the picture it is meant to sit on.
 */
export function textTrackFor(project: Project, start: number, duration: number): string | null {
  const top = project.tracks.filter((t) => t.type === "video").sort((a, b) => b.order - a.order)[0];
  if (!top) return null;
  const busy = top.clips.some((c) => c.timelineStart < start + duration - EPS && start < clipEnd(c) - EPS);
  return busy ? null : top.id;
}

/** Add a drawn text picture as an asset and put it on the timeline at `start`. One undoable step. */
export function addTextClip(
  project: Project,
  args: { picture: string; spec: TextSpec; start: number; assetId: string; clipId: string; trackId: string },
): EditResult {
  const { width, height } = project.settings;
  const asset: MediaAsset = {
    id: args.assetId,
    path: args.picture,
    type: "image",
    width,
    height,
    text: args.spec,
  };
  let next: Project = { ...project, assets: [...project.assets, asset] };
  const existing = textTrackFor(project, args.start, DEFAULT_IMAGE_DURATION);
  if (!existing) {
    const added = addTrack(next, "video", args.trackId);
    if (!added.ok) return added;
    next = added.project;
  }
  return addClip(next, {
    assetId: asset.id,
    trackId: existing ?? args.trackId,
    start: args.start,
    id: args.clipId,
  });
}

/** "Add text": draw the default text for this canvas (in Rust) and place it at the playhead. */
export async function addTextAtPlayhead(preset?: StylePreset): Promise<void> {
  const { width, height } = useProjectStore.getState().project.settings;
  const plain = defaultTextSpec(height);
  const spec = preset ? withStyle(plain, preset.style) : plain;
  let picture: string;
  try {
    picture = await invoke<string>("render_text", { spec, width, height });
  } catch (e) {
    const reason = typeof e === "string" ? e : e instanceof Error ? e.message : "unknown error";
    useUiStore.getState().setNotice(`Could not add text: ${reason}`);
    return;
  }
  const clipId = crypto.randomUUID();
  const result = useProjectStore.getState().execute({
    label: "Add text",
    apply: (p) => {
      const added = addTextClip(p, {
        picture,
        spec,
        start: usePlaybackStore.getState().playhead,
        assetId: crypto.randomUUID(),
        clipId,
        trackId: crypto.randomUUID(),
      });
      return added.ok && preset?.fade ? setTextFade(added.project, clipId, preset.fade) : added;
    },
  });
  if (result.ok) useSelectionStore.getState().select(clipId);
  else useUiStore.getState().setNotice(result.error.message);
}

/**
 * Point a text clip at a freshly drawn picture of its edited text. A text shared by several clips (the halves
 * of a split) is copied first, so editing one clip never changes another.
 */
export function applyTextEdit(
  project: Project,
  args: {
    clipId: string;
    picture: string;
    spec: TextSpec;
    newAssetId: string;
    /** Also set how long the text fades in and out (seconds; 0 for none). Left alone when absent. */
    fade?: number;
  },
): EditResult {
  const clip = project.tracks.flatMap((t) => t.clips).find((c) => c.id === args.clipId);
  const asset = clip && project.assets.find((a) => a.id === clip.assetId);
  if (!clip || !asset?.text) {
    return { ok: false, error: { code: "unknown-clip", message: "That text is no longer on the timeline" } };
  }
  const { width, height } = project.settings;
  const edited: MediaAsset = { ...asset, path: args.picture, width, height, text: args.spec };
  const shared = project.tracks.flatMap((t) => t.clips).filter((c) => c.assetId === asset.id).length > 1;
  const assetId = shared ? args.newAssetId : asset.id;
  return {
    ok: true,
    project: {
      ...project,
      assets: shared
        ? [...project.assets, { ...edited, id: assetId }]
        : project.assets.map((a) => (a.id === asset.id ? edited : a)),
      tracks:
        shared || args.fade !== undefined
          ? project.tracks.map((t) => ({
              ...t,
              clips: t.clips.map((c) => (c.id === clip.id ? withFade({ ...c, assetId }, args.fade) : c)),
            }))
          : project.tracks,
    },
  };
}

/** The longest a text can fade in or out (the stored limit for any fade). */
export const MAX_TEXT_FADE = 60;

/** A clip with its fade in and out set to `seconds` (0 removes them); untouched when `seconds` is absent. */
function withFade(clip: TimelineClip, seconds: number | undefined): TimelineClip {
  if (seconds === undefined) return clip;
  const out = { ...clip };
  if (seconds > 0) {
    out.fadeIn = seconds;
    out.fadeOut = seconds;
  } else {
    delete out.fadeIn;
    delete out.fadeOut;
  }
  return out;
}

/** Set how long a text clip fades in and out. One undoable step; nothing is redrawn. */
export function setTextFade(project: Project, clipId: string, seconds: number): EditResult {
  const clip = project.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
  const asset = clip && project.assets.find((a) => a.id === clip.assetId);
  if (!clip || !asset?.text) {
    return { ok: false, error: { code: "unknown-clip", message: "That text is no longer on the timeline" } };
  }
  if (!(seconds >= 0 && seconds <= MAX_TEXT_FADE)) {
    return { ok: false, error: { code: "out-of-range", message: "A fade can be 0 to 60 seconds" } };
  }
  if ((clip.fadeIn ?? 0) === seconds && (clip.fadeOut ?? 0) === seconds) return { ok: true, project };
  return {
    ok: true,
    project: {
      ...project,
      tracks: project.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => (c.id === clipId ? withFade(c, seconds) : c)),
      })),
    },
  };
}

/** The newest requested text per clip while its picture is still being drawn. */
const pendingSpecs = new Map<string, { spec: TextSpec; turn: number }>();
let turns = 0;

/**
 * Change some properties of a text clip: draw the new picture (in Rust), then swap it in as one undoable
 * step. Quick successive edits build on each other, and only the newest picture is applied.
 * Returns a message when the change is not valid, otherwise null.
 */
export function editText(clipId: string, patch: Partial<TextSpec>): Promise<string | null> {
  return changeText(clipId, (current) => ({ ...current, ...patch }), "Edit text");
}

/**
 * Give a text clip a style preset: its look is replaced, its words, size and place are kept, and the
 * preset's fade (if any) is set on the clip. ONE undoable step.
 */
export function applyTextStyle(clipId: string, preset: StylePreset): Promise<string | null> {
  return changeText(
    clipId,
    (current) => withStyle(current, preset.style),
    "Change text style",
    preset.fade ?? 0,
  );
}

async function changeText(
  clipId: string,
  change: (current: TextSpec) => TextSpec,
  label: string,
  fade?: number,
): Promise<string | null> {
  const project = useProjectStore.getState().project;
  const clip = project.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
  const stored = clip && project.assets.find((a) => a.id === clip.assetId)?.text;
  if (!stored) return "That text is no longer on the timeline";

  const parsed = TextSpecSchema.safeParse(change(pendingSpecs.get(clipId)?.spec ?? stored));
  if (!parsed.success) return parsed.error.issues[0]?.message ?? "Invalid text";
  const spec = parsed.data;
  const turn = ++turns;
  pendingSpecs.set(clipId, { spec, turn });

  const { width, height } = project.settings;
  try {
    const picture = await invoke<string>("render_text", { spec, width, height });
    if (pendingSpecs.get(clipId)?.turn !== turn) return null; // a newer edit is on its way
    const result = useProjectStore.getState().execute({
      label,
      apply: (p) => applyTextEdit(p, { clipId, picture, spec, newAssetId: crypto.randomUUID(), fade }),
    });
    return result.ok ? null : result.error.message;
  } catch (e) {
    const reason = typeof e === "string" ? e : e instanceof Error ? e.message : "unknown error";
    return `Could not draw the text: ${reason}`;
  } finally {
    if (pendingSpecs.get(clipId)?.turn === turn) pendingSpecs.delete(clipId);
  }
}

/**
 * Keep text pictures the size of the canvas: when the canvas changes (or an undo brings back an older
 * picture), draw them again. Not an undo step of its own; it follows whatever changed the canvas.
 */
export function watchTextPictures(): () => void {
  const busy = new Set<string>(); // also remembers failures, so a picture that cannot be drawn is not retried forever
  const check = () => {
    const { project } = useProjectStore.getState();
    const { width, height } = project.settings;
    for (const asset of project.assets) {
      const spec = asset.text;
      if (!spec || (asset.width === width && asset.height === height)) continue;
      const key = `${asset.id}:${width}x${height}:${JSON.stringify(spec)}`;
      if (busy.has(key)) continue;
      busy.add(key);
      Promise.resolve(invoke<string>("render_text", { spec, width, height })).then(
        (picture) => {
          if (typeof picture !== "string") return;
          busy.delete(key);
          useProjectStore.setState((s) => {
            const now = s.project.settings;
            if (now.width !== width || now.height !== height) return s;
            return {
              project: {
                ...s.project,
                assets: s.project.assets.map((a) =>
                  a.id === asset.id && a.text === spec ? { ...a, path: picture, width, height } : a,
                ),
              },
            };
          });
        },
        () => {
          /* left as it is: the old picture is still shown, scaled to fit */
        },
      );
    }
  };
  check();
  return useProjectStore.subscribe(check);
}

/** Rough width of a character as a share of the font size (the real picture is drawn in Rust). */
const CHAR_WIDTH = 0.62;
const LINE_HEIGHT = 1.25;
const WRAP_WIDTH = 0.9;
const HIT_PADDING = 0.02;

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * About where a text sits on the canvas, as shares of its width and height: good enough to tell whether a
 * pointer is on the text. Follows the same layout rules as the renderer (90% wrap width, alignment).
 */
export function textHitBox(spec: TextSpec, canvasWidth: number, canvasHeight: number): Box {
  const lineWidth = (chars: number) => (chars * spec.fontSize * CHAR_WIDTH) / canvasWidth;
  const lines = spec.content.split("\n");
  const width = Math.min(WRAP_WIDTH, Math.max(...lines.map((l) => lineWidth(l.length))));
  const rows = lines.reduce((n, l) => n + Math.max(1, Math.ceil(lineWidth(l.length) / WRAP_WIDTH)), 0);
  const height = (rows * spec.fontSize * LINE_HEIGHT) / canvasHeight;
  const align = spec.align ?? "center";
  const centre =
    align === "left"
      ? spec.x - WRAP_WIDTH / 2 + width / 2
      : align === "right"
        ? spec.x + WRAP_WIDTH / 2 - width / 2
        : spec.x;
  return {
    left: centre - width / 2 - HIT_PADDING,
    right: centre + width / 2 + HIT_PADDING,
    top: spec.y - height / 2 - HIT_PADDING,
    bottom: spec.y + height / 2 + HIT_PADDING,
  };
}
