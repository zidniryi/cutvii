# Smoke tests

Automated checks run in CI on Linux, macOS and Windows (`.github/workflows/ci.yml`): typecheck, lint, format,
frontend tests, `cargo fmt/clippy/test` (with real FFmpeg renders) and a release bundle build.
Those do **not** replace a human pass on each OS. Use this list before a release.

## Checklist (≈10 minutes per OS)

1. **Launch** the installed app: window opens with the black/orange shell, no console errors.
2. **Import** an MP4, an audio file and an image (+ button). Thumbnails and durations appear.
   Import the same file again → "already in the project".
3. **Timeline:** add all three, drag to move, trim an edge, split at the playhead (S), delete (Del), undo/redo.
4. **Preview:** press Space; picture and sound follow the playhead; scrub the ruler; cross a cut between two clips.
5. **Inspector:** change Start, Duration and Volume of a clip; mute a track; hide a video track.
6. **Save** (Ctrl/Cmd+S), make an edit, **reopen** with Ctrl/Cmd+O: the saved state returns.
7. **Missing media:** move a source file, reopen the project → "Missing" badges; use Relink.
8. **Export** at 720p / Draft: progress moves, the file plays in another player, duration and sound are right.
9. **Cancel** an export mid-way: no partial file is left next to the target.
10. **Close** with unsaved changes → prompt appears.
11. **No FFmpeg:** start with FFmpeg off `PATH` → import shows a clear error (not a crash).

## What has actually been verified

| Platform                        | Status                                                                                                                                                                                                                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS 15 (Apple Silicon)        | Built and run by hand. Import via the native picker, playback, and two real exports (1920×1080 H.264 + AAC, decoded cleanly) were exercised in the live app on an earlier build. The packaged `.app` was built and launched; see the phase report for what was checked. |
| Windows 10/11                   | **Not run.** Only the CI build/test matrix is defined. Expect to check: native dialogs, `asset://` media playback (`http://asset.localhost`), console-window flashing (suppressed in code, untested).                                                                   |
| Linux (Debian/Ubuntu, AppImage) | **Not run.** WebKitGTK codec support for preview varies with installed GStreamer plugins; export is unaffected.                                                                                                                                                         |
| Intel macOS                     | **Not run.**                                                                                                                                                                                                                                                            |
| Android                         | Not started (Phase 8).                                                                                                                                                                                                                                                  |

Do not describe a platform as supported until its row says it was built **and** run.
