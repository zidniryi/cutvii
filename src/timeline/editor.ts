/** User-level editing actions: read the stores, run one undoable command, keep selection sane. */
import { useSelectionStore } from "@/store/selection";
import { useUiStore } from "@/store/ui";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { setAudioStyle, type StyleChoice } from "./audioStyle";
import { clipEnd, EPS, minClipDuration } from "./clips";
import type { AudioClean, ClipTransition, Crop, FitBackground, FitMode } from "@/project/model";
import {
  addClip,
  addTrack,
  applyFitBackgroundToAll,
  deleteClip,
  moveClip,
  placeClip,
  setClipCrop,
  setClipFit,
  setClipFitBackground,
  setClipKeepPitch,
  setClipReversed,
  setClipSpeed,
  setClipVolume,
  setTrackFlag,
  splitClip,
  trimClip,
  type EditResult,
} from "./edit";
import { removeKey, resetProp, setKey } from "./keyframes";
import { setClipTransition } from "./transitions";
import type { KeyProp } from "./transform";
import { detachAudio, setClipClean, setClipDuck, setClipSound, type ClipSound } from "./audio";
import { setClipColor, setClipLut, type ClipLut, type ColorAdjust } from "./color";
import { setColorOnAll } from "./looks";
import { planPlacement, type DropPlacement } from "./placement";
import {
  autoMatch,
  cutOnBeats,
  setClipBeatFx,
  type AutoMatchOptions,
  type BeatFxPatch,
  type BeatGrid,
  type CutEvery,
} from "./beats";
import { setTextFade } from "./text";
import { setClipTransform, type Transform } from "./transform";
import { setTransformAt } from "./transformBox";

export { newDropPlacement, type DropPlacement, type DropTarget } from "./placement";

const project = () => useProjectStore.getState().project;
const run = (label: string, apply: (p: ReturnType<typeof project>) => EditResult) =>
  useProjectStore.getState().execute({ label, apply });

/** Drop selected ids that no longer exist (after delete/undo/redo). */
export function pruneSelection() {
  const existing = new Set(project().tracks.flatMap((t) => t.clips.map((c) => c.id)));
  const sel = useSelectionStore.getState();
  const kept = sel.selectedClipIds.filter((id) => existing.has(id));
  if (kept.length !== sel.selectedClipIds.length) sel.setSelection(kept);
}

/** Select every clip on the timeline (Ctrl/Cmd + A). */
export function selectAllClips() {
  useSelectionStore.getState().setSelection(project().tracks.flatMap((t) => t.clips.map((c) => c.id)));
}

/** Ctrl/Cmd + A: everything in the part of the editor being used: the media listed, or the clips. */
export function selectAll() {
  const sel = useSelectionStore.getState();
  if (sel.area === "library") sel.setAssetSelection(sel.libraryOrder);
  else selectAllClips();
}

/** Remove the media selected in the library, with the clips that use them, as one undoable step. */
export function removeSelectedMedia() {
  const sel = useSelectionStore.getState();
  const existing = new Set(project().assets.map((a) => a.id));
  const ids = sel.selectedAssetIds.filter((id) => existing.has(id));
  if (ids.length === 0) return;
  useProjectStore.getState().removeAssets(ids);
  sel.setAssetSelection([]);
  pruneSelection();
}

/** Delete / Backspace: the selected media when the library is being used, otherwise the selected clips. */
export function deleteSelection() {
  if (useSelectionStore.getState().area === "library") removeSelectedMedia();
  else deleteSelected();
}

export function undo() {
  useProjectStore.getState().undo();
  pruneSelection();
}

export function redo() {
  useProjectStore.getState().redo();
  pruneSelection();
}

/** Place an asset on a track (default: first compatible track), at `start` (default: end of that track). */
export function addAssetToTimeline(
  assetId: string,
  opts: { trackId?: string; start?: number } = {},
): EditResult {
  const p = project();
  const asset = p.assets.find((a) => a.id === assetId);
  const wanted = asset?.type === "audio" ? "audio" : "video";
  const track = opts.trackId
    ? p.tracks.find((t) => t.id === opts.trackId)
    : [...p.tracks].sort((a, b) => a.order - b.order).find((t) => t.type === wanted);
  if (!track) return { ok: false, error: { code: "unknown-track", message: "No suitable track" } };
  const start = opts.start ?? Math.max(0, ...track.clips.map(clipEnd));

  const id = crypto.randomUUID();
  const result = run("Add clip", (pr) => addClip(pr, { assetId, trackId: track.id, start, id }));
  if (result.ok) useSelectionStore.getState().select(id);
  return result;
}

