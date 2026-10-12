import { useEffect, useState } from "react";
import { ClipboardCopy, ClipboardPaste, CopyCheck, FolderInput, MoreHorizontal, Save } from "lucide-react";
import { confirmDialog } from "@/lib/dialog";
import { thumbnailUrl } from "@/lib/media";
import { cn } from "@/lib/utils";
import type { ColorAdjust, MediaAsset, TimelineClip } from "@/project/model";
import { lookPreviewKey, useLookPreviewStore } from "@/store/lookPreviews";
import { useProjectStore } from "@/store/project";
import { useUiStore } from "@/store/ui";
import { colorOf, isGraded, NO_COLOR, sameColor } from "@/timeline/color";
import { applyColorToAll, changeColor, report } from "@/timeline/editor";
import { isOwnPreset, MAX_PRESET_NAME, useColorPresetStore } from "@/store/colorPresets";
import { colourClipCount, lookAt, LOOKS, matchLook, type Look } from "@/timeline/looks";

const quiet =
  "flex h-8 items-center gap-1 rounded-md border px-2 text-xs text-text-muted hover:text-text disabled:opacity-40 pointer-coarse:h-11 [&_svg]:size-3.5";

function Card({
  name,
  picture,
  selected,
  onSelect,
  menu,
}: {
  name: string;
  picture?: string;
  selected: boolean;
  onSelect: () => void;
  /** A menu button over the card (the user's own presets). */
  menu?: React.ReactNode;
}) {
  return (
    <div className="relative">
      <button
        type="button"
        aria-label={name}
        aria-pressed={selected}
        title={name}
        onClick={onSelect}
        className={cn(
          "block w-full overflow-hidden rounded-md border bg-surface-2 text-left focus-visible:outline-accent pointer-coarse:min-h-11",
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
      {menu}
    </div>
  );
}

const menuItem =
  "flex h-9 w-full items-center rounded-sm px-2 text-left text-xs hover:bg-accent-soft pointer-coarse:h-11";

/** Rename, duplicate, export and delete for one of the user's presets. */
function PresetMenu({ preset }: { preset: Look }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const store = useColorPresetStore.getState;
  const close = () => {
    setOpen(false);
    setName(null);
    setProblem(null);
  };
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  async function exportIt() {
    close();
    try {
      const path = await store().exportFile(preset.id);
      if (path) useUiStore.getState().setNotice(`Preset saved as ${path}`);
    } catch (e) {
      useUiStore.getState().setNotice(`Could not export the preset: ${e instanceof Error ? e.message : e}`);
    }
  }
  return (
    <>
      <button
        type="button"
        aria-label={`${preset.name} options`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        className="absolute top-1 right-1 flex size-6 items-center justify-center rounded-md bg-black/60 text-text-muted hover:text-text pointer-coarse:size-11 [&_svg]:size-3.5"
      >
        <MoreHorizontal />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={`${preset.name} preset`}
          className="absolute top-8 right-0 z-20 w-40 rounded-md border bg-popover p-1 shadow-lg"
        >
          {name !== null ? (
            <form
              className="space-y-1 p-1"
              onSubmit={(e) => {
                e.preventDefault();
                const failed = store().rename(preset.id, name);
                if (failed) setProblem(failed);
                else close();
              }}
            >
              <input
                autoFocus
                aria-label="New name"
                maxLength={MAX_PRESET_NAME}
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="h-9 w-full rounded-md border bg-surface-2 px-2 text-xs focus-visible:outline-accent pointer-coarse:h-11"
              />
              {problem && (
                <p role="alert" className="text-[11px] text-danger">
                  {problem}
                </p>
              )}
              <button type="submit" className={cn(menuItem, "justify-center border")}>
                Rename
              </button>
            </form>
          ) : (
            <>
              <button role="menuitem" className={menuItem} onClick={() => setName(preset.name)}>
                Rename
              </button>
              <button
                role="menuitem"
                className={menuItem}
                onClick={() => {
                  store().duplicate(preset.id);
                  close();
                }}
              >
                Duplicate
              </button>
              <button role="menuitem" className={menuItem} onClick={() => void exportIt()}>
                Export as a file…
              </button>
              <button
                role="menuitem"
                className={cn(menuItem, "text-danger")}
                onClick={() => {
                  store().remove(preset.id);
                  close();
                }}
              >
                Delete
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
}

/** "Save as preset": a name, then the clip's current colour becomes one of the user's presets. */
function SavePreset({ adjust }: { adjust: ColorAdjust }) {
  const [name, setName] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  if (name === null) {
    return (
      <button
        type="button"
        className={quiet}
        disabled={!isGraded(adjust)}
        title={isGraded(adjust) ? undefined : "Change a colour slider or choose a look first"}
        onClick={() => setName("")}
      >
        <Save /> Save as preset
      </button>
    );
  }
  return (
    <form
      className="flex w-full flex-wrap items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        const result = useColorPresetStore.getState().save(name, adjust);
        if ("problem" in result) return setProblem(result.problem);
        setName(null);
        setProblem(null);
      }}
    >
      <input
        autoFocus
        aria-label="Preset name"
        placeholder="Preset name"
        maxLength={MAX_PRESET_NAME}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && (setName(null), setProblem(null))}
        className="h-8 min-w-0 flex-1 rounded-md border bg-surface-2 px-2 text-xs focus-visible:outline-accent pointer-coarse:h-11"
      />
      <button type="submit" className={quiet}>
        Save
      </button>
      <button type="button" className={quiet} onClick={() => (setName(null), setProblem(null))}>
        Cancel
      </button>
      {problem && (
        <p role="alert" className="w-full text-[11px] text-danger">
          {problem}
        </p>
      )}
    </form>
  );
}

/**
 * Looks for a clip: a gallery whose pictures are a frame of this clip through each look, an Intensity
 * slider, copy / paste of the colour, and "apply to all clips". Choosing a look sets the Adjust sliders
 * below (one undo step); nothing else is stored.
 */
export function LooksPanel({ clip, asset }: { clip: TimelineClip; asset: MediaAsset }) {
  const stored = colorOf(clip);
  const mine = useColorPresetStore((s) => s.mine);
  const all = [...LOOKS, ...mine];
  const match = matchLook(stored, all);
  const look = all.find((l) => l.id === match?.id);
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
    useLookPreviewStore
      .getState()
      .ensure(asset.path, frameAt, [NO_COLOR, ...LOOKS.map((l) => l.adjust), ...mine.map((l) => l.adjust)]);
  }, [asset.path, frameAt, mine]);
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
  async function importPresets() {
    try {
      const { added, skipped, problems } = await useColorPresetStore.getState().importFiles();
      const parts = [
        added.length > 0 ? `Imported ${added.join(", ")}.` : "",
        skipped.length > 0 ? `Already had ${skipped.join(", ")}.` : "",
        ...problems.map((p) => `${p.file}: ${p.message}.`),
      ].filter(Boolean);
      if (parts.length > 0) useUiStore.getState().setNotice(parts.join(" "));
    } catch (e) {
      useUiStore.getState().setNotice(`Could not import: ${e instanceof Error ? e.message : e}`);
    }
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
    <div role="group" aria-label="Presets" className="space-y-2">
      <p className="text-xs text-text-muted">Presets</p>
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
      {mine.length > 0 && (
        <div role="group" aria-label="My presets" className="space-y-1">
          <p className="text-xs text-text-muted">My presets</p>
          <div className="grid grid-cols-3 gap-1.5">
            {mine.map((l) => (
              <Card
                key={l.id}
                name={l.name}
                picture={picture(l.adjust)}
                selected={match?.id === l.id}
                onSelect={() => choose(l.adjust)}
                menu={isOwnPreset(l.id) ? <PresetMenu preset={l} /> : undefined}
              />
            ))}
          </div>
        </div>
      )}
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
        <SavePreset adjust={stored} />
        <button type="button" className={quiet} onClick={() => void importPresets()}>
          <FolderInput /> Import preset…
        </button>
      </div>
    </div>
  );
}
