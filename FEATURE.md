# CutVii features

Everything the app does today (2026-10-13). Only macOS (Apple Silicon) has been built and run; Windows and
Linux are untested. What is planned but not built is listed at the end.

Each feature that changes the picture or the sound is applied the same way in the preview and in the export,
unless a line says otherwise.

## Projects

- New project with a canvas: templates (16:9, 9:16, 1:1, 4:5), Original (set by the first video) or a custom size.
- Save, Save as and Open; projects are JSON files with a schema version (now 7) and migrations from every older version.
- Missing media is detected on open, with a relink flow ("Replace media").
- Recent projects, unsaved-changes status, undo and redo for every edit.
- Local only: no account, nothing uploaded, original media is never changed.

## Media library

- Import video, audio and pictures by dialog or by dragging files onto the window.
- Thumbnails, search, file name, duration and type; duplicate imports are caught.
- Select one or many (click, Ctrl/Cmd-click, Shift-click); remove from the project without deleting the file.
- Drag media onto the timeline.

## Timeline

- Several video and audio tracks, ruler, playhead, zoom (buttons, Ctrl-wheel, pinch) and scrolling.
- Move, trim, split at the playhead, delete, cut / copy / paste, select all, snapping, a context menu.
- Waveforms on clips with sound.
- Track mute and hide.
- Toolbar buttons: Add text, AI, Subtitles (auto subtitles), Auto clips, Karaoke, Voice-over. The AI menu
  in the top bar has the same four tools.

## Preview

- Play, pause, seek, timecode, loop, preview speed, volume, full screen inside the window.
- Follows the timeline across clips and tracks; sound leads so music does not stutter.
- Drag a text in the preview to move it, with guides for the centre and the safe margin.
- Crop a clip directly in the preview with a box and handles.

## Clip tools (inspector)

- **Clip:** name, start, duration, source in and out. A button next to Start moves the clip to the playhead.
- **Transform:** scale, position, rotation, opacity, flip across and down, reset.
- **Sections:** Fit to canvas, Transform, Crop, Upscale, Volume and fades, Clean up sound and Ducking fold
  away under their title and stay as they were left.
- **Scrub a number:** drag the label of a Transform value, a crop side, Start or Duration left or right.
- **Copy / paste transform** between clips (keyframes are not copied; a text keeps its own position).
- **Reset per field:** a small arrow puts one value back: each Transform value (its keyframes go too),
  Volume, Fade in / out and each side of the crop.
- **Keyframes:** animate scale, position, rotation and opacity. The diamond next to a value adds a keyframe
  at the playhead; a value with keyframes is edited at the playhead. Straight-line movement between keys.
  Every keyframe shows as a diamond on the clip in the timeline; a click on it moves the playhead there.
- **Transitions:** in the Transition tab a clip can come in and leave with one of sixteen transitions
  (Dissolve / Fade out, Fade from / to black, four slides, two glides, Zoom in, Zoom out, Pop, Spin, Swing,
  Rise, Drop, Tilt), 0.1 to 3 seconds each. Pick one from a gallery that shows the movement, or drag it onto
  a clip in the timeline (left half = coming in, right half = leaving); "Play it" shows the result. On the
  timeline a transition is a darker block at the clip's end whose bar can be pulled to change its length.
  Coming in, the clip before it on the same track holds its last frame underneath. The clip's sound fades
  with its picture. "Fade out" on one clip and "Fade from black" on the next gives a fade through black.
- **Crop:** sliders or the preview box; shapes Free, 16:9, 9:16, 1:1, 4:5, 4:3.
- **Fit:** fill, fit, or fit over a blurred copy; background black, a colour or a picture; apply to all clips.
- **Speed:** presets and custom speed (0.1× to 10×), keep pitch, reverse, freeze frame.
- **Info:** resolution, codecs, audio details, file size, bit rate, location, Show in Finder / folder, Replace media.

## Sound

- Clip volume, mute, fade in and fade out.
- Detach audio: a video's sound becomes its own clip on an audio track.
- **Clean up sound:** reduce steady noise (hiss, fan) and remove rumble and hum below 80 Hz. The preview
  plays the original sound; "Listen to 6 s" plays a cleaned sample, and the export is cleaned.
- **Ducking:** a clip (music) is turned down while other clips make sound and comes back afterwards.
  Export only; the preview plays it at full level.

## Colour

- **Adjust:** exposure, contrast, saturation, vibrance, temperature, tint, highlights, shadows; per-slider
  reset, Reset all, hold for Before, a warning for HDR footage.
