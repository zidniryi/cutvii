import { useEffect } from "react";
import { AboutDialog } from "@/components/AboutDialog";
import { AppDialog } from "@/components/AppDialog";
import { AutoClipsWizard } from "@/components/autoclips/AutoClipsWizard";
import { CanvasDialog } from "@/components/canvas/CanvasDialog";
import { CanvasNotice } from "@/components/canvas/CanvasNotice";
import { NewProjectDialog } from "@/components/canvas/NewProjectDialog";
import { NoticeToast } from "@/components/NoticeToast";
import { ExportDialog } from "@/components/ExportDialog";
import { DragChip } from "@/components/DragChip";
import { Inspector } from "@/components/layout/Inspector";
import { MediaLibrary } from "@/components/layout/MediaLibrary";
import { Preview } from "@/components/layout/Preview";
import { Timeline } from "@/components/layout/Timeline";
import { StyleEditorSheet } from "@/components/text/StyleEditor";
import { TextStylesPanel } from "@/components/text/TextStylesPanel";
import { TopBar } from "@/components/layout/TopBar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useUiStore, type SidePanel } from "@/store/ui";
import { cn } from "@/lib/utils";
import { installCloseGuard } from "@/lib/closeGuard";
import { onMenuAction } from "@/lib/menuEvents";
import { useFileDrop } from "@/hooks/useFileDrop";
import { watchLongClips } from "@/timeline/ai";
import { watchTextPictures } from "@/timeline/text";
import { useEditorShortcuts } from "@/timeline/useEditorShortcuts";

const TABS: { id: SidePanel; label: string }[] = [
  { id: "library", label: "Media" },
  { id: "text", label: "Text" },
  { id: "inspector", label: "Inspector" },
];

/** Tab switcher for the side panels; only shown on narrow screens. */
function SidePanelTabs() {
  const sidePanel = useUiStore((s) => s.sidePanel);
  const setSidePanel = useUiStore((s) => s.setSidePanel);
  return (
    <div role="tablist" aria-label="Side panels" className="flex shrink-0 border-y bg-surface-1 lg:hidden">
      {TABS.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={sidePanel === t.id}
          onClick={() => setSidePanel(t.id)}
          className={cn(
            "h-11 flex-1 text-sm",
            sidePanel === t.id ? "border-b-2 border-accent text-text" : "text-text-muted",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export default function App() {
  useEditorShortcuts();
  useFileDrop();
  useEffect(() => watchTextPictures(), []);
  useEffect(() => watchLongClips(), []);
  useEffect(() => {
    const guard = installCloseGuard();
    const menu = onMenuAction();
    return () => {
      void guard.then((off) => off());
      void menu.then((off) => off()).catch(() => {});
    };
  }, []);
  return (
    <TooltipProvider>
      <div className="flex h-full flex-col bg-bg">
        <TopBar />
        <CanvasNotice />
        <main className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)] lg:grid-cols-[18rem_minmax(0,1fr)_20rem] lg:grid-rows-[minmax(0,1fr)_16rem]">
          <Preview />
          {/* narrow: tabs + the active panel; wide: wrapper disappears and panels become grid items */}
          <div className="flex min-h-0 flex-col lg:contents">
            <SidePanelTabs />
            <MediaLibrary />
            <TextStylesPanel />
            <Inspector />
          </div>
          <Timeline />
        </main>
      </div>
      <DragChip />
      <ExportDialog />
      <AutoClipsWizard />
      <NewProjectDialog />
      <CanvasDialog />
      <AppDialog />
      <AboutDialog />
      <StyleEditorSheet />
      <NoticeToast />
    </TooltipProvider>
  );
}
