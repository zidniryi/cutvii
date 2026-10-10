import { SCHEMA_VERSION, type Project, type ProjectSettings } from "./model";

export const DEFAULT_SETTINGS: ProjectSettings = {
  width: 1920,
  height: 1080,
  fps: 30,
  backgroundColor: "#000000",
};

export function createProject(name = "Untitled project", settings: Partial<ProjectSettings> = {}): Project {
  const now = new Date().toISOString();
  const track = (type: "video" | "audio", label: string, order: number) => ({
    id: crypto.randomUUID(),
    name: label,
    type,
    order,
    muted: false,
    hidden: false,
    clips: [],
  });
  return {
    id: crypto.randomUUID(),
    name,
    schemaVersion: SCHEMA_VERSION,
    createdAt: now,
    modifiedAt: now,
    settings: { ...DEFAULT_SETTINGS, ...settings },
    assets: [],
    tracks: [track("video", "Video 1", 0), track("audio", "Audio 1", 1)],
  };
}
