//! Style packs: the user's own text styles, colour presets and export presets in ONE `.cutvii-pack` file,
//! to share with someone else. Local only: a pack is a file, nothing is uploaded or fetched.
//!
//! A pack is UNTRUSTED input. Reading one: the size is capped before reading, the top level must be exactly
//! a pack of our format, every list has a cap, and every item is checked with the same rules as the single
//! files (`text::checked_style_file`, `ColorAdjust::is_valid`) or, for export presets, the ranges below.
//! An item that fails is left out and named in `problems`; the rest still load. Nothing in a pack is a
//! path, nothing is run, no font data travels (a style names its font, no more).

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::color::ColorAdjust;
use super::text::checked_style_file;
use crate::errors::{AppError, AppResult};

pub const PACK_EXTENSION: &str = "cutvii-pack";
pub const PACK_FORMAT: &str = "cutvii-pack";
pub const PACK_VERSION: u32 = 1;
/// A pack larger than this is not read.
pub const MAX_PACK_BYTES: u64 = 5 * 1024 * 1024;
/// Most items of one kind in a pack.
pub const MAX_PACK_ITEMS: usize = 200;
pub const MAX_PACK_NAME: usize = 60;
pub const MAX_PACK_NOTES: usize = 2000;
const MAX_ITEM_NAME: usize = 40;
const MAX_ITEM_ID: usize = 80;

/// The file as written. Lists are kept as JSON and checked item by item.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackFile {
    pub format: String,
    pub version: u32,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default)]
    pub text_styles: Vec<Value>,
    #[serde(default)]
    pub color_presets: Vec<Value>,
    #[serde(default)]
    pub export_presets: Vec<Value>,
}

/// A pack after checking: only items that passed, plus what was left out and why.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckedPack {
    pub name: String,
    pub author: Option<String>,
    pub notes: Option<String>,
    pub text_styles: Vec<Value>,
    pub color_presets: Vec<Value>,
    pub export_presets: Vec<Value>,
    pub problems: Vec<String>,
}