export function moveClipTo(clipId: string, start: number, trackId?: string): EditResult {
  return run("Move clip", (p) => moveClip(p, clipId, { start, trackId }));
}

/** Drop a clip on the timeline: onto another clip it goes in before or after it and makes room. */
export function dropClipAt(clipId: string, start: number, trackId?: string): EditResult {
  return run("Move clip", (p) => placeClip(p, clipId, { start, trackId }));
}

export function trimClipEdge(clipId: string, edge: "start" | "end", time: number): EditResult {
  return run("Trim clip", (p) => trimClip(p, clipId, edge, time));
}

export function changeVolume(clipId: string, volume: number): EditResult {
  return run("Change volume", (p) => setClipVolume(p, clipId, volume));
}

/** Change speed. Returns `needs-ripple` (nothing changed) when later clips would have to move. */
export function changeSpeed(clipId: string, speed: number, ripple = false): EditResult {
  return run(ripple ? "Change speed (move following clips)" : "Change speed", (p) =>
    setClipSpeed(p, clipId, speed, { ripple }),
  );
}

export function changeKeepPitch(clipId: string, keepPitch: boolean): EditResult {
  return run(keepPitch ? "Keep pitch" : "Let pitch follow speed", (p) =>
    setClipKeepPitch(p, clipId, keepPitch),
  );
}

export function changeFitBackground(clipId: string, background: FitBackground): EditResult {
  return run("Change background", (p) => setClipFitBackground(p, clipId, background));
}

export function applyBackgroundToAllClips(background: FitBackground): EditResult {
  return run("Apply background to all clips", (p) => applyFitBackgroundToAll(p, background));
}

export function changeReversed(clipId: string, reversed: boolean): EditResult {
  return run(reversed ? "Reverse clip" : "Play clip forwards", (p) => setClipReversed(p, clipId, reversed));
}

export function changeClipSound(clipId: string, patch: Partial<ClipSound>): EditResult {
  const label = patch.muted === undefined ? "Change fade" : patch.muted ? "Mute clip" : "Unmute clip";
  return run(label, (p) => setClipSound(p, clipId, patch));
}

/** Noise / rumble clean-up of a clip's sound. One undo step. */
export function changeClean(clipId: string, patch: Partial<AudioClean>): EditResult {
  return run("Change sound clean-up", (p) => setClipClean(p, clipId, patch));
}

/** Beat Sync settings of a clip (grid id, half / double, tempo, nudge). One undo step. */
export function changeBeatFx(clipId: string, patch: BeatFxPatch, label = "Change beats"): EditResult {
  return run(label, (p) => setClipBeatFx(p, clipId, patch));
}

/** Give a sound clip a style (or remove it with null). One undo step; `needs-ripple` when it would grow into the next clip. */
export function changeAudioStyle(
  clipId: string,
  choice: StyleChoice | null,
  ripple = false,
  label = "Change sound style",
): EditResult {
  return run(ripple ? `${label} (move following clips)` : label, (p) =>
    setAudioStyle(p, clipId, choice, { ripple }),
  );
}

/** Split a clip at every `every`-th beat of its grid, optionally dropping the part before the first. One undo step. */
export function cutClipOnBeats(
  clipId: string,
  grid: BeatGrid,
  options: { every: CutEvery; removeLeadIn?: boolean },
): EditResult {
  return run("Cut on beats", (p) => cutOnBeats(p, clipId, grid, options));
}

/**
 * Place library media one after another on a new "Beat edit" track, each as long as its beats (Auto-match).
 * One undo step; the new clips are selected. Returns the result and how many clips were placed.
 */
export function autoMatchClips(
  musicClipId: string,
  grid: BeatGrid,
  assetIds: readonly string[],
  options: AutoMatchOptions,
): EditResult {
  const trackId = crypto.randomUUID();
  const result = run("Auto-match to beats", (p) =>
    autoMatch(p, musicClipId, grid, assetIds, options, trackId),
  );
  if (result.ok) {
    const track = project().tracks.find((t) => t.id === trackId);
    if (track) useSelectionStore.getState().setSelection(track.clips.map((c) => c.id));
  }
  return result;
}

