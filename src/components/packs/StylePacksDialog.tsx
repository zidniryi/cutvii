import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Package, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { describeOptions } from "@/export/presets";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { cn } from "@/lib/utils";
import { useColorPresetStore } from "@/store/colorPresets";
import { useExportPresetStore } from "@/store/exportPresets";
import { useFontStore } from "@/store/fonts";
import { useStylePackStore } from "@/store/stylePacks";
import { useTextStyleStore } from "@/store/textStyles";
import { useUiStore } from "@/store/ui";
import {
  conflictOf,
  exportPack,
  KIND_LABEL,
  missingFonts,
  type Choice,
  type PackItem,
  type PackKind,
} from "@/timeline/stylePack";

const field =
  "h-9 w-full rounded-md border bg-surface-2 px-2 text-sm pointer-coarse:h-11 focus-visible:outline-accent";
const KINDS: PackKind[] = ["text", "color", "export"];

function Checklist({
  title,
  items,
  ticked,
  onToggle,
}: {
  title: string;
  items: { id: string; name: string; detail?: string }[];
  ticked: string[];
  onToggle: (id: string) => void;
}) {
  return (
    <fieldset className="space-y-1">
      <legend className="mb-1 text-xs font-medium text-text-muted">
        {title} ({items.filter((i) => ticked.includes(i.id)).length} of {items.length})
      </legend>
      {items.length === 0 && <p className="text-xs text-text-muted">You have none of your own yet.</p>}
      {items.map((item) => (
        <label key={item.id} className="flex min-h-9 items-center gap-2 text-sm pointer-coarse:min-h-11">
          <input
            type="checkbox"
            className="size-4 accent-[var(--accent)]"
            checked={ticked.includes(item.id)}
            onChange={() => onToggle(item.id)}
          />
          <span className="min-w-0 truncate">{item.name}</span>
          {item.detail && <span className="ml-auto shrink-0 text-xs text-text-muted">{item.detail}</span>}
        </label>
      ))}
    </fieldset>
  );
}

