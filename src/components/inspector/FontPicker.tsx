import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, FilePlus2, Search } from "lucide-react";
import { thumbnailUrl } from "@/lib/media";
import { cn } from "@/lib/utils";
import type { FontInfo } from "@/store/fonts";

interface Props {
  fonts: FontInfo[];
  /** Family the text uses now (it may be one that is not installed here). */
  value: string;
  onChange: (family: string) => void;
  onImport: () => void;
}

/** A font's name drawn in the font itself (a picture made by Rust), or plain text until that exists. */
function FontName({ font }: { font: FontInfo }) {
  const [broken, setBroken] = useState(false);
  if (!font.preview || broken) return <span className="truncate text-sm">{font.family}</span>;
  return (
    <img
      src={thumbnailUrl(font.preview)}
      alt=""
      draggable={false}
      onError={() => setBroken(true)}
      // the picture is twice this size, so it stays sharp on dense screens
      className="h-8 w-[280px] max-w-none shrink-0 object-cover object-left"
    />
  );
}

/** Where the floating list goes, in window px. It is not clipped by the panel the button sits in. */
interface Placement {
  left: number;
  width: number;
  /** Set when the list hangs below the button. */
  top?: number;
  /** Set when it opens upwards instead (not enough room below). */
  bottom?: number;
  listHeight: number;
}

const MIN_WIDTH = 340;
const MAX_LIST_HEIGHT = 360;
const MIN_LIST_HEIGHT = 120;
/** Search box, import row and borders around the scrolling list. */
const CHROME_HEIGHT = 86;
const GAP = 4;
const EDGE = 8;

/** Below the button when there is room for a useful list, otherwise above it; never off the window. */
export function placeList(
  button: { left: number; right: number; top: number; bottom: number; width: number },
  viewport: { width: number; height: number },
): Placement {
  const width = Math.min(Math.max(button.width, MIN_WIDTH), Math.max(0, viewport.width - EDGE * 2));
  const left = Math.max(EDGE, Math.min(button.left, viewport.width - width - EDGE));
  const below = viewport.height - button.bottom - GAP - EDGE - CHROME_HEIGHT;
  const above = button.top - GAP - EDGE - CHROME_HEIGHT;
  const fit = (space: number) => Math.max(MIN_LIST_HEIGHT, Math.min(MAX_LIST_HEIGHT, space));
  return below >= 200 || below >= above
    ? { left, width, top: button.bottom + GAP, listHeight: fit(below) }
    : { left, width, bottom: viewport.height - button.top + GAP, listHeight: fit(above) };
}

