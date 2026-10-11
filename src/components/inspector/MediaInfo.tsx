import { useEffect, useState } from "react";
import { FolderOpen, Replace } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type { MediaAsset } from "@/project/model";
import { relinkFlow } from "@/project/fileActions";
import { channelLabel, formatBitRate, formatBytes, useMediaDetailsStore } from "@/store/mediaDetails";

const buttonClass =
  "flex h-9 items-center justify-center gap-2 rounded-md border border-border bg-surface-2 px-2 text-xs text-text-muted hover:text-text disabled:opacity-40 pointer-coarse:h-11 [&_svg]:size-4";

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-text-muted">{label}</dt>
      <dd className="break-words tabular-nums">{children}</dd>
    </div>
  );
}

/** The file manager's name on this system, for the button label. */
const fileManager = () => (/Mac/i.test(navigator.userAgent) ? "Show in Finder" : "Show in folder");

/**
 * What the file behind a clip is (codecs, container, size), where it is, and two actions on it: show it in
 * the file manager, or replace it with another file. `missing`: the file was not found on disk.
 */
export function MediaInfo({ asset, missing }: { asset: MediaAsset; missing: boolean }) {
  const entry = useMediaDetailsStore((s) => s.entries[asset.path]);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!missing) useMediaDetailsStore.getState().ensure(asset.path);
  }, [asset.path, missing]);
  const details = entry?.status === "ready" ? entry.details : null;
  const sound = details?.audioCodec
    ? [
        details.audioCodec.toUpperCase(),
        details.audioChannels ? channelLabel(details.audioChannels) : null,
        details.sampleRate ? `${Math.round(details.sampleRate / 100) / 10} kHz` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;

  function reveal() {
    setProblem(null);
    Promise.resolve(invoke("reveal_media", { path: asset.path })).catch((e: unknown) =>
      setProblem(typeof e === "string" ? e : e instanceof Error ? e.message : "Could not show the file"),
    );
  }

  return (
    <div className="col-span-2 space-y-3">
      <dl className="grid grid-cols-2 gap-3">
        {details?.videoCodec && (
          <Fact label={asset.type === "image" ? "Format" : "Video codec"}>
            {details.videoCodec.toUpperCase()}
          </Fact>
        )}
        {sound && <Fact label="Audio">{sound}</Fact>}
        {details && asset.type === "video" && !details.audioCodec && <Fact label="Audio">none</Fact>}
        {details && <Fact label="File size">{formatBytes(details.sizeBytes)}</Fact>}
        {details?.bitRate !== undefined && asset.type !== "image" && (
          <Fact label="Bit rate">{formatBitRate(details.bitRate)}</Fact>
        )}
        {details?.container && asset.type !== "image" && (
          <div className="col-span-2">
            <Fact label="Container">{details.container}</Fact>
          </div>
        )}
        <div className="col-span-2">
          <Fact label="File">{asset.path}</Fact>
        </div>
      </dl>
      {entry?.status === "loading" && <p className="text-text-muted">Reading the file…</p>}
      {entry?.status === "failed" && <p className="text-text-muted">The file's details could not be read.</p>}
      {missing && <p className="text-danger">This file was not found. Replace it to bring the clip back.</p>}
      {problem && (
        <p role="alert" className="text-danger">
          {problem}
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        <button type="button" className={buttonClass} disabled={missing} onClick={reveal}>
          <FolderOpen />
          {fileManager()}
        </button>
        <button
          type="button"
          className={buttonClass}
          onClick={() => {
            const before = asset.path;
            void relinkFlow(asset.id).then(() => useMediaDetailsStore.getState().forget(before));
          }}
        >
          <Replace />
          Replace media…
        </button>
      </div>
    </div>
  );
}
