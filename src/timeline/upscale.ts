/**
 * AI upscale of a picture clip (section 6c). Rust enlarges the picture with a downloaded model and writes a
 * new PNG; here the clip is pointed at that new picture as ONE undoable step. The original file and its
 * library entry stay as they are, so Undo, or "Replace media", brings the original back.
 */
import type { MediaAsset, Project } from "@/project/model";
import { findClip } from "./clips";
import type { EditResult } from "./edit";

export type UpscaleFactor = 2 | 4;
/** The longer side a picture may have to be upscaled (the same limit as in Rust). */
export const MAX_UPSCALE_SIDE = 2048;

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
  if (asset.type !== "image") return "AI upscale works on picture clips for now. Video is coming.";
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
