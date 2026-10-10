# Export rules (what the render does, and how it matches the preview)

Source of truth: `src-tauri/src/export/` (`plan.rs` builds the plan and FFmpeg filter graph, `render.rs` runs it).

## Timeline → picture

- Canvas = export size on the project's background colour; the length is the end of the last clip on any track.
- Tracks are composited in ascending `order`; the clip on the highest **visible** video track covers the ones below
  (same rule as the preview, where only that clip is shown).
- Clips are fitted inside the canvas keeping aspect ratio, letter/pillar-boxed with the background colour.
- Stills are looped for the clip length; transparency is flattened onto the background.
- Gaps show the background colour.
- `hidden` tracks give no picture. `x`, `y`, `scale`, `opacity` are not applied yet (not in the preview either).

## Timeline → sound

- Sources: audio-track clips and the audio of video clips (if the file has an audio stream).
- Each clip is positioned at `timelineStart` (millisecond resolution), scaled by `volume` (0–2), resampled to
  48 kHz stereo, and mixed over a silent base without level normalisation. Overlapping loud clips can clip.
- `muted` tracks contribute nothing; `hidden` video tracks still play their sound (as in the preview).
- The file always has an audio stream (silent if nothing is audible).

## Speed

- A clip plays `(sourceOut - sourceIn) / speed` seconds. Picture: `setpts=(PTS-STARTPTS)/speed`, then resampled to the
  output frame rate (frames are dropped or repeated; no frame blending).
- Sound with **Keep pitch**: `atempo`, chained in factors of 0.5–2 (0.25× = two filters). Without it: `asetrate`, so
  pitch rises and falls with the speed.
- Above 4× the clip's sound is left out, and the export result says so. The preview follows the same rule.
- The preview can only play 0.25×–4× in the webview; outside that range it plays at the nearest limit while the
  export uses the real speed.

## Reverse and freeze frame

- A reversed clip plays its used source range backwards (picture and sound). Before rendering, that range is
  reversed into a lossless temporary copy (FFV1 + PCM) next to the output, in chunks sized to keep at most about
  256 MB of raw frames in memory, joined in reverse order. The copy is deleted when the export ends, fails or is
  cancelled. Speed is applied after reversing.
- The preview plays a separate small reversed copy (H.264, 540p max) cached under the app cache; it is never used
  for export. Until it exists the preview shows "Preparing reverse preview…".
- Freeze frame extracts the exact frame from the original file at full resolution as a PNG in the app data folder
  and holds it as a 2 s still.

## Encoding

- H.264 in MP4 (`+faststart`), AAC 192 kb/s. Software x264 when available (Draft/Standard/High = CRF 28/23/18),
  otherwise `libopenh264` or VideoToolbox with a bitrate derived from size, fps and quality.
- Width and height must be even; fps 1–120.

## Safety

- The output is written to `.<name>.cutvii-part.mp4` next to the target and renamed only after ffprobe has verified
  it (video + audio streams, exact size, duration within 3 frames + 0.1 s). A failure or cancel leaves any existing
  file untouched and removes the temp file.
- The export refuses to overwrite a file that is used as source media.
- Cancel kills FFmpeg within ~50 ms of the next poll.

## Known limits

- One FFmpeg input per clip (a source used many times is opened many times).
- The filter graph is passed on the command line; a project with many hundreds of clips could hit OS argument
  limits (switch to a script file if that happens).
- Preview and export agree on ordering, boxing, gaps and mute/hide; frame-exact equality is not guaranteed
  (see `preview-limits.md`).
