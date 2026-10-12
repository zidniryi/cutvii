/**
 * Karaoke Maker, v1: lyrics as timed lines over a song.
 *
 * Lines come from one of three sources and end up in the same shape: recognised from the song (Whisper),
 * pasted by the user and matched to what was recognised, or read from an `.lrc` / `.srt` file. Each line
 * becomes a text clip in the Karaoke style on a track named "Karaoke", added as ONE undoable step.
 *
 * The highlight is per LINE. Word times from the speech model were measured and are not reliable enough
 * (see the word-timing spike in CLAUDE.md), and this file never invents them.
 */
import { invoke } from "@tauri-apps/api/core";
import type { MediaAsset, Project, TextStyle, TimelineClip } from "@/project/model";
import { useAiStore } from "@/store/ai";
import { useProjectStore } from "@/store/project";
import { clipDuration, clipSpeed, findClip, sourceDuration } from "./clips";
import { addClip, addTrack, type EditResult } from "./edit";
import { subtitleSpec, type DrawnSubtitle, type SpeechSegment } from "./subtitles";
import { setTextFade } from "./text";
import { findStyle, withStyle } from "./textStyles";

/** A lyric line. Times are seconds from the start of the part of the song the clip uses. */
export interface LyricLine {
  text: string;
  start: number;
  end: number;
  /** How sure the timing is, 0..1: 1 for times from a file or straight from recognition. */
  confidence: number;
  /** The timing is a guess (no good match in the song): the user should check it. */
  low: boolean;
}

/** Limits for lyrics the user brings: they are untrusted input. */
export const MAX_LYRIC_CHARS = 200_000;
export const MAX_LYRIC_LINES = 2000;
export const MAX_LINE_CHARS = 300;
/** A line with no known end shows for this long at most. */
export const DEFAULT_LINE_SECONDS = 5;
/** A line shows for at least this long, so it can be read. */
export const MIN_LINE_SECONDS = 0.4;
/** A pasted line counts as found in the song at or above this likeness. */
export const MATCH_THRESHOLD = 0.5;
/** How far ahead in the recognised speech a line is looked for (segments). */
const LOOKAHEAD = 8;
/** A line may span this many recognised segments. */
const MAX_SPAN = 3;

const clean = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, MAX_LINE_CHARS);

/** The lines of pasted lyrics: one per non-empty line, section labels like "[Chorus]" dropped. */
export function pastedLines(text: string): string[] {
  return text
    .slice(0, MAX_LYRIC_CHARS)
    .split(/\r?\n/)
    .map(clean)
    .filter((line) => line !== "" && !/^[[(][^\])]*[\])]$/.test(line))
    .slice(0, MAX_LYRIC_LINES);
}

/** Give lines that only have a start an end: the next line's start, or a few seconds. Sorted, no overlaps. */
function closeLines(lines: { text: string; start: number; end?: number }[]): LyricLine[] {
  const sorted = lines
    .filter((l) => Number.isFinite(l.start) && l.start >= 0 && l.text !== "")
    .sort((a, b) => a.start - b.start)
    .slice(0, MAX_LYRIC_LINES);
  return sorted.map((line, i) => {
    const next = sorted[i + 1]?.start ?? Infinity;
    const wanted =
      line.end !== undefined && line.end > line.start ? line.end : line.start + DEFAULT_LINE_SECONDS;
    const end = Math.max(line.start + 0.05, Math.min(wanted, next));
    return { text: line.text, start: line.start, end, confidence: 1, low: false };
  });
}

/**
 * Parse an `.lrc` file: `[mm:ss.xx] words`, several time tags on one line allowed, `[ar:..]`-style tags and
 * an `[offset:+/-ms]` understood, word tags `<mm:ss.xx>` removed. Anything else on a line is ignored.
 */
export function parseLrc(text: string): LyricLine[] {
  const out: { text: string; start: number }[] = [];
  let offset = 0;
  for (const raw of text.slice(0, MAX_LYRIC_CHARS).split(/\r?\n/)) {
    const shift = /^\s*\[offset:\s*([+-]?\d{1,7})\s*\]/i.exec(raw);
    if (shift) {
      offset = Number(shift[1]) / 1000;
      continue;
    }
    const times: number[] = [];
    let rest = raw;
    for (;;) {
      const tag = /^\s*\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/.exec(rest);
      if (!tag) break;
      const fraction = tag[3] ? Number(`0.${tag[3]}`) : 0;
      times.push(Number(tag[1]) * 60 + Number(tag[2]) + fraction);
      rest = rest.slice(tag[0].length);
    }
    const words = clean(rest.replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, ""));
    if (times.length === 0 || words === "") continue;
    // a positive offset means the lyrics appear earlier
    for (const t of times) out.push({ text: words, start: Math.max(0, t - offset) });
    if (out.length > MAX_LYRIC_LINES) break;
  }
  return closeLines(out);
}

