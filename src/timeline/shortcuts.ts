/** Keyboard shortcut resolution (pure): which action, if any, a key event means. */

export type ShortcutAction =
  | "save"
  | "save-as"
  | "open"
  | "new"
  | "undo"
  | "redo"
  | "cut"
  | "copy"
  | "paste"
  | "zoom-in"
  | "zoom-out"
  | "zoom-fit"
  | "play-pause"
  | "split"
  | "freeze"
  | "delete"
  | "seek-back"
  | "seek-forward"
  | "seek-back-second"
  | "seek-forward-second"
  | "home";

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface Resolved {
  action: ShortcutAction;
  /** Always stop the webview's own behaviour (save page, page zoom, scrolling). */
  preventDefault: true;
}

/** Shortcuts that must work, and must be swallowed, even while the user is typing in a field. */
const ALWAYS: ShortcutAction[] = ["save", "save-as", "open", "new", "zoom-in", "zoom-out", "zoom-fit"];

export const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
  save: "Ctrl/⌘ S",
  "save-as": "Ctrl/⌘ Shift S",
  open: "Ctrl/⌘ O",
  new: "Ctrl/⌘ N",
  undo: "Ctrl/⌘ Z",
  redo: "Ctrl/⌘ Shift Z",
  cut: "Ctrl/⌘ X",
  copy: "Ctrl/⌘ C",
  paste: "Ctrl/⌘ V",
  "zoom-in": "Ctrl/⌘ +",
  "zoom-out": "Ctrl/⌘ −",
  "zoom-fit": "Ctrl/⌘ 0",
  "play-pause": "Space",
  split: "S",
  freeze: "Shift F",
  delete: "Del",
  "seek-back": "←",
  "seek-forward": "→",
  "seek-back-second": "Shift ←",
  "seek-forward-second": "Shift →",
  home: "Home",
};

function withModifier(e: KeyLike): ShortcutAction | null {
  const key = e.key.toLowerCase();
  switch (key) {
    case "s":
      return e.shiftKey ? "save-as" : "save";
    case "o":
      return "open";
    case "n":
      return "new";
    case "z":
      return e.shiftKey ? "redo" : "undo";
    case "y":
      return "redo";
    case "x":
      return e.shiftKey ? null : "cut";
    case "c":
      return e.shiftKey ? null : "copy";
    case "v":
      return e.shiftKey ? null : "paste";
    case "=":
    case "+":
      return "zoom-in";
    case "-":
    case "_":
      return "zoom-out";
    case "0":
      return "zoom-fit";
    default:
      return null;
  }
}

function plain(e: KeyLike): ShortcutAction | null {
  switch (e.key) {
    case " ":
      return "play-pause";
    case "s":
    case "S":
      return "split";
    case "F":
      return e.shiftKey ? "freeze" : null;
    case "Delete":
    case "Backspace":
      return "delete";
    case "ArrowLeft":
      return e.shiftKey ? "seek-back-second" : "seek-back";
    case "ArrowRight":
      return e.shiftKey ? "seek-forward-second" : "seek-forward";
    case "Home":
      return "home";
    default:
      return null;
  }
}

/**
 * @param typing  focus is in a text field: only file and zoom shortcuts apply (the rest would fight typing)
 * @param onButton  focus is on a real button, where Space already means "press it"
 */
export function resolveShortcut(e: KeyLike, ctx: { typing: boolean; onButton: boolean }): Resolved | null {
  const mod = e.ctrlKey || e.metaKey;
  if (e.altKey) return null;

  const action = mod ? withModifier(e) : plain(e);
  if (!action) return null;
  if (ctx.typing && !ALWAYS.includes(action)) return null;
  if (action === "play-pause" && ctx.onButton) return null;
  return { action, preventDefault: true };
}
