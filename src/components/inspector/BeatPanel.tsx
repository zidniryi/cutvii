import { useEffect, useRef, useState } from "react";
import { AudioWaveform, Loader2, Square } from "lucide-react";
import { cn } from "@/lib/utils";
import { BEAT_LIMITS, type MediaAsset, type TimelineClip } from "@/project/model";
import { useBeatStore } from "@/store/beats";
import { useProjectStore } from "@/store/project";
import {
  adjustedBeats,
  CUT_EVERY,
  cutPoints,
  effectiveBpm,
  gridCoversClip,
  piecesAfterCut,
  tapTempo,
  type CutEvery,
} from "@/timeline/beats";
import { changeBeatFx, cutClipOnBeats, report } from "@/timeline/editor";

const buttonClass =
  "flex h-9 items-center justify-center gap-2 rounded-md border px-2 text-xs pointer-coarse:h-11 [&_svg]:size-4 disabled:opacity-40";
const plain = "border-border bg-surface-2 text-text-muted hover:text-text";
const pressed = "border-accent/60 bg-accent-soft text-text";

/** Taps are committed this long after the last one, so a run of taps is one undo step. */
const TAP_SETTLE_MS = 1500;

/**
 * Beat Sync, step 1: find the beat of the part of the sound a clip uses, then adjust it by hand (half /
 * double, a typed or tapped tempo, a nudge). Detection runs on this computer in the background and is
 * cached; every change is one undo step.
 */