/** Export: tick what goes in, name the pack, save one file. Only the user's own items are offered. */
function ExportSide() {
  const text = useTextStyleStore((s) => s.mine);
  const color = useColorPresetStore((s) => s.mine);
  const exports = useExportPresetStore((s) => s.mine);
  const [ticked, setTicked] = useState<string[]>(() => [...text, ...color, ...exports].map((p) => p.id));
  const [name, setName] = useState("");
  const [author, setAuthor] = useState("");
  const [notes, setNotes] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toggle = (id: string) => setTicked((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));
  const count = [...text, ...color, ...exports].filter((p) => ticked.includes(p.id)).length;

  async function save() {
    setProblem(null);
    setBusy(true);
    try {
      const path = await exportPack({
        name,
        author,
        notes,
        textIds: text.filter((p) => ticked.includes(p.id)).map((p) => p.id),
        colorIds: color.filter((p) => ticked.includes(p.id)).map((p) => p.id),
        exportIds: exports.filter((p) => ticked.includes(p.id)).map((p) => p.id),
      });
      if (path) {
        useStylePackStore.getState().hide();
        useUiStore.getState().setNotice(`Style pack saved as ${path}`);
      }
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-text-muted">
        One file with the styles and presets you made, to give to someone else. Built-in ones are not
        included, and fonts are never put in the file: a style only names its font.
      </p>
      <div className="grid gap-4 sm:grid-cols-3">
        <Checklist title="My styles" items={text} ticked={ticked} onToggle={toggle} />
        <Checklist title="My colour presets" items={color} ticked={ticked} onToggle={toggle} />
        <Checklist
          title="My export presets"
          items={exports.map((p) => ({ id: p.id, name: p.name, detail: describeOptions(p.options) }))}
          ticked={ticked}
          onToggle={toggle}
        />
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1 text-xs text-text-muted">
          Pack name
          <input
            aria-label="Pack name"
            className={field}
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="space-y-1 text-xs text-text-muted">
          Made by (optional)
          <input
            aria-label="Made by"
            className={field}
            maxLength={60}
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
          />
        </label>
        <label className="space-y-1 text-xs text-text-muted sm:col-span-2">
          Notes (optional)
          <textarea
            aria-label="Notes"
            className={cn(field, "h-20 resize-y py-1.5")}
            maxLength={2000}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>
      </div>
      {problem && (
        <p role="alert" className="rounded-md border border-danger/50 px-3 py-2 text-sm text-danger">
          {problem}
        </p>
      )}
      <Button
        disabled={busy || count === 0 || name.trim() === ""}
        title={
          count === 0 ? "Tick at least one item" : name.trim() === "" ? "Give the pack a name" : undefined
        }
        className="pointer-coarse:h-11"
        onClick={() => void save()}
      >
        Save pack with {count} item{count === 1 ? "" : "s"}…
      </Button>
    </div>
  );
}

const CHOICE_LABEL: Record<Choice, string> = { keep: "Keep both", skip: "Skip", replace: "Replace mine" };

function ItemRow({ item }: { item: PackItem }) {
  const ticked = useStylePackStore((s) => s.ticked.includes(item.key));
  const choice = useStylePackStore((s) => s.choices[item.key] ?? "keep");
  // re-read when the user's lists change
  useTextStyleStore((s) => s.mine);
  useColorPresetStore((s) => s.mine);
  useExportPresetStore((s) => s.mine);
  const conflict = conflictOf(item);
  const store = useStylePackStore.getState;
  const detail = item.kind === "export" ? describeOptions(item.value.options) : undefined;
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-md border border-border px-2 py-1">
      <label className="flex min-h-9 min-w-0 flex-1 items-center gap-2 text-sm pointer-coarse:min-h-11">
        <input
          type="checkbox"
          aria-label={`Import ${item.value.name}`}
          className="size-4 accent-[var(--accent)]"
          checked={ticked}
          onChange={() => store().toggle(item.key)}
        />
        {/* a name from a file is shown as plain text, never as markup */}
        <span className="min-w-0 truncate">{item.value.name}</span>
        {detail && <span className="shrink-0 text-xs text-text-muted">{detail}</span>}
      </label>
      {conflict !== "none" && (
        <>
          <span className="shrink-0 text-xs text-text-muted">
            {conflict === "own" ? "You have one with this name" : "Same name as a built-in one"}
          </span>
          <select
            aria-label={`What to do with ${item.value.name}`}
            className="h-9 rounded-md border bg-surface-2 px-2 text-xs pointer-coarse:h-11 focus-visible:outline-accent"
            value={conflict === "builtin" && choice === "replace" ? "keep" : choice}
            disabled={!ticked}
            onChange={(e) => store().choose(item.key, e.target.value as Choice)}
          >
            <option value="keep">{CHOICE_LABEL.keep} (rename)</option>
            <option value="skip">{CHOICE_LABEL.skip}</option>
            {/* a built-in item can never be overwritten */}
            {conflict === "own" && <option value="replace">{CHOICE_LABEL.replace}</option>}
          </select>
        </>
      )}
    </li>
  );
}

