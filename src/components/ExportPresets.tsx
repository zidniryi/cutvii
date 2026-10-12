import { useState } from "react";
import { Save, X } from "lucide-react";
import type { ExportOptions } from "@/export/options";
import { describeOptions, MAX_EXPORT_PRESET_NAME, sameOptions } from "@/export/presets";
import { cn } from "@/lib/utils";
import { useExportPresetStore } from "@/store/exportPresets";

const quiet =
  "flex h-9 items-center gap-1 rounded-md border px-2 text-xs text-text-muted hover:text-text disabled:opacity-40 pointer-coarse:h-11 [&_svg]:size-3.5";

/**
 * The user's export presets in the Export dialog: press one to use its settings, save the current settings
 * under a name, rename or delete one.
 */
export function ExportPresets({
  options,
  onApply,
}: {
  options: ExportOptions;
  onApply: (options: ExportOptions) => void;
}) {
  const mine = useExportPresetStore((s) => s.mine);
  const store = useExportPresetStore.getState;
  // "new" = naming a new preset; an id = renaming that one
  const [naming, setNaming] = useState<"new" | string | null>(null);
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const current = mine.find((p) => sameOptions(p.options, options));
  const leave = () => {
    setNaming(null);
    setName("");
    setProblem(null);
  };

  return (
    <div role="group" aria-label="My export presets" className="space-y-2">
      <p className="text-xs text-text-muted">My presets</p>
      {mine.length === 0 && naming === null && (
        <p className="text-xs text-text-muted">
          None yet. Choose the settings below, then save them to reuse with one press.
        </p>
      )}
      {mine.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {mine.map((p) => (
            <li key={p.id} className="flex">
              <button
                type="button"
                aria-pressed={current?.id === p.id}
                title={describeOptions(p.options)}
                onClick={() => onApply(p.options)}
                className={cn(
                  "min-h-9 rounded-l-md border px-3 text-left text-sm pointer-coarse:min-h-11 focus-visible:outline-accent",
                  current?.id === p.id
                    ? "border-accent bg-accent-soft text-text"
                    : "border-border bg-surface-2 text-text-muted hover:text-text",
                )}
              >
                {p.name}
              </button>
              <button
                type="button"
                aria-label={`Delete preset ${p.name}`}
                title="Delete this preset"
                onClick={() => store().remove(p.id)}
                className="flex min-h-9 w-8 items-center justify-center rounded-r-md border border-l-0 border-border bg-surface-2 text-text-muted hover:text-danger pointer-coarse:min-h-11 pointer-coarse:w-11 focus-visible:outline-accent [&_svg]:size-3.5"
              >
                <X />
              </button>
            </li>
          ))}
        </ul>
      )}
      {naming === null ? (
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            className={quiet}
            disabled={current !== undefined}
            title={current ? `These settings are already saved as “${current.name}”` : undefined}
            onClick={() => setNaming("new")}
          >
            <Save /> Save as preset
          </button>
          {current && (
            <button
              type="button"
              className={quiet}
              onClick={() => {
                setNaming(current.id);
                setName(current.name);
              }}
            >
              Rename “{current.name}”
            </button>
          )}
        </div>
      ) : (
        <form
          className="flex flex-wrap items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (naming === "new") {
              const result = store().save(name, options);
              if ("problem" in result) return setProblem(result.problem);
            } else {
              const failed = store().rename(naming, name);
              if (failed) return setProblem(failed);
            }
            leave();
          }}
        >
          <input
            autoFocus
            aria-label="Preset name"
            placeholder="Preset name"
            maxLength={MAX_EXPORT_PRESET_NAME}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              e.stopPropagation(); // leave the name field, not the whole Export dialog
              leave();
            }}
            className="h-9 min-w-0 flex-1 rounded-md border bg-surface-2 px-2 text-sm focus-visible:outline-accent pointer-coarse:h-11"
          />
          <button type="submit" className={quiet}>
            {naming === "new" ? "Save" : "Rename"}
          </button>
          <button type="button" className={quiet} onClick={leave}>
            Cancel
          </button>
          {naming === "new" && (
            <span className="w-full text-xs text-text-muted">{describeOptions(options)}</span>
          )}
          {problem && (
            <p role="alert" className="w-full text-xs text-danger">
              {problem}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