- **Presets (looks):** a gallery with thumbnails from the clip, intensity, apply to one or all clips, copy and paste colour.
- **Own presets:** save, rename, duplicate, delete; export and import as `.cutviipreset`.
- **LUT:** import `.cube` files (3D LUTs), choose one per clip with an intensity; applied after Adjust.
- One colour path: everything is baked into one table that the preview (WebGL) and the export (FFmpeg) share.

## Text and titles

- Add text at the playhead; content, font, size, colour, bold, alignment, upper case.
- Outline, shadow or glow, background box (rectangle, per line, jagged), highlight, fade in and out.
- 37 bundled font families plus "Import a font file"; a searchable font picker that shows each font in its own typeface.
- Text styles: 31 built-in styles, My styles (save, rename, delete), most-recent order; export and import a style as a file.
- Position: 3×3 anchors, X/Y, safe margin, "Move all texts on this track", reset.

## AI (on this computer; models are downloaded only after you agree)

- **Auto subtitles:** speech to text with Whisper (Tiny, Base, Small, Medium, Large Turbo, Large, and Medium
  Indonesia), language choice, one text clip per line in a chosen subtitle style.
- **Subtitles as a file:** "Export subtitles (.srt)…" in a text clip's menu (the texts of its track) and in
  the File menu (the selected text's track, otherwise every text on the timeline).
- **Auto clips:** finds short clips in a long video, a review step with a player and cut handles, then adds
  them to the timeline or exports each as its own file.
- **Voice-over from text:** the "Voice-over" button in the timeline toolbar turns typed words into speech
  (Supertonic 3: Indonesian, English and 29 more languages, ten voices, speed) and puts it on a
  "Voice-over" audio track at the playhead. Two sizes of the voice model can be chosen and downloaded
  (Standard about 401 MB, Compact about 148 MB), each once and after asking; the words never leave the computer.
- **Karaoke Maker:** lyrics from recognition, pasted text or an `.lrc` / `.srt` file; lines are timed, can be
  nudged and edited, and are added in a karaoke style. Optional "Lower the singer's voice (estimate)".
- **AI upscale (pictures and video):** 2× or 4× with Real-ESRGAN models; the clip is pointed at the new
  file. For video only the part the clip uses is treated, frame by frame (slow: seconds per frame), up to
  1280 px on the longer side and 3000 frames at a time.

## Style packs

- Share your own text styles, colour presets and export presets as one `.cutvii-pack` file.
- Import by dialog or by dropping the file on the window, with a preview, a checklist, and keep both / skip /
  replace for conflicts. Fonts are never inside a pack; missing fonts are named.

## Export

- MP4 (H.264 + AAC) with resolution, frame rate and quality; up to 2K and 4K.
- Audio only: M4A, MP3, WAV.
- Own export presets (save, rename, delete).
- Progress, cancel, a check of the finished file, "Show in folder". A failed export never damages an existing file.

## App

- Black and orange interface, keyboard shortcuts (Space, S, Delete, arrows, Home, Ctrl/Cmd Z / S / A / X / C / V).
- File menu, AI menu, About window.
- **Support CutVii:** a gift button in the top bar opens a popup with two links (donate, other ways to
  support). It opens only when clicked. CutVii has no locked features, accounts, licence keys or analytics.
- **Update check:** optional and a notification only. At most once a day CutVii asks GitHub whether a newer
  release exists and shows "CutVii X.Y.Z is available" with Download (opens the release page), Later and
  Skip this version. "Check for updates" in the menu asks right away. Not active until the project's
  repository is filled in (`UPDATE_REPO`).
- **Settings:** one setting so far, "Check for updates automatically".
- Notices appear as a toast; dialogs trap focus and close with Escape.

## What needs something installed

- FFmpeg and FFprobe are not bundled yet: CutVii looks for them on the computer and says so when they are missing.
- MP3 export needs an FFmpeg build with `libmp3lame`.

## Not built yet

- Remove background, blur background, text behind the subject.
- Vocal separation (stems) and word-by-word highlight in Karaoke; tap-to-sync.
- Keyframes for volume, crop and colour; easing per keyframe; dragging a keyframe mark.
- Wipes and other masked transitions; a true cross-fade of two moving clips (the outgoing one is frozen).
- Clean-up and ducking heard in the preview.
- Subtitle translation; `.vtt` export.
- More settings (the Settings window has one).
- Windows and Linux builds, Android, an installer (`.dmg`), bundled FFmpeg.
