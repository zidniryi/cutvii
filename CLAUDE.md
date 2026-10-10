# CLAUDE.md — CutVii (Open-Source Desktop Video Editor)

## 0. Token-Saving Rules (READ FIRST)
- Work on ONE phase at a time. Never start the next phase until I say "next".
- Do not re-read files you already created in this session unless editing them.
- Do not paste full files in your reply. Report only: files changed, commands run, test result, known limits, next step. Max ~15 lines.
- No long explanations or plans. A plan is max 5 bullets, once, in Phase 0 only.
- Prefer small edits (Edit) over rewriting whole files.
- If a phase looks too big, split it and tell me; do not push through.
- Run only the tests/checks relevant to the current phase.
- Never claim something works unless you ran it.

## 1. Project Overview
CutVii is an original, open-source, cross-platform desktop video editor inspired by the workflow of modern editors (import → timeline edit → preview → export MP4).
- Do NOT copy CapCut (or any product) code, logos, assets, templates, or branding. Own name, own UI identity.
- Local-first, offline-friendly, no account required, user media never modified or uploaded.
- Functional features over mockups. Every visible control must work or be clearly disabled with "Coming soon".
- Prioritize a reliable import → edit → save → reopen → export loop over feature count.
- Target platforms: Windows, macOS, Linux (desktop MVP) and Android (Phase 8). Desktop first; do not let Android work block the desktop MVP.

## 2. Tech Stack
- Frontend: React, TypeScript (strict), Vite, Tailwind CSS, shadcn/ui, Lucide icons, Zustand, Zod, Vitest + React Testing Library.
- Desktop/backend: Tauri 2, Rust stable, serde/serde_json, Tokio for async jobs, typed Tauri commands.
- Media: FFmpeg + FFprobe (managed binary or Tauri sidecar). Never assume global install; check and show a clear error. Do not bundle GPL builds without noting licensing in docs.
- Storage: local JSON project files with a documented schema + `schemaVersion`. No database for MVP.

## 2b. Platform Support
- Desktop (Phases 1–7): Windows 10/11, macOS (Intel + Apple Silicon), Linux (Debian/Ubuntu + AppImage). Use cross-platform APIs only: `std::path::PathBuf`, Tauri path APIs, no hardcoded `/` or `\\`, no shell-specific commands, no OS-specific code outside `cfg(target_os)` blocks.
- Android (Phase 8): via Tauri 2 mobile (`tauri android init/dev/build`). Needs Android Studio, SDK, NDK, JDK. Minimum API level to be decided in the Phase 8 spike.
- Keep the media engine behind a Rust trait (e.g. `MediaBackend`: probe, thumbnail, render) so each platform can use a different implementation. Desktop = FFmpeg/FFprobe sidecar. Android = decided in Phase 8 (do NOT assume the desktop sidecar works there; sidecar executables are not a reliable option on mobile).
- Android options to evaluate in the spike: FFmpeg built as an LGPL shared library called from Rust/JNI, or Android MediaCodec/MediaMuxer via a Tauri Kotlin plugin. Pick one, report trade-offs (size, license, speed), wait for my approval before building.
- Licensing for Android/store builds: LGPL only, dynamic linking, no GPL/nonfree FFmpeg flags.
- File access: use Tauri dialog/fs plugins; on Android handle content URIs / Storage Access Framework instead of raw paths. Keep file access behind one abstraction.
- UI must be responsive from Phase 1: use relative units, avoid hover-only interactions, 44px minimum touch targets, pointer events (not mouse-only) so the same timeline works with touch.
- CI (Phase 7): GitHub Actions matrix building Windows, macOS, Linux. Add Android build in Phase 8.
- Never claim a platform is supported unless it was built and run on it. Report untested platforms explicitly.

## 3. Visual Design — Black & Orange
Dark, warm, calm, professional. Original look (do not reuse any third-party logo or mascot).

Design tokens (define once as CSS variables / Tailwind theme, use everywhere):
- `--bg`: #0B0B0C (app background, near-black)
- `--surface-1`: #141416 (panels)
- `--surface-2`: #1C1C1F (cards, inputs, clips base)
- `--border`: #2A2A2E (subtle 1px borders)
- `--text`: #F2F0ED (primary), `--text-muted`: #9A968F
- `--accent`: #E5733A (orange; primary buttons, playhead, selected state)
- `--accent-hover`: #F08450, `--accent-soft`: rgba(229,115,58,0.15)
- `--danger`: #E5484D, `--success`: #3FB27F
- Clip colors: video = orange-tinted, audio = muted teal-gray, image = muted amber. Always keep contrast readable.

