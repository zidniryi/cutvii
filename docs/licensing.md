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

### Rust (448 crates in the build graph)

Almost entirely permissive: MIT, Apache-2.0, `MIT OR Apache-2.0`, Unicode-3.0, Zlib, Unlicense, BSD-3-Clause.
No GPL/LGPL/AGPL crates.

| Licence | Crates                                                                   | Note                                                                                                                                                                |
| ------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MPL-2.0 | `cssparser`, `cssparser-macros`, `selectors`, `dtoa-short`, `option-ext` | File-level copyleft: changes _to those files_ must be shared. Using them unmodified imposes no obligation on CutVii's own code. Pulled in by Tauri's HTML handling. |

### Assets

- The app icon (`design/app-icon.png`) and in-app logo are original artwork for this project; no third-party logo or
  mascot is used. The default Tauri icon set was replaced.
- Fonts: the UI uses the system font stack. Text and titles can be drawn in 38 font families that ship with the
  app: 37 under the **SIL Open Font License 1.1** and one (Luckiest Guy) under the **Apache License 2.0**. The
  files are in `src-tauri/assets/fonts/` and each licence text, with its copyright line, is in
  `src-tauri/assets/fonts/licenses/`. Noto Sans (the default) is compiled into the program; the others are bundle
  resources (`bundle.resources` in `tauri.conf.json`), about 30 MB in total, read from disk only when used:

  Alegreya, Aleo, Alex Brush, Anton, Arapey, Assistant, Barlow, Bitcount Ink, Bitter, Brawler, Bungee Spice, Caladea,
  Carme, DM Sans, Enriqueta, Fraunces, Google Sans, Grandiflora One, Grechen Fuemen, Lato, Libre Baskerville, LINE
  Seed JP, Luckiest Guy, Merienda, Merriweather, Mulish (formerly Muli), Noto Sans, Nunito, Open Sans, Oswald,
  Pinyon Script, Playfair Display, Playwrite NZ Basic Guides, Poppins, Roboto, Rokkitt, Rubik, Work Sans.

  - Luckiest Guy (Copyright 2010 Brian J. Bonislawsky DBA Astigmatic) is Apache-2.0: ship
    `licenses/LuckiestGuy-Apache-2.0.txt` with any distributed build.
  - Playwrite NZ Basic Guides is listed as OFL by Google Fonts but its folder there carries no licence file;
    `licenses/PlaywriteNZ-OFL.txt` is the licence of the same project's Playwrite NZ Basic (same copyright line).
  - The OFL allows bundling and redistribution: ship the licence texts with any distributed build (they are part
    of the resources) and do not sell the fonts on their own.
  - Several licences reserve the font name (Lato, Libre Baskerville, Merriweather, Playfair Display): the files
    are shipped unmodified, so the names may be kept. A modified copy would have to be renamed.
  - "Google" and "Google Sans" are trademarks of Google LLC (`licenses/GoogleSans-TRADEMARKS.md`): the font may be
    offered under its name, but the name must not be used to suggest any affiliation with Google.
  - Bitcount Ink and Bungee Spice are colour fonts; CutVii draws them in the single text colour.
  - Anton (Copyright 2020 The Anton Project Authors, OFL 1.1) is the heavy display face used by the Hot Take
    text style.
  - Alex Brush, Anton, Arapey, Bungee Spice, Carme, Grandiflora One, Grechen Fuemen, Luckiest Guy, Pinyon Script and
    Playwrite NZ Basic Guides have one weight (Bold does nothing).
    Barlow, Brawler, Caladea, Enriqueta, Lato, LINE Seed JP and Poppins ship as Regular and Bold only.

- Fonts a user imports (`.ttf`, `.otf`, `.ttc`) are copied into the app data folder on their machine and are never
  redistributed by CutVii; the user is responsible for having the right to use them.
- Text drawing uses `cosmic-text` (MIT OR Apache-2.0) and `png` (MIT OR Apache-2.0).

### Speech recognition (auto subtitles)

- The engine is **whisper.cpp** (MIT), compiled into the app through the `whisper-rs` crate (Unlicense). Building
  it needs `cmake` and a C++ compiler on the build machine. On macOS it uses the GPU through Metal.
