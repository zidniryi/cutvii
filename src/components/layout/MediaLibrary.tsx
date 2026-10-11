import { useEffect, useMemo, useState } from "react";
import {
  CircleAlert,
  FileWarning,
  Film,
  Image as ImageIcon,
  Link2,
  ListPlus,
  Loader2,
  Music,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { IconButton } from "@/components/IconButton";
import { LeftTabs } from "@/components/text/LeftTabs";
import { EmptyState, Panel } from "@/components/Panel";
import { importIntoProject, type ImportSummary } from "@/lib/importFlow";
import { assetName, thumbnailUrl } from "@/lib/media";
import { formatDuration } from "@/lib/timecode";
import { cn } from "@/lib/utils";
import { relinkFlow } from "@/project/fileActions";
import type { MediaAsset } from "@/project/model";
import { useImportsStore, type ImportJob } from "@/store/imports";
import { useProjectStore } from "@/store/project";
import { beginAssetDrag } from "@/hooks/useAssetDrag";
import { useSelectionStore } from "@/store/selection";
import { addAssetToTimeline, removeSelectedMedia, report } from "@/timeline/editor";
import { useUiStore } from "@/store/ui";

const TYPE_LABEL = { video: "Video", audio: "Audio", image: "Image" } as const;
const TYPE_ICON = { video: Film, audio: Music, image: ImageIcon } as const;

type Notice = { kind: "error"; message: string } | { kind: "summary"; summary: ImportSummary };

function noticeLines(n: Notice): string[] {
  if (n.kind === "error") return [n.message];
  const { added, duplicates, failed } = n.summary;
  return [
    ...(added > 0 ? [`Imported ${added} file${added === 1 ? "" : "s"}.`] : []),
    ...duplicates.map((d) => `${d} is already in the project.`),
    ...failed.map((f) => `${f.name}: ${f.error}`),
  ];
}

function AssetRow({
  asset,
  missing,
  selected,
  onSelect,
  onRemove,
}: {
  asset: MediaAsset;
  missing: boolean;
  selected: boolean;
  /** A click on the card (not on one of its buttons): plain, Ctrl/Cmd or Shift. */
  onSelect: (mode: "replace" | "toggle" | "range") => void;
  onRemove: () => void;
}) {
  const Icon = TYPE_ICON[asset.type];
  const name = assetName(asset);
  const meta = [
    asset.text ? "Text" : TYPE_LABEL[asset.type],
    asset.duration !== undefined ? formatDuration(asset.duration) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <li
      data-testid="media-card"
      data-selected={selected || undefined}
      onPointerDown={(e) => beginAssetDrag(e, asset)}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button, input, a")) return; // the card's own buttons
        onSelect(e.shiftKey ? "range" : e.metaKey || e.ctrlKey ? "toggle" : "replace");
      }}
      className={cn(
        "flex cursor-grab touch-none items-center gap-2 rounded-md bg-surface-2 p-1.5 select-none",
        selected && "bg-accent-soft ring-2 ring-accent",
      )}
    >
      {selected && <span className="sr-only">Selected</span>}
      <div className="flex h-9 w-14 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-black text-text-muted">
        {asset.thumbnailPath ? (
          <img src={thumbnailUrl(asset.thumbnailPath)} alt="" className="h-full w-full object-cover" />
        ) : (
          <Icon className="size-4" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm" title={asset.path}>
          {name}
        </p>
        {missing ? (
          <p className="flex items-center gap-1 text-xs text-danger">
            <FileWarning className="size-3" /> Missing — file not found
          </p>
        ) : (
          <p className="text-xs text-text-muted">{meta}</p>
        )}
      </div>
      {missing && (
        <IconButton label={`Relink ${name}`} icon={<Link2 />} onClick={() => void relinkFlow(asset.id)} />
      )}
      <IconButton
        label={`Add ${name} to timeline`}
        icon={<ListPlus />}
        onClick={() => report(addAssetToTimeline(asset.id))}
      />
      <IconButton label={`Remove ${name} from project`} icon={<Trash2 />} onClick={onRemove} />
    </li>
  );
}

/** A file that is queued, being read, or could not be imported. Replaced by the real card when it succeeds. */
function PlaceholderCard({ job, onDismiss }: { job: ImportJob; onDismiss: () => void }) {
  const problem = job.state === "failed" || job.state === "skipped";
  const status =
    job.state === "queued"
      ? "Waiting…"
      : job.state === "reading" || job.state === "ready"
        ? "Reading file…"
        : job.message;
  return (
    <li
      data-testid="import-placeholder"
      data-state={job.state}
      className={cn(
        "flex items-start gap-2 rounded-md border p-1.5",
        problem ? "border-danger/50 bg-surface-2" : "border-dashed bg-surface-2/60",
      )}
    >
      <div className="flex h-9 w-14 shrink-0 items-center justify-center rounded-sm bg-black text-text-muted">
        {problem ? (
          <CircleAlert className="size-4 text-danger" />
        ) : (
          <Loader2 className="size-4 animate-spin" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm" title={job.name}>
          {job.name}
        </p>
        <p
          className={cn(
            "text-xs break-words",
            problem ? (job.state === "failed" ? "text-danger" : "text-text-muted") : "text-text-muted",
          )}
        >
          {status}
        </p>
      </div>
      {problem && (
        <button
          aria-label={`Dismiss ${job.name}`}
          onClick={onDismiss}
          className="shrink-0 p-1 pointer-coarse:p-3"
        >
          <X className="size-3.5" />
        </button>
      )}
    </li>
  );
}

export function MediaLibrary() {
  const active = useUiStore((s) => s.sidePanel === "library");
  const wide = useUiStore((s) => s.leftPanel === "library");
  const assets = useProjectStore((s) => s.project.assets);
  const removeAsset = useProjectStore((s) => s.removeAsset);
  const jobs = useImportsStore((s) => s.jobs);
  const hovering = useImportsStore((s) => s.hovering);
  const removeJob = useImportsStore((s) => s.remove);
  const missingPaths = useProjectStore((s) => s.missingPaths);
  const missing = useMemo(() => new Set(missingPaths), [missingPaths]);
  const [query, setQuery] = useState("");
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? assets.filter((a) => assetName(a).toLowerCase().includes(q)) : assets;
  }, [assets, query]);

  // Selection: click, Ctrl/Cmd-click, Shift-click; Ctrl/Cmd + A and Delete act on what is listed here.
  const selectedIds = useSelectionStore((s) => s.selectedAssetIds);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  useEffect(() => {
    useSelectionStore.getState().setLibraryOrder(visible.map((a) => a.id));
  }, [visible]);

  async function onImport() {
    setImporting(true);
    setNotice(null);
    try {
      const summary = await importIntoProject();
      if (!summary.cancelled) setNotice({ kind: "summary", summary });
    } catch (e) {
      setNotice({ kind: "error", message: e instanceof Error ? e.message : "Import failed" });
    } finally {
      setImporting(false);
    }
  }

  const lines = notice ? noticeLines(notice) : [];

  return (
    <Panel
      title="Media"
      className={cn(
        active ? "flex" : "hidden",
        wide ? "lg:flex" : "lg:hidden",
        "relative min-h-0 border-r lg:col-start-1 lg:row-start-1",
      )}
      actions={
        <div className="flex items-center gap-1">
          <LeftTabs />
          <IconButton
            label="Import media"
            icon={importing ? <Loader2 className="animate-spin" /> : <Plus />}
            disabled={importing}
            onClick={onImport}
          />
        </div>
      }
    >
      <div className="relative m-2">
        <Search className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-text-muted" />
        <input
          type="search"
          aria-label="Search media"
          placeholder="Search media"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-9 w-full rounded-md border bg-surface-2 pr-2 pl-8 text-sm placeholder:text-text-muted pointer-coarse:h-11"
        />
      </div>

      {lines.length > 0 && (
        <div
          role={notice?.kind === "error" ? "alert" : "status"}
          className={cn(
            "mx-2 mb-2 flex items-start gap-2 rounded-md border p-2 text-xs",
            notice?.kind === "error" ? "border-danger/60 text-danger" : "text-text-muted",
          )}
        >
          <ul className="min-w-0 flex-1 space-y-1">
            {lines.map((l, i) => (
              <li key={i} className="break-words">
                {l}
              </li>
            ))}
          </ul>
          <button aria-label="Dismiss message" onClick={() => setNotice(null)} className="shrink-0 p-0.5">
            <X className="size-3.5" />
          </button>
        </div>
      )}

      {jobs.length > 0 && (
        <ul aria-label="Importing" className="max-h-[45%] shrink-0 space-y-1.5 overflow-y-auto px-2 pb-2">
          {jobs.map((j) => (
            <PlaceholderCard key={j.id} job={j} onDismiss={() => removeJob(j.id)} />
          ))}
        </ul>
      )}

      {selectedIds.length > 0 && (
        <div
          role="toolbar"
          aria-label="Selected media"
          className="mx-2 mb-2 flex items-center gap-2 rounded-md border border-accent/40 bg-accent-soft px-2 py-1 text-xs"
        >
          <span className="min-w-0 flex-1 truncate">{selectedIds.length} selected</span>
          <button
            type="button"
            onClick={removeSelectedMedia}
            className="flex h-7 items-center gap-1 rounded-md px-2 text-danger hover:bg-danger/10 pointer-coarse:h-11 [&_svg]:size-3.5"
          >
            <Trash2 />
            Remove
            <kbd className="text-text-muted">Del</kbd>
          </button>
          <button
            type="button"
            onClick={() => useSelectionStore.getState().setAssetSelection([])}
            className="h-7 rounded-md px-2 text-text-muted hover:text-text pointer-coarse:h-11"
          >
            Clear
          </button>
        </div>
      )}

      {assets.length === 0 ? (
        jobs.length === 0 && (
          <EmptyState
            icon={<Film />}
            title="No media yet"
            hint="Drop files here, or use + to import video, audio or images. Your originals are never changed."
          />
        )
      ) : visible.length === 0 ? (
        <EmptyState icon={<Search />} title="No matches" hint={`Nothing named “${query.trim()}”.`} />
      ) : (
        <ul aria-label="Media files" className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2 pt-0">
          {visible.map((a) => (
            <AssetRow
              key={a.id}
              asset={a}
              missing={missing.has(a.path)}
              selected={selected.has(a.id)}
              onSelect={(mode) => useSelectionStore.getState().selectAsset(a.id, mode)}
              onRemove={() => removeAsset(a.id)}
            />
          ))}
        </ul>
      )}

      {hovering && (
        <div
          aria-hidden
          data-testid="drop-overlay"
          className="pointer-events-none absolute inset-1 z-20 flex items-center justify-center rounded-md border-2 border-dashed border-accent bg-black/70 text-sm font-medium"
        >
          Drop files to import
        </div>
      )}
    </Panel>
  );
}
