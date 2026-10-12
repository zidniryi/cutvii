import { useEffect, useState } from "react";
import { ClipboardCopy, ClipboardPaste, CopyCheck } from "lucide-react";
import { confirmDialog } from "@/lib/dialog";
import { thumbnailUrl } from "@/lib/media";
import { cn } from "@/lib/utils";
import type { ColorAdjust, MediaAsset, TimelineClip } from "@/project/model";
import { lookPreviewKey, useLookPreviewStore } from "@/store/lookPreviews";
import { useProjectStore } from "@/store/project";
import { useUiStore } from "@/store/ui";
import { colorOf, isGraded, NO_COLOR, sameColor } from "@/timeline/color";
import { applyColorToAll, changeColor, report } from "@/timeline/editor";
import { colourClipCount, lookAt, LOOKS, matchLook } from "@/timeline/looks";

const quiet =
  "flex h-8 items-center gap-1 rounded-md border px-2 text-xs text-text-muted hover:text-text disabled:opacity-40 pointer-coarse:h-11 [&_svg]:size-3.5";

function Card({
  name,
  picture,
  selected,
  onSelect,
}: {
  name: string;
  picture?: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={name}
      aria-pressed={selected}
      title={name}
      onClick={onSelect}
      className={cn(
        "overflow-hidden rounded-md border bg-surface-2 text-left focus-visible:outline-accent pointer-coarse:min-h-11",
        selected ? "border-accent ring-1 ring-accent" : "border-border",
      )}
    >
      {picture ? (
        <img
          src={thumbnailUrl(picture)}
          alt=""
          draggable={false}
          className="aspect-video w-full object-cover"
        />
      ) : (
        <span aria-hidden className="block aspect-video w-full bg-surface-1" />
      )}
      <span className="block truncate px-1.5 py-1 text-[11px] text-text-muted">{name}</span>
    </button>
  );
}

/**
 * Looks for a clip: a gallery whose pictures are a frame of this clip through each look, an Intensity
 * slider, copy / paste of the colour, and "apply to all clips". Choosing a look sets the Adjust sliders
 * below (one undo step); nothing else is stored.
 */
export function LooksPanel({ clip, asset }: { clip: TimelineClip; asset: MediaAsset }) {
  const stored = colorOf(clip);
  const match = matchLook(stored);
  const look = LOOKS.find((l) => l.id === match?.id);
  const [dragging, setDragging] = useState<number | null>(null);
  // Neighbouring percents can give the same values; keep showing the one the user let go of, as long as
  // it still describes the clip, so the slider does not jump by one after a drag.
  const [chosen, setChosen] = useState<number | null>(null);
  const kept = look && chosen !== null && sameColor(lookAt(look.adjust, chosen), stored) ? chosen : null;
  const intensity = dragging ?? kept ?? match?.intensity ?? 100;
  const copied = useUiStore((s) => s.colorClipboard);
  const total = useProjectStore((s) => colourClipCount(s.project));
  // a frame from the middle of what the clip uses: stable while the playhead moves
  const at = Math.round(((clip.sourceIn + clip.sourceOut) / 2) * 1000) / 1000;
  const frameAt = asset.type === "image" ? 0 : at;
  const pictures = useLookPreviewStore((s) => s.pictures);
  useEffect(() => {
    useLookPreviewStore.getState().ensure(asset.path, frameAt, [NO_COLOR, ...LOOKS.map((l) => l.adjust)]);
  }, [asset.path, frameAt]);
  useEffect(() => () => useUiStore.getState().setColorDraft(null), [clip.id]);
  const picture = (adjust: ColorAdjust) => pictures[lookPreviewKey(asset.path, frameAt, adjust)];

  function choose(adjust: ColorAdjust | null) {
    // the look replaces whatever the sliders had: clear, then set, as one step
    report(changeColor(clip.id, adjust ? lookAt(adjust, 100) : null, true));
  }
  function previewIntensity(value: number) {
    if (!look) return;
    setDragging(value);
    useUiStore.getState().setColorDraft({ clipId: clip.id, adjust: lookAt(look.adjust, value) });
  }
  function commitIntensity() {
    if (dragging === null || !look) return;
    const value = dragging;
    setDragging(null);
    setChosen(value);
    // 0 % is the same as no look at all
    report(changeColor(clip.id, value === 0 ? null : lookAt(look.adjust, value), true));
    useUiStore.getState().setColorDraft(null);
  }
  async function applyToAll() {
    const others = total - 1;
    const agreed = await confirmDialog({
      title: isGraded(stored) ? "Use this colour on all clips?" : "Remove the colour from all clips?",
      lines: [
        `${others} other clip${others === 1 ? "" : "s"} will get exactly this clip's colour settings, replacing their own.`,
        "It is one step: Undo brings every clip's colour back.",
      ],
      confirmLabel: "Apply to all",
    });
    if (agreed) report(applyColorToAll(isGraded(stored) ? stored : null));
  }

  return (
    <div role="group" aria-label="Looks" className="space-y-2">
      <p className="text-xs text-text-muted">Looks</p>
      <div className="grid grid-cols-3 gap-1.5">
        <Card
          name="None"
          picture={picture(NO_COLOR)}
          selected={!isGraded(stored)}
          onSelect={() => choose(null)}
        />
        {LOOKS.map((l) => (
          <Card
            key={l.id}
            name={l.name}
            picture={picture(l.adjust)}
            selected={match?.id === l.id}
            onSelect={() => choose(l.adjust)}
          />
        ))}
      </div>
      <div>
        <div className="mb-1 flex items-center justify-between text-xs text-text-muted">
          <label htmlFor="look-intensity">Intensity{look ? ` of ${look.name}` : ""}</label>
          <span className="tabular-nums">{look ? `${intensity}%` : "–"}</span>
        </div>
        <input
          id="look-intensity"
          type="range"
          min={0}
          max={100}
          step={1}
          value={look ? intensity : 100}
          disabled={!look}
          title={look ? undefined : "Choose a look first"}
          className="w-full accent-[var(--accent)] disabled:opacity-40 pointer-coarse:h-11"
          onChange={(e) => previewIntensity(Number(e.target.value))}
          onPointerUp={commitIntensity}
          onKeyUp={commitIntensity}
          onBlur={commitIntensity}
        />
        {!look && isGraded(stored) && (
          <p className="text-[11px] text-text-muted">
            Custom colour (the sliders below were changed by hand).
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-1">
        <button
          type="button"
          className={quiet}
          disabled={!isGraded(stored)}
          onClick={() => {
            useUiStore.getState().setColorClipboard(stored);
            useUiStore.getState().setNotice("Colour copied. Select another clip and choose Paste colour.");
          }}
        >
          <ClipboardCopy /> Copy colour
        </button>
        <button
          type="button"
          className={quiet}
          disabled={!copied || sameColor(copied, stored)}
          title={copied ? undefined : "Copy a clip's colour first"}
          onClick={() => copied && report(changeColor(clip.id, copied, true))}
        >
          <ClipboardPaste /> Paste colour
        </button>
        <button
          type="button"
          className={quiet}
          disabled={total < 2}
          title={total < 2 ? "There is no other clip with a picture" : undefined}
          onClick={() => void applyToAll()}
        >
          <CopyCheck /> Apply to all clips
        </button>
      </div>
    </div>
  );
}
