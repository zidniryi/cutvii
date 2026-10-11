import { Plus, Type } from "lucide-react";
import { LeftTabs } from "@/components/text/LeftTabs";
import { StyleList } from "@/components/text/StyleList";
import { Panel } from "@/components/Panel";
import { cn } from "@/lib/utils";
import { useProjectStore } from "@/store/project";
import { useSelectionStore } from "@/store/selection";
import { useTextStyleStore } from "@/store/textStyles";
import { useUiStore } from "@/store/ui";
import { addTextAtPlayhead } from "@/timeline/text";
import { matchesStyle } from "@/timeline/textStyles";

const action =
  "flex h-9 flex-1 items-center justify-center gap-1 rounded-md border bg-surface-2 text-xs text-text-muted hover:text-text pointer-coarse:h-11 [&_svg]:size-3.5";

/** The Text tab of the left panel: add a text, in any style, and make styles of your own. */
export function TextStylesPanel() {
  const narrowActive = useUiStore((s) => s.sidePanel === "text");
  const wideActive = useUiStore((s) => s.leftPanel === "text");
  // the style of the one selected text, so its card is marked
  const selectedText = useProjectStore((s) => {
    const ids = useSelectionStore.getState().selectedClipIds;
    if (ids.length !== 1) return undefined;
    const clip = s.project.tracks.flatMap((t) => t.clips).find((c) => c.id === ids[0]);
    return clip && s.project.assets.find((a) => a.id === clip.assetId)?.text;
  });
  useSelectionStore((s) => s.selectedClipIds); // re-read when the selection changes

  return (
    <Panel
      title="Text"
      className={cn(
        narrowActive ? "flex" : "hidden",
        wideActive ? "lg:flex" : "lg:hidden",
        "min-h-0 border-r lg:col-start-1 lg:row-start-1",
      )}
      actions={<LeftTabs />}
    >
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-2">
        <div className="flex gap-1.5">
          <button type="button" className={action} onClick={() => void addTextAtPlayhead()}>
            <Type /> Add text
          </button>
          <button
            type="button"
            className={action}
            onClick={() => {
              const id = useTextStyleStore.getState().create();
              if (id) useTextStyleStore.getState().setEditing(id);
            }}
          >
            <Plus /> New style
          </button>
        </div>
        <StyleList
          isSelected={(preset) => selectedText !== undefined && matchesStyle(selectedText, preset.style)}
          onSelect={(preset) => void addTextAtPlayhead(preset)}
          hint="Choosing a style adds a new text in it at the playhead."
        />
      </div>
    </Panel>
  );
}
