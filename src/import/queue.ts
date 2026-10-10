/**
 * Background import queue: at most `concurrency` items are being read at once, but results are committed
 * strictly in the order the files were dropped, so the library order (and "first media decides the canvas")
 * is deterministic however long each file takes.
 */
export type QueueState = "queued" | "reading" | "ready" | "committed" | "failed";

export interface QueueItem<T> {
  id: string;
  payload: T;
}

export interface OrderedQueueOptions<T, R> {
  concurrency: number;
  /** The slow part (probe, thumbnail). Runs concurrently. */
  run: (payload: T) => Promise<R>;
  /** Fast and synchronous; called in drop order with the outcome of `run`. */
  commit: (item: QueueItem<T>, outcome: { ok: true; value: R } | { ok: false; error: string }) => void;
  onState?: (id: string, state: QueueState) => void;
}

interface Entry<T, R> {
  item: QueueItem<T>;
  state: QueueState;
  outcome?: { ok: true; value: R } | { ok: false; error: string };
  batch: Batch;
}
interface Batch {
  remaining: number;
  onDone?: () => void;
}

export function createOrderedQueue<T, R>(opts: OrderedQueueOptions<T, R>) {
  const entries: Entry<T, R>[] = [];
  let nextToCommit = 0;
  let running = 0;

  const setState = (e: Entry<T, R>, state: QueueState) => {
    e.state = state;
    opts.onState?.(e.item.id, state);
  };

  function flush() {
    while (nextToCommit < entries.length) {
      const e = entries[nextToCommit];
      if (!e.outcome) break;
      nextToCommit += 1;
      try {
        opts.commit(e.item, e.outcome);
      } finally {
        setState(e, e.outcome.ok ? "committed" : "failed");
        if (--e.batch.remaining === 0) e.batch.onDone?.();
      }
    }
  }

  function pump() {
    for (const e of entries) {
      if (running >= opts.concurrency) return;
      if (e.state !== "queued") continue;
      running += 1;
      setState(e, "reading");
      opts
        .run(e.item.payload)
        .then(
          (value) => (e.outcome = { ok: true, value }),
          (err: unknown) =>
            (e.outcome = { ok: false, error: err instanceof Error ? err.message : String(err) }),
        )
        .then(() => {
          running -= 1;
          setState(e, "ready");
          flush();
          pump();
        });
    }
  }

  return {
    /** Queue items; `onDone` fires once every one of them has been committed (or failed). */
    add(items: QueueItem<T>[], onDone?: () => void) {
      if (items.length === 0) return onDone?.();
      const batch: Batch = { remaining: items.length, onDone };
      for (const item of items) entries.push({ item, state: "queued", batch });
      pump();
    },
    /** For tests and diagnostics. */
    get active() {
      return running;
    },
  };
}
