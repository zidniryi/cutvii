import { useEffect, useState } from "react";
import { Plus, Search } from "lucide-react";
import { thumbnailUrl } from "@/lib/media";
import { cn } from "@/lib/utils";
import type { TextSpec } from "@/project/model";
import { useStylePreviewStore } from "@/store/stylePreviews";
import { addTextAtPlayhead, applyTextStyle } from "@/timeline/text";
import { matchesStyle, STYLE_PRESETS, type StylePreset } from "@/timeline/textStyles";

function Tile({
  preset,
  preview,
  active,
  onApply,
  onAdd,
}: {
  preset: StylePreset;
  preview?: string;
  active: boolean;
  onApply: () => void;
  onAdd: () => void;
}) {
  const [broken, setBroken] = useState(false);
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-md border bg-surface-2",
        active ? "border-accent ring-1 ring-accent" : "border-border",
      )}
    >
      <button
        type="button"
        aria-label={preset.name}
        aria-pressed={active}
        title={`Use the ${preset.name} style`}
        onClick={onApply}
        className="block w-full text-left focus-visible:outline-accent"
      >
        {/* a mid-dark backdrop, so light and dark styles are both readable */}
        <span className="flex h-[68px] items-center justify-center bg-[#3a3f47]">
          {preview && !broken ? (
            <img
              src={thumbnailUrl(preview)}
              alt=""
              draggable={false}
              onError={() => setBroken(true)}
              className="h-full w-full object-contain"
            />
          ) : (
            <span className="text-xs text-text">Aa</span>
          )}
        </span>
        <span className="block truncate px-2 py-1 text-xs text-text-muted">{preset.name}</span>
      </button>
      <button
        type="button"
        aria-label={`Add a new ${preset.name} text`}
        title={`Add a new text in the ${preset.name} style at the playhead`}
        onClick={onAdd}
        className="absolute top-1 right-1 flex size-6 items-center justify-center rounded-md bg-black/60 text-text-muted hover:text-text pointer-coarse:size-11 [&_svg]:size-3.5"
      >
        <Plus />
      </button>
    </div>
  );
}

/**
 * Ready-made text styles. Choosing one restyles the selected text clip as ONE undo step (its words, size
 * and place are kept); the plus on a tile adds a new text in that style instead.
 */
export function StyleGallery({ clipId, spec }: { clipId: string; spec: TextSpec }) {
  const previews = useStylePreviewStore((s) => s.previews);
  const [query, setQuery] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => useStylePreviewStore.getState().ensure(), []);
  const q = query.trim().toLowerCase();
  const shown = STYLE_PRESETS.filter((p) => p.name.toLowerCase().includes(q));

  return (
    <div role="group" aria-label="Styles" className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-text-muted">Styles</p>
        <div className="relative w-36">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-text-muted" />
          <input
            aria-label="Search styles"
            placeholder="Search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-7 w-full rounded-md border bg-surface-2 pr-2 pl-7 text-xs focus-visible:outline-accent pointer-coarse:h-11"
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {shown.map((preset) => (
          <Tile
            key={preset.id}
            preset={preset}
            preview={previews[preset.id]}
            active={matchesStyle(spec, preset.style)}
            onApply={() => void applyTextStyle(clipId, preset).then(setProblem)}
            onAdd={() => void addTextAtPlayhead(preset)}
          />
        ))}
      </div>
      {shown.length === 0 && <p className="text-xs text-text-muted">No style matches “{query.trim()}”.</p>}
      {problem && (
        <p role="alert" className="text-xs text-danger">
          {problem}
        </p>
      )}
    </div>
  );
}
