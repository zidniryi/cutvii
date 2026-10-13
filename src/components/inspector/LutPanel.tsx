import { useEffect, useState } from "react";
import { FolderInput, Trash2 } from "lucide-react";
import { confirmDialog } from "@/lib/dialog";
import type { TimelineClip } from "@/project/model";
import { useUiStore } from "@/store/ui";
import { useUserLutStore } from "@/store/userLuts";
import type { ColorAdjust } from "@/timeline/color";
import { changeLut, report } from "@/timeline/editor";

const quiet =
  "flex h-8 items-center gap-1 rounded-md border px-2 text-xs text-text-muted hover:text-text disabled:opacity-40 pointer-coarse:h-11 [&_svg]:size-3.5";

/**
 * An imported LUT (`.cube`) on a clip. It is applied AFTER the Adjust sliders, mixed in by Intensity, and
 * baked into the clip's one colour table, so the preview and the export show the same picture.
 */
export function LutPanel({ clip, adjust }: { clip: TimelineClip; adjust: ColorAdjust }) {
  const luts = useUserLutStore((s) => s.luts);
  useEffect(() => useUserLutStore.getState().ensure(), []);
  const current = clip.lut ?? null;
  const [draft, setDraft] = useState<number | null>(null);
  const missing = current !== null && luts !== null && !luts.some((l) => l.id === current.id);
  const percent = Math.round((draft ?? current?.intensity ?? 1) * 100);
  const notice = (text: string) => useUiStore.getState().setNotice(text);

  function choose(id: string) {
    if (id === "") return void report(changeLut(clip.id, null));
    const lut = luts?.find((l) => l.id === id);
    if (lut) report(changeLut(clip.id, { id: lut.id, name: lut.name, intensity: current?.intensity || 1 }));
  }
  function preview(value: number) {
    if (!current) return;
    setDraft(value / 100);
    useUiStore
      .getState()
      .setColorDraft({ clipId: clip.id, adjust, lut: { ...current, intensity: value / 100 } });
  }
  function commit() {
    if (draft === null || !current) return;
    const intensity = draft;
    setDraft(null);
    report(changeLut(clip.id, { ...current, intensity }));
    useUiStore.getState().setColorDraft(null);
  }
  async function importLuts() {
    try {
      const { added, problems } = await useUserLutStore.getState().importFiles();
      // the first new one goes straight onto this clip: that is why it was imported
      if (added.length > 0) {
        report(
          changeLut(clip.id, { id: added[0].id, name: added[0].name, intensity: current?.intensity || 1 }),
        );
      }
      const parts = [
        added.length > 0 ? `Imported ${added.map((l) => l.name).join(", ")}.` : "",
        ...problems.map((p) => `${p.file}: ${p.message}.`),
      ].filter(Boolean);
      if (parts.length > 0) notice(parts.join(" "));
    } catch (e) {
      notice(`Could not import: ${e instanceof Error ? e.message : e}`);
    }
  }
  async function forget() {
    if (!current) return;
    const agreed = await confirmDialog({
      title: `Remove the LUT “${current.name}” from CutVii?`,
      lines: [
        "CutVii's copy is deleted; the file you imported is not touched.",
        "Clips that use it keep their setting and show it as missing until you import it again.",
      ],
      confirmLabel: "Remove",
    });
    if (!agreed) return;
    try {
      await useUserLutStore.getState().remove(current.id);
    } catch (e) {
      notice(`Could not remove: ${e instanceof Error ? e.message : e}`);
    }
  }

  return (
    <div role="group" aria-label="LUT" className="space-y-2 border-t pt-3">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor="clip-lut" className="text-xs text-text-muted">
          LUT
        </label>
        <button type="button" className={quiet} onClick={() => void importLuts()}>
          <FolderInput /> Import LUT…
        </button>
      </div>
      <div className="flex gap-1">
        <select
          id="clip-lut"
          className="h-8 min-w-0 flex-1 rounded-md border bg-surface-2 px-2 text-xs pointer-coarse:h-11 focus-visible:outline-accent"
          value={current?.id ?? ""}
          onChange={(e) => choose(e.target.value)}
        >
          <option value="">None</option>
          {missing && current && <option value={current.id}>{current.name} (missing)</option>}
          {(luts ?? []).map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          aria-label="Remove this LUT from CutVii"
          title="Remove this LUT from CutVii"
          disabled={!current || missing}
          className={quiet}
          onClick={() => void forget()}
        >
          <Trash2 />
        </button>
      </div>
      {luts !== null && luts.length === 0 && !current && (
        <p className="text-xs text-text-muted">
          Import a <code>.cube</code> file (3D LUT). It is applied after the sliders above.
        </p>
      )}
      {current && !missing && (
        <div>
          <div className="mb-1 flex items-center justify-between text-xs text-text-muted">
            <label htmlFor="clip-lut-intensity">Intensity</label>
            <span className="tabular-nums">{percent} %</span>
          </div>
          <input
            id="clip-lut-intensity"
            type="range"
            min={0}
            max={100}
            step={1}
            value={percent}
            aria-valuetext={`${percent} %`}
            className="w-full accent-[var(--accent)] pointer-coarse:h-11"
            onChange={(e) => preview(Number(e.target.value))}
            onPointerUp={commit}
            onKeyUp={commit}
            onBlur={commit}
          />
        </div>
      )}
      {missing && current && (
        <p role="alert" className="rounded-md border border-danger/50 px-2 py-1.5 text-xs text-text-muted">
          The LUT “{current.name}” is not on this computer. Import the same <code>.cube</code> file again, or
          choose None. Until then the picture is shown without it, and an export stops with a message.
        </p>
      )}
    </div>
  );
}
