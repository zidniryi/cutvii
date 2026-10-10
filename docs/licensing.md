# Licensing

## FFmpeg (the one that matters)

CutVii **does not bundle FFmpeg**. It runs the `ffmpeg` / `ffprobe` executables it finds on the machine
(see the README for the lookup order) as separate processes, and never links against FFmpeg libraries.

What that means depends on how you obtain and ship FFmpeg:

| Scenario                                                  | Obligations                                                                                                                                             |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User installs FFmpeg themselves (current behaviour)       | None for CutVii; the user's FFmpeg licence applies to their copy.                                                                                       |
| You ship an **LGPL** FFmpeg build next to the app         | Provide the FFmpeg source/build config and licence text; allow replacing the binary. No GPL obligations on CutVii.                                      |
| You ship a **GPL** build (e.g. Homebrew's, Gyan's "full") | GPL applies to that binary: provide its source and licence text. Check whether you want CutVii distributed together with it under GPL-compatible terms. |
| Any build with `--enable-nonfree`                         | **Not redistributable.** Do not ship.                                                                                                                   |

### Check which build you have

```bash
ffmpeg -version | head -3        # look at "configuration:" for --enable-gpl / --enable-nonfree / --enable-version3
ffmpeg -L | head -5              # prints the licence of the build
ffmpeg -hide_banner -encoders | grep -E "libx264|libopenh264|videotoolbox"
```

The development machine uses Homebrew's FFmpeg, which is a **GPL** build (it enables `libx264`). That is fine for
development; it is not what a store/LGPL distribution should ship.

### Encoders and what an LGPL build changes

CutVii picks the H.264 encoder at export time, in this order: `libx264` (GPL), `libopenh264` (BSD, needs Cisco's
runtime library), `h264_videotoolbox` (macOS hardware). An LGPL FFmpeg has no `libx264`, so exports use the next
available encoder. The fallback encoders are covered by argument-level unit tests only; **a render with them has
not been run**. Verify with your chosen build before shipping.

### Android / store builds

Per the project rules: LGPL only, dynamic linking, no GPL or `--enable-nonfree` flags. Desktop sidecar executables are
not a reliable option on Android; the media backend there is decided in Phase 8.

### Decision needed from the maintainer

1. Ship FFmpeg at all, or require users to install it? (Today: users install it.)
2. If shipping: LGPL build (needs an encoder plan, see above) or GPL build (then document the combined licensing).
3. Pick the CutVii licence (none chosen yet).

To bundle a binary later, Tauri's sidecar mechanism (`bundle.externalBin`, `binaries/ffmpeg-<target-triple>`) is the
intended route; the lookup in `src-tauri/src/media/tools.rs` is where a bundled path would be checked first.

## Dependencies

Counts come from `pnpm licenses list --prod` and `cargo metadata` (re-run them when dependencies change).

### Runtime JavaScript (22 packages, shipped in the UI bundle)

| Licence           | Packages |
| ----------------- | -------- |
| MIT               | 19       |
| Apache-2.0        | 1        |
| Apache-2.0 OR MIT | 1        |
| ISC               | 1        |

Direct dependencies: `react`, `react-dom`, `zustand`, `zod`, `lucide-react`, `@base-ui/react`,
`class-variance-authority`, `clsx`, `tailwind-merge`, `tw-animate-css`, `@tauri-apps/api`.
Tailwind and the Vite plugin are build tools only (they pull in `lightningcss`, MPL-2.0, which is not shipped).

### Rust (421 crates in the build graph)

Almost entirely permissive: MIT, Apache-2.0, `MIT OR Apache-2.0`, Unicode-3.0, Zlib, Unlicense, BSD-3-Clause.
No GPL/LGPL/AGPL crates.

| Licence | Crates                                                                   | Note                                                                                                                                                                |
| ------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MPL-2.0 | `cssparser`, `cssparser-macros`, `selectors`, `dtoa-short`, `option-ext` | File-level copyleft: changes _to those files_ must be shared. Using them unmodified imposes no obligation on CutVii's own code. Pulled in by Tauri's HTML handling. |

### Assets

- The app icon (`design/app-icon.png`) and in-app logo are original artwork for this project; no third-party logo or
  mascot is used. The default Tauri icon set was replaced.
- Fonts: system font stack only, nothing bundled.
