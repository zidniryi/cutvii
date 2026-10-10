import type { MediaAsset, Project } from "./model";

export type AddAssetResult =
  { ok: true; project: Project } | { ok: false; reason: "duplicate"; existing: MediaAsset };

const touch = (project: Project): Project => ({ ...project, modifiedAt: new Date().toISOString() });

/** Paths are compared exactly (case-sensitive, no symlink resolution). */
export function findAssetByPath(project: Project, path: string): MediaAsset | undefined {
  return project.assets.find((a) => a.path === path);
}

/** Duplicate-import guard: the same file is never added twice. */
export function addAsset(project: Project, asset: MediaAsset): AddAssetResult {
  const existing = findAssetByPath(project, asset.path);
  if (existing) return { ok: false, reason: "duplicate", existing };
  return { ok: true, project: touch({ ...project, assets: [...project.assets, asset] }) };
}

/** Removes the asset and any clips using it from the project. Never touches the file on disk. */
export function removeAsset(project: Project, assetId: string): Project {
  return touch({
    ...project,
    assets: project.assets.filter((a) => a.id !== assetId),
    tracks: project.tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => c.assetId !== assetId) })),
  });
}
