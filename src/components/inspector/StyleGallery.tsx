import { useState } from "react";
import { StyleList } from "@/components/text/StyleList";
import type { TextSpec } from "@/project/model";
import { applyTextStyle } from "@/timeline/text";
import { matchesStyle } from "@/timeline/textStyles";

/**
 * The styles in the inspector: choosing one restyles the selected text clip as ONE undo step (its words,
 * size and place are kept). The list, its order and the styles themselves are the shared ones.
 */
export function StyleGallery({ clipId, spec }: { clipId: string; spec: TextSpec }) {
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <p className="text-xs text-text-muted">Styles</p>
      <StyleList
        isSelected={(preset) => matchesStyle(spec, preset.style)}
        onSelect={(preset) => void applyTextStyle(clipId, preset).then(setProblem)}
      />
      {problem && (
        <p role="alert" className="text-xs text-danger">
          {problem}
        </p>
      )}
    </div>
  );
}
