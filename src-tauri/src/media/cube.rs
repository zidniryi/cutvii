//! Imported colour tables (`.cube` 3D LUT files, section 6p). A `.cube` file comes from somewhere else and
//! is UNTRUSTED: FFmpeg accepts `nan` values in one and then writes garbage, and a file name with an
//! apostrophe breaks its filter argument. So the user's file never reaches FFmpeg. It is parsed and checked
//! here, and CutVii keeps its OWN copy, written by this file under a name it chooses (a hash of the
//! contents). A clip's final table is still baked by `color.rs`: Adjust first, then the imported table,
//! mixed in by its intensity. Preview and export read that one baked table, as they do today.
//!
//! What is accepted: 3D tables of 2 to 65 points per side, `TITLE`, `DOMAIN_MIN` / `DOMAIN_MAX`,
//! `LUT_3D_INPUT_RANGE`, `#` comments, blank lines, CRLF. Refused: 1D tables, a missing size, too few or
//! too many rows, values that are not finite numbers, unknown keywords, files over `MAX_CUBE_BYTES`.
//!
//! Limit: a table larger than `color::LUT_SIZE` loses some detail when it is baked into the clip's table.
//! That loss is the same in the preview and in the export.

use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::errors::{AppError, AppResult};

pub const CUBE_EXTENSION: &str = "cube";
/// A 65-point table is about 8 MB of text; nothing bigger is read.
pub const MAX_CUBE_BYTES: u64 = 16 * 1024 * 1024;
pub const MIN_CUBE_SIZE: usize = 2;
pub const MAX_CUBE_SIZE: usize = 65;
/// How many imported tables are kept.
pub const MAX_CUBES: usize = 200;
pub const MAX_CUBE_FILES: usize = 20;
const MAX_NAME: usize = 40;
/// Table values are colours around 0..1; a little outside is normal, far outside is a broken file.
const VALUE_LIMIT: f32 = 16.0;

/// A checked 3D table: `size^3` colours, red changing fastest, then green, then blue (the `.cube` order).
#[derive(Debug, Clone, PartialEq)]
pub struct Cube {
    pub name: String,
    pub size: usize,
    /// The input colours the table covers, per channel. Almost always 0 and 1.
    pub domain_min: [f32; 3],
    pub domain_max: [f32; 3],
    pub table: Vec<[f32; 3]>,
}

/// One imported table, as the UI lists it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CubeInfo {
    /// Hash of the contents: the same table imported twice is one table.
    pub id: String,
    pub name: String,
    pub size: usize,
}

fn bad(message: impl Into<String>) -> AppError {
    AppError::InvalidInput(message.into())
}

/// A name for people: plain text, one line, no control characters, at most `MAX_NAME` characters.
pub fn plain_name(raw: &str) -> String {
    let clean: String = raw
        .chars()
        .filter(|c| !c.is_control() && *c != '"')
        .collect();
    let name: String = clean.trim().chars().take(MAX_NAME).collect();
    if name.trim().is_empty() {
        "Imported LUT".into()
    } else {
        name.trim().to_string()
    }
}

fn three(parts: &[&str], line: usize) -> AppResult<[f32; 3]> {
    if parts.len() != 3 {
        return Err(bad(format!("line {line}: expected three numbers")));
    }
    let mut out = [0f32; 3];
    for (slot, text) in out.iter_mut().zip(parts) {
        // `parse` would accept "nan" and "inf": those are refused right after
        let v: f32 = text
            .parse()
            .map_err(|_| bad(format!("line {line}: \"{text}\" is not a number")))?;
        if !v.is_finite() || v.abs() > VALUE_LIMIT {
            return Err(bad(format!("line {line}: a value is out of range")));
        }
        *slot = v;
    }
    Ok(out)
}