export function BeatPanel({ clip, asset }: { clip: TimelineClip; asset: MediaAsset }) {
  const fx = clip.beatFx;
  const gridId = fx?.gridId;
  const grid = useBeatStore((s) => (gridId ? s.grids[gridId] : undefined));
  const running = useBeatStore((s) => s.running);
  const project = useProjectStore((s) => s.project);
  const [problem, setProblem] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const [taps, setTaps] = useState<number[]>([]);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [bpmDraft, setBpmDraft] = useState<string | null>(null);
  const [every, setEvery] = useState<CutEvery>(1);
  const [removeLeadIn, setRemoveLeadIn] = useState(false);

  useEffect(() => {
    if (gridId) useBeatStore.getState().ensureGrid(asset.path, gridId);
  }, [asset.path, gridId]);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [running]);
  useEffect(() => () => void (settle.current && clearTimeout(settle.current)), []);

  const mine = running?.clipId === clip.id;
  // time left from how long the finished part took: measured, never a fixed claim
  const elapsed = mine && now > running.startedAt ? (now - running.startedAt) / 1000 : 0;
  const left =
    mine && running.done > 0.05 && elapsed > 0 ? (elapsed / running.done) * (1 - running.done) : null;

  async function detect() {
    setProblem(null);
    setProblem(await useBeatStore.getState().detect(clip.id));
  }

  function tap() {
    const next = [...taps, performance.now()].slice(-12);
    setTaps(next);
    if (settle.current) clearTimeout(settle.current);
    const bpm = tapTempo(next);
    if (bpm === null) return;
    settle.current = setTimeout(() => {
      report(changeBeatFx(clip.id, { bpmOverride: bpm, halfDouble: undefined }, "Tap tempo"));
      setTaps([]);
    }, TAP_SETTLE_MS);
  }

  function commitBpm() {
    if (bpmDraft === null) return;
    const text = bpmDraft.trim();
    setBpmDraft(null);
    if (text === "")
      return void report(changeBeatFx(clip.id, { bpmOverride: undefined }, "Use detected tempo"));
    const value = Number(text);
    report(changeBeatFx(clip.id, { bpmOverride: Number.isFinite(value) ? value : NaN }, "Set tempo"));
  }

  const nudge = (ms: number) => {
    const offset = Math.max(
      -BEAT_LIMITS.maxGridOffsetMs,
      Math.min(BEAT_LIMITS.maxGridOffsetMs, Math.round((fx?.offsetMs ?? 0) + ms)),
    );
    report(changeBeatFx(clip.id, { offsetMs: offset }, "Nudge beats"));
  };

  if (mine) {
    return (
      <div role="group" aria-label="Beats" className="space-y-2">
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          <span>Finding the beat… {Math.round(running.done * 100)} %</span>
        </div>
        <div
          className="h-1.5 overflow-hidden rounded-full bg-surface-2"
          role="progressbar"
          aria-valuenow={Math.round(running.done * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Finding the beat"
        >
          <div className="h-full bg-accent" style={{ width: `${running.done * 100}%` }} />
        </div>
        <p className="text-xs text-text-muted">
          {left === null ? "Estimating the time left…" : `About ${Math.max(1, Math.round(left))} s left`}
        </p>
        <button
          type="button"
          onClick={() => useBeatStore.getState().cancel()}
          className={cn(buttonClass, plain, "w-full")}
        >
          <Square /> Stop
        </button>
      </div>
    );
  }

  const detectButton = (label: string) => (
    <button
      type="button"
      disabled={running !== null}
      onClick={() => void detect()}
      className={cn(buttonClass, plain, "w-full")}
      title={running ? "Beats are being found for another clip" : undefined}
    >
      <AudioWaveform /> {label}
    </button>
  );

  if (!gridId || grid === null) {
    return (
      <div role="group" aria-label="Beats" className="space-y-2">
        {detectButton("Detect beats")}
        <p className="text-xs text-text-muted">
          {grid === null
            ? "The beats of this clip are no longer stored, or the file has changed. Detect them again."
            : "Finds the beat in the part of the sound this clip uses. Runs on this computer; nothing is uploaded."}
        </p>
        {problem && (
          <p role="alert" className="text-xs text-danger">
            {problem}
          </p>
        )}
      </div>
    );
  }
  if (!grid) return <p className="text-xs text-text-muted">Loading the beats…</p>;

  const bpm = effectiveBpm(grid, fx);
  const count = adjustedBeats(grid, fx).length;
  const half = fx?.halfDouble ?? "normal";
  return (
    <div role="group" aria-label="Beats" className="space-y-3">
      <div className="flex items-baseline justify-between">
        <span className="text-lg font-semibold tabular-nums text-text">{bpm.toFixed(1)} BPM</span>
        <span className="text-xs text-text-muted tabular-nums">{count} beats</span>
      </div>
      {!grid.clear && (
        <p className="text-xs text-accent" role="status">
          No clear beat was found (speech or free-flowing music?). Set the tempo by hand or tap it.
        </p>
      )}
      {grid.clear && !grid.steady && !fx?.bpmOverride && (
        <p className="text-xs text-text-muted">
          The tempo changes: the beats follow the music, not a fixed grid.
        </p>
      )}
      {clip.reversed && (
        <p className="text-xs text-text-muted">This clip plays backwards: its beats are not used.</p>
      )}
      {!gridCoversClip(clip, grid) && (
        <p className="text-xs text-text-muted">
          The clip now uses more of the sound than was analysed. Detect again to find beats in the new part.
        </p>
      )}

      <div role="radiogroup" aria-label="Half or double tempo" className="grid grid-cols-3 gap-1">
        {(["half", "normal", "double"] as const).map((v) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={half === v}
            onClick={() =>
              report(
                changeBeatFx(clip.id, { halfDouble: v === "normal" ? undefined : v }, "Change beat tempo"),
              )
            }
            className={cn(buttonClass, half === v ? pressed : plain)}
          >
            {v === "half" ? "Half" : v === "double" ? "Double" : "Normal"}
          </button>
        ))}
      </div>

      <div className="flex items-end gap-2">
        <label className="flex-1 text-xs text-text-muted">
          Tempo (BPM)
          <input
            type="number"
            inputMode="decimal"
            min={BEAT_LIMITS.minBpm}
            max={BEAT_LIMITS.maxBpm}
            step={0.1}
            placeholder={grid.bpm.toFixed(1)}
            value={bpmDraft ?? (fx?.bpmOverride !== undefined ? String(fx.bpmOverride) : "")}
            onChange={(e) => setBpmDraft(e.target.value)}
            onBlur={commitBpm}
            onKeyDown={(e) => e.key === "Enter" && commitBpm()}
            className="mt-1 h-9 w-full rounded-md border border-border bg-surface-2 px-2 text-text tabular-nums pointer-coarse:h-11"
          />
        </label>
        <button
          type="button"
          onClick={tap}
          className={cn(buttonClass, taps.length ? pressed : plain, "w-24")}
        >
          {taps.length ? `Tap (${taps.length})` : "Tap tempo"}
        </button>
      </div>
      {fx?.bpmOverride !== undefined && (
        <button
          type="button"
          onClick={() => report(changeBeatFx(clip.id, { bpmOverride: undefined }, "Use detected tempo"))}
          className={cn(buttonClass, plain, "w-full")}
        >
          Use the detected tempo ({grid.bpm.toFixed(1)})
        </button>
      )}

      <div>
        <div className="mb-1 flex justify-between text-xs text-text-muted">
          <span>Move the beats</span>
          <span className="tabular-nums">
            {(fx?.offsetMs ?? 0) > 0 ? "+" : ""}
            {fx?.offsetMs ?? 0} ms
          </span>
        </div>
        <div className="grid grid-cols-3 gap-1">
          <button
            type="button"
            onClick={() => nudge(-10)}
            className={cn(buttonClass, plain)}
            aria-label="Move the beats 10 ms earlier"
          >
            −10 ms
          </button>
          <button
            type="button"
            onClick={() => nudge(10)}
            className={cn(buttonClass, plain)}
            aria-label="Move the beats 10 ms later"
          >
            +10 ms
          </button>
          <button
            type="button"
            onClick={() => nudge(30000 / bpm)}
            className={cn(buttonClass, plain)}
            title="For when the beats sit between the kicks"
          >
            ½ beat
          </button>
        </div>
      </div>

      {(fx?.offsetMs || fx?.halfDouble || fx?.bpmOverride) && (
        <button
          type="button"
          onClick={() =>
            report(
              changeBeatFx(
                clip.id,
                { offsetMs: undefined, halfDouble: undefined, bpmOverride: undefined },
                "Reset beat adjustments",
              ),
            )
          }
          className={cn(buttonClass, plain, "w-full")}
        >
          Reset adjustments
        </button>
      )}
      <div role="group" aria-label="Cut on beats" className="space-y-2 border-t pt-3">
        <div className="text-xs text-text-muted">Cut on beats: split this clip every</div>
        <div role="radiogroup" aria-label="Cut every" className="grid grid-cols-4 gap-1">
          {CUT_EVERY.map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={every === n}
              onClick={() => setEvery(n)}
              className={cn(buttonClass, every === n ? pressed : plain)}
            >
              {n === 1 ? "beat" : `${n} beats`}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-xs text-text-muted">
          <input
            type="checkbox"
            checked={removeLeadIn}
            onChange={(e) => setRemoveLeadIn(e.target.checked)}
            className="size-4 accent-[var(--accent)]"
          />
          Remove the part before the first beat and close the gap
        </label>
        <button
          type="button"
          disabled={clip.reversed || cutPoints(clip, grid, every).length === 0}
          onClick={() => report(cutClipOnBeats(clip.id, grid, { every, removeLeadIn }))}
          className={cn(buttonClass, plain, "w-full")}
        >
          Cut on beats
          {!clip.reversed && cutPoints(clip, grid, every).length > 0 && (
            <span className="tabular-nums text-text-muted">
              ({piecesAfterCut(project, clip, grid, every)} pieces)
            </span>
          )}
        </button>
      </div>
      {detectButton("Detect again")}
      {problem && (
        <p role="alert" className="text-xs text-danger">
          {problem}
        </p>
      )}
    </div>
  );
}
