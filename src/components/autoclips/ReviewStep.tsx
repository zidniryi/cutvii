import { useEffect, useState } from "react";
import { ChevronUp, Info, RefreshCw, Trash2 } from "lucide-react";
import { mediaUrl } from "@/lib/media";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/lib/timecode";
import { useAutoClipsStore } from "@/store/autoClips";
import { ClipPreview } from "./ClipPreview";
import { metReasons, sortedClips, TIER_LABEL, type ReviewClip, type Tier } from "@/timeline/autoClips";

const TIER_CLASS: Record<Tier, string> = {
  high: "border-success/50 text-success",
  medium: "border-accent/50 text-accent",
  low: "border-border text-text-muted",
};
const quiet =
  "min-h-9 rounded-md border border-border bg-surface-2 px-3 text-xs text-text-muted hover:text-text disabled:opacity-40 pointer-coarse:min-h-11 focus-visible:outline-accent";
const iconButton =
  "flex size-9 shrink-0 items-center justify-center rounded-md border border-border text-text-muted hover:text-text disabled:opacity-40 pointer-coarse:size-11 focus-visible:outline-accent [&_svg]:size-4";

/** Three still frames across the clip: its start, middle and end. Video only. */
function Thumbs({ clip, path }: { clip: ReviewClip; path: string }) {
  const length = clip.sourceOut - clip.sourceIn;
  return (
    <div aria-hidden className="flex gap-0.5 overflow-hidden rounded-sm">
      {[0.02, 0.5, 0.95].map((share) => (
        <video
          key={share}
          src={`${mediaUrl(path)}#t=${(clip.sourceIn + length * share).toFixed(2)}`}
          preload="metadata"
          muted
          playsInline
          tabIndex={-1}
          className="pointer-events-none h-10 w-1/3 bg-black object-cover"
        />
      ))}
    </div>
  );
}

function Card({
  clip,
  busy,
  replacing,
  selected,
  thumbs,
  onSelect,
}: {
  clip: ReviewClip;
  busy: boolean;
  replacing: boolean;
  selected: boolean;
  /** The video file to take still frames from, when there is a picture. */
  thumbs: string | null;
  onSelect: () => void;
}) {
  const store = useAutoClipsStore.getState;
  const reasons = metReasons(clip);
  // every rule and whether it counted: the "Why this clip" list
  const why = clip.reasons.map((r) => `${r.met ? "✓" : "–"} ${r.label}`).join("\n");
  return (
    <li
      aria-current={selected || undefined}
      onClick={onSelect}
      className={cn(
        selected && "outline outline-2 outline-accent",
        "rounded-lg border bg-surface-2 p-3",
        clip.included ? "border-border" : "border-dashed opacity-70",
      )}
    >
      <div className="flex items-start gap-2">
        <label className="flex size-9 shrink-0 items-center justify-center pointer-coarse:size-11">
          <input
            type="checkbox"
            aria-label={`Include ${clip.title || "clip"}`}
            className="size-4 accent-[var(--accent)]"
            checked={clip.included}
            onChange={() => store().toggle(clip.id)}
          />
        </label>
        <div className="min-w-0 flex-1 space-y-1.5">
          {/* Frames only on the selected card: a video element per frame per card made dozens of
              simultaneous range requests on one big file and crashed the release build. */}
          {thumbs && selected && <Thumbs clip={clip} path={thumbs} />}
          <input
            aria-label="Clip title"
            className="h-9 w-full rounded-md border border-transparent bg-transparent px-1 text-sm font-medium hover:border-border focus:border-border focus:bg-surface-1 pointer-coarse:h-11 focus-visible:outline-accent"
            value={clip.title}
            maxLength={80}
            onChange={(e) => store().setTitle(clip.id, e.target.value)}
          />
          <div className="flex flex-wrap items-center gap-1.5 px-1 text-xs text-text-muted">
            <span className="tabular-nums">
              {formatDuration(clip.sourceOut - clip.sourceIn)} · from {formatDuration(clip.sourceIn)}
            </span>
            <span
              className={cn("rounded-sm border px-1.5 py-0.5", TIER_CLASS[clip.tier])}
              aria-label={`Score: ${TIER_LABEL[clip.tier]}`}
            >
              {TIER_LABEL[clip.tier]}
            </span>
            {reasons.map((r) => (
              <span key={r.rule} className="rounded-sm bg-surface-1 px-1.5 py-0.5">
                {r.label}
              </span>
            ))}
            <span
              tabIndex={0}
              role="note"
              aria-label={`Why this clip: ${why.replaceAll("\n", "; ")}`}
              title={`Why this clip\n${why}`}
              className="flex size-6 items-center justify-center rounded-sm hover:text-text focus-visible:outline-accent [&_svg]:size-3.5"
            >
              <Info />
            </span>
          </div>
          <p className="line-clamp-3 px-1 text-xs text-text-muted">{clip.text}</p>
        </div>
        <div className="flex flex-col gap-1.5 sm:flex-row">
          <button
            type="button"
            aria-label="Find another clip instead of this one"
            title="Find another: the next best clip that does not overlap the others"
            disabled={busy}
            className={iconButton}
            onClick={() => void store().findAnother(clip.id)}
          >
            <RefreshCw className={replacing ? "animate-spin" : undefined} />
          </button>
          <button
            type="button"
            aria-label="Delete this suggestion"
            title="Delete this suggestion (your video is not touched)"
            disabled={busy}
            className={cn(iconButton, "hover:text-danger")}
            onClick={() => store().remove(clip.id)}
          >
            <Trash2 />
          </button>
        </div>
      </div>
    </li>
  );
}

