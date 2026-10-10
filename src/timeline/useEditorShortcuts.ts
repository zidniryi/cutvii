import { useEffect } from "react";
import { togglePlayback } from "@/playback/controller";
import { openProjectFlow, saveFlow } from "@/project/fileActions";
import { usePlaybackStore } from "@/store/playback";
import { useProjectStore } from "@/store/project";
import { deleteSelected, redo, report, splitAtPlayhead, undo } from "./editor";

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable;
}

/** Section 7 shortcuts, plus Open (Ctrl/Cmd+O) and Save as (Ctrl/Cmd+Shift+S). */
export function useEditorShortcuts() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();

      if (mod && key === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && key === "s") {
        e.preventDefault();
        void saveFlow(e.shiftKey);
        return;
      }
      if (mod && key === "o") {
        e.preventDefault();
        void openProjectFlow();
        return;
      }
      if (mod && key === "y") {
        e.preventDefault();
        redo();
        return;
      }
      if (mod || e.altKey) return;

      const playback = usePlaybackStore.getState();
      const fps = useProjectStore.getState().project.settings.fps;
      switch (e.key) {
        case " ":
          // a focused real <button> already toggles on Space; don't double-fire
          if (e.target instanceof HTMLElement && e.target.tagName === "BUTTON") return;
          e.preventDefault();
          togglePlayback();
          break;
        case "s":
        case "S":
          e.preventDefault();
          report(splitAtPlayhead());
          break;
        case "Delete":
        case "Backspace":
          e.preventDefault();
          deleteSelected();
          break;
        case "ArrowLeft":
          e.preventDefault();
          playback.setPlayhead(playback.playhead - (e.shiftKey ? 1 : 1 / fps));
          break;
        case "ArrowRight":
          e.preventDefault();
          playback.setPlayhead(playback.playhead + (e.shiftKey ? 1 : 1 / fps));
          break;
        case "Home":
          e.preventDefault();
          playback.setPlayhead(0);
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