/// Read the text of a `.cube` file. `fallback_name` is used when the file has no `TITLE`.
pub fn parse_cube(text: &str, fallback_name: &str) -> AppResult<Cube> {
    let mut title: Option<String> = None;
    let mut size: Option<usize> = None;
    let mut domain_min = [0f32; 3];
    let mut domain_max = [1f32; 3];
    let mut table: Vec<[f32; 3]> = Vec::new();
    let mut expected = 0usize;

    for (index, raw) in text.lines().enumerate() {
        let line = index + 1;
        let row = raw.trim().trim_start_matches('\u{feff}');
        if row.is_empty() || row.starts_with('#') {
            continue;
        }
        let first = row.chars().next().unwrap_or(' ');
        if first.is_ascii_alphabetic() {
            let (keyword, rest) = row.split_once(char::is_whitespace).unwrap_or((row, ""));
            let parts: Vec<&str> = rest.split_whitespace().collect();
            match keyword {
                "TITLE" => title = Some(plain_name(rest.trim().trim_matches('"'))),
                "LUT_3D_SIZE" => {
                    if size.is_some() || !table.is_empty() {
                        return Err(bad(format!("line {line}: the size is given twice")));
                    }
                    let n: usize = parts
                        .first()
                        .filter(|_| parts.len() == 1)
                        .and_then(|p| p.parse().ok())
                        .ok_or_else(|| {
                            bad(format!("line {line}: the table size is not a number"))
                        })?;
                    if !(MIN_CUBE_SIZE..=MAX_CUBE_SIZE).contains(&n) {
                        return Err(bad(format!(
                            "a table of {n} points per side is not supported ({MIN_CUBE_SIZE} to {MAX_CUBE_SIZE})"
                        )));
                    }
                    size = Some(n);
                    expected = n * n * n;
                    table.reserve_exact(expected);
                }
                "LUT_1D_SIZE" | "LUT_1D_INPUT_RANGE" => {
                    return Err(bad("this is a 1D table; only 3D LUT files can be used"));
                }
                "DOMAIN_MIN" => domain_min = three(&parts, line)?,
                "DOMAIN_MAX" => domain_max = three(&parts, line)?,
                "LUT_3D_INPUT_RANGE" => {
                    if parts.len() != 2 {
                        return Err(bad(format!("line {line}: expected two numbers")));
                    }
                    let range = three(&[parts[0], parts[1], "0"], line)?;
                    domain_min = [range[0]; 3];
                    domain_max = [range[1]; 3];
                }
                _ => return Err(bad(format!("line {line}: this is not a .cube LUT file"))),
            }
            if !table.is_empty() {
                return Err(bad(format!(
                    "line {line}: a keyword after the table started"
                )));
            }
            continue;
        }
        if size.is_none() {
            return Err(bad("the file does not say how large its table is"));
        }
        if table.len() == expected {
            return Err(bad("the file has more rows than its size says"));
        }
        let parts: Vec<&str> = row.split_whitespace().collect();
        table.push(three(&parts, line)?);
    }

    let size = size.ok_or_else(|| bad("this is not a .cube LUT file"))?;
    if table.len() != expected {
        return Err(bad(format!(
            "the file is cut short: {} of {expected} rows",
            table.len()
        )));
    }
    if (0..3).any(|k| domain_max[k] - domain_min[k] < 1e-6) {
        return Err(bad("the file's input range is empty"));
    }
    Ok(Cube {
        name: title.unwrap_or_else(|| plain_name(fallback_name)),
        size,
        domain_min,
        domain_max,
        table,
    })
}

/// Read and check a `.cube` file the user picked.
pub fn read_cube(path: &Path) -> AppResult<Cube> {
    if fs::metadata(path)?.len() > MAX_CUBE_BYTES {
        return Err(bad("the file is too large to be a LUT"));
    }
    let text =
        String::from_utf8(fs::read(path)?).map_err(|_| bad("this is not a .cube LUT file"))?;
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    parse_cube(&text, &stem)
}

impl Cube {
    /// The table as CutVii writes it: the same text for the same table, whatever the file it came from
    /// looked like (comments, spacing and line ends are gone).
    pub fn text(&self) -> String {
        let mut out = String::with_capacity(self.table.len() * 28 + 128);
        let three = |v: [f32; 3]| format!("{:.6} {:.6} {:.6}", v[0], v[1], v[2]);
        writeln!(out, "TITLE \"{}\"", plain_name(&self.name)).ok();
        writeln!(out, "LUT_3D_SIZE {}", self.size).ok();
        writeln!(out, "DOMAIN_MIN {}", three(self.domain_min)).ok();
        writeln!(out, "DOMAIN_MAX {}", three(self.domain_max)).ok();
        for c in &self.table {
            writeln!(out, "{}", three(*c)).ok();
        }
        out
    }