/** Parse an `.srt` file: numbered blocks of `hh:mm:ss,mmm --> hh:mm:ss,mmm` and text. Markup is removed. */
export function parseSrt(text: string): LyricLine[] {
  const out: { text: string; start: number; end: number }[] = [];
  const stamp = (h: string, m: string, s: string, ms: string) =>
    Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, "0")) / 1000;
  for (const block of text.slice(0, MAX_LYRIC_CHARS).split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const at = lines.findIndex((l) => l.includes("-->"));
    if (at < 0) continue;
    const m = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/.exec(
      lines[at],
    );
    if (!m) continue;
    const words = clean(
      lines
        .slice(at + 1)
        .join(" ")
        .replace(/<[^>]{0,40}>|\{[^}]{0,40}\}/g, ""),
    );
    if (words === "") continue;
    out.push({ text: words, start: stamp(m[1], m[2], m[3], m[4]), end: stamp(m[5], m[6], m[7], m[8]) });
    if (out.length > MAX_LYRIC_LINES) break;
  }
  return closeLines(out);
}

/** Lyrics from a file by what it looks like: `.srt` blocks, `.lrc` tags, otherwise plain lines (no times). */
export function parseLyricsFile(name: string, text: string): { lines: LyricLine[]; plain: string[] } {
  const lower = name.toLowerCase();
  if (lower.endsWith(".srt") || /-->/.test(text.slice(0, 4000))) {
    const lines = parseSrt(text);
    if (lines.length > 0) return { lines, plain: [] };
  }
  if (lower.endsWith(".lrc") || /^\s*\[\d{1,3}:\d{1,2}/m.test(text.slice(0, 4000))) {
    const lines = parseLrc(text);
    if (lines.length > 0) return { lines, plain: [] };
  }
  return { lines: [], plain: pastedLines(text) };
}

/** Recognised speech as lyric lines, as it is. */
export function linesFromSegments(segments: SpeechSegment[]): LyricLine[] {
  return closeLines(segments.map((s) => ({ text: clean(s.text), start: s.start, end: s.end })));
}

// ---------------------------------------------------------------------------------------------------
// Matching pasted lyrics to the song
// ---------------------------------------------------------------------------------------------------

/** Words for comparing: lower case, no accents or punctuation. */
export function wordsForMatch(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/'/g, "")
    .split(/\s+/)
    .filter(Boolean);
}

/** One edit apart or equal (words of four letters or more only: short words must be equal). */
function alike(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 4 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let j = 0;
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  return Math.max(a.length, b.length) - i - j <= 1;
}

/**
 * How alike two word lists are, 0..1: the share of words that have a partner in the other list (each word
 * used once), counted against the longer list. Order inside a line does not matter; singers repeat and swap.
 */
export function likeness(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const left = [...b];
  let hits = 0;
  for (const word of a) {
    const at = left.findIndex((other) => alike(word, other));
    if (at >= 0) {
      hits += 1;
      left.splice(at, 1);
    }
  }
  return hits / Math.max(a.length, b.length);
}

/**
 * Put the user's lines on the song. The rules, in order:
 * 1. Lines are matched in the order given; a line never goes before the one above it.
 * 2. For each line, the next few recognised segments are tried, alone and joined (up to three in a row);
 *    the most alike wins, earlier ones on a tie. At or above `MATCH_THRESHOLD` the line takes those times
 *    and its confidence is the likeness.
 * 3. A line with no match keeps its place between its neighbours: the gap between the matched lines around
 *    it is shared out evenly. Its confidence is 0 and it is flagged.
 * 4. With nothing recognised at all, or no line matched, every line is spread evenly over the whole clip
 *    and flagged.
 * The user's text is always kept exactly; only times come from the song.
 */
export function alignLyrics(userLines: string[], segments: SpeechSegment[], length: number): LyricLine[] {
  const lines = userLines.map(clean).filter(Boolean).slice(0, MAX_LYRIC_LINES);
  const speech = [...segments]
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start)
    .map((s) => ({ ...s, words: wordsForMatch(s.text) }));
  const placed: ({ start: number; end: number; score: number } | null)[] = [];
  let cursor = 0;
  for (const line of lines) {
    const want = wordsForMatch(line);
    let best: { score: number; from: number; to: number } | null = null;
    for (let from = cursor; from < Math.min(speech.length, cursor + LOOKAHEAD); from++) {
      let joined: string[] = [];
      for (let to = from; to < Math.min(speech.length, from + MAX_SPAN); to++) {
        joined = [...joined, ...speech[to].words];
        const score = likeness(want, joined);
        if (!best || score > best.score + 1e-9) best = { score, from, to };
      }
    }
    if (best && best.score >= MATCH_THRESHOLD) {
      placed.push({ start: speech[best.from].start, end: speech[best.to].end, score: best.score });
      cursor = best.to + 1;
    } else {
      placed.push(null);
    }
  }

  const out: LyricLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const hit = placed[i];
    if (hit) {
      out.push({ text: lines[i], start: hit.start, end: hit.end, confidence: hit.score, low: false });
      continue;
    }
    // a run of unmatched lines shares the gap between the matched lines around it
    let first = i;
    while (first > 0 && !placed[first - 1]) first--;
    let last = i;
    while (last < lines.length - 1 && !placed[last + 1]) last++;
    const from = first > 0 ? placed[first - 1]!.end : 0;
    const to = last < lines.length - 1 ? placed[last + 1]!.start : length;
    const room = Math.max(0, to - from);
    const each = room / (last - first + 1);
    const start = from + each * (i - first);
    out.push({ text: lines[i], start, end: start + each, confidence: 0, low: true });
  }
  // never past the clip, never overlapping, always long enough to exist
  return out.map((line, i) => {
    const start = Math.min(Math.max(0, line.start), Math.max(0, length - 0.05));
    const limit = Math.min(length, out[i + 1]?.start ?? length);
    return { ...line, start, end: Math.max(start + 0.05, Math.min(line.end, Math.max(limit, start + 0.05))) };
  });
}