/** Import: choose a pack, see what is in it, tick what to take and decide the clashes. */
function ImportSide() {
  const pack = useStylePackStore((s) => s.pack);
  const ticked = useStylePackStore((s) => s.ticked);
  const fonts = useFontStore((s) => s.fonts);
  useEffect(() => useFontStore.getState().ensure(), []);
  const store = useStylePackStore.getState;
  if (!pack) {
    return (
      <div className="space-y-3">
        <p className="text-xs text-text-muted">
          Open a <code>.cutvii-pack</code> file, or drop one on the window. You see what is inside and choose
          what to take before anything is added. Nothing is downloaded and nothing in the file is run.
        </p>
        <Button className="pointer-coarse:h-11" onClick={() => void store().choosePack()}>
          Choose a pack file…
        </Button>
      </div>
    );
  }
  const missing = missingFonts(
    pack.items.filter((i) => ticked.includes(i.key)),
    fonts.map((f) => f.family),
  );
  const count = pack.items.filter((i) => ticked.includes(i.key)).length;
  return (
    <div className="space-y-4">
      <div className="rounded-md border border-border px-3 py-2">
        <p className="text-sm font-medium break-words">{pack.name}</p>
        {pack.author && <p className="text-xs break-words text-text-muted">By {pack.author}</p>}
        {pack.notes && (
          <p className="mt-1 max-h-24 overflow-y-auto text-xs break-words whitespace-pre-wrap text-text-muted">
            {pack.notes}
          </p>
        )}
        <p className="mt-1 text-xs text-text-muted">
          {KINDS.map(
            (k) => `${pack.items.filter((i) => i.kind === k).length} ${KIND_LABEL[k].toLowerCase()}`,
          ).join(" · ")}
        </p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Button
          variant="secondary"
          size="sm"
          className="pointer-coarse:h-11"
          onClick={() => store().setAll(true)}
        >
          Select all
        </Button>
        <Button
          variant="secondary"
          size="sm"
          className="pointer-coarse:h-11"
          onClick={() => store().setAll(false)}
        >
          Select none
        </Button>
        <Button
          variant="secondary"
          size="sm"
          className="ml-auto pointer-coarse:h-11"
          onClick={store().forgetPack}
        >
          Choose another file
        </Button>
      </div>
      {KINDS.map((kind) => {
        const items = pack.items.filter((i) => i.kind === kind);
        return items.length === 0 ? null : (
          <fieldset key={kind} className="space-y-1">
            <legend className="mb-1 text-xs font-medium text-text-muted">{KIND_LABEL[kind]}</legend>
            <ul aria-label={KIND_LABEL[kind]} className="space-y-1">
              {items.map((item) => (
                <ItemRow key={item.key} item={item} />
              ))}
            </ul>
          </fieldset>
        );
      })}
      {missing.length > 0 && (
        <p
          role="note"
          className="flex items-start gap-2 rounded-md border border-border px-3 py-2 text-xs text-text-muted [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-accent"
        >
          <AlertTriangle />
          <span>
            Fonts not on this computer: <span className="break-words text-text">{missing.join(", ")}</span>.
            Those styles are drawn in the default font until you import the font (Text tab, font list).
          </span>
        </p>
      )}
      {pack.problems.length > 0 && (
        <div role="note" className="rounded-md border border-danger/40 px-3 py-2 text-xs text-text-muted">
          <p className="text-text">
            Left out ({pack.problems.length}): these could not be used and are not in the list above.
          </p>
          <ul className="mt-1 max-h-28 list-disc space-y-0.5 overflow-y-auto pl-4">
            {pack.problems.map((p, i) => (
              <li key={i} className="break-words">
                {p}
              </li>
            ))}
          </ul>
        </div>
      )}
      <Button
        disabled={count === 0}
        title={count === 0 ? "Tick at least one item" : undefined}
        className="pointer-coarse:h-11"
        onClick={() => store().importTicked()}
      >
        Import {count} item{count === 1 ? "" : "s"}
      </Button>
    </div>
  );
}

/** Style packs: share your own text styles, colour presets and export presets as one file. Local only. */
export function StylePacksDialog() {
  const open = useStylePackStore((s) => s.open);
  return open ? <Body /> : null;
}

function Body() {
  const tab = useStylePackStore((s) => s.tab);
  const problem = useStylePackStore((s) => s.problem);
  const rootRef = useRef<HTMLDivElement>(null);
  useFocusTrap(rootRef);
  const store = useStylePackStore.getState;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !useUiStore.getState().dialog) useStylePackStore.getState().hide();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="fixed inset-0 z-50 flex justify-center bg-black/60 sm:p-4">
      <div
        ref={rootRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="style-packs-title"
        className="flex h-full w-full max-w-3xl flex-col border bg-surface-1 shadow-xl sm:rounded-lg"
      >
        <header className="flex shrink-0 flex-wrap items-center gap-3 border-b px-4 py-2">
          <h2
            id="style-packs-title"
            className="flex items-center gap-2 text-sm font-semibold [&_svg]:size-4 [&_svg]:text-accent"
          >
            <Package />
            Style packs
          </h2>
          <div role="tablist" aria-label="Style packs" className="flex gap-1 text-xs">
            {(["export", "import"] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => store().setTab(t)}
                className={cn(
                  "min-h-9 rounded-md px-3 pointer-coarse:min-h-11 focus-visible:outline-accent",
                  tab === t ? "bg-accent-soft text-text" : "text-text-muted hover:text-text",
                )}
              >
                {t === "export" ? "Export" : "Import"}
              </button>
            ))}
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={store().hide}
            className="ml-auto flex size-9 items-center justify-center rounded-md text-text-muted hover:text-text pointer-coarse:size-11 focus-visible:outline-accent [&_svg]:size-4"
          >
            <X />
          </button>
        </header>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-sm">
          {problem && (
            <p role="alert" className="rounded-md border border-danger/50 px-3 py-2 text-sm text-danger">
              {problem}
            </p>
          )}
          {tab === "export" ? <ExportSide /> : <ImportSide />}
        </div>
      </div>
    </div>
  );
}
