import type { MediaAsset, MediaType, Project } from "./model";

/** What the media engine reports about a candidate replacement file. */
export interface ReplacementMedia {
  path: string;
  mediaType: MediaType;
  duration?: number;
  width?: number;
  height?: number;
  thumbnailPath?: string;
  /** A still whose pixels were found to be partly see-through. */
  alpha?: boolean;
}

export type RelinkResult = { ok: true; project: Project } | { ok: false; reason: string };

const TOLERANCE = 1e-3;

/** Point an asset at a new file, if the new file can actually serve the clips that use it. */
export function relinkAsset(project: Project, assetId: string, media: ReplacementMedia): RelinkResult {
  const asset = project.assets.find((a) => a.id === assetId);
  if (!asset) return { ok: false, reason: "That media is no longer in the project." };

  if (media.mediaType !== asset.type) {
    return { ok: false, reason: `The original is ${asset.type} but the chosen file is ${media.mediaType}.` };
  }
  if (project.assets.some((a) => a.id !== assetId && a.path === media.path)) {
    return { ok: false, reason: "That file is already in the project as different media." };
  }

  const usedUntil = Math.max(
    0,
    ...project.tracks.flatMap((t) => t.clips.filter((c) => c.assetId === assetId).map((c) => c.sourceOut)),
  );
  if (asset.type !== "image" && media.duration !== undefined && usedUntil > media.duration + TOLERANCE) {
    return {
      ok: false,
      reason: `The chosen file is ${media.duration.toFixed(1)}s long, but clips use it up to ${usedUntil.toFixed(1)}s.`,
    };
  }

  const next: MediaAsset = { id: asset.id, path: media.path, type: asset.type };
  if (media.duration !== undefined) next.duration = media.duration;
  if (media.width !== undefined) next.width = media.width;
  if (media.height !== undefined) next.height = media.height;
  if (media.thumbnailPath !== undefined) next.thumbnailPath = media.thumbnailPath;
  // the new file decides whether the picture is see-through
  if (asset.type === "image" && media.alpha) next.alpha = true;

  return {
    ok: true,
    project: { ...project, assets: project.assets.map((a) => (a.id === assetId ? next : a)) },
  };
}
