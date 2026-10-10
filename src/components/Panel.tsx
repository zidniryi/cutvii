import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Panel({
  title,
  actions,
  className,
  children,
}: {
  title: string;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className={cn("flex min-h-0 min-w-0 flex-col border-border bg-surface-1", className)}
    >
      <header className="flex h-10 shrink-0 items-center justify-between border-b px-3">
        <h2 className="text-xs font-medium tracking-wide text-text-muted uppercase">{title}</h2>
        {actions}
      </header>
      {children}
    </section>
  );
}

export function EmptyState({ icon, title, hint }: { icon: ReactNode; title: string; hint?: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <div className="text-text-muted [&_svg]:size-8">{icon}</div>
      <p className="text-sm font-medium">{title}</p>
      {hint && <p className="max-w-[28ch] text-xs text-text-muted">{hint}</p>}
    </div>
  );
}
