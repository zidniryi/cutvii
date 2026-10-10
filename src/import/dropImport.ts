import { applyPendingCanvas, commitImportedMedia } from "@/lib/importFlow";
import { importDroppedFile, type DroppedFile } from "@/lib/dropApi";
import type { MediaAsset } from "@/project/model";
import { useImportsStore } from "@/store/imports";
import { placeAssetAtDrop, report, type DropPlacement } from "@/timeline/editor";
import { createOrderedQueue, type QueueState } from "./queue";

export const IMPORT_CONCURRENCY = 2;

/** Shared by every file of one drop. */
interface DropBatch {
  firstAdded?: MediaAsset;
  /** Set when the files were dropped on the timeline: each one also becomes a clip there. */
  placement?: DropPlacement;
}
interface Payload {
  file: DroppedFile;
  batch: DropBatch;
}

const STATE_TO_JOB: Partial<Record<QueueState, "queued" | "reading" | "ready">> = {
  queued: "queued",
  reading: "reading",
  ready: "ready",
};

/**
 * One queue for the whole app. Reading (FFprobe + thumbnail) runs in Rust, two files at a time;
 * committing to the project happens here, in drop order.
 */
const queue = createOrderedQueue<Payload, Awaited<ReturnType<typeof importDroppedFile>>>({
  concurrency: IMPORT_CONCURRENCY,
  run: ({ file }) => importDroppedFile(file.id),
  onState: (id, state) => {
    const job = STATE_TO_JOB[state];
    if (job) useImportsStore.getState().update(id, { state: job });
  },
  commit: (item, outcome) => {
    const jobs = useImportsStore.getState();
    if (!outcome.ok) {
      jobs.update(item.id, { state: "failed", message: outcome.error });
      return;
    }
    const result = commitImportedMedia(outcome.value);
    const { batch } = item.payload;
    if (result.status === "added") {
      batch.firstAdded ??= result.asset;
      jobs.remove(item.id); // the real card replaces the placeholder
      if (batch.placement) report(placeAssetAtDrop(result.asset.id, batch.placement));
    } else if (result.status === "duplicate") {
      if (batch.placement) {
        // already in the library: dropping it on the timeline still makes a clip
        jobs.remove(item.id);
        report(placeAssetAtDrop(result.existing.id, batch.placement));
      } else {
        jobs.update(item.id, { state: "skipped", message: "Already in the project" });
      }
    } else {
      jobs.update(item.id, { state: "failed", message: "The media engine returned unexpected metadata" });
    }
  },
});

/** Queue dropped files: placeholders appear immediately and the UI is never blocked. */
export function enqueueDroppedFiles(files: DroppedFile[], placement?: DropPlacement) {
  if (files.length === 0) return;
  const batch: DropBatch = { placement };
  const items = files.map((file) => ({ id: crypto.randomUUID(), payload: { file, batch } }));
  useImportsStore.getState().addJobs(items.map((i) => ({ id: i.id, name: i.payload.file.name })));

  // once per drop, after every file is in, so the canvas notice's Undo stays valid
  queue.add(items, () => {
    if (batch.firstAdded) applyPendingCanvas(batch.firstAdded);
  });
}
