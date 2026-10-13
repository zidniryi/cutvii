/**
 * Subtitles as a `.srt` file: every text clip is one cue, with the words as typed (a style that draws
 * capitals does not change them). The file is written by Rust, where the native dialog picks the place.
 */
import { invoke } from "@tauri-apps/api/core";
import type { Project } from "@/project/model";
import { useProjectStore } from "@/store/project";
import { useUiStore } from "@/store/ui";
import { clipDuration, findClip } from "./clips";

export interface Cue {
  /** Timeline seconds. */
  start: number;
  end: number;
  text: string;
}

/** The track of a text clip, or null when the clip is not text. */
export function textTrackOf(project: Project, clipId: string): string | null {
  const found = findClip(project, clipId);
  const asset = found && project.assets.find((a) => a.id === found.clip.assetId);
  return found && asset?.text ? found.track.id : null;
}

/**
 * The text clips of one track (or of every track) as cues in time order. A blank line would end a cue in
 * a `.srt` file, so empty lines are left out; a text with no words is no cue.
 */
export function subtitleCues(project: Project, trackId?: string): Cue[] {
  const cues: Cue[] = [];
  for (const track of project.tracks) {
    if (trackId !== undefined && track.id !== trackId) continue;
    for (const clip of track.clips) {
      const spec = project.assets.find((a) => a.id === clip.assetId)?.text;
      if (!spec) continue;
      const text = spec.content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .join("\n");
      if (text) cues.push({ start: clip.timelineStart, end: clip.timelineStart + clipDuration(clip), text });
    }
  }
  return cues.sort((a, b) => a.start - b.start || a.end - b.end);
}

/** `HH:MM:SS,mmm`, the time format of `.srt`. */
export function srtTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(Math.floor(ms / 3_600_000))}:${two(Math.floor(ms / 60_000) % 60)}:${two(
    Math.floor(ms / 1000) % 60,
  )},${String(ms % 1000).padStart(3, "0")}`;
}

/** The cues as the text of a `.srt` file, numbered from 1. A cue shorter than a millisecond is left out. */
export function formatSrt(cues: Cue[]): string {
  return cues
    .filter((cue) => srtTime(cue.end) !== srtTime(cue.start) && cue.end > cue.start)
    .map((cue, i) => `${i + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${cue.text}\n`)
    .join("\n");
}

/**
 * Save subtitles as a `.srt` file: the track of `clipId` when that is a text clip, otherwise every text
 * on the timeline. Says what happened in a notice; returns the path written, or null.
 */
export async function exportSrt(clipId?: string): Promise<string | null> {
  const project = useProjectStore.getState().project;
  const { setNotice } = useUiStore.getState();
  const trackId = (clipId && textTrackOf(project, clipId)) || undefined;
  const cues = subtitleCues(project, trackId);
  const text = formatSrt(cues);
  if (!text) {
    setNotice("There is no text on the timeline to export as subtitles.");
    return null;
  }
  try {
    const path = await invoke<string | null>("export_srt", { name: project.name, text });
    if (path) {
      const count = text.split("\n\n").length;
      setNotice(`Saved ${count} subtitle${count === 1 ? "" : "s"} to ${path}`);
    }
    return path;
  } catch (e) {
    setNotice(`The subtitles could not be saved: ${String(e)}`);
    return null;
  }
}
