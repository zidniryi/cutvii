/**
 * AI upscale of a picture clip (section 6c). Rust enlarges the picture with a downloaded model and writes a
 * new PNG; here the clip is pointed at that new picture as ONE undoable step. The original file and its
 * library entry stay as they are, so Undo, or "Replace media", brings the original back.
 */
import type { Keyframes, MediaAsset, Project, TimelineClip } from "@/project/model";
import { findClip, sourceDuration } from "./clips";
import type { EditResult } from "./edit";
import { KEY_PROPS, valueAt } from "./transform";

export type UpscaleFactor = 2 | 4;
/** The longer side a picture may have to be upscaled (the same limit as in Rust). */
export const MAX_UPSCALE_SIDE = 2048;

/** The longer side a video may have, and the longest stretch of it (the same limits as in Rust). */
export const MAX_UPSCALE_VIDEO_SIDE = 1280;
/** 3000 frames at 30 fps. Rust counts the real frames and has the last word. */
export const MAX_UPSCALE_VIDEO_SECONDS = 100;

export interface UpscaledVideo {
  path: string;
  width: number;
  height: number;
  /** Seconds. The new file holds only the stretch the clip used, starting at 0. */
  duration: number;
}

export interface UpscaledPicture {
  path: string;
  width: number;
  height: number;
}

/** Why a clip cannot be upscaled with AI, or null. Pictures only for now. */
export function upscaleBlocker(project: Project, clipId: string): string | null {
  const found = findClip(project, clipId);
  const asset = found && project.assets.find((a) => a.id === found.clip.assetId);
  if (!found || !asset) return "The clip is missing from the project.";
  if (asset.text) return "Text is drawn sharp at any size already.";
  if (asset.type === "audio" || found.track.type === "audio") return "Sound has no picture to upscale.";
  if (asset.type === "video") {
    if (asset.width && asset.height && Math.max(asset.width, asset.height) > MAX_UPSCALE_VIDEO_SIDE)
      return `This video is ${asset.width}×${asset.height}. AI upscale takes video up to ${MAX_UPSCALE_VIDEO_SIDE} px on the longer side.`;
    const used = sourceDuration(found.clip);
    if (used > MAX_UPSCALE_VIDEO_SECONDS)
      return `This clip uses ${Math.round(used)} s of its video. AI upscale takes up to ${MAX_UPSCALE_VIDEO_SECONDS} s at a time: trim or split the clip.`;
    return null;
  }
  if (asset.width && asset.height && Math.max(asset.width, asset.height) > MAX_UPSCALE_SIDE)
    return `This picture is ${asset.width}×${asset.height}. AI upscale takes pictures up to ${MAX_UPSCALE_SIDE} px on the longer side.`;
  return null;
}

/** The size a picture will have after upscaling, when its size is known. */
export function upscaledSize(
  asset: Pick<MediaAsset, "width" | "height">,
  factor: UpscaleFactor,
): { width: number; height: number } | null {
  if (!asset.width || !asset.height) return null;
  // 2x is "four times, then halved", so odd sizes round down like the halving does
  return factor === 4
    ? { width: asset.width * 4, height: asset.height * 4 }
    : { width: Math.floor((asset.width * 4) / 2), height: Math.floor((asset.height * 4) / 2) };
}

/**
 * Point a picture clip at its upscaled copy: the copy joins the project's media and the clip uses it.
 * Everything else about the clip (place, length, fit, crop, colour) is kept. Pure.
 */
export function applyUpscaledPicture(
  project: Project,
  clipId: string,
  picture: UpscaledPicture,
  assetId: string,
): EditResult {
  const found = findClip(project, clipId);
  const old = found && project.assets.find((a) => a.id === found.clip.assetId);
  if (!found || !old)
    return { ok: false, error: { code: "unknown-clip", message: `Unknown clip ${clipId}` } };
  if (old.type !== "image" || old.text) {
    return {
      ok: false,
      error: { code: "incompatible-track", message: "Only picture clips can be upscaled" },
    };
  }
  // the same upscaled file may already be in the project (another clip of the same picture)
  const existing = project.assets.find((a) => a.path === picture.path);
  const asset: MediaAsset = existing ?? {
    id: assetId,
    path: picture.path,
    type: "image",
    width: picture.width,
    height: picture.height,
  };
  if (found.clip.assetId === asset.id) return { ok: true, project };
  return {
    ok: true,
    project: {
      ...project,
      assets: existing ? project.assets : [...project.assets, asset],
      tracks: project.tracks.map((t) =>
        t.id === found.track.id
          ? { ...t, clips: t.clips.map((c) => (c.id === clipId ? { ...c, assetId: asset.id } : c)) }
          : t,
      ),
    },
  };
}

/** Keyframes of a clip whose source now starts at `from`: times move with it, and each property keeps the
 * value it had at the new start. */
function shiftKeys(keys: Keyframes, from: number): Keyframes {
  const out: Keyframes = {};
  for (const prop of KEY_PROPS) {
    const list = keys[prop];
    if (!list || list.length === 0) continue;
    const later = list.filter((k) => k.t > from + 1e-6).map((k) => ({ t: k.t - from, v: k.v }));
    out[prop] = [{ t: 0, v: valueAt(list, from) }, ...later];
  }
  return out;
}

/**
 * Point a video clip at the upscaled copy of the stretch it used. The copy starts at 0, so the clip's
 * source range (and its keyframes, which are source times) move with it; place, speed, reverse, crop,
 * colour and everything else are kept, and the clip never gets longer than it was. Pure.
 */
export function applyUpscaledVideo(
  project: Project,
  clipId: string,
  video: UpscaledVideo,
  assetId: string,
): EditResult {
  const found = findClip(project, clipId);
  const old = found && project.assets.find((a) => a.id === found.clip.assetId);
  if (!found || !old)
    return { ok: false, error: { code: "unknown-clip", message: `Unknown clip ${clipId}` } };
  if (old.type !== "video" || found.track.type !== "video") {
    return {
      ok: false,
      error: { code: "incompatible-track", message: "Only video clips on a video track can be upscaled" },
    };
  }
  const existing = project.assets.find((a) => a.path === video.path);
  const asset: MediaAsset = existing ?? {
    id: assetId,
    path: video.path,
    type: "video",
    duration: video.duration,
    width: video.width,
    height: video.height,
  };
  if (found.clip.assetId === asset.id) return { ok: true, project };
  const change = (c: TimelineClip): TimelineClip => {
    const out: TimelineClip = {
      ...c,
      assetId: asset.id,
      sourceIn: 0,
      sourceOut: Math.min(sourceDuration(c), video.duration),
    };
    if (c.keyframes) out.keyframes = shiftKeys(c.keyframes, c.sourceIn);
    return out;
  };
  return {
    ok: true,
    project: {
      ...project,
      assets: existing ? project.assets : [...project.assets, asset],
      tracks: project.tracks.map((t) =>
        t.id === found.track.id ? { ...t, clips: t.clips.map((c) => (c.id === clipId ? change(c) : c)) } : t,
      ),
    },
  };
}
