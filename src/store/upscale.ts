import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { confirmDialog } from "@/lib/dialog";
import { findClip } from "@/timeline/clips";
import {
  upscaleBlocker,
  applyUpscaledPicture,
  applyUpscaledVideo,
  type UpscaledPicture,
  type UpscaledVideo,
  type UpscaleFactor,
} from "@/timeline/upscale";
import { useAiStore } from "./ai";
import { useProjectStore } from "./project";

/** An upscale model on offer (see `src-tauri/src/media/upscale.rs`). Models are never bundled. */
export interface UpscaleModel {
  id: string;
  label: string;
  approxMb: number;
  source: string;
  installed: boolean;
}

interface UpscaleState {
  models: UpscaleModel[];
  loaded: boolean;
  /** Model being downloaded and how far (bytes), if any. */
  download: { id: string; received: number; total?: number } | null;
  /** Clip being upscaled, how far (0..1) and when it started, if any. */
  running: { clipId: string; fraction: number; startedAt: number } | null;
  ensure: () => void;
  refresh: () => Promise<void>;
  /** Ask the user, then download. Returns a note to show, or null when they declined. */
  downloadWithConsent: (id: string) => Promise<{ kind: "ok" | "problem"; text: string } | null>;
  remove: (id: string) => Promise<void>;
  /** Upscale a picture clip and use the result (one undo step). Returns a message when it did not work. */
  upscaleClip: (clipId: string, modelId: string, factor: UpscaleFactor) => Promise<string | null>;
  cancel: () => void;
}

const message = (e: unknown) =>
  (typeof e === "string" ? e : e instanceof Error ? e.message : "unknown error").replace(
    /^invalid input: /,
    "",
  );

let attached: Promise<unknown> | null = null;

export const useUpscaleStore = create<UpscaleState>((set, get) => {
  const attach = () => {
    attached ??= Promise.all([
      listen<{ id: string; received: number; total?: number }>("ai-download", (e) => {
        const current = get().download;
        if (current && e.payload.id === `upscale:${current.id}`) {
          set({ download: { id: current.id, received: e.payload.received, total: e.payload.total } });
        }
      }),
      listen<{ fraction: number }>("upscale-progress", (e) => {
        const current = get().running;
        if (current) set({ running: { ...current, fraction: e.payload.fraction } });
      }),
    ]).catch(() => null);
  };
  return {
    models: [],
    loaded: false,
    download: null,
    running: null,
    refresh: async () => {
      const models = await invoke<UpscaleModel[]>("upscale_models");
      if (Array.isArray(models)) set({ models, loaded: true });
    },
    ensure: () => {
      if (get().loaded) return;
      attach();
      get()
        .refresh()
        .catch(() => undefined);
    },
    downloadWithConsent: async (id) => {
      const model = get().models.find((m) => m.id === id);
      if (!model) return null;
      const host = new URL(model.source).host;
      const agreed = await confirmDialog({
        title: "Download the upscale model?",
        lines: [
          `${model.label}: about ${model.approxMb} MB, downloaded once from ${host} (the Real-ESRGAN project's release page).`,
          "Licence: the project's code is BSD-3-Clause. Its page states no separate licence for this model file, so check that this suits what you make.",
          "It is kept on this computer. Your pictures are never uploaded: they are enlarged here.",
        ],
        confirmLabel: "Download",
      });
      if (!agreed) return null;
      attach();
      set({ download: { id, received: 0 } });
      try {
        await invoke("download_upscale_model", { id });
        return { kind: "ok", text: "The upscale model is ready." };
      } catch (e) {
        const reason = message(e);
        return /cancel/i.test(reason)
          ? { kind: "ok", text: "The download was cancelled." }
          : { kind: "problem", text: `Could not download the model: ${reason}` };
      } finally {
        set({ download: null });
        await get()
          .refresh()
          .catch(() => undefined);
      }
    },
    remove: async (id) => {
      await Promise.resolve(invoke("delete_upscale_model", { id })).catch(() => undefined);
      await get()
        .refresh()
        .catch(() => undefined);
    },
    upscaleClip: async (clipId, modelId, factor) => {
      if (get().running) return "Another clip is still being upscaled.";
      const project = useProjectStore.getState().project;
      const blocker = upscaleBlocker(project, clipId);
      if (blocker) return blocker;
      const found = findClip(project, clipId)!;
      const asset = project.assets.find((a) => a.id === found.clip.assetId)!;
      attach();
      set({ running: { clipId, fraction: 0, startedAt: Date.now() } });
      if (asset.type === "video") {
        // only the stretch the clip uses is treated: every frame costs seconds
        let video: UpscaledVideo;
        try {
          video = await invoke<UpscaledVideo>("upscale_video", {
            path: asset.path,
            modelId,
            factor,
            sourceIn: found.clip.sourceIn,
            sourceOut: found.clip.sourceOut,
          });
        } catch (e) {
          const reason = message(e);
          return /cancel/i.test(reason) ? "Stopped. Nothing was changed." : reason;
        } finally {
          set({ running: null });
        }
        if (!video || typeof video.path !== "string" || !(video.width > 0) || !(video.duration > 0)) {
          return "The upscaled video could not be made.";
        }
        const done = useProjectStore.getState().execute({
          label: `Upscale ${factor}× with AI`,
          apply: (p) => applyUpscaledVideo(p, clipId, video, crypto.randomUUID()),
        });
        return done.ok ? null : done.error.message;
      }
      let picture: UpscaledPicture;
      try {
        picture = await invoke<UpscaledPicture>("upscale_image", { path: asset.path, modelId, factor });
      } catch (e) {
        const reason = message(e);
        return /cancel/i.test(reason) ? "Stopped. Nothing was changed." : reason;
      } finally {
        set({ running: null });
      }
      if (!picture || typeof picture.path !== "string" || !(picture.width > 0) || !(picture.height > 0)) {
        return "The upscaled picture could not be made.";
      }
      const result = useProjectStore.getState().execute({
        label: `Upscale ${factor}× with AI`,
        apply: (p) => applyUpscaledPicture(p, clipId, picture, crypto.randomUUID()),
      });
      return result.ok ? null : result.error.message;
    },
    cancel: () => useAiStore.getState().cancel(),
  };
});