/** Ducking amount of a clip, 0 (off) to 1. One undo step. */
export function changeDuck(clipId: string, amount: number): EditResult {
  return run(amount > 0 ? "Change ducking" : "Switch ducking off", (p) => setClipDuck(p, clipId, amount));
}

/** Put a video clip's sound on an audio track as its own clip (adding a track if none is free there). */
export function detachClipAudio(clipId: string): EditResult {
  const ids = { clipId: crypto.randomUUID(), trackId: crypto.randomUUID() };
  const result = run("Detach audio", (p) => detachAudio(p, clipId, ids));
  if (result.ok) useSelectionStore.getState().select(ids.clipId);
  return result;
}

export function changeTextFade(clipId: string, seconds: number): EditResult {
  return run("Change text fade", (p) => setTextFade(p, clipId, seconds));
}

/**
 * Change a clip's colour. `patch` is merged into what the clip has; with `replace` the clip gets exactly
 * `patch` instead (a look, a pasted colour). `null` clears it. One undo step either way.
 */
export function changeColor(clipId: string, patch: Partial<ColorAdjust> | null, replace = false): EditResult {
  return run(patch ? "Adjust colour" : "Reset colour", (p) => {
    if (!patch || !replace) return setClipColor(p, clipId, patch);
    const cleared = setClipColor(p, clipId, null);
    return cleared.ok ? setClipColor(cleared.project, clipId, patch) : cleared;
  });
}

/** Put an imported LUT on a clip, change its intensity, or take it off (`null`). One undo step. */
export function changeLut(clipId: string, lut: ClipLut | null): EditResult {
  return run(lut ? "Set LUT" : "Remove LUT", (p) => setClipLut(p, clipId, lut));
}

/** Give every clip that has a picture the same colour (`null` removes it everywhere). One undo step. */
export function applyColorToAll(color: ColorAdjust | null): EditResult {
  return run(color ? "Apply colour to all clips" : "Remove colour from all clips", (p) =>
    setColorOnAll(p, color),
  );
}

export function changeTransform(clipId: string, patch: Partial<Transform> | null): EditResult {
  return run(patch ? "Transform" : "Reset transform", (p) => setClipTransform(p, clipId, patch));
}

/** Move, size or turn a clip by hand in the preview: keyed values get a keyframe at `time`. One undo step. */
export function changeTransformAt(
  clipId: string,
  patch: Partial<Record<"x" | "y" | "scale" | "rotation", number>>,
  time: number,
): EditResult {
  return run("Transform", (p) => setTransformAt(p, clipId, patch, time));
}

/** Give a clip a transition in, change it, or take it away (`null`). One undo step. */
export function changeTransition(
  clipId: string,
  transition: ClipTransition | null,
  which: "in" | "out" = "in",
): EditResult {
  return run(transition ? "Set transition" : "Remove transition", (p) =>
    setClipTransition(p, clipId, transition, which),
  );
}

/** Set (add or change) the keyframe of `prop` at source time `t`. One undo step. */
export function changeKey(clipId: string, prop: KeyProp, t: number, v: number): EditResult {
  return run("Set keyframe", (p) => setKey(p, clipId, prop, t, v));
}

/** Remove the keyframe of `prop` at source time `t`. One undo step. */
export function deleteKey(clipId: string, prop: KeyProp, t: number): EditResult {
  return run("Remove keyframe", (p) => removeKey(p, clipId, prop, t));
}

/** Give a clip a transform copied from another clip; its own keyframes go. One undo step. */
export function pasteTransform(clipId: string, transform: Partial<Transform>): EditResult {
  return run("Paste transform", (p) => {
    const cleared = setClipTransform(p, clipId, null);
    return cleared.ok ? setClipTransform(cleared.project, clipId, transform) : cleared;
  });
}

/** Put one transform property back to its plain value, keyframes included. One undo step. */
export function resetTransformProp(clipId: string, prop: KeyProp): EditResult {
  return run("Reset transform value", (p) => resetProp(p, clipId, prop));
}

export function changeCrop(clipId: string, crop: Crop | null): EditResult {
  return run(crop ? "Crop" : "Reset crop", (p) => setClipCrop(p, clipId, crop));
}

