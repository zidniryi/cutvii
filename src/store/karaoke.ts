/** Karaoke Maker dialog state. Outside the dialog, so closing it keeps the lines being worked on. */
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import {
  alignLyrics,
  createKaraoke,
  KARAOKE_FADE,
  KARAOKE_STYLE_ID,
  makeInstrumental,
  type Instrumental,
  linesFromSegments,
  parseLyricsFile,
  pastedLines,
  recogniseSong,
  type LyricLine,
} from "@/timeline/karaoke";
import type { SpeechSegment } from "@/timeline/subtitles";
import { findClip, sourceDuration } from "@/timeline/clips";
import { useAiStore } from "./ai";
import { usePlaybackStore } from "./playback";
import { useProjectStore } from "./project";
import { allStyles, useTextStyleStore } from "./textStyles";
import { useUiStore } from "./ui";
import type { StylePreset } from "@/project/model";

export type KaraokeSource = "listen" | "paste" | "file";

interface KaraokeState {
  open: boolean;
  clipId: string | null;
  source: KaraokeSource;
  /** Whisper's language code; "" lets the model detect it. */
  language: string;
  /** The speech model picked in the dialog; null = the largest installed one. */
  model: string | null;
  setModel: (model: string | null) => void;
  pasted: string;
  /** Also make a copy of the song with the singer lowered and put it under the song. */
  lowerVoice: boolean;
  setLowerVoice: (on: boolean) => void;
  /** The text style the lyrics are drawn in (a built-in one or one of My styles). */
  styleId: string;
  setStyle: (id: string) => void;
  /** Name of the lyrics file that was read, if any. */
  fileName: string | null;
  lines: LyricLine[];
  /** What is happening right now ("Listening…"), or null. */
  busy: string | null;
  problem: string | null;
  note: string | null;
  /** What was recognised for the current clip: pasting other lyrics does not listen to the song again. */
  heard: { clipId: string; model: string; language: string; segments: SpeechSegment[] } | null;

  openFor: (clipId: string) => void;
  hide: () => void;
  setSource: (source: KaraokeSource) => void;
  setLanguage: (language: string) => void;
  setPasted: (text: string) => void;
  /** Make the lines from the chosen source. */
  findLines: () => Promise<void>;
  /** Pick an `.lrc` / `.srt` / `.txt` file (native dialog in Rust) and read its lines. */
  openFile: () => Promise<void>;
  editLine: (index: number, patch: Partial<Pick<LyricLine, "text" | "start" | "end">>) => void;
  removeLine: (index: number) => void;
  /** Move every line earlier (negative) or later by `seconds`. */
  shiftAll: (seconds: number) => void;
  clearLines: () => void;
  create: () => Promise<void>;
}

const message = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : "Failed");

/** The style lyrics are drawn in: the chosen one, or the bundled Karaoke style if it is gone. */
export function karaokeStyle(id: string): StylePreset {
  const styles = allStyles(useTextStyleStore.getState());
  return styles.find((p) => p.id === id) ?? styles.find((p) => p.id === KARAOKE_STYLE_ID) ?? styles[0];
}

/**
 * The speech model to listen with: the one chosen in the dialog if it is on this computer, otherwise the
 * largest one that is (singing is hard to recognise, so bigger is better here).
 */
export function karaokeModel(): string | null {
  const installed = useAiStore.getState().models.filter((m) => m.installed);
  const chosen = useKaraokeStore.getState().model;
  const largest = [...installed].sort((a, b) => b.approxMb - a.approxMb)[0];
  return (installed.find((m) => m.id === chosen) ?? largest)?.id ?? null;
}

