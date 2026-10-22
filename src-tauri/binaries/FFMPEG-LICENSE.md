# FFmpeg in CutVii

The CutVii installers include the programs `ffmpeg` and `ffprobe` (FFmpeg 9.0.2). CutVii runs them as separate
programs; it does not link against them.

These are **GPL builds** (they include libx264 and other GPL components), licensed under the
**GNU General Public License, version 3 or later**. The full text is at <https://www.gnu.org/licenses/gpl-3.0.txt>.
They are not modified by CutVii. FFmpeg is a trademark of Fabrice Bellard; the code belongs to the FFmpeg developers
(<https://ffmpeg.org>).

Builds used:

- Windows and Linux: BtbN FFmpeg-Builds, <https://github.com/BtbN/FFmpeg-Builds> (tag `autobuild-2026-10-22-13-06`).
- macOS: Martin Riedl's static builds, <https://ffmpeg.martin-riedl.de> (release 9.0.2).

Source code: the FFmpeg 9.0.2 source is at <https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz>. The build scripts and
configuration of each build are published by the two projects above. You can also ask for the source of the exact
build you received by opening an issue at <https://github.com/zidniryi/cutvii/issues>.

To use your own FFmpeg instead, set `CUTVII_FFMPEG` and `CUTVII_FFPROBE` to its paths.