/** Font chooser for text: a button that opens a searchable list, each font shown in its own typeface. */
export function FontPicker({ fonts, value, onChange, onImport }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const uid = useId();

  // imported fonts first (the user brought them in on purpose), then the bundled ones; both A to Z
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...fonts]
      .sort((a, b) => Number(a.bundled) - Number(b.bundled) || a.family.localeCompare(b.family))
      .filter((f) => f.family.toLowerCase().includes(q));
  }, [fonts, query]);
  const current = fonts.find((f) => f.family === value);

  function openList() {
    setQuery("");
    setActive(
      Math.max(
        0,
        [...fonts]
          .sort((a, b) => Number(a.bundled) - Number(b.bundled) || a.family.localeCompare(b.family))
          .findIndex((f) => f.family === value),
      ),
    );
    const button = root.current?.getBoundingClientRect();
    setPlacement(
      placeList(button ?? { left: 0, right: 0, top: 0, bottom: 0, width: 0 }, {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    );
    setOpen(true);
  }
  function choose(family: string) {
    setOpen(false);
    if (family !== value) onChange(family);
  }

  // close when the pointer goes down anywhere else, and when the button moves from under the list
  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) =>
      target instanceof Node && (root.current?.contains(target) || panel.current?.contains(target));
    const outside = (e: Event) => {
      if (!inside(e.target)) setOpen(false);
    };
    const close = () => setOpen(false);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("scroll", outside, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("scroll", outside, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  // keep the highlighted font in view while moving with the arrow keys
  useEffect(() => {
    if (open) list.current?.querySelector('[data-active="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [open, active, shown]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      root.current?.querySelector<HTMLButtonElement>("[data-font-trigger]")?.focus();
      return;
    }
    e.stopPropagation(); // typing here must not trigger editor shortcuts
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (shown.length === 0) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i + step + shown.length) % shown.length);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setActive(e.key === "Home" ? 0 : Math.max(0, shown.length - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const font = shown[Math.min(active, shown.length - 1)];
      if (font) choose(font.family);
    }
  }

  const firstBundled = shown.findIndex((f) => f.bundled);
  return (
    <div ref={root} className="relative">
      <button
        type="button"
        data-font-trigger
        aria-label={`Font: ${value}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openList())}
        className={cn(
          "flex h-10 w-full items-center gap-2 overflow-hidden rounded-md border bg-surface-2 pr-2 pl-1 text-left pointer-coarse:h-11 focus-visible:outline-accent",
          open && "border-accent",
        )}
      >
        <span className="flex min-w-0 flex-1 items-center overflow-hidden pl-1">
          {current ? <FontName font={current} /> : <span className="truncate text-sm">{value}</span>}
        </span>
        <ChevronDown
          className={cn("size-4 shrink-0 text-text-muted transition-transform", open && "rotate-180")}
        />
      </button>

      {open &&
        placement &&
        createPortal(
          <div
            ref={panel}
            role="dialog"
            aria-label="Choose a font"
            onKeyDown={onKeyDown}
            className="fixed z-50 overflow-hidden rounded-md border bg-surface-1 text-text shadow-xl shadow-black/60"
            style={{
              left: placement.left,
              width: placement.width,
              top: placement.top,
              bottom: placement.bottom,
            }}
          >
            <div className="relative border-b">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-text-muted" />
              <input
                autoFocus
                role="combobox"
                aria-label="Search fonts"
                aria-expanded
                aria-controls={`${uid}-list`}
                aria-activedescendant={shown[active] ? `${uid}-${active}` : undefined}
                placeholder={`Search ${fonts.length} fonts`}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                className="h-10 w-full bg-transparent pr-2 pl-8 text-sm outline-none placeholder:text-text-muted pointer-coarse:h-11"
              />
            </div>

            <ul
              id={`${uid}-list`}
              ref={list}
              role="listbox"
              aria-label="Fonts"
              className="overflow-y-auto py-1"
              style={{ maxHeight: placement.listHeight }}
            >
              {shown.length === 0 && (
                <li role="presentation" className="px-3 py-4 text-center text-xs text-text-muted">
                  No font matches “{query.trim()}”.
                </li>
              )}
              {shown.map((font, i) => {
                const selected = font.family === value;
                return (
                  <li key={font.family} role="presentation">
                    {i === 0 && !font.bundled && (
                      <p className="px-3 pt-1 pb-0.5 text-[10px] tracking-wide text-text-muted uppercase">
                        Imported
                      </p>
                    )}
                    {i === firstBundled && firstBundled > 0 && (
                      <p className="mt-1 border-t px-3 pt-2 pb-0.5 text-[10px] tracking-wide text-text-muted uppercase">
                        Included
                      </p>
                    )}
                    <button
                      type="button"
                      id={`${uid}-${i}`}
                      role="option"
                      aria-selected={selected}
                      aria-label={font.family}
                      title={font.family}
                      data-active={i === active}
                      tabIndex={-1}
                      onPointerMove={() => i !== active && setActive(i)}
                      onClick={() => choose(font.family)}
                      className={cn(
                        "flex h-10 w-full items-center gap-1 overflow-hidden px-2 text-left pointer-coarse:h-11",
                        i === active && "bg-surface-2",
                        selected && "text-accent",
                      )}
                    >
                      <span className="flex size-5 shrink-0 items-center justify-center text-accent">
                        {selected && <Check className="size-4" />}
                      </span>
                      <span className="flex min-w-0 flex-1 items-center overflow-hidden">
                        <FontName font={font} />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>

            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onImport();
              }}
              className="flex h-10 w-full items-center gap-2 border-t px-3 text-left text-xs text-text-muted hover:bg-surface-2 hover:text-text pointer-coarse:h-11 [&_svg]:size-4"
            >
              <FilePlus2 />
              Import a font file (.ttf, .otf)…
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}