fn plain(text: &str, max: usize) -> Option<String> {
    // plain text only: control characters (other than a line break in notes) are dropped
    let cleaned: String = text
        .chars()
        .filter(|c| !c.is_control() || *c == '\n')
        .take(max)
        .collect();
    let trimmed = cleaned.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn item_id(v: &Value) -> Option<String> {
    let id = v.get("id")?.as_str()?.trim();
    (!id.is_empty() && id.chars().count() <= MAX_ITEM_ID && !id.chars().any(char::is_control))
        .then(|| id.to_string())
}

fn item_name(v: &Value) -> Option<String> {
    let name = v.get("name")?.as_str()?.trim();
    (!name.is_empty()
        && name.chars().count() <= MAX_ITEM_NAME
        && !name.chars().any(char::is_control))
    .then(|| name.to_string())
}

fn only_keys(v: &Value, allowed: &[&str]) -> bool {
    v.as_object()
        .is_some_and(|o| o.keys().all(|k| allowed.contains(&k.as_str())))
}

fn check_text_style(v: &Value) -> Result<Value, String> {
    if !only_keys(v, &["id", "name", "style", "fade"]) {
        return Err("has parts CutVii does not know".into());
    }
    let (id, name) = (
        item_id(v).ok_or("has no id")?,
        item_name(v).ok_or("has no usable name")?,
    );
    let style = v.get("style").ok_or("has no style")?;
    let fade = match v.get("fade") {
        None | Some(Value::Null) => None,
        Some(f) => Some(f.as_f64().ok_or("has a fade that is not a number")?),
    };
    let checked = checked_style_file(&name, style, fade).map_err(|e| e.to_string())?;
    let mut out = json!({ "id": id, "name": checked.name, "style": checked.style });
    if let Some(f) = checked.fade {
        out["fade"] = json!(f);
    }
    Ok(out)
}

fn check_color_preset(v: &Value) -> Result<Value, String> {
    if !only_keys(v, &["id", "name", "kind", "adjust"]) {
        return Err("has parts CutVii does not know".into());
    }
    let (id, name) = (
        item_id(v).ok_or("has no id")?,
        item_name(v).ok_or("has no usable name")?,
    );
    match v.get("kind").and_then(Value::as_str) {
        Some("adjust") => {}
        Some("lut") => return Err("is a LUT look: share its .cube file separately".into()),
        _ => return Err("is of a kind CutVii does not know".into()),
    }
    let adjust: ColorAdjust =
        serde_json::from_value(v.get("adjust").cloned().unwrap_or(Value::Null))
            .map_err(|_| "has colour values CutVii cannot read")?;
    if !adjust.is_valid() || adjust.is_identity() {
        return Err("has colour values out of range, or changes nothing".into());
    }
    Ok(json!({ "id": id, "name": name, "kind": "adjust", "adjust": adjust }))
}

fn check_export_preset(v: &Value) -> Result<Value, String> {
    if !only_keys(v, &["id", "name", "options"]) {
        return Err("has parts CutVii does not know".into());
    }
    let (id, name) = (
        item_id(v).ok_or("has no id")?,
        item_name(v).ok_or("has no usable name")?,
    );
    let o = v.get("options").ok_or("has no settings")?;
    if !only_keys(o, &["width", "height", "fps", "quality", "format"]) {
        return Err("has settings CutVii does not know".into());
    }
    let side = |key: &str| -> Result<u64, String> {
        let n = o
            .get(key)
            .and_then(Value::as_u64)
            .ok_or(format!("has no whole-number {key}"))?;
        if !(16..=8192).contains(&n) || n % 2 != 0 {
            return Err(format!(
                "has a {key} that is not an even number from 16 to 8192"
            ));
        }
        Ok(n)
    };
    let (width, height) = (side("width")?, side("height")?);
    let fps = o
        .get("fps")
        .and_then(Value::as_f64)
        .ok_or("has no frame rate")?;
    if !(fps.is_finite() && (1.0..=120.0).contains(&fps)) {
        return Err("has a frame rate outside 1 to 120".into());
    }
    let quality = o.get("quality").and_then(Value::as_str).unwrap_or("");
    if !["draft", "standard", "high"].contains(&quality) {
        return Err("has a quality CutVii does not know".into());
    }
    let format = o.get("format").and_then(Value::as_str).unwrap_or("");
    if !["mp4", "m4a", "mp3", "wav"].contains(&format) {
        return Err("asks for a format CutVii cannot write".into());
    }
    Ok(json!({ "id": id, "name": name,
        "options": { "width": width, "height": height, "fps": fps, "quality": quality, "format": format } }))
}

fn check_list(
    items: &[Value],
    what: &str,
    check: fn(&Value) -> Result<Value, String>,
    problems: &mut Vec<String>,
) -> Vec<Value> {
    let mut out = Vec::new();
    for (i, item) in items.iter().enumerate() {
        match check(item) {
            Ok(v) => out.push(v),
            Err(why) => {
                // the name is shown as plain text and only when it is short and tame
                let label = item_name(item).unwrap_or_else(|| format!("#{}", i + 1));
                problems.push(format!("{what} \u{201c}{label}\u{201d} {why}"));
            }
        }
    }
    out
}

/// Check a pack that was parsed from JSON: the envelope strictly, the items one by one.
pub fn check_pack(file: &PackFile) -> AppResult<CheckedPack> {
    let bad = |m: &str| AppError::InvalidInput(m.to_string());
    if file.format != PACK_FORMAT {
        return Err(bad("this is not a CutVii style pack"));
    }
    if file.version != PACK_VERSION {
        return Err(bad("this pack was made by a newer CutVii"));
    }
    let name = plain(&file.name, MAX_PACK_NAME).ok_or_else(|| bad("the pack has no name"))?;
    if name.contains('\n') {
        return Err(bad("the pack has no usable name"));
    }
    for (list, what) in [
        (&file.text_styles, "text styles"),
        (&file.color_presets, "colour presets"),
        (&file.export_presets, "export presets"),
    ] {
        if list.len() > MAX_PACK_ITEMS {
            return Err(AppError::InvalidInput(format!(
                "the pack has too many {what} ({MAX_PACK_ITEMS} at most)"
            )));
        }
    }
    let mut problems = Vec::new();
    let text_styles = check_list(
        &file.text_styles,
        "Text style",
        check_text_style,
        &mut problems,
    );
    let color_presets = check_list(
        &file.color_presets,
        "Colour preset",
        check_color_preset,
        &mut problems,
    );
    let export_presets = check_list(
        &file.export_presets,
        "Export preset",
        check_export_preset,
        &mut problems,
    );
    Ok(CheckedPack {
        name,
        author: file
            .author
            .as_deref()
            .and_then(|a| plain(a, MAX_PACK_NAME))
            .map(|a| a.replace('\n', " ")),
        notes: file.notes.as_deref().and_then(|n| plain(n, MAX_PACK_NOTES)),
        text_styles,
        color_presets,
        export_presets,
        problems,
    })
}

/// Read and check a `.cutvii-pack` file.
pub fn read_pack(path: &Path) -> AppResult<CheckedPack> {
    let bad = |m: &str| AppError::InvalidInput(m.to_string());
    if fs::metadata(path)?.len() > MAX_PACK_BYTES {
        return Err(bad(
            "the file is too large to be a style pack (5 MB at most)",
        ));
    }
    let text =
        String::from_utf8(fs::read(path)?).map_err(|_| bad("this is not a CutVii style pack"))?;
    let file: PackFile =
        serde_json::from_str(&text).map_err(|_| bad("this is not a CutVii style pack"))?;
    check_pack(&file)
}

/// The text of a pack file for what the UI wants to export, after the same checks as reading one. A pack
/// in which any item fails is not written at all (our own items should always pass).
pub fn pack_text(file: &PackFile) -> AppResult<String> {
    let checked = check_pack(file)?;
    if let Some(first) = checked.problems.first() {
        return Err(AppError::InvalidInput(format!("cannot export: {first}")));
    }
    if checked.text_styles.is_empty()
        && checked.color_presets.is_empty()
        && checked.export_presets.is_empty()
    {
        return Err(AppError::InvalidInput(
            "choose at least one item to export".into(),
        ));
    }
    serde_json::to_string_pretty(&PackFile {
        format: PACK_FORMAT.into(),
        version: PACK_VERSION,
        name: checked.name,
        author: checked.author,
        notes: checked.notes,
        text_styles: checked.text_styles,
        color_presets: checked.color_presets,
        export_presets: checked.export_presets,
    })
    .map_err(|e| AppError::InvalidInput(format!("pack file: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pack() -> PackFile {
        serde_json::from_value(json!({
            "format": "cutvii-pack", "version": 1, "name": "  My pack ", "author": "Me", "notes": "Line one\nLine two",
            "textStyles": [
                {"id": "my-1", "name": "Yellow", "style": {"color": "#FFE14A", "bold": true, "font": "A Rare Font"}, "fade": 0.3}
            ],
            "colorPresets": [
                {"id": "my-2", "name": "Evening", "kind": "adjust", "adjust": {"exposure": 0.2, "contrast": 0.0,
                 "saturation": 0.0, "vibrance": 0.0, "temperature": 0.3, "tint": 0.0, "highlights": 0.0, "shadows": 0.0}}
            ],
            "exportPresets": [
                {"id": "my-3", "name": "Reel", "options": {"width": 1080, "height": 1920, "fps": 30, "quality": "high", "format": "mp4"}}
            ]
        }))
        .unwrap()
    }

    #[test]
    fn a_pack_round_trips_with_identical_items_and_holds_no_font_data_or_paths() {
        let text = pack_text(&pack()).unwrap();
        assert!(text.contains("\"format\": \"cutvii-pack\""));
        assert!(text.len() < 2000, "names and numbers only");
        // no file paths (the only backslash is JSON's own escape of the line break in the notes)
        assert!(!text.contains('/') && !text.contains(":\\"), "no paths");
        let dir = std::env::temp_dir().join(format!("cutvii-pack-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("my.cutvii-pack");
        fs::write(&path, &text).unwrap();
        let read = read_pack(&path).unwrap();
        let original = check_pack(&pack()).unwrap();
        assert_eq!(read, original);
        assert_eq!(read.name, "My pack");
        assert_eq!(read.notes.as_deref(), Some("Line one\nLine two"));
        assert!(read.problems.is_empty());
        assert_eq!(read.text_styles[0]["style"]["font"], "A Rare Font");
        assert_eq!(read.export_presets[0]["options"]["height"], 1920);
        // written again from what was read: the same file
        let again: PackFile = serde_json::from_str(&text).unwrap();
        assert_eq!(pack_text(&again).unwrap(), text);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn broken_files_are_rejected_whole() {
        let dir = std::env::temp_dir().join(format!("cutvii-pack-bad-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let text = pack_text(&pack()).unwrap();
        let refuse = |name: &str, body: &[u8], says: &str| {
            let p = dir.join(name);
            fs::write(&p, body).unwrap();
            let e = read_pack(&p).unwrap_err().to_string();
            assert!(e.contains(says), "{name}: {e}");
        };
        refuse("garbage", b"\x00\xff\x01", "not a CutVii style pack");
        refuse("not-json", b"{ nope", "not a CutVii style pack");
        refuse(
            "other",
            br#"{"cutviiPreset": 1, "name": "x"}"#,
            "not a CutVii style pack",
        );
        refuse(
            "wrong-format",
            text.replace("\"cutvii-pack\"", "\"other-pack\"").as_bytes(),
            "not a CutVii style pack",
        );
        refuse(
            "newer",
            text.replace("\"version\": 1", "\"version\": 7").as_bytes(),
            "newer",
        );
        refuse(
            "extra",
            text.replace("\"version\"", "\"run\": \"rm -rf ~\", \"version\"")
                .as_bytes(),
            "not a CutVii style pack",
        );
        refuse(
            "noname",
            text.replace("My pack", "  ").as_bytes(),
            "no name",
        );
        refuse("big", &vec![b' '; MAX_PACK_BYTES as usize + 1], "too large");
        let mut many = pack();
        many.export_presets = vec![many.export_presets[0].clone(); MAX_PACK_ITEMS + 1];
        let e = check_pack(&many).unwrap_err().to_string();
        assert!(e.contains("too many export presets"), "{e}");
        assert!(read_pack(&dir.join("missing")).is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn one_bad_item_is_skipped_with_a_reason_and_the_good_ones_load() {
        let mut p = pack();
        let good_export = p.export_presets[0].clone();
        let with = |change: Value| {
            let mut v = good_export.clone();
            for (k, val) in change.as_object().unwrap() {
                v["options"][k] = val.clone();
            }
            v
        };
        p.export_presets = vec![
            good_export.clone(),
            with(json!({"width": 1081})),
            with(json!({"height": 9000})),
            with(json!({"width": 8})),
            with(json!({"fps": 500})),
            with(json!({"fps": 0})),
            with(json!({"format": "exe"})),
            with(json!({"quality": "ultra"})),
            with(json!({"output": "/etc/passwd"})),
        ];
        p.text_styles
            .push(json!({"id": "x", "name": "Bad colour", "style": {"color": "yellow"}}));
        p.text_styles
            .push(json!({"id": "y", "name": "Script", "style": {"color": "#FFFFFF"}, "run": "x"}));
        p.color_presets
            .push(json!({"id": "l", "name": "Film LUT", "kind": "lut", "file": "/tmp/a.cube"}));
        p.color_presets
            .push(json!({"id": "m", "name": "Kind LUT", "kind": "lut"}));
        p.color_presets.push(json!({"id": "w", "name": "Wild", "kind": "adjust", "adjust": {"exposure": 9.0,
            "contrast": 0.0, "saturation": 0.0, "vibrance": 0.0, "temperature": 0.0, "tint": 0.0, "highlights": 0.0, "shadows": 0.0}}));
        let checked = check_pack(&p).unwrap();
        assert_eq!(
            checked.export_presets,
            vec![check_export_preset(&good_export).unwrap()]
        );
        assert_eq!(checked.text_styles.len(), 1);
        assert_eq!(checked.color_presets.len(), 1);
        assert_eq!(checked.problems.len(), 8 + 2 + 3);
        let all = checked.problems.join("\n");
        assert!(all.contains("even number from 16 to 8192"));
        assert!(all.contains("frame rate outside 1 to 120"));
        assert!(all.contains("format CutVii cannot write"));
        assert!(
            all.contains("\u{201c}Kind LUT\u{201d} is a LUT look: share its .cube file separately")
        );
        assert!(all.contains("\u{201c}Bad colour\u{201d}"));
        // exporting refuses a pack with a bad item, and an empty one
        assert!(
            pack_text(&p)
                .unwrap_err()
                .to_string()
                .contains("cannot export")
        );
        let mut empty = pack();
        empty.text_styles.clear();
        empty.color_presets.clear();
        empty.export_presets.clear();
        assert!(
            pack_text(&empty)
                .unwrap_err()
                .to_string()
                .contains("at least one item")
        );
    }

    #[test]
    fn names_and_notes_are_plain_text_within_limits() {
        let mut p = pack();
        p.name = format!("Pack\u{7}{}", "x".repeat(200));
        p.notes = Some(format!(
            "<script>alert(1)</script>\u{0}\n{}",
            "n".repeat(5000)
        ));
        p.author = Some("A\nB".into());
        let c = check_pack(&p).unwrap();
        assert_eq!(c.name.chars().count(), MAX_PACK_NAME);
        assert!(!c.name.contains('\u{7}'));
        // markup is not interpreted anywhere: it stays the text it is, minus control characters
        assert!(
            c.notes
                .as_deref()
                .unwrap()
                .starts_with("<script>alert(1)</script>\n")
        );
        assert_eq!(c.notes.unwrap().chars().count(), MAX_PACK_NOTES);
        assert_eq!(c.author.as_deref(), Some("A B"));
    }
}