Rules:
- Rounded corners small (4–8px). Compact controls. Tooltips on icon-only buttons.
- Accent used sparingly: Export button, playhead, selected clip outline, focus rings.
- Keyboard-accessible, visible focus states.
- Logo: simple original wordmark "CutVii" (text + a minimal scissor/play glyph drawn by us).

## 4. Layout
- Top bar: logo + project name, File menu, undo/redo, project settings, save status, Export button.
- Left: media library (import, thumbnails, search, filename/duration/type, drag to timeline, remove from project without deleting the file).
- Center: preview canvas (aspect-aware, play/pause, seek, timecode, fit-to-view, empty state).
- Right: properties inspector (position, in/out, duration, volume, scale/position, opacity). Show only implemented controls.
- Bottom: timeline (ruler, playhead, multi-track video/audio, zoom, scroll, clip labels, snapping, context menu).
- Wide screens: panels as above. Narrow/mobile screens: collapse into tabs/bottom sheets (library, inspector) with preview on top and timeline below.
- Resizable panels where practical. Use canvas or virtualized rendering for the timeline; avoid thousands of DOM nodes.

## 5. Data Model (seconds as canonical unit; frame-aware for snapping/export)
```ts
type MediaType = "video" | "audio" | "image";
interface ProjectSettings { width: number; height: number; fps: number; backgroundColor: string }
interface MediaAsset { id: string; path: string; type: MediaType; duration?: number; width?: number; height?: number; thumbnailPath?: string }
interface TimelineClip { id: string; assetId: string; trackId: string; timelineStart: number; sourceIn: number; sourceOut: number; volume: number; x: number; y: number; scale: number; opacity: number }
interface TimelineTrack { id: string; name: string; type: "video" | "audio"; order: number; muted: boolean; hidden: boolean; clips: TimelineClip[] }
```
Project also has: id, name, settings, assets, tracks, schemaVersion, createdAt, modifiedAt. Mirror these as Rust serde structs. Validate on load (Zod + Rust), support migrations, detect missing files and offer relink. Never modify original media.

## 6. Architecture
- Keep media engine separate from UI. Rust modules: `commands/` (project, media, export), `media/` (ffmpeg, ffprobe, thumbnail, waveform), `project/` (model, persistence, validation), `export/` (render, progress), `errors.rs`.
- Typed Tauri commands only. No unrestricted shell exposed to the webview. Validate all paths/args in Rust. Never build commands from raw filenames.
- Progress via Tauri events. Background jobs for import, thumbnails, export. Never block the UI thread.
- Preview and export are separate but must produce consistent results. Do not decode whole videos into React state or stream big buffers over IPC.
- Export: validate → resolve timing → build FFmpeg filter graph (trim, scale, audio mix, compose, gaps/overlaps with documented rules) → encode H.264/AAC MP4 (software first) → progress + cancel → temp cleanup → never corrupt an existing output on failure.
- State: Zustand, separate slices (project, selection, playback, UI, jobs, history). Undo/redo via command pattern; no media buffers in history. Granular selectors so playhead updates don't re-render everything.

## 6j. Inspector Roadmap (collapsible sections)
The inspector is organised into collapsible sections that remember their last open/closed state. Planned features slot into these sections. Status as of 2026-10-11: only Clip (name, Start, Duration, Source in/out), Speed (step 6d-1), Image fit and Volume exist. Everything below is NOT built unless marked done.