export const useKaraokeStore = create<KaraokeState>((set, get) => {
  const lengthOf = (clipId: string) => {
    const found = findClip(useProjectStore.getState().project, clipId);
    return found ? sourceDuration(found.clip) : 0;
  };
  /** Recognised words for the clip, reusing what was heard with the same model and language. */
  const listen = async (clipId: string): Promise<SpeechSegment[] | null> => {
    const model = karaokeModel();
    if (!model) {
      set({ problem: "Download a speech model first (AI tab, Auto subtitles, step 1)." });
      return null;
    }
    const { heard, language } = get();
    if (heard && heard.clipId === clipId && heard.model === model && heard.language === language) {
      return heard.segments;
    }
    set({ busy: "Listening to the song…" });
    const result = await recogniseSong(clipId, model, language === "" ? null : language);
    if (!result.ok) {
      set({ busy: null, problem: /cancel/i.test(result.reason) ? null : result.reason });
      return null;
    }
    set({ heard: { clipId, model, language, segments: result.segments } });
    return result.segments;
  };

  return {
    open: false,
    clipId: null,
    source: "listen",
    language: "",
    model: null,
    setModel: (model) => set({ model }),
    pasted: "",
    lowerVoice: true,
    setLowerVoice: (lowerVoice) => set({ lowerVoice }),
    styleId: KARAOKE_STYLE_ID,
    setStyle: (styleId) => set({ styleId }),
    fileName: null,
    lines: [],
    busy: null,
    problem: null,
    note: null,
    heard: null,

    openFor: (clipId) => {
      useAiStore.getState().ensure();
      if (get().clipId !== clipId) set({ lines: [], heard: null, fileName: null, note: null });
      set({ open: true, clipId, problem: null });
    },
    hide: () => set({ open: false }),
    setSource: (source) => set({ source, problem: null }),
    setLanguage: (language) => set({ language }),
    setPasted: (pasted) => set({ pasted }),

    findLines: async () => {
      const { clipId, source, pasted, busy } = get();
      if (!clipId || busy) return;
      set({ problem: null, note: null });
      if (source === "paste" && pastedLines(pasted).length === 0) {
        return set({ problem: "Paste the lyrics first, one line per line." });
      }
      const segments = await listen(clipId);
      if (!segments) return;
      if (source === "listen") {
        const lines = linesFromSegments(segments);
        return set({
          busy: null,
          lines,
          problem: lines.length === 0 ? "No words were recognised in this clip." : null,
          note:
            lines.length > 0
              ? "Recognised from the song with the music still in it, so check the words. Sung lyrics are harder to recognise than speech."
              : null,
        });
      }
      const lines = alignLyrics(pastedLines(pasted), segments, lengthOf(clipId));
      const low = lines.filter((l) => l.low).length;
      set({
        busy: null,
        lines,
        note:
          low === 0
            ? "Every line was found in the song."
            : low === lines.length
              ? "The lines could not be found in the song, so they are spread evenly. Set the times by hand."
              : `${low} of ${lines.length} lines were not found in the song; they are placed between their neighbours and marked. Check their times.`,
      });
    },

    openFile: async () => {
      const { clipId, busy } = get();
      if (!clipId || busy) return;
      set({ problem: null, note: null });
      let file: { name: string; text: string } | null;
      try {
        file = (await invoke<{ name: string; text: string } | null>("open_lyrics_file")) ?? null;
      } catch (e) {
        return set({ problem: message(e) });
      }
      if (!file || typeof file.text !== "string") return;
      const name = String(file.name).slice(0, 120);
      const parsed = parseLyricsFile(name, file.text);
      if (parsed.lines.length > 0) {
        return set({
          lines: parsed.lines,
          fileName: name,
          note: `${parsed.lines.length} timed lines read from ${name}.`,
        });
      }
      if (parsed.plain.length === 0) return set({ problem: `${name} has no lyrics in it.` });
      // a plain text file: the same as pasting it
      set({ pasted: parsed.plain.join("\n"), source: "paste", fileName: name });
      await get().findLines();
    },

    editLine: (index, patch) =>
      set((s) => ({
        lines: s.lines.map((line, i) => {
          if (i !== index) return line;
          const start = Math.max(0, patch.start ?? line.start);
          const end = Math.max(start + 0.05, patch.end ?? Math.max(line.end, start + 0.05));
          // a time set by hand is the user's: no longer a guess
          const touched = patch.start !== undefined || patch.end !== undefined;
          return { ...line, ...patch, start, end, low: touched ? false : line.low };
        }),
      })),
    removeLine: (index) => set((s) => ({ lines: s.lines.filter((_, i) => i !== index) })),
    shiftAll: (seconds) =>
      set((s) => ({
        lines: s.lines.map((l) => {
          const start = Math.max(0, l.start + seconds);
          return { ...l, start, end: Math.max(start + 0.05, l.end + seconds) };
        }),
      })),
    clearLines: () => set({ lines: [], note: null, problem: null, fileName: null }),

    create: async () => {
      const { clipId, lines, busy } = get();
      if (!clipId || busy || lines.length === 0) return;
      set({ busy: "Preparing…", problem: null });
      let instrumental: Instrumental | null = null;
      if (get().lowerVoice) {
        set({ busy: "Lowering the singer's voice…" });
        try {
          instrumental = await makeInstrumental(clipId, lines);
        } catch (e) {
          // nothing was added: the user decides whether to go on without it
          return set({
            busy: null,
            problem: `The singer's voice could not be lowered: ${message(e)}. Untick “Lower the singer's voice” to add the lyrics only.`,
          });
        }
      }
      const look = karaokeStyle(get().styleId);
      const result = await createKaraoke(
        clipId,
        lines,
        (stage) => set({ busy: stage }),
        look.style,
        instrumental,
        look.fade && look.fade > 0 ? look.fade : KARAOKE_FADE,
      );
      set({ busy: null });
      if (!result.ok) return set({ problem: result.reason });
      const found = findClip(useProjectStore.getState().project, clipId);
      if (found) usePlaybackStore.getState().setPlayhead(found.clip.timelineStart);
      set({ open: false });
      useUiStore
        .getState()
        .setNotice(
          `Added ${result.added} lyric line${result.added === 1 ? "" : "s"} on a new “Karaoke” track${instrumental ? ", and a lowered-voice copy of the song on “Karaoke music” (the original clip is muted, not changed)" : ""}. Undo removes it all.`,
        );
    },
  };
});