// ---------------------------------------------------------------------------------------------------
// On the timeline
// ---------------------------------------------------------------------------------------------------

export interface KaraokeCaption {
  /** Timeline seconds. */
  start: number;
  duration: number;
  text: string;
}

/**
 * Where each line sits on the timeline: by the clip's start and speed, inside the clip, never overlapping
 * (they share a track). A reversed clip gets nothing: the song was heard forwards.
 */
export function captionsFor(clip: TimelineClip, lines: LyricLine[]): KaraokeCaption[] {
  if (clip.reversed) return [];
  const speed = clipSpeed(clip);
  const clipEnd = clip.timelineStart + clipDuration(clip);
  const out: KaraokeCaption[] = [];
  let free = clip.timelineStart;
  for (const line of [...lines].sort((a, b) => a.start - b.start)) {
    const text = line.text.trim();
    const start = Math.max(free, clip.timelineStart + line.start / speed);
    const end = Math.min(clipEnd, clip.timelineStart + line.end / speed);
    if (!text || end - start < MIN_LINE_SECONDS / 2) continue;
    out.push({ start, duration: end - start, text });
    free = end;
  }
  return out;
}

export const KARAOKE_TRACK_NAME = "Karaoke";
/** The style lyrics are drawn in. */
export const KARAOKE_STYLE_ID = "karaoke";
/** Lyric size as a share of the canvas height, and where the lines sit. */
export const KARAOKE_SIZE = 0.055;
export const KARAOKE_POSITION = { x: 0.5, y: 0.82 };
/** Lyrics wrap a little inside the canvas so outlines stay off the edge. */
export const KARAOKE_WRAP = 0.84;
/** Seconds a lyric line takes to fade in and out when its style does not say. */
export const KARAOKE_FADE = 0.25;
/** A silence between lyric lines longer than this is an instrumental part: the voice is not lowered there. */
export const INSTRUMENTAL_GAP = 12;