/** Step 2: look through the suggestions, keep the good ones. */
export function ReviewStep() {
  const clips = useAutoClipsStore((s) => s.clips);
  const sort = useAutoClipsStore((s) => s.sort);
  const replacing = useAutoClipsStore((s) => s.replacing);
  const notice = useAutoClipsStore((s) => s.notice);
  const fromCache = useAutoClipsStore((s) => s.fromCache);
  const store = useAutoClipsStore.getState;
  const included = clips.filter((c) => c.included).length;
  const hasHigh = clips.some((c) => c.tier === "high");
  const selectedId = useAutoClipsStore((s) => s.selectedId);
  const context = useAutoClipsStore((s) => s.context);
  const selected = clips.find((c) => c.id === selectedId);
  // narrow screens: the list is a sheet over the bottom of the preview
  const [sheet, setSheet] = useState(false);

  // Up / Down choose a clip, Enter includes or excludes it (Space plays: see ClipPreview)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // the key may arrive on the window itself, which is not an element
      const target = e.target instanceof HTMLElement ? e.target : null;
      const tag = target?.tagName ?? "";
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || target?.getAttribute("role") === "slider") return;
      const s = useAutoClipsStore.getState();
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        s.selectNext(e.key === "ArrowDown" ? 1 : -1);
      } else if (e.key === "Enter" && tag !== "BUTTON" && s.selectedId) {
        e.preventDefault();
        s.toggle(s.selectedId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
      <div className="min-w-0 lg:order-2">
        {selected ? (
          <ClipPreview clip={selected} />
        ) : (
          <p className="py-8 text-center text-sm text-text-muted">Choose a clip to preview it.</p>
        )}
      </div>
      <button
        type="button"
        aria-expanded={sheet}
        onClick={() => setSheet((o) => !o)}
        className="flex min-h-11 items-center justify-center gap-2 rounded-md border bg-surface-2 text-sm lg:hidden [&_svg]:size-4"
      >
        <ChevronUp className={sheet ? "rotate-180" : undefined} />
        {sheet ? "Hide the clip list" : `Show the clip list (${clips.length})`}
      </button>
      <div
        data-sheet={sheet ? "open" : "closed"}
        className={cn(
          "min-w-0 space-y-3 lg:order-1 lg:block",
          sheet
            ? "fixed inset-x-0 top-1/4 bottom-14 z-20 overflow-y-auto rounded-t-lg border-t bg-surface-1 p-3 shadow-xl lg:static lg:overflow-visible lg:rounded-none lg:border-0 lg:p-0 lg:shadow-none"
            : "hidden",
        )}
      >
        <p className="rounded-md border border-border bg-surface-2 px-3 py-2 text-xs text-text-muted">
          These are suggestions from simple rules (pace, pauses, how a part opens and ends). They do not
          predict views. Always check a clip before you use it.
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          <p role="status" className="mr-auto text-sm">
            {included} of {clips.length} selected
            {fromCache && <span className="text-xs text-text-muted"> · transcript reused</span>}
          </p>
          <button type="button" className={quiet} onClick={() => store().setAllIncluded(true)}>
            Select all
          </button>
          <button type="button" className={quiet} onClick={() => store().setAllIncluded(false)}>
            Select none
          </button>
          <button
            type="button"
            className={quiet}
            disabled={!hasHigh}
            title={hasHigh ? undefined : "No clip scored High"}
            onClick={() => store().includeOnly("high")}
          >
            Include only High
          </button>
          <label className="flex items-center gap-1.5 text-xs text-text-muted">
            Sort
            <select
              aria-label="Sort clips"
              className="h-9 rounded-md border bg-surface-2 px-2 text-xs pointer-coarse:h-11 focus-visible:outline-accent"
              value={sort}
              onChange={(e) => store().setSort(e.target.value === "time" ? "time" : "score")}
            >
              <option value="score">Best first</option>
              <option value="time">By time</option>
            </select>
          </label>
        </div>
        {notice && (
          <p role="status" className="rounded-md border border-border px-3 py-2 text-xs text-text-muted">
            {notice}
          </p>
        )}
        {clips.length === 0 ? (
          <p className="py-8 text-center text-sm text-text-muted">
            No suggestions left. Go back to change the settings and search again.
          </p>
        ) : (
          <ul aria-label="Suggested clips" className="space-y-2">
            {sortedClips(clips, sort).map((c) => (
              <Card
                key={c.id}
                clip={c}
                busy={replacing !== null}
                replacing={replacing === c.id}
                selected={c.id === selectedId}
                thumbs={context?.video ? context.path : null}
                onSelect={() => {
                  store().select(c.id);
                  setSheet(false);
                }}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
