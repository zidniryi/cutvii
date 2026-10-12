import type { Project } from "@/project/model";

export type Quality = "draft" | "standard" | "high";

export type ExportFormat = "mp4" | "m4a" | "mp3" | "wav";

export interface ExportOptions {
  width: number;
  height: number;
  fps: number;
  quality: Quality;
  format: ExportFormat;
}

export const FORMATS: { id: ExportFormat; label: string; detail: string; audioOnly: boolean }[] = [
  { id: "mp4", label: "Video", detail: "MP4 · H.264 + AAC", audioOnly: false },
  { id: "m4a", label: "Audio", detail: "M4A · AAC 192 kb/s", audioOnly: true },
  { id: "mp3", label: "Audio (MP3)", detail: "MP3 · 192 kb/s", audioOnly: true },
  { id: "wav", label: "Audio (lossless)", detail: "WAV · 16-bit PCM", audioOnly: true },
];

export const isAudioFormat = (f: ExportFormat) => f !== "mp4";

export interface ResolutionPreset {
  id: string;
  label: string;
  width: number;
  height: number;
}

export const QUALITIES: { id: Quality; label: string; hint: string }[] = [
  { id: "draft", label: "Draft", hint: "Fastest, smaller file, visible compression" },
  { id: "standard", label: "Standard", hint: "Balanced" },
  { id: "high", label: "High", hint: "Slowest, best quality" },
];

/** The largest picture the exporter accepts (the same limit as in Rust, `ExportOptions::validate`). */
export const EXPORT_MAX = { width: 7680, height: 4320 } as const;

/**
 * A size larger than the project in both directions enlarges the picture. That makes it bigger, not
 * sharper: no detail is invented (this is plain scaling, not AI upscaling).
 */
export const isEnlarged = (size: { width: number; height: number }, project: Project) =>
  size.width > project.settings.width + 1 && size.height > project.settings.height + 1;

/** H.264 4:2:0 needs even dimensions. */
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Project size plus common heights at the project's aspect ratio (never distorting it). */
export function resolutionPresets(project: Project): ResolutionPreset[] {
  const { width, height } = project.settings;
  const aspect = width / height;
  const fromHeight = (h: number) => ({ width: even(h * aspect), height: even(h) });

  // 2K and 4K are named after the SHORT side, so a vertical project gets 2160×3840, not a narrow strip
  const fromShortSide = (s: number) =>
    width >= height
      ? { width: even(s * aspect), height: even(s) }
      : { width: even(s), height: even(s / aspect) };
  const list: ResolutionPreset[] = [
    { id: "project", label: "Project size", width: even(width), height: even(height) },
    ...[1080, 720, 480].map((h) => ({ id: `${h}p`, label: `${h}p`, ...fromHeight(h) })),
    { id: "1440p", label: "2K", ...fromShortSide(1440) },
    { id: "2160p", label: "4K", ...fromShortSide(2160) },
  ].filter((p) => p.width <= EXPORT_MAX.width && p.height <= EXPORT_MAX.height);
  const seen = new Set<string>();
  return list.filter((p) => {
    const key = `${p.width}x${p.height}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function fpsChoices(project: Project): number[] {
  return [...new Set([24, 25, 30, 50, 60, Math.round(project.settings.fps)])].sort((a, b) => a - b);
}

export function defaultOptions(project: Project): ExportOptions {
  const size = resolutionPresets(project)[0];
  return {
    width: size.width,
    height: size.height,
    fps: Math.min(120, Math.max(1, project.settings.fps)),
    quality: "standard",
    format: "mp4",
  };
}