/** Add drawn lyric clips on a new top track named "Karaoke". Pure: run as one undoable command. */
export function addKaraokeClips(project: Project, items: DrawnSubtitle[], trackId: string): EditResult {
  if (items.length === 0) return { ok: true, project };
  const { width, height } = project.settings;
  const track = addTrack(project, "video", trackId);
  if (!track.ok) return track;
  const assets: MediaAsset[] = items.map((item) => ({
    id: item.assetId,
    path: item.picture,
    type: "image",
    width,
    height,
    text: item.spec,
  }));
  let next: Project = {
    ...track.project,
    assets: [...track.project.assets, ...assets],
    tracks: track.project.tracks.map((t) => (t.id === trackId ? { ...t, name: KARAOKE_TRACK_NAME } : t)),
  };
  for (const item of items) {
    const added = addClip(next, {
      assetId: item.assetId,
      trackId,
      start: item.start,
      duration: item.duration,
      id: item.clipId,
    });
    if (!added.ok) return added;
    next = added.project;
    if (item.fade) {
      // a short line fades for at most a third of its time, so it is fully visible in between
      const faded = setTextFade(next, item.clipId, Math.min(item.fade, item.duration / 3));
      if (!faded.ok) return faded;
      next = faded.project;
    }
  }
  return { ok: true, project: next };
}

/** A copy of the song's sound with the singer lowered, made by Rust (`make_instrumental`). */
export interface Instrumental {
  path: string;
  duration: number;
}
export const INSTRUMENTAL_TRACK_NAME = "Karaoke music";

/**
 * Put the lowered-voice copy under the song: on a new audio track, at the song clip's place and speed, with
 * its volume. The song clip itself is muted (not removed or changed otherwise), so the music is heard once
 * and un-muting it brings the singer back. Pure: part of the one karaoke command.
 */
export function addInstrumental(
  project: Project,
  songClipId: string,
  made: Instrumental,
  ids: { asset: string; track: string; clip: string },
): EditResult {
  const found = findClip(project, songClipId);
  if (!found) return { ok: false, error: { code: "unknown-clip", message: "The song clip is missing" } };
  const song = found.clip;
  const track = addTrack(project, "audio", ids.track);
  if (!track.ok) return track;
  const asset: MediaAsset = { id: ids.asset, path: made.path, type: "audio", duration: made.duration };
  const used = Math.min(made.duration, song.sourceOut - song.sourceIn);
  const clip: TimelineClip = {
    id: ids.clip,
    assetId: ids.asset,
    trackId: ids.track,
    timelineStart: song.timelineStart,
    sourceIn: 0,
    sourceOut: used,
    volume: song.volume,
    x: 0,
    y: 0,
    scale: 1,
    opacity: 1,
    ...(song.speed !== undefined ? { speed: song.speed } : {}),
    ...(song.keepPitch !== undefined ? { keepPitch: song.keepPitch } : {}),
  };
  return {
    ok: true,
    project: {
      ...track.project,
      assets: [...track.project.assets, asset],
      tracks: track.project.tracks.map((t) => {
        if (t.id === ids.track) return { ...t, name: INSTRUMENTAL_TRACK_NAME, clips: [clip] };
        if (t.id !== found.track.id) return t;
        return { ...t, clips: t.clips.map((c) => (c.id === songClipId ? { ...c, muted: true } : c)) };
      }),
    },
  };
}

/**
 * Where the voice is lowered (seconds from the clip's start): from the first lyric line to the last, in one
 * piece. Lines the recognition missed, held notes and short pauses lie between the lines, and the singer
 * must not come back there. Only a long gap (an instrumental part) splits the stretch, so intros, solos and
 * outros keep their full sound.
 */
export function sungRanges(lines: LyricLine[]): [number, number][] {
  const out: [number, number][] = [];
  for (const line of lines.filter((l) => l.end > l.start).sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && line.start - last[1] <= INSTRUMENTAL_GAP) last[1] = Math.max(last[1], line.end);
    else out.push([line.start, line.end]);
  }
  return out;
}

/** Ask Rust for the lowered-voice copy of the part of the song a clip uses. Throws a readable message. */
export async function makeInstrumental(clipId: string, lines: LyricLine[]): Promise<Instrumental> {
  const project = useProjectStore.getState().project;
  const found = findClip(project, clipId);
  const asset = found && project.assets.find((a) => a.id === found.clip.assetId);
  if (!found || !asset) throw new Error("The clip is missing from the project.");
  let made: unknown;
  try {
    made = await invoke("make_instrumental", {
      path: asset.path,
      sourceIn: found.clip.sourceIn,
      sourceOut: found.clip.sourceOut,
      ranges: sungRanges(lines),
    });
  } catch (e) {
    throw new Error(message(e).replace(/^invalid input: /, ""), { cause: e });
  }
  const m = made as Partial<Instrumental> | null;
  if (!m || typeof m.path !== "string" || !(typeof m.duration === "number" && m.duration > 0)) {
    throw new Error("The lowered-voice copy could not be made.");
  }
  return { path: m.path, duration: m.duration };
}

