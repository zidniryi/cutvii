import { useEffect } from "react";
import { goToEnd, goToStart, stepFrames, togglePlayback } from "@/playback/controller";
import { newProjectFlow, openProjectFlow, saveFlow } from "@/project/fileActions";
import { usePlaybackStore } from "@/store/playback";
import { copySelected, cutSelected, pasteAtPlayhead } from "./clipboard";
import { deleteSelected, redo, report, selectAllClips, splitAtPlayhead, undo } from "./editor";
import { freezeFrameAtPlayhead } from "./freeze";
import { resolveShortcut, type ShortcutAction } from "./shortcuts";
import { zoomByFactorAt, zoomByWheel, zoomStep, zoomToFit } from "./zoomController";

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable;
}
const isButton = (target: EventTarget | null) => target instanceof HTMLElement && target.tagName === "BUTTON";
const overTimeline = (target: EventTarget | null) =>
  target instanceof Element && target.closest("[data-timeline-area]") !== null;

function seek(seconds: number) {
  const pb = usePlaybackStore.getState();
  pb.setPlayhead(pb.playhead + seconds);
}

const RUN: Record<ShortcutAction, () => void> = {
  save: () => void saveFlow(false),
  "save-as": () => void saveFlow(true),
  open: () => void openProjectFlow(),
  new: () => void newProjectFlow(),
  undo,
  redo,
  cut: () => void cutSelected(),
  copy: () => void copySelected(),
  paste: () => void report(pasteAtPlayhead()),
  "select-all": selectAllClips,
  "zoom-in": () => zoomStep(1),
  "zoom-out": () => zoomStep(-1),
  "zoom-fit": zoomToFit,
  "play-pause": togglePlayback,
  split: () => void report(splitAtPlayhead()),
  freeze: () => void freezeFrameAtPlayhead(),
  delete: () => void deleteSelected(),
  "seek-back": () => stepFrames(-1),
  "seek-forward": () => stepFrames(1),
  "seek-back-second": () => seek(-1),
  "seek-forward-second": () => seek(1),
  home: goToStart,
  end: goToEnd,
};

/**
 * Global keyboard, wheel and pinch handling.
 * Every recognised shortcut calls preventDefault, so the webview never saves the page, zooms the page
 * or scrolls instead. Ctrl/Cmd + wheel and trackpad pinch zoom the timeline at the pointer.
 */
export function useEditorShortcuts() {
  useEffect(() => {
    let lastClipboardAction = 0;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return; // already handled closer to the target (e.g. the ruler slider)
      const hit = resolveShortcut(e, { typing: isTyping(e.target), onButton: isButton(e.target) });
      if (!hit) return;
      e.preventDefault();
      if (hit.action === "cut" || hit.action === "copy" || hit.action === "paste") {
        if (performance.now() - lastClipboardAction < 150) return;
        lastClipboardAction = performance.now();
      }
      RUN[hit.action]();
    };

    // Ctrl/Cmd + wheel (and Chromium's pinch, which arrives as ctrl+wheel): never the page zoom.
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      if (overTimeline(e.target)) zoomByWheel(e.deltaY, e.clientX);
    };

    // WebKit (macOS webview) reports trackpad pinch as gesture events with a cumulative scale.
    let lastScale = 1;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      lastScale = 1;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as Event & { scale?: number; clientX?: number };
      if (typeof g.scale !== "number" || g.scale <= 0) return;
      if (overTimeline(e.target)) zoomByFactorAt(g.scale / lastScale, g.clientX ?? 0);
      lastScale = g.scale;
    };
    const onGestureEnd = (e: Event) => e.preventDefault();

    // The native Edit menu (macOS) may deliver Cmd+X/C/V as clipboard events instead of key presses.
    // Handle those too, but only once per gesture and never while typing in a field.
    const clipboard = (action: "cut" | "copy" | "paste") => (e: Event) => {
      if (isTyping(e.target) || isTyping(document.activeElement)) return;
      e.preventDefault();
      if (performance.now() - lastClipboardAction < 150) return;
      lastClipboardAction = performance.now();
      RUN[action]();
    };
    const onCut = clipboard("cut");
    const onCopy = clipboard("copy");
    const onPaste = clipboard("paste");
    document.addEventListener("cut", onCut);
    document.addEventListener("copy", onCopy);
    document.addEventListener("paste", onPaste);

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("gesturestart", onGestureStart);
    window.addEventListener("gesturechange", onGestureChange);
    window.addEventListener("gestureend", onGestureEnd);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("cut", onCut);
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("paste", onPaste);
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("gesturestart", onGestureStart);
      window.removeEventListener("gesturechange", onGestureChange);
      window.removeEventListener("gestureend", onGestureEnd);
    };
  }, []);
}
