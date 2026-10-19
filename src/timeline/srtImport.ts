/**
 * Import subtitles from a `.srt` file. Rust opens the native dialog and reads the file as untrusted text
 * (`open_srt_file`: `.srt` only, 1 MB, UTF-8); the cues are parsed here (`parseSrt`, markup removed). The
 * Import subtitles dialog then shows them with the subtitle look (style, place, size), the caption length and a
 * time shift; Import cuts them into readable captions by the one splitter, draws them and puts them on a new
 * subtitle track as ONE undo step. Cue times are timeline times plus the shift: 00:00:01,000 with no shift
 * lands at 1 s on the timeline.
 */
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { DEFAULT_STYLE, subtitleStyleOf, useTextStyleStore } from "@/store/textStyles";
import { useProjectStore } from "@/store/project";
import { useUiStore } from "@/store/ui";
import { parseSrt } from "./karaoke";
import { limitsFor } from "./resplit";
import { placeSubtitles, type Subtitle, type SubtitleResult } from "./subtitles";

/** The cues of an `.srt` text as subtitles, in time order. */
export function srtSubtitles(text: string): Subtitle[] {
  return parseSrt(text)
    .filter((c) => c.end > c.start)
    .map((c) => ({ start: c.start, duration: c.end - c.start, text: c.text }));
}

/** The subtitles moved by `shift` seconds. A cue moved before 0 is cut at 0; one that ends by then is dropped. */
export function shiftSubtitles(subtitles: Subtitle[], shift: number): Subtitle[] {
  return subtitles.flatMap((s) => {
    const start = Math.max(0, s.start + shift);
    const end = s.start + s.duration + shift;
    return end > start + 1e-6 ? [{ ...s, start, duration: end - start }] : [];
  });
}

export interface SrtFile {
  name: string;
  subtitles: Subtitle[];
}
export type SrtRead = { ok: true; file: SrtFile } | { ok: false; reason: string };

/** Pick and read an `.srt` file. `null` when the user cancels the dialog. */
export async function readSrt(): Promise<SrtRead | null> {
  let file: { name: string; text: string } | null;
  try {
    file = await invoke<{ name: string; text: string } | null>("open_srt_file");
  } catch (e) {
    return { ok: false, reason: `Could not read the subtitles: ${typeof e === "string" ? e : String(e)}` };
  }
  if (!file) return null;
  const subtitles = srtSubtitles(file.text);
  if (subtitles.length === 0) return { ok: false, reason: `No subtitles were found in ${file.name}` };
  return { ok: true, file: { name: file.name, subtitles } };
}

/** Add the subtitles, moved by `shift` seconds, in the subtitle look and caption length chosen now. */
export async function placeSrt(
  subtitles: Subtitle[],
  shift = 0,
  onStage?: (stage: string) => void,
): Promise<SubtitleResult> {
  const moved = shiftSubtitles(subtitles, shift);
  if (moved.length === 0) return { ok: false, reason: "Every subtitle would be before the start" };
  const styles = useTextStyleStore.getState();
  const subtitle = subtitleStyleOf(styles);
  const { width, height } = useProjectStore.getState().project.settings;
  return placeSubtitles(moved, {
    label: "Import subtitles",
    language: null,
    endLimit: Math.max(...moved.map((s) => s.start + s.duration)),
    onStage,
    // the same look, place, size and caption length as auto subtitles
    style:
      subtitle.id === DEFAULT_STYLE && !subtitle.customised
        ? undefined
        : { style: subtitle.style, fade: subtitle.fade },
    at: styles.subtitlePosition ?? undefined,
    share: styles.subtitleSize ?? undefined,
    limits: limitsFor(width, height),
  });
}

export const importedNotice = (added: number) =>
  `Imported ${added} subtitle${added === 1 ? "" : "s"} on a new track`;

/** The Import subtitles dialog: the file being imported, `null` when closed. */
export const useSrtImport = create<{ file: SrtFile | null; close: () => void }>((set) => ({
  file: null,
  close: () => set({ file: null }),
}));

/** The File menu action: pick a file, then open the dialog (or say why not). */
export async function importSrtFromMenu(): Promise<void> {
  const read = await readSrt();
  if (!read) return;
  if (!read.ok) useUiStore.getState().setNotice(read.reason);
  else useSrtImport.setState({ file: read.file });
}