    /// Hash of the table itself (not of its name): the id it is stored and referred to by.
    pub fn id(&self) -> String {
        let mut hasher = Sha256::new();
        hasher.update((self.size as u32).to_le_bytes());
        for v in self
            .domain_min
            .iter()
            .chain(&self.domain_max)
            .chain(self.table.iter().flatten())
        {
            hasher.update(v.to_le_bytes());
        }
        hasher
            .finalize()
            .iter()
            .take(12)
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    /// The colour the table gives for `rgb` (0..1 each), by tetrahedral interpolation: the method FFmpeg's
    /// `lut3d` uses by default, so a table looks here as it would there. Inputs outside the table's range
    /// take the nearest edge.
    pub fn sample(&self, rgb: [f64; 3]) -> [f64; 3] {
        let last = (self.size - 1) as f64;
        let mut cell = [0usize; 3];
        let mut frac = [0f64; 3];
        for k in 0..3 {
            let (lo, hi) = (self.domain_min[k] as f64, self.domain_max[k] as f64);
            let p = ((rgb[k] - lo) / (hi - lo)).clamp(0.0, 1.0) * last;
            cell[k] = (p.floor() as usize).min(self.size - 2);
            frac[k] = p - cell[k] as f64;
        }
        let at = |dr: usize, dg: usize, db: usize| {
            self.table[((cell[2] + db) * self.size + (cell[1] + dg)) * self.size + (cell[0] + dr)]
        };
        let [r, g, b] = frac;
        let (w, a1, a2) = if r > g {
            if g > b {
                ([1.0 - r, r - g, g - b, b], at(1, 0, 0), at(1, 1, 0))
            } else if r > b {
                ([1.0 - r, r - b, b - g, g], at(1, 0, 0), at(1, 0, 1))
            } else {
                ([1.0 - b, b - r, r - g, g], at(0, 0, 1), at(1, 0, 1))
            }
        } else if b > g {
            ([1.0 - b, b - g, g - r, r], at(0, 0, 1), at(0, 1, 1))
        } else if b > r {
            ([1.0 - g, g - b, b - r, r], at(0, 1, 0), at(0, 1, 1))
        } else {
            ([1.0 - g, g - r, r - b, b], at(0, 1, 0), at(1, 1, 0))
        };
        let (c000, c111) = (at(0, 0, 0), at(1, 1, 1));
        let mut out = [0f64; 3];
        for k in 0..3 {
            out[k] = w[0] * c000[k] as f64
                + w[1] * a1[k] as f64
                + w[2] * a2[k] as f64
                + w[3] * c111[k] as f64;
        }
        out
    }
}

/// Whether `id` could be one of ours: nothing but the hex digits `Cube::id` writes. Checked before an id
/// from a project file or the webview is ever joined to a folder.
pub fn is_cube_id(id: &str) -> bool {
    id.len() == 24 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub fn cube_path(dir: &Path, id: &str) -> AppResult<PathBuf> {
    if !is_cube_id(id) {
        return Err(bad("unknown LUT"));
    }
    Ok(dir.join(format!("{id}.{CUBE_EXTENSION}")))
}

/// Keep CutVii's own copy of `cube` in `dir` and say how it is listed. Storing the same table again
/// changes nothing but its name.
pub fn store_cube(dir: &Path, cube: &Cube) -> AppResult<CubeInfo> {
    let id = cube.id();
    let out = cube_path(dir, &id)?;
    if !out.is_file() && list_cubes(dir).len() >= MAX_CUBES {
        return Err(bad(format!(
            "there are already {MAX_CUBES} LUTs; remove one first"
        )));
    }
    fs::create_dir_all(dir)?;
    let tmp = out.with_extension(format!("part-{}", std::process::id()));
    if let Err(e) = fs::write(&tmp, cube.text()) {
        fs::remove_file(&tmp).ok();
        return Err(e.into());
    }
    fs::rename(&tmp, &out)?;
    Ok(CubeInfo {
        id,
        name: plain_name(&cube.name),
        size: cube.size,
    })
}

/// Load one of CutVii's own copies. It is checked again like any other file: the folder could have been
/// touched from outside, and a copy that no longer matches its id is refused.
pub fn load_cube(dir: &Path, id: &str) -> AppResult<Cube> {
    let path = cube_path(dir, id)?;
    if !path.is_file() {
        return Err(bad("that LUT is not on this computer; import it again"));
    }
    let cube = read_cube(&path)?;
    if cube.id() != id {
        return Err(bad("that LUT file was changed; import it again"));
    }
    Ok(cube)
}

/// The imported tables, by name. A copy that cannot be read is left out.
pub fn list_cubes(dir: &Path) -> Vec<CubeInfo> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found: Vec<CubeInfo> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let id = path.file_stem()?.to_str()?.to_string();
            if path.extension()?.to_str()? != CUBE_EXTENSION || !is_cube_id(&id) {
                return None;
            }
            let cube = load_cube(dir, &id).ok()?;
            Some(CubeInfo {
                id,
                name: cube.name,
                size: cube.size,
            })
        })
        .collect();
    found.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then(a.id.cmp(&b.id))
    });
    found
}

