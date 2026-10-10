import { useUiStore } from "@/store/ui";

/** Ask the user to confirm; resolves false on cancel/Escape. */
export function confirmDialog(opts: {
  title: string;
  lines?: string[];
  confirmLabel: string;
}): Promise<boolean> {
  return new Promise((resolve) =>
    useUiStore.getState().openDialog({
      title: opts.title,
      lines: opts.lines ?? [],
      confirmLabel: opts.confirmLabel,
      cancelLabel: "Cancel",
      resolve,
    }),
  );
}

export async function messageDialog(title: string, lines: string[]): Promise<void> {
  await new Promise<boolean>((resolve) =>
    useUiStore.getState().openDialog({ title, lines, confirmLabel: "OK", cancelLabel: null, resolve }),
  );
}
