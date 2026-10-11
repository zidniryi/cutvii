import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, MoreHorizontal, Pencil, Plus, Search, TextCursorInput, Trash2 } from "lucide-react";
import { StylePreview } from "@/components/text/StylePreview";
import { Button } from "@/components/ui/button";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/utils";
import type { StylePreset } from "@/project/model";
import { isBuiltIn, orderedStyles, useTextStyleStore } from "@/store/textStyles";

/** How many styles a list shows before "Show more". */
export const VISIBLE_STYLES = 6;

const menuItem =
  "flex h-9 w-full items-center gap-2 rounded-sm px-2 text-left text-xs hover:bg-accent-soft pointer-coarse:h-11 [&_svg]:size-3.5";

/** Open the editor for a style. A built-in one is never changed: a copy of it is made and edited instead. */
export function editStyle(preset: StylePreset) {
  const store = useTextStyleStore.getState();
  const id = isBuiltIn(preset.id) ? store.create(preset) : preset.id;
  if (id) store.setEditing(id);
}

function CardMenu({ preset, onClose }: { preset: StylePreset; onClose: () => void }) {
  const own = !isBuiltIn(preset.id);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(preset.name);
  const [problem, setProblem] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);
  const store = useTextStyleStore.getState();
  const act = (run: () => void) => () => {
    run();
    onClose();
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`${preset.name} style`}
      onKeyDown={(e) => e.stopPropagation()}
      className="absolute top-8 right-1 z-20 w-40 rounded-md border bg-popover p-1 shadow-lg"
    >
      {renaming ? (
        <form
          className="space-y-1 p-1"
          onSubmit={(e) => {
            e.preventDefault();
            const failed = store.rename(preset.id, name);
            if (failed) setProblem(failed);
            else onClose();
          }}
        >
          <input
            autoFocus
            aria-label="New name"
            maxLength={40}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-9 w-full rounded-md border bg-surface-2 px-2 text-xs focus-visible:outline-accent pointer-coarse:h-11"
          />
          {problem && (
            <p role="alert" className="text-[11px] text-danger">
              {problem}
            </p>
          )}
          <Button type="submit" className="h-8 w-full text-xs pointer-coarse:h-11">
            Rename
          </Button>
        </form>
      ) : (
        <>
          <button role="menuitem" className={menuItem} onClick={act(() => editStyle(preset))}>
            <Pencil /> Edit{own ? "" : " a copy"}
          </button>
          <button role="menuitem" className={menuItem} onClick={act(() => void store.create(preset))}>
            <Copy /> Duplicate
          </button>
          {own && (
            <>
              <button role="menuitem" className={menuItem} onClick={() => setRenaming(true)}>
                <TextCursorInput /> Rename
              </button>
              <button
                role="menuitem"
                className={cn(menuItem, "text-danger")}
                onClick={act(() => store.remove(preset.id))}
              >
                <Trash2 /> Delete
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}

/** One style: its sample and name (press to choose it), and a menu for editing it. */
export function StyleCard({
  preset,
  selected,
  onSelect,
  disabled = false,
}: {
  preset: StylePreset;
  selected: boolean;
  onSelect: () => void;
  disabled?: boolean;
}) {
  const [menu, setMenu] = useState(false);
  return (
    <div
      data-style-id={preset.id}
      className={cn(
        "relative rounded-md border bg-surface-2",
        selected ? "border-accent ring-1 ring-accent" : "border-border",
      )}
    >
      <button
        type="button"
        aria-label={preset.name}
        aria-pressed={selected}
        title={preset.name}
        disabled={disabled}
        onClick={onSelect}
        className="block w-full overflow-hidden rounded-md text-left focus-visible:outline-accent disabled:opacity-60"
      >
        <StylePreview style={preset.style} label={preset.name} className="h-14 w-full" />
        <span className="flex items-center gap-1 px-2 py-1 text-xs text-text-muted">
          <span className="min-w-0 flex-1 truncate">{preset.name}</span>
          {!isBuiltIn(preset.id) && (
            <span className="shrink-0 rounded-sm bg-surface-1 px-1 text-[9px]">Mine</span>
          )}
        </span>
      </button>
      <button
        type="button"
        aria-label={`${preset.name} options`}
        aria-haspopup="menu"
        aria-expanded={menu}
        onClick={() => setMenu((open) => !open)}
        className="absolute top-1 right-1 flex size-6 items-center justify-center rounded-md bg-black/60 text-text-muted hover:text-text pointer-coarse:size-11 [&_svg]:size-3.5"
      >
        <MoreHorizontal />
      </button>
      {menu && <CardMenu preset={preset} onClose={() => setMenu(false)} />}
    </div>
  );
}

interface ListProps {
  /** Whether a style is the one in use (by id, or by how a text looks). */
  isSelected: (preset: StylePreset) => boolean;
  /** A style was chosen. The list itself moves it to the front for every list. */
  onSelect: (preset: StylePreset) => void;
  /** What choosing a style does here, for the hint under the list ("restyles the selected text"). */
  hint?: string;
  disabled?: boolean;
}

/**
 * The style list every entry point shares: the six most recently used styles, and "Show more" for all of
 * them. Choosing any style moves it to position 1 here and everywhere else.
 */
export function StyleList({ isSelected, onSelect, hint, disabled = false }: ListProps) {
  const mine = useTextStyleStore((s) => s.mine);
  const order = useTextStyleStore((s) => s.order);
  const styles = useMemo(() => orderedStyles({ mine, order }), [mine, order]);
  const [more, setMore] = useState(false);
  const choose = (preset: StylePreset) => {
    useTextStyleStore.getState().use(preset.id);
    onSelect(preset);
  };

  return (
    <div role="group" aria-label="Styles" className="space-y-2">
      <div className="grid grid-cols-2 gap-1.5">
        {styles.slice(0, VISIBLE_STYLES).map((preset) => (
          <StyleCard
            key={preset.id}
            preset={preset}
            selected={isSelected(preset)}
            disabled={disabled}
            onSelect={() => choose(preset)}
          />
        ))}
      </div>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setMore(true)}
        className="h-9 w-full rounded-md border bg-surface-2 text-xs text-text-muted hover:text-text disabled:opacity-60 pointer-coarse:h-11"
      >
        Show more ({styles.length} styles)
      </button>
      {hint && <p className="text-xs text-text-muted">{hint}</p>}
      {more && (
        <StylePicker
          styles={styles}
          isSelected={isSelected}
          onClose={() => setMore(false)}
          onSelect={(preset) => {
            choose(preset);
            setMore(false);
          }}
        />
      )}
    </div>
  );
}

/** Every style, in a popup (a bottom sheet on narrow screens): search, "My styles" only, new style, reset order. */
function StylePicker({
  styles,
  isSelected,
  onSelect,
  onClose,
}: {
  styles: StylePreset[];
  isSelected: (preset: StylePreset) => boolean;
  onSelect: (preset: StylePreset) => void;
  onClose: () => void;
}) {
  const wide = useMediaQuery("(min-width: 1024px)");
  const [query, setQuery] = useState("");
  const [mineOnly, setMineOnly] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useFocusTrap(rootRef, searchRef);
  const editing = useTextStyleStore((s) => s.editingId !== null);
  const reordered = useTextStyleStore((s) => s.order.length > 0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // the editor sheet sits on top and takes Escape first
      if (e.key === "Escape" && useTextStyleStore.getState().editingId === null) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const q = query.trim().toLowerCase();
  const shown = styles.filter((p) => p.name.toLowerCase().includes(q) && (!mineOnly || !isBuiltIn(p.id)));

  return (
    <div
      className={cn(
        "fixed inset-0 z-[62] flex bg-black/60",
        wide ? "items-center justify-center p-4" : "items-end",
      )}
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
      aria-hidden={editing || undefined}
    >
      <div
        ref={rootRef}
        role="dialog"
        aria-modal="true"
        aria-label="All styles"
        data-layout={wide ? "modal" : "bottom"}
        onKeyDown={(e) => e.key !== "Escape" && e.stopPropagation()}
        className={cn(
          "flex max-h-[85vh] w-full flex-col border bg-surface-1 shadow-xl",
          wide ? "max-w-2xl rounded-lg" : "rounded-t-lg border-b-0",
        )}
      >
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b p-3">
          <div className="relative min-w-40 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-text-muted" />
            <input
              ref={searchRef}
              aria-label="Search styles"
              placeholder={`Search ${styles.length} styles`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-9 w-full rounded-md border bg-surface-2 pr-2 pl-8 text-sm focus-visible:outline-accent pointer-coarse:h-11"
            />
          </div>
          <button
            type="button"
            aria-pressed={mineOnly}
            onClick={() => setMineOnly((on) => !on)}
            className={cn(
              "h-9 rounded-md border px-3 text-xs pointer-coarse:h-11",
              mineOnly ? "border-accent bg-accent-soft text-text" : "text-text-muted hover:text-text",
            )}
          >
            My styles
          </button>
          <button
            type="button"
            onClick={() => {
              const id = useTextStyleStore.getState().create();
              if (id) useTextStyleStore.getState().setEditing(id);
            }}
            className="flex h-9 items-center gap-1 rounded-md border px-3 text-xs text-text-muted hover:text-text pointer-coarse:h-11 [&_svg]:size-3.5"
          >
            <Plus /> New style
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {shown.map((preset) => (
              <StyleCard
                key={preset.id}
                preset={preset}
                selected={isSelected(preset)}
                onSelect={() => onSelect(preset)}
              />
            ))}
          </div>
          {shown.length === 0 && (
            <p className="py-6 text-center text-xs text-text-muted">
              {mineOnly && !q
                ? "You have no styles of your own yet. Use “New style”, or duplicate one."
                : `No style matches “${query.trim()}”.`}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center justify-between gap-2 border-t p-3">
          <button
            type="button"
            disabled={!reordered}
            onClick={() => useTextStyleStore.getState().resetOrder()}
            className="h-9 rounded-md border px-3 text-xs text-text-muted hover:text-text disabled:opacity-40 pointer-coarse:h-11"
          >
            Reset order
          </button>
          <Button variant="secondary" className="pointer-coarse:h-11" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
