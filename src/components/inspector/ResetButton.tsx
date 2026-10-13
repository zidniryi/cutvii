import { RotateCcw } from "lucide-react";

/** Puts one field back to where it starts. Out of sight (but keeping its place) when there is nothing to undo. */
export function ResetButton({
  label,
  disabled,
  onReset,
}: {
  /** The field's name, as in "Reset Scale". */
  label: string;
  disabled: boolean;
  onReset: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={`Reset ${label}`}
      title={`Reset ${label}`}
      disabled={disabled}
      onClick={onReset}
      className="flex size-5 shrink-0 items-center justify-center rounded-sm text-text-muted hover:text-text disabled:invisible pointer-coarse:size-11 [&_svg]:size-3"
    >
      <RotateCcw />
    </button>
  );
}
