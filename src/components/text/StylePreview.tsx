import { useEffect, useState } from "react";
import { thumbnailUrl } from "@/lib/media";
import { cn } from "@/lib/utils";
import type { TextStyle } from "@/project/model";
import { previewKey, useStylePreviewStore } from "@/store/stylePreviews";

/**
 * A sample of a text style, as drawn by the text rasterizer itself. Used by every style card, the style
 * editor and the subtitle step, so what is shown is what will be made.
 */
export function StylePreview({
  style,
  label,
  className,
}: {
  style: TextStyle;
  /** Written in the sample (the style's name). */
  label: string;
  className?: string;
}) {
  const key = previewKey(style, label);
  const path = useStylePreviewStore((s) => s.previews[key]);
  const [broken, setBroken] = useState<string | null>(null);
  useEffect(() => useStylePreviewStore.getState().ensure(style, label), [key]); // eslint-disable-line react-hooks/exhaustive-deps -- `key` stands for both
  return (
    // a mid-dark backdrop, so light and dark styles are both readable
    <span
      data-testid="style-preview"
      data-preview-key={key}
      className={cn("flex items-center justify-center overflow-hidden bg-[#3a3f47]", className)}
    >
      {path && broken !== path ? (
        <img
          src={thumbnailUrl(path)}
          alt=""
          draggable={false}
          onError={() => setBroken(path)}
          className="h-full w-full object-contain"
        />
      ) : (
        <span className="text-xs font-semibold text-white">Aa</span>
      )}
    </span>
  );
}