Cheap and most noticeable (do first):
- **Transform:** Position X/Y, Scale (with aspect lock), Rotation, Flip horizontal/vertical, Opacity, and Fit / Fill / Reset buttons. Position, scale and opacity already exist in the data model; rotation and flip must be added (schema bump + migration). Must be applied identically in preview and export.
- **Audio:** Mute button, Fade in / Fade out (seconds), and Detach audio (split a video clip's sound into its own clip on an audio track).
- **Clip info (read-only):** resolution, fps, codec, file size, file location with "Show in Finder", proxy status, and a Replace media (relink) button.
- **Basic colour:** Brightness, Contrast, Saturation, Temperature. Verify the preview matches the export (do not rely on CSS filters alone).

Already planned elsewhere, to be given a slot here:
- Speed (presets, reverse, keep pitch, freeze frame), Crop, Background (remove background), Upscale, Audio fx (noise reduction, remove rumble), and Text (when a text clip is selected).
- Transition in/out per clip (fade, dissolve), if transitions are built.

Inspector comfort:
- Collapsible sections (remember last state), a Reset button per field, and numbers that can be scrubbed by dragging their label.
- A "set to playhead" button on Start, and timecode inputs that snap to frames.
- Copy / paste properties between clips (for example colour and transform).
- With several clips selected: show "mixed" on fields whose values differ, and apply a change to all of them.
- Later: a keyframe (diamond) button next to fields, for animation.

Rules: show only controls that work (section 1); every property must look the same in preview and export; each change is one undoable action.

## 7. Shortcuts
Space play/pause · Delete/Backspace delete clip · Ctrl/Cmd+Z undo · Ctrl/Cmd+Shift+Z redo · Ctrl/Cmd+S save · S split at playhead · Left/Right seek · Home to start. Ignore while typing in inputs.

## 8. Security & Licensing
Least-privilege Tauri capabilities, no analytics, no unnecessary network calls, document dependency licenses and FFmpeg build config.

## 9. MVP Phases (one at a time, stop after each)

### Phase 0 — Check (very short)
Inspect repo, Node/Rust/Tauri/FFmpeg versions. Give a 5-bullet plan and top 3 risks. Write nothing else.

### Phase 1 — Foundation
Init Tauri 2 + React + TS + Tailwind + shadcn. Add the black/orange design tokens from section 3. Build the app shell (top bar, library, preview, inspector, timeline placeholders) with empty states. Add lint/format/test scripts. Define the `MediaBackend` trait skeleton and use responsive/touch-safe layout from the start.
Done when: app launches with the shell; `tsc` and lint pass.

### Phase 2 — Project & Media Management
Project models (TS + Rust), Zod/Rust validation, new project, import dialog, FFprobe metadata, duplicate-import guard, cached thumbnails, media library UI (search, remove).
Done when: video/audio/image import and appear in the library; model tests pass.

### Phase 3 — Timeline Editing
Tracks, ruler, playhead, zoom/scroll, drag media to timeline, selection, move, trim, split at playhead, delete, snapping, context menu, undo/redo (command pattern) + tests.
Done when: all edit actions work and are undoable.

### Phase 4 — Preview
Play/pause/seek synced to the timeline, timecode, handle missing media and playback errors, document scrubbing-accuracy limits.
Done when: preview follows the playhead across multiple clips.

### Phase 5 — Persistence
Save/reopen project, schemaVersion + migrations, validation of invalid/old files, missing-media detection and relink flow.
Done when: save -> reopen preserves the exact editing state.

### Phase 6 — Export
Export dialog (resolution, fps, quality), FFmpeg filter-graph render, progress, cancel, errors, FFprobe verification of the output, export-planning tests.
Done when: exported MP4 plays and duration/streams match.

### Phase 7 — Polish
Keyboard shortcuts (section 7), inspector controls for implemented properties, accessibility pass, empty/error states, full-flow integration test, README (install, dev, FFmpeg licensing), packaging check, GitHub Actions build matrix (Windows, macOS, Linux), per-OS smoke test notes.

### Phase 8 — Android
Step 1 (spike, no big code): evaluate the media backend options from section 2b, report size/license/speed trade-offs, wait for my approval.
Step 2: `tauri android init`, make the responsive layout work with touch, content-URI file import, chosen media backend for probe/thumbnail/export.
Step 3: build a debug APK, test import → edit → save → export on an emulator or device, document limitations.
Done when: APK installs and exports a playable MP4 on at least one device/emulator.

### Later (P1/P2, only after Phase 8)
Text overlays, transitions, fades, aspect presets (16:9, 9:16, 1:1, 4:5), export presets, color adjustments, keyframes, auto captions, AI features.

## 10. Per-Phase Report Format
Files changed · Features done · Commands run · Test results · Known limits · Next step. Then STOP and wait for "next".

## 11. Definition of Done (MVP)
Desktop MVP (Phases 1–7, Windows/macOS/Linux): user can launch CutVii, import local media, edit clips on multiple tracks, preview, save and reopen, and export a playable MP4. Core flow is tested. A screenshot or static mockup does not count.
Android is done only after Phase 8 is verified on a real device or emulator.