/// Forget an imported table. Clips that use it keep their setting and say the LUT is missing.
pub fn delete_cube(dir: &Path, id: &str) -> AppResult<()> {
    let path = cube_path(dir, id)?;
    if path.is_file() {
        fs::remove_file(path)?;
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn temp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("cutvii-cube-{tag}-{}", std::process::id()));
        fs::remove_dir_all(&d).ok();
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// A table of `size` points per side that maps every colour through `f`.
    pub(crate) fn cube_of(size: usize, f: impl Fn([f32; 3]) -> [f32; 3]) -> Cube {
        let last = (size - 1) as f32;
        let mut table = Vec::new();
        for b in 0..size {
            for g in 0..size {
                for r in 0..size {
                    table.push(f([r as f32 / last, g as f32 / last, b as f32 / last]));
                }
            }
        }
        Cube {
            name: "Test".into(),
            size,
            domain_min: [0.0; 3],
            domain_max: [1.0; 3],
            table,
        }
    }

    const TWO: &str = "0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n";

    #[test]
    fn a_normal_file_loads_with_its_title_comments_and_windows_line_ends() {
        let text = format!(
            "\u{feff}# made elsewhere\r\nTITLE \"Warm  film\"\r\n\r\nLUT_3D_SIZE 2\r\nDOMAIN_MIN 0 0 0\r\nDOMAIN_MAX 1.0 1.0 1.0\r\n{}",
            TWO.replace('\n', "\r\n")
        );
        let cube = parse_cube(&text, "file name").unwrap();
        assert_eq!((cube.name.as_str(), cube.size), ("Warm  film", 2));
        assert_eq!(cube.table.len(), 8);
        assert_eq!(cube.table[1], [1.0, 0.0, 0.0]); // red changes fastest

        // no title: the file's name, cleaned
        let untitled = parse_cube(&format!("LUT_3D_SIZE 2\n{TWO}"), "  my\u{7}\"look\"\n").unwrap();
        assert_eq!(untitled.name, "mylook");
        assert_eq!(
            parse_cube(&format!("LUT_3D_SIZE 2\n{TWO}"), "")
                .unwrap()
                .name,
            "Imported LUT"
        );
        assert_eq!(plain_name(&"x".repeat(90)).chars().count(), MAX_NAME);

        let ranged = parse_cube(
            &format!("LUT_3D_SIZE 2\nLUT_3D_INPUT_RANGE 0 2\n{TWO}"),
            "r",
        )
        .unwrap();
        assert_eq!(ranged.domain_max, [2.0; 3]);
    }

    #[test]
    fn broken_and_hostile_files_are_refused() {
        let with = |body: &str| parse_cube(body, "x").unwrap_err().to_string();
        assert!(with("").contains("not a .cube"));
        assert!(with("hello world").contains("not a .cube"));
        assert!(with(TWO).contains("how large"));
        assert!(with("LUT_1D_SIZE 2\n0 0 0\n1 1 1\n").contains("1D"));
        assert!(with("LUT_3D_SIZE 100000\n").contains("not supported"));
        assert!(with("LUT_3D_SIZE 1\n0 0 0\n").contains("not supported"));
        assert!(with("LUT_3D_SIZE 66\n").contains("not supported"));
        assert!(with("LUT_3D_SIZE two\n").contains("not a number"));
        assert!(with("LUT_3D_SIZE 2\nLUT_3D_SIZE 2\n").contains("twice"));
        // cut short, and too long
        assert!(with("LUT_3D_SIZE 2\n0 0 0\n1 0 0\n").contains("cut short: 2 of 8"));
        assert!(with(&format!("LUT_3D_SIZE 2\n{TWO}0 0 0\n")).contains("more rows"));
        // the values FFmpeg would take and turn into garbage
        for value in ["nan", "NaN", "inf", "-inf", "1e30", "abc", "0x10"] {
            let body = format!(
                "LUT_3D_SIZE 2\n{}",
                TWO.replacen("1 1 1", &format!("1 {value} 1"), 1)
            );
            let message = with(&body);
            assert!(
                message.contains("not a number") || message.contains("out of range"),
                "{value}: {message}"
            );
        }
        assert!(with("LUT_3D_SIZE 2\n0 0\n").contains("three numbers"));
        assert!(with("LUT_3D_SIZE 2\n0 0 0 0\n").contains("three numbers"));
        assert!(
            with(&format!("LUT_3D_SIZE 2\n0 0 0\nTITLE \"late\"\n{TWO}"))
                .contains("after the table")
        );
        assert!(
            with(&format!("LUT_3D_SIZE 2\nDOMAIN_MAX 0 0 0\n{TWO}")).contains("range is empty")
        );
        assert!(with(&format!("LUT_3D_SIZE 2\nDOMAIN_MIN nan 0 0\n{TWO}")).contains("line 2"));
    }

    #[test]
    fn files_that_are_too_large_or_not_text_are_refused_before_parsing() {
        let dir = temp("files");
        let big = dir.join("big.cube");
        fs::File::create(&big)
            .unwrap()
            .set_len(MAX_CUBE_BYTES + 1)
            .unwrap();
        assert!(
            read_cube(&big)
                .unwrap_err()
                .to_string()
                .contains("too large")
        );
        let binary = dir.join("binary.cube");
        fs::write(&binary, [0xff, 0xfe, 0x00, 0x80]).unwrap();
        assert!(
            read_cube(&binary)
                .unwrap_err()
                .to_string()
                .contains("not a .cube")
        );
        assert!(read_cube(&dir.join("missing.cube")).is_err());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn an_identity_table_returns_what_it_is_given_and_a_table_does_what_it_holds() {
        let same = cube_of(17, |c| c);
        for rgb in [
            [0.0, 0.0, 0.0],
            [1.0, 1.0, 1.0],
            [0.2, 0.7, 0.4],
            [0.9, 0.1, 0.55],
        ] {
            let out = same.sample(rgb);
            for k in 0..3 {
                assert!((out[k] - rgb[k]).abs() < 1e-6, "{rgb:?} -> {out:?}");
            }
        }
        // outside the range: the nearest edge, never a panic
        assert_eq!(same.sample([-3.0, 0.5, 9.0]), same.sample([0.0, 0.5, 1.0]));

        let swapped = cube_of(9, |c| [c[2], c[1], c[0]]);
        let out = swapped.sample([0.8, 0.3, 0.1]);
        assert!((out[0] - 0.1).abs() < 1e-6 && (out[2] - 0.8).abs() < 1e-6);

        // a table that covers 0..2 is read at half the position
        let mut wide = cube_of(9, |c| c);
        wide.domain_max = [2.0; 3];
        assert!((wide.sample([1.0, 1.0, 1.0])[0] - 0.5).abs() < 1e-6);
    }

    #[test]
    fn our_copy_has_our_name_round_trips_and_is_checked_again() {
        let dir = temp("store");
        // a title nobody should ever put in a filter argument
        let mut cube = cube_of(3, |c| [c[0] * 0.5, c[1], c[2]]);
        cube.name = "it's: a 'look'\n".into();
        let info = store_cube(&dir, &cube).unwrap();
        assert!(is_cube_id(&info.id));
        assert_eq!(info.name, "it's: a 'look'");
        let files: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(files, [format!("{}.cube", info.id)]);

        let back = load_cube(&dir, &info.id).unwrap();
        assert_eq!(back.table, cube.table);
        assert_eq!(back.id(), info.id);
        // the same table under another name is the same table
        cube.name = "Renamed".into();
        assert_eq!(store_cube(&dir, &cube).unwrap().id, info.id);
        assert_eq!(
            list_cubes(&dir),
            [CubeInfo {
                name: "Renamed".into(),
                ..info.clone()
            }]
        );

        // ids are only ever hex: nothing that walks out of the folder
        for id in ["../../etc/passwd", "", "ABCDEF0123456789abcdef01", "0123"] {
            assert!(
                load_cube(&dir, id).is_err() && delete_cube(&dir, id).is_err(),
                "{id}"
            );
        }
        // a copy changed behind our back is refused and not listed
        let path = cube_path(&dir, &info.id).unwrap();
        let changed = fs::read_to_string(&path)
            .unwrap()
            .replacen("0.500000", "0.900000", 1);
        fs::write(&path, changed).unwrap();
        assert!(
            load_cube(&dir, &info.id)
                .unwrap_err()
                .to_string()
                .contains("changed")
        );
        assert!(list_cubes(&dir).is_empty());

        delete_cube(&dir, &info.id).unwrap();
        assert!(
            load_cube(&dir, &info.id)
                .unwrap_err()
                .to_string()
                .contains("import it again")
        );
        delete_cube(&dir, &info.id).unwrap(); // already gone: fine
        fs::remove_dir_all(dir).ok();
    }
}
