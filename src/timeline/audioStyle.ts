/**
 * Audio styles for a sound clip (sped up, slowed + reverb, bass boost, custom). The tempo is the clip's own
 * `speed` (kept in pitch), so the clip's length, its beats and the overlap rule all follow the one speed
 * formula; pitch, reverb and bass are drawn by the export (`src-tauri/src/export/audiostyle.rs`). Removing the
 * style puts back the speed and pitch handling the clip had before. Pure; one undo step via the editor.
 */
import { AUDIO_STYLE_LIMITS, type AudioStyle, type Project } from "@/project/model";
import { clipSpeed, findClip } from "./clips";
import { setClipKeepPitch, setClipSpeed, type EditResult } from "./edit";

export type StylePreset = AudioStyle["preset"];

/** What the user chooses: the tempo (percent of the original sound) plus the style's own values. */
export interface StyleChoice {
  preset: StylePreset;
  tempo: number;
  pitch: number;
  reverb: number;
  bass: number;
}

export const TEMPO_LIMITS = { min: 50, max: 200 } as const;

export const STYLE_PRESETS: Record<Exclude<StylePreset, "custom">, StyleChoice & { label: string }> = {
  sped: { label: "Sped up", preset: "sped", tempo: 125, pitch: 125, reverb: 0, bass: 0 },
  slowed: { label: "Slowed + reverb", preset: "slowed", tempo: 85, pitch: 85, reverb: 0.5, bass: 0 },
  bass: { label: "Bass boost", preset: "bass", tempo: 100, pitch: 100, reverb: 0, bass: 8 },
};

const fail = (code: "unknown-clip" | "out-of-range" | "incompatible-track", message: string): EditResult => ({
  ok: false,
  error: { code, message },
});

/** The choice a clip currently has (its speed is the tempo), or null when it has no style. */
export function currentChoice(clip: { speed?: number; audioStyle?: AudioStyle }): StyleChoice | null {
  const s = clip.audioStyle;
  if (!s) return null;
  return {
    preset: s.preset,
    tempo: Math.round(clipSpeed(clip) * 100),
    pitch: s.pitch,
    reverb: s.reverb,
    bass: s.bass,
  };
}

/** Whether the clip is a sound clip (an audio file, or a video's sound on an audio track). */
export function takesAudioStyle(project: Project, clipId: string): boolean {
  const found = findClip(project, clipId);
  return !!found && found.track.type === "audio";
}

/**
 * Give a sound clip a style, or take it away with `null`. With a style the clip's speed becomes
 * `tempo / 100` (of the original sound) with the pitch kept; a clip that would grow into the clips after it
 * is refused with `needs-ripple` unless `ripple` is set.
 */
export function setAudioStyle(
  project: Project,
  clipId: string,
  choice: StyleChoice | null,
  opts: { ripple?: boolean } = {},
): EditResult {
  const found = findClip(project, clipId);
  if (!found) return fail("unknown-clip", `Unknown clip ${clipId}`);
  if (found.track.type !== "audio") {
    return fail("incompatible-track", "Sound styles are for clips on an audio track");
  }
  const { clip } = found;
  let next: Project;

  if (choice === null) {
    const style = clip.audioStyle;
    if (!style) return { ok: true, project };
    const sped = setClipSpeed(project, clipId, style.baseSpeed ?? 1, opts);
    if (!sped.ok) return sped;
    const kept = setClipKeepPitch(sped.project, clipId, style.baseKeepPitch ?? true);
    if (!kept.ok) return kept;
    next = mapClip(kept.project, clipId, (c) => {
      const rest = { ...c };
      delete rest.audioStyle;
      return rest;
    });
    return { ok: true, project: next };
  }

  const { tempo, pitch, reverb, bass } = choice;
  if (!(tempo >= TEMPO_LIMITS.min && tempo <= TEMPO_LIMITS.max)) {
    return fail("out-of-range", `Tempo must be ${TEMPO_LIMITS.min} to ${TEMPO_LIMITS.max} percent`);
  }
  if (!(pitch >= AUDIO_STYLE_LIMITS.minPitch && pitch <= AUDIO_STYLE_LIMITS.maxPitch)) {
    return fail(
      "out-of-range",
      `Pitch must be ${AUDIO_STYLE_LIMITS.minPitch} to ${AUDIO_STYLE_LIMITS.maxPitch} percent`,
    );
  }
  if (!(reverb >= 0 && reverb <= 1)) return fail("out-of-range", "Reverb must be between 0 and 100 percent");
  if (!(bass >= 0 && bass <= AUDIO_STYLE_LIMITS.maxBass)) {
    return fail("out-of-range", `Bass must be 0 to ${AUDIO_STYLE_LIMITS.maxBass} dB`);
  }

  const before = clip.audioStyle;
  const style: AudioStyle = {
    preset: choice.preset,
    pitch,
    reverb,
    bass,
    baseSpeed: before?.baseSpeed ?? clipSpeed(clip),
  };
  const baseKeep = before ? before.baseKeepPitch : clip.keepPitch;
  if (baseKeep !== undefined) style.baseKeepPitch = baseKeep;

  const sped = setClipSpeed(project, clipId, tempo / 100, opts);
  if (!sped.ok) return sped;
  const kept = setClipKeepPitch(sped.project, clipId, true);
  if (!kept.ok) return kept;
  return { ok: true, project: mapClip(kept.project, clipId, (c) => ({ ...c, audioStyle: style })) };
}

function mapClip(
  project: Project,
  clipId: string,
  change: (c: Project["tracks"][number]["clips"][number]) => Project["tracks"][number]["clips"][number],
): Project {
  return {
    ...project,
    tracks: project.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => (c.id === clipId ? change(c) : c)),
    })),
  };
}
