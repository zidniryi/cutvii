# Export rules (what the render does, and how it matches the preview)

Source of truth: `src-tauri/src/export/` (`plan.rs` builds the plan and FFmpeg filter graph, `render.rs` runs it).

## Timeline → picture

- Canvas = export size on the project's background colour; the length is the end of the last clip on any track.
- Tracks are composited in ascending `order`; the clip on the highest **visible** video track covers the ones below
  (same rule as the preview, where only that clip is shown).
- Each video or image clip is scaled to the canvas by its `fitMode`, never shown at native pixel size:
  **fill** (default) covers the canvas and crops the overflow equally on both sides; **fit** shows the whole picture
  with bars in the background colour; **blur-bg** shows the whole picture over a blurred, covering copy of itself
  (blur sigma = 3 % of the canvas height). The preview uses the same geometry (`src/timeline/fit.ts`).
- Stills are looped for the clip length; transparency is flattened onto the background.
- **Text** is the exception to both rules above: a text picture keeps its transparency and is laid over whatever
  the tracks below show, with no background of its own (`fitMode` and `fitBackground` do not apply to it). It is
  scaled to fit the export size and centred. The preview shows the same file the export overlays, and shows every
  text layer down to the first video or image under it.
- Gaps show the background colour.
- `hidden` tracks give no picture. `x`, `y`, `scale`, `opacity` are not applied yet (not in the preview either).

## Timeline → sound

- Sources: audio-track clips and the audio of video clips (if the file has an audio stream).
- Each clip is positioned at `timelineStart` (millisecond resolution), scaled by `volume` (0–2), resampled to
  48 kHz stereo, and mixed over a silent base without level normalisation. Overlapping loud clips can clip.
- `muted` tracks contribute nothing; `hidden` video tracks still play their sound (as in the preview).
- The file always has an audio stream (silent if nothing is audible).

## Audio-only formats

- **M4A** (AAC 192 kb/s), **MP3** (192 kb/s, `libmp3lame`) and **WAV** (16-bit PCM) export the same mix as the
  video export, with no video stream.
- MP3 needs an FFmpeg built with `libmp3lame` (LGPL, so allowed in an LGPL build). Without it the export stops
  with a clear message and suggests M4A or WAV; nothing is written.

## Fit background

- `fitBackground` decides what shows where the picture does not cover the canvas (the bars of **fit**, and behind
  transparent stills): **black** (default), a **colour**, or an **image** from the library scaled to cover the
  canvas. The preview and the export use the same choice.
- Its `blur` (0–100, default 30) is the strength of **blur-bg**: radius = amount/1000 of the canvas height; 0 means
  no blur at all.
- The export reads the original background image; the preview uses a cached copy at most 1280 px wide.
- A filled or blurred _video_ is opaque, so its background is not visible and no background input is added.

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
