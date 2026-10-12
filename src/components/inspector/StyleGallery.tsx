import { useState } from "react";
import { Save } from "lucide-react";
import { StyleList } from "@/components/text/StyleList";
import type { TextSpec } from "@/project/model";
import { allStyles, MAX_STYLE_NAME, useTextStyleStore } from "@/store/textStyles";
import { applyTextStyle } from "@/timeline/text";
import { matchesStyle, styleOfSpec } from "@/timeline/textStyles";

const quiet =
  "flex h-8 items-center gap-1 rounded-md border px-2 text-xs text-text-muted hover:text-text disabled:opacity-40 pointer-coarse:h-11 [&_svg]:size-3.5";

/** "Save as style": the look of this text (not its words, size or place) becomes one of My styles. */
function SaveStyle({ spec, fade }: { spec: TextSpec; fade: number }) {
  const [name, setName] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const mine = useTextStyleStore((s) => s.mine);
  // already exactly one of the styles: nothing new to save
  const existing = allStyles({ mine }).find((p) => matchesStyle(spec, p.style));
  const leave = () => {
    setName(null);
    setProblem(null);
  };
  if (name === null) {
    return (
      <button
        type="button"
        className={quiet}
        disabled={existing !== undefined}
        title={existing ? `This text already looks like \u201c${existing.name}\u201d` : undefined}
        onClick={() => setName("")}
      >
        <Save /> Save as style
      </button>
    );
  }
  return (
    <form
      className="flex flex-wrap items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        const result = useTextStyleStore.getState().saveAs(name, styleOfSpec(spec), fade);
        if ("problem" in result) return setProblem(result.problem);
        leave();
      }}
    >
      <input
        autoFocus
        aria-label="Style name"
        placeholder="Style name"
        maxLength={MAX_STYLE_NAME}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && leave()}
        className="h-8 min-w-0 flex-1 rounded-md border bg-surface-2 px-2 text-xs focus-visible:outline-accent pointer-coarse:h-11"
      />
      <button type="submit" className={quiet}>
        Save
      </button>
      <button type="button" className={quiet} onClick={leave}>
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
 * The styles in the inspector: choosing one restyles the selected text clip as ONE undo step (its words,
 * size and place are kept). The list, its order and the styles themselves are the shared ones.
 */
export function StyleGallery({ clipId, spec, fade = 0 }: { clipId: string; spec: TextSpec; fade?: number }) {
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <p className="text-xs text-text-muted">Styles</p>
      <StyleList
        isSelected={(preset) => matchesStyle(spec, preset.style)}
        onSelect={(preset) => void applyTextStyle(clipId, preset).then(setProblem)}
      />
      <SaveStyle spec={spec} fade={fade} />
      {problem && (
        <p role="alert" className="text-xs text-danger">
          {problem}
        </p>
      )}
    </div>
  );
}
