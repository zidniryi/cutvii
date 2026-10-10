import { useEffect } from "react";
import { togglePlayback } from "@/playback/controller";
import { newProjectFlow, openProjectFlow, saveFlow } from "@/project/fileActions";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { deleteSelected, redo, report, splitAtPlayhead, undo } from "./editor";
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
  "zoom-in": () => zoomStep(1),
  "zoom-out": () => zoomStep(-1),
  "zoom-fit": zoomToFit,
  "play-pause": togglePlayback,
  split: () => void report(splitAtPlayhead()),
  delete: () => void deleteSelected(),
  "seek-back": () => seek(-1 / useProjectStore.getState().project.settings.fps),
  "seek-forward": () => seek(1 / useProjectStore.getState().project.settings.fps),
  "seek-back-second": () => seek(-1),
  "seek-forward-second": () => seek(1),
  home: () => usePlaybackStore.getState().setPlayhead(0),
};

/**
 * Global keyboard, wheel and pinch handling.
 * Every recognised shortcut calls preventDefault, so the webview never saves the page, zooms the page
 * or scrolls instead. Ctrl/Cmd + wheel and trackpad pinch zoom the timeline at the pointer.
 */
export function useEditorShortcuts() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return; // already handled closer to the target (e.g. the ruler slider)
      const hit = resolveShortcut(e, { typing: isTyping(e.target), onButton: isButton(e.target) });
      if (!hit) return;
      e.preventDefault();
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

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("gesturestart", onGestureStart);
    window.addEventListener("gesturechange", onGestureChange);
    window.addEventListener("gestureend", onGestureEnd);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("gesturestart", onGestureStart);
      window.removeEventListener("gesturechange", onGestureChange);
      window.removeEventListener("gestureend", onGestureEnd);
    };
  }, []);
}
