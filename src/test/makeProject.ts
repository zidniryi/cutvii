import { createProject } from "@/project/factory";
import type { Project } from "@/project/model";
import { parseProject } from "@/project/parse";

export const IDS = {
  v1: "v1",
  v2: "v2",
  a1: "a1",
  vid: "vid",
  vid2: "vid2",
  aud: "aud",
  img: "img",
} as const;

/** 30fps project: tracks v1,v2 (video) + a1 (audio); assets vid(10s) vid2(4s) aud(20s) img. */
export function makeProject(): Project {
  const base = createProject("Test", { fps: 30 });
  const track = (id: string, name: string, type: "video" | "audio", order: number) => ({
    id,
    name,
    type,
    order,
    muted: false,
    hidden: false,
    clips: [],
  });
  return {
    ...base,
    assets: [
      { id: IDS.vid, path: "/m/vid.mp4", type: "video", duration: 10 },
      { id: IDS.vid2, path: "/m/vid2.mp4", type: "video", duration: 4 },
      { id: IDS.aud, path: "/m/aud.mp3", type: "audio", duration: 20 },
      { id: IDS.img, path: "/m/img.png", type: "image" },
    ],
    tracks: [
      track(IDS.v1, "Video 1", "video", 0),
      track(IDS.v2, "Video 2", "video", 1),
      track(IDS.a1, "Audio 1", "audio", 2),
    ],
  };
}

/** Every edit result must still be a valid project file. */
export function expectValid(project: Project) {
  const r = parseProject(project);
  if (!r.ok) throw new Error(`invalid project after edit:\n${r.errors.join("\n")}`);
}