- **No speech model is bundled.** A model (Tiny about 75 MB, Base about 142 MB, Small about 466 MB; OpenAI's
  Whisper weights, MIT, in the whisper.cpp project's ggml format) is downloaded only when the user asks for it and
  confirms a dialog that states the size and the source (`huggingface.co/ggerganov/whisper.cpp`). The file is
  checked against the published size and SHA-256 before it is used, kept in the app data folder, and can be
  removed from the AI tab.
- **Medium Indonesia** (about 514 MB) is the one model that does not come from the whisper.cpp project: it is
  `cahya/whisper-medium-id` (a fine-tune of OpenAI's Whisper Medium on Indonesian speech, declared Apache-2.0
  on Hugging Face) as converted to ggml and quantised by a third party (`rafdiraf/whisper-medium-id-ggml`,
  declared Apache-2.0). CutVii pins one commit of that repository and its exact size and SHA-256, and the
  consent dialog names the publisher. The licences are as declared on those pages; nobody here has checked
  the training data.
- This download, the upscale model download and the voice model download (both below), and the optional
  update check, are the **only network requests CutVii makes** (`ureq`, MIT OR Apache-2.0; `sha2`, MIT OR
  Apache-2.0). Recognition runs entirely on the user's machine; media and text are never sent anywhere.

## AI upscale (Real-ESRGAN models, ONNX Runtime)

- The engine is **ONNX Runtime** (MIT), linked into the app through the `ort` crate (MIT / Apache-2.0). The
  runtime library is fetched when CutVii is BUILT (by `ort`'s build script); nothing is fetched at run time
  except a model the user asked for.
- Models are **never bundled**. Two are offered, both from the Real-ESRGAN project's own release page
  (`github.com/xinntao/Real-ESRGAN`, tag `v0.2.5.0`), each pinned by exact size and SHA-256:
  `realesr-general-x4v3.pth` (4,885,111 bytes) and `realesr-animevideov3.pth` (2,504,012 bytes). A model is
  downloaded only after the user confirms a dialog that states the size, the source and the licence situation.
- **Licence of the models: not stated upstream.** The Real-ESRGAN CODE is BSD-3-Clause. Its release page and
  model list state no licence, and no training data, for the weight files (checked 2026-10-13). CutVii says so
  in the download dialog and does not redistribute the files; whether a model suits a given use is for the
  user to judge.
- CutVii reads the checkpoint as data and writes its own ONNX model from it (`src-tauri/src/media/upscale.rs`):
  no PyTorch, and nothing inside the checkpoint is executed. The network layout it rebuilds
  ("SRVGGNetCompact") is described in the BSD-3-Clause Real-ESRGAN repository.
- Pictures are enlarged on this computer and never uploaded. The result is a new file in the app data folder;
  the original is not changed.

## Voice-over from text (Supertonic 3, ONNX Runtime)

- The engine is **ONNX Runtime** again (see above); the text is tidied with `unicode-normalization`
  (MIT / Apache-2.0). No phonemizer is used, so there is no espeak-ng (GPL) anywhere in CutVii.
- The model is **Supertonic 3** by Supertone (`huggingface.co/Supertone/supertonic-3`), **never bundled**:
  sixteen files (four ONNX networks, two JSON tables, ten voices; 401,276,744 bytes together), each pinned
  to one published revision by exact size and SHA-256. It is downloaded only after the user confirms a
  dialog that states the size, the source and the licence.
- **Licence of the model: BigScience OpenRAIL-M** (checked 2026-10-14). Use is allowed, commercial use
  included, under use restrictions that travel with the model: among others, not to impersonate a person
  without consent, not to deceive, nothing unlawful. CutVii states this in the download dialog. The
  model's sample code is MIT; CutVii's own engine (`src-tauri/src/media/tts.rs`) follows the steps of that
  sample.
- A second size, **Compact** (147,709,674 bytes), uses the same files except the two big networks, which
  are 8-bit copies made by the sherpa-onnx project (`huggingface.co/csukuangfj2/sherpa-onnx-supertonic-3-tts-int8-2026-05-11`,
  a third party, pinned by revision, size and SHA-256). They are a derivative of the model, so the same
  OpenRAIL-M terms apply; the download dialog names who made them.
- **Training data: not stated upstream.** The model card names no recordings. CutVii says so in the dialog.
- The words typed are spoken on this computer and never uploaded. The result is a WAV file in the app
  data folder. There is no voice cloning: only the model's ten fixed voices are offered.
