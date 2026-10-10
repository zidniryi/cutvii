import { Component, type ErrorInfo, type ReactNode } from "react";

interface State {
  error: Error | null;
}

/** Last line of defence: a render crash shows a message instead of a blank window. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("CutVii UI error:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <h1 className="text-base font-semibold">Something went wrong</h1>
        <p className="max-w-[60ch] text-sm break-words text-text-muted">{this.state.error.message}</p>
        <p className="max-w-[60ch] text-xs text-text-muted">
          Your project file on disk is unaffected. Reload to continue; unsaved changes in this session may be
          lost.
        </p>
        <button
          className="h-9 rounded-md bg-accent px-4 text-sm font-medium text-primary-foreground pointer-coarse:h-11"
          onClick={() => window.location.reload()}
        >
          Reload
        </button>
      </div>
    );
  }
}