export function changeFit(clipId: string, fit: FitMode): EditResult {
  return run("Change fit to canvas", (p) => setClipFit(p, clipId, fit));
}

/**
 * Put one dropped asset on the timeline, following `planPlacement` (the same rules the ghost preview shows).
 * Adding a needed track and the clip is one undo step.
 */
export function placeAssetAtDrop(assetId: string, placement: DropPlacement): EditResult {
  const p = project();
  const asset = p.assets.find((a) => a.id === assetId);
  if (!asset)
    return { ok: false, error: { code: "unknown-asset", message: "That media is no longer in the project" } };

  const plan = planPlacement(p, placement, asset);
  const trackId = plan.trackId ?? crypto.randomUUID();
  const id = crypto.randomUUID();

  const result = run("Add clip", (pr) => {
    let next = pr;
    if (!plan.trackId) {
      const t = addTrack(next, plan.trackType, trackId);
      if (!t.ok) return t;
      next = t.project;
    }
    return addClip(next, { assetId, trackId, start: plan.start, id });
  });
  if (result.ok) {
    if (!plan.trackId) placement.created[plan.trackType] = trackId;
    placement.cursor[plan.trackType] = plan.start + plan.duration;
    useSelectionStore.getState().select(id);
    if (plan.hint) useUiStore.getState().setNotice(plan.hint);
  }
  return result;
}

export function toggleTrackFlag(trackId: string, flag: "muted" | "hidden"): EditResult {
  const track = project().tracks.find((t) => t.id === trackId);
  const turningOn = track ? !track[flag] : true;
  const label =
    flag === "muted" ? (turningOn ? "Mute track" : "Unmute track") : turningOn ? "Hide track" : "Show track";
  return run(label, (p) => setTrackFlag(p, trackId, flag, turningOn));
}

/**
 * Split at the playhead: selected clips under it, or every clip under it when nothing is selected.
 * All cuts are one undo step.
 */
export function splitAtPlayhead(): EditResult {
  const time = usePlaybackStore.getState().playhead;
  const selected = new Set(useSelectionStore.getState().selectedClipIds);

  return run("Split at playhead", (p) => {
    const min = minClipDuration(p);
    const under = p.tracks
      .flatMap((t) => t.clips)
      .filter((c) => time > c.timelineStart + min - EPS && time < clipEnd(c) - min + EPS);
    const targets = selected.size > 0 ? under.filter((c) => selected.has(c.id)) : under;
    if (targets.length === 0) {
      return { ok: false, error: { code: "out-of-range", message: "No clip under the playhead" } };
    }
    let next = p;
    for (const c of targets) {
      const r = splitClip(next, c.id, time);
      if (!r.ok) return r;
      next = r.project;
    }
    return { ok: true, project: next };
  });
}

/** The transition block picked on the timeline, when it is still there and its clip is the one selected. */
function pickedTransition(): { clipId: string; way: "in" | "out" } | null {
  const picked = useUiStore.getState().selectedTransition;
  const ids = useSelectionStore.getState().selectedClipIds;
  if (!picked || ids.length !== 1 || ids[0] !== picked.clipId) return null;
  const clip = project()
    .tracks.flatMap((t) => t.clips)
    .find((c) => c.id === picked.clipId);
  return (picked.way === "in" ? clip?.transitionIn : clip?.transitionOut) ? picked : null;
}

/** Delete the picked transition block, or else the selected clips. */
export function deleteSelected(): EditResult {
  const picked = pickedTransition();
  if (picked) {
    useUiStore.getState().setSelectedTransition(null);
    return changeTransition(picked.clipId, null, picked.way); // the clip stays
  }
  const ids = useSelectionStore.getState().selectedClipIds;
  if (ids.length === 0) {
    return { ok: false, error: { code: "unknown-clip", message: "Nothing selected" } };
  }
  const result = run(ids.length > 1 ? "Delete clips" : "Delete clip", (p) => {
    let next = p;
    for (const id of ids) {
      const r = deleteClip(next, id);
      if (!r.ok) return r;
      next = r.project;
    }
    return { ok: true, project: next };
  });
  if (result.ok) pruneSelection();
  return result;
}

/** Surface a failed edit to the user (transient notice). Successful results pass through untouched. */
export function report(result: EditResult): EditResult {
  if (!result.ok) useUiStore.getState().setNotice(result.error.message);
  return result;
}
