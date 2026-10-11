/** Original CutVii mark: a play triangle split by a gap (same glyph as the app icon). */
export function LogoMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label="CutVii logo">
      <rect x="0.5" y="0.5" width="23" height="23" rx="6" fill="var(--bg)" stroke="var(--border)" />
      {/* left part: the tall half of the triangle */}
      <path
        d="M8.4 5.8 L12.9 8.6 L12.9 15.4 L8.4 18.2 Z"
        fill="var(--accent)"
        stroke="var(--accent)"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      {/* right part: the tip, separated by the cut */}
      <path
        d="M14.6 9.6 L18.2 12 L14.6 14.4 Z"
        fill="var(--accent)"
        stroke="var(--accent)"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The mark plus the wordmark. */
export function Logo() {
  return (
    <div className="flex items-center gap-2 select-none">
      <LogoMark />
      <span className="text-sm font-semibold tracking-tight">
        Cut<span className="text-accent">Vii</span>
      </span>
    </div>
  );
}
