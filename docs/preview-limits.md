# Preview behaviour and accuracy limits

The preview is a _monitor_, not the render. Export (Phase 6) uses FFmpeg and is the source of truth.

## How it works

- The playhead is driven by a wall-clock (`requestAnimationFrame`) while playing; media elements follow it.
- Per frame, the on-screen layers are computed by `layersAt` (`src/playback/engine.ts`): the clip under the
  playhead on every track, plus clips starting within 1 s (mounted paused so they are ready).
- The visible picture is the active video/image clip on the highest non-hidden video track.
  Audio from every active clip (including video clips underneath) plays; muted tracks are silent.
- Gaps show the project background; the clock keeps running through them.

## Transport bar

- The seek bar, the timeline playhead and the timecode read and write one playhead. Dragging the seek bar asks
  for at most one seek per animation frame; the picture keeps its last frame until the new one is decoded.
- Monitor volume, mute, loop and preview speed (0.5× / 1× / 1.5× / 2×) are preview-only UI state. They are not
  saved in the project and never affect the export. Preview speed multiplies each clip's own speed and is still
  limited to what the webview can play (0.25×–4×).

## Accuracy limits

- **Seek precision:** `HTMLMediaElement.currentTime` lands on the decoder's nearest frame, which depends on the
  file's keyframe spacing. Scrubbing can be off by up to a few frames on long-GOP footage; export is exact.
- **Sync:** while playing, an element is re-seeked only if it drifts more than 0.3 s from the clock, so audio and
  video of different clips may be off by up to that amount. Paused seeks are corrected to within 0.02 s.
- **Cuts between clips:** the next clip is preloaded for 1 s, but a brief stall at a cut is possible on slow disks
  or heavy codecs; the clock does not wait for media.
- **Volume:** preview caps at 100 % (browser limit); export will apply gains up to 200 %.
- **Transforms:** `x`, `y`, `scale`, `opacity` are not applied in preview yet (inspector controls arrive in Phase 7,
  at which point preview and export must agree).
- **Formats:** playback uses the system webview's decoders. Files FFmpeg can read may still be unplayable here
  (for example MKV/AVI on macOS). The app shows "missing, or its format is not supported by the preview"; the
  clip can still be edited and exported.
- **Performance:** several overlapping 4K clips can drop frames; only the visible one is shown but all decode.

## Access

The webview can read only files imported in this session: the Rust import command adds each file to the asset
protocol scope at runtime. Re-opening a saved project must re-grant access (Phase 5).
