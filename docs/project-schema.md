# CutVii project file (schemaVersion 5)

Plain JSON. Source of truth: `src/project/model.ts` (Zod) and `src-tauri/src/project/` (serde + `validate`).
Both are tested against `fixtures/project-v1.json`; change the fixture and both test suites together.

| Field                      | Notes                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`            | Integer, currently `1`. Unknown versions are rejected until migrations exist (Phase 5).                                                                                                                                                                                                                                                                                                                                             |
| `createdAt` / `modifiedAt` | ISO-8601 UTC strings.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `settings`                 | `width`, `height` (positive ints), `fps` (0–240], `backgroundColor` (`#RRGGBB`).                                                                                                                                                                                                                                                                                                                                                    |
| `assets[]`                 | `id`, `path`, `type` (`video`/`audio`/`image`), optional `duration` (s), `width`, `height`, `thumbnailPath`.                                                                                                                                                                                                                                                                                                                        |
| `tracks[]`                 | `id`, `name`, `type` (`video`/`audio`), `order`, `muted`, `hidden`, `clips[]`.                                                                                                                                                                                                                                                                                                                                                      |
| `clips[]`                  | `id`, `assetId`, `trackId`, `timelineStart`, `sourceIn`, `sourceOut` (seconds), `volume` (0–2), `x`, `y`, `scale` (>0), `opacity` (0–1); optional `fitBackground` (`kind`: `black`/`color`/`image`, `color`, `assetId`, `blur` 0–100), `fitMode` (`fill` default, `fit`, `blur-bg`; video and stills), `reversed`, `speed` (0.1–10, default 1), `keepPitch` (default true). Timeline length = (`sourceOut` − `sourceIn`) / `speed`. |

## Text (schemaVersion 5)

A text clip is an ordinary clip whose asset is an `image` with an extra `text` object: `content` (1–2000
characters, line breaks kept), `fontSize` (8–2000, in canvas pixels), `color` (`#RRGGBB`), optional `bold`,
optional `align` (`left` / `center` default / `right`), and `x`, `y` (centre of the text block as a share of the
canvas, 0–1). The asset's `path` is the picture CutVii drew from those properties: a transparent PNG the size of
the canvas, kept in the app data folder. If that file is gone when the project is opened (another machine, data
folder cleared) it is drawn again and is not reported as missing media. Migration from v4 changes nothing but the
version number.

## Rules enforced on load

- `text` is only allowed on `image` assets, and its values must be inside the limits above.

- Unknown fields are rejected.
- Ids are unique per kind; `clip.trackId` equals its containing track; `clip.assetId` exists.
- `sourceOut > sourceIn`; `sourceOut` does not exceed the asset's `duration` (1 ms tolerance).
- Audio tracks hold audio assets only; video tracks hold video or image assets.

## Known limits

- Asset paths are compared as exact strings (case-sensitive, symlinks not resolved) for the duplicate-import guard.
- The Rust side checks timestamps are non-empty only; the TS side validates ISO format.

## Files on disk

- Extension `.cutvii`, UTF-8 JSON, pretty-printed. Files over 64 MB are refused.
- **Saving** validates first, writes to `<name>.tmp` in the same folder, fsyncs, then renames over the target.
  A failed save never touches the existing file.
- **Opening** parses JSON → runs migrations → deserializes (unknown fields rejected) → validates (Rust), then the
  frontend validates again with Zod. Errors are shown with the offending field paths.
- **Paths** to the webview: Rust owns the project file path; the webview can only trigger the native dialogs, so it
  cannot make the app read or write arbitrary locations.
- **Migrations** live in `src-tauri/src/project/migrate.rs`: one function per schema bump (`MIGRATIONS[n]`: n → n+1).
  Files from a newer schema are rejected with a clear message rather than guessed at.
- **Missing media:** asset paths are absolute and not portable between machines. On open, files that no longer exist
  are flagged (Media panel + dashed clips) and can be relinked; the replacement must be the same media type and at
  least as long as the part of it the clips use. Relinking is undoable.
- Stale `thumbnailPath` entries (cache cleared) are dropped on open; thumbnails are regenerated on re-import only.