const message = (e: unknown) =>
  typeof e === "string" ? e : e instanceof Error ? e.message : "unknown error";

/** Why a clip cannot be used for karaoke, or null. */
export function karaokeBlocker(project: Project, clipId: string): string | null {
  const found = findClip(project, clipId);
  const asset = found && project.assets.find((a) => a.id === found.clip.assetId);
  if (!found || !asset) return "The clip is missing from the project.";
  if (asset.type === "image") return "Pictures have no sound: choose the song's clip.";
  if (found.clip.reversed) return "Reversed clips are skipped: the song is heard forwards.";
  return null;
}

/** Recognise the words sung in a clip (in Rust, on this computer). Times are from the start of its range. */
export async function recogniseSong(
  clipId: string,
  model: string,
  language: string | null,
): Promise<{ ok: true; segments: SpeechSegment[]; length: number } | { ok: false; reason: string }> {
  const project = useProjectStore.getState().project;
  const blocker = karaokeBlocker(project, clipId);
  const found = findClip(project, clipId);
  const asset = found && project.assets.find((a) => a.id === found.clip.assetId);
  if (blocker || !found || !asset) return { ok: false, reason: blocker ?? "The clip is missing." };
  useAiStore.getState().setListening({ clipId, percent: 0 });
  try {
    const segments = await invoke<SpeechSegment[]>("transcribe_media", {
      path: asset.path,
      sourceIn: found.clip.sourceIn,
      sourceOut: found.clip.sourceOut,
      model,
      language,
    });
    return {
      ok: true,
      segments: Array.isArray(segments) ? segments : [],
      length: sourceDuration(found.clip),
    };
  } catch (e) {
    return { ok: false, reason: message(e) };
  } finally {
    useAiStore.getState().setListening(null);
  }
}

export type KaraokeResult = { ok: true; added: number; trackId: string } | { ok: false; reason: string };

/**
 * Draw the lines in the Karaoke style and add them over the clip as ONE undo step. Nothing changes if a
 * line cannot be drawn. `style` is for tests; the bundled Karaoke style otherwise.
 */
export async function createKaraoke(
  clipId: string,
  lines: LyricLine[],
  onStage: (stage: string) => void = () => {},
  style: TextStyle | undefined = findStyle(KARAOKE_STYLE_ID)?.style,
  /** The lowered-voice copy to put under the song (it mutes the song clip), when the user asked for it. */
  instrumental: Instrumental | null = null,
  /** Seconds each line fades in and out over, so lyrics do not pop on and off. */
  fade: number = KARAOKE_FADE,
): Promise<KaraokeResult> {
  const project = useProjectStore.getState().project;
  const blocker = karaokeBlocker(project, clipId);
  const found = findClip(project, clipId);
  if (blocker || !found) return { ok: false, reason: blocker ?? "The clip is missing." };
  const captions = captionsFor(found.clip, lines);
  if (captions.length === 0) return { ok: false, reason: "There are no lyric lines inside this clip." };
  const { width, height } = project.settings;
  const drawn: DrawnSubtitle[] = [];
  try {
    for (const [i, caption] of captions.entries()) {
      onStage(`Drawing line ${i + 1} of ${captions.length}`);
      const plain = subtitleSpec(caption.text, height, KARAOKE_POSITION, KARAOKE_SIZE, KARAOKE_WRAP);
      const spec = style ? withStyle(plain, style) : plain;
      const picture = await invoke<string>("render_text", { spec, width, height });
      drawn.push({
        ...caption,
        spec,
        picture,
        assetId: crypto.randomUUID(),
        clipId: crypto.randomUUID(),
        ...(fade > 0 ? { fade } : {}),
      });
    }
  } catch (e) {
    return { ok: false, reason: `Could not draw the lyrics: ${message(e)}` };
  }
  const trackId = crypto.randomUUID();
  const result = useProjectStore.getState().execute({
    label: "Add karaoke lyrics",
    apply: (p) => {
      const lyrics = addKaraokeClips(p, drawn, trackId);
      if (!lyrics.ok || !instrumental) return lyrics;
      return addInstrumental(lyrics.project, clipId, instrumental, {
        asset: crypto.randomUUID(),
        track: crypto.randomUUID(),
        clip: crypto.randomUUID(),
      });
    },
  });
  if (!result.ok) return { ok: false, reason: result.error.message };
  return { ok: true, added: drawn.length, trackId };
}
