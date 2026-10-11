//! Upgrading older project files to the current schema.
//!
//! `MIGRATIONS[n]` upgrades a document from `schemaVersion` n to n + 1. Version 1 is the first released
//! format; v2 added clip speed. The machinery is also exercised with a synthetic chain in tests.
//! Add one function per schema bump and never edit an existing one.

use serde_json::Value;

use super::model::SCHEMA_VERSION;
use crate::errors::{AppError, AppResult};

pub type Migration = fn(Value) -> Result<Value, String>;

const MIGRATIONS: &[Migration] = &[no_version_zero, v1_to_v2, v2_to_v3, v3_to_v4, v4_to_v5];

fn no_version_zero(_: Value) -> Result<Value, String> {
    Err("schema version 0 never existed".into())
}

/// v2 adds clip speed. Older clips always played at normal speed with their original pitch.
fn v1_to_v2(mut doc: Value) -> Result<Value, String> {
    let tracks = doc
        .get_mut("tracks")
        .and_then(Value::as_array_mut)
        .ok_or("tracks missing")?;
    for track in tracks {
        let clips = track
            .get_mut("clips")
            .and_then(Value::as_array_mut)
            .ok_or("clips missing")?;
        for clip in clips {
            let clip = clip.as_object_mut().ok_or("clip is not an object")?;
            clip.entry("speed").or_insert(Value::from(1));
            clip.entry("keepPitch").or_insert(Value::from(true));
        }
    }
    Ok(doc)
}

/// v5 adds the optional `text` on image assets (text and titles). Older projects have none: nothing changes.
fn v4_to_v5(doc: Value) -> Result<Value, String> {
    Ok(doc)
}

pub fn migrate_to_current(value: Value) -> AppResult<Value> {
    migrate_with(value, SCHEMA_VERSION, MIGRATIONS)
}

pub fn migrate_with(mut value: Value, current: u32, chain: &[Migration]) -> AppResult<Value> {
    let invalid = |m: String| AppError::InvalidInput(m);

    let mut version = value
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .ok_or_else(|| invalid("not a CutVii project (missing schemaVersion)".into()))?
        as u32;

    if version > current {
        return Err(invalid(format!(
            "this project was saved by a newer CutVii (schema version {version}, this app supports up to {current})"
        )));
    }
    while version < current {
        let step = chain
            .get(version as usize)
            .ok_or_else(|| invalid(format!("no migration from schema version {version}")))?;
        value = step(value).map_err(|e| {
            invalid(format!(
                "migrating from schema version {version} failed: {e}"
            ))
        })?;
        version += 1;
        value["schemaVersion"] = Value::from(version);
    }
    Ok(value)
}

/// v3 renames the still-only `fit` to `fitMode`, which now applies to video too and defaults to "fill"
/// for new clips. Existing clips keep exactly the look they had: an explicit choice is carried over
/// (`blur` becomes `blur-bg`), everything else was letterboxed, so it becomes "fit".
fn v2_to_v3(mut doc: Value) -> Result<Value, String> {
    let tracks = doc
        .get_mut("tracks")
        .and_then(Value::as_array_mut)
        .ok_or("tracks missing")?;
    for track in tracks {
        let clips = track
            .get_mut("clips")
            .and_then(Value::as_array_mut)
            .ok_or("clips missing")?;
        for clip in clips {
            let clip = clip.as_object_mut().ok_or("clip is not an object")?;
            let old = clip.remove("fit");
            let mode = match old.as_ref().and_then(Value::as_str) {
                Some("fill") => "fill",
                Some("blur") => "blur-bg",
                _ => "fit",
            };
            clip.entry("fitMode").or_insert(Value::from(mode));
        }
    }
    Ok(doc)
}

/// v4 adds `fitBackground` to clips on video tracks. Until now the bars of a fitted picture used the project
/// background colour, so that is what existing clips keep: black for a black project, the colour otherwise.
fn v3_to_v4(mut doc: Value) -> Result<Value, String> {
    let project_bg = doc
        .get("settings")
        .and_then(|s| s.get("backgroundColor"))
        .and_then(Value::as_str)
        .unwrap_or("#000000")
        .to_string();
    let background = if project_bg.eq_ignore_ascii_case("#000000") {
        serde_json::json!({ "kind": "black" })
    } else {
        serde_json::json!({ "kind": "color", "color": project_bg })
    };
    let tracks = doc
        .get_mut("tracks")
        .and_then(Value::as_array_mut)
        .ok_or("tracks missing")?;
    for track in tracks {
        if track.get("type").and_then(Value::as_str) != Some("video") {
            continue;
        }
        let clips = track
            .get_mut("clips")
            .and_then(Value::as_array_mut)
            .ok_or("clips missing")?;
        for clip in clips {
            let clip = clip.as_object_mut().ok_or("clip is not an object")?;
            clip.entry("fitBackground").or_insert(background.clone());
        }
    }
    Ok(doc)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn v1_to_v2(mut v: Value) -> Result<Value, String> {
        let name = v["name"].take();
        v["title"] = name;
        Ok(v)
    }
    fn v2_to_v3(mut v: Value) -> Result<Value, String> {
        if v["title"].is_null() {
            return Err("title missing".into());
        }
        v["extra"] = json!(true);
        Ok(v)
    }
    // index = from-version; index 0 is unused here
    fn unused(v: Value) -> Result<Value, String> {
        Ok(v)
    }

    #[test]
    fn v1_projects_are_upgraded_all_the_way_and_match_the_current_fixture() {
        let v1: Value =
            serde_json::from_str(include_str!("../../../fixtures/project-v1.json")).unwrap();
        let current: Value =
            serde_json::from_str(include_str!("../../../fixtures/project-v5.json")).unwrap();
        let migrated = migrate_to_current(v1).unwrap();
        assert_eq!(migrated["schemaVersion"], 5);
        assert_eq!(migrated["tracks"][0]["clips"][0]["speed"], 1);
        assert_eq!(migrated["tracks"][0]["clips"][0]["keepPitch"], true);
        assert_eq!(migrated["tracks"][0]["clips"][0]["fitMode"], "fit");
        assert_eq!(migrated, current);

        // an existing value is never overwritten, and broken documents are reported
        let mut odd: Value =
            serde_json::from_str(include_str!("../../../fixtures/project-v1.json")).unwrap();
        odd["tracks"][0]["clips"][0]["speed"] = json!(2);
        assert_eq!(
            migrate_to_current(odd).unwrap()["tracks"][0]["clips"][0]["speed"],
            2
        );
        assert!(
            migrate_to_current(json!({"schemaVersion": 1}))
                .unwrap_err()
                .to_string()
                .contains("tracks missing")
        );
        assert!(migrate_to_current(json!({"schemaVersion": 0, "tracks": []})).is_err());
    }

    #[test]
    fn v2_projects_keep_their_look_when_fit_becomes_fit_mode() {
        let v2: Value =
            serde_json::from_str(include_str!("../../../fixtures/project-v2.json")).unwrap();
        let current: Value =
            serde_json::from_str(include_str!("../../../fixtures/project-v5.json")).unwrap();
        assert_eq!(migrate_to_current(v2.clone()).unwrap(), current);

        // explicit choices are carried over, `blur` is renamed, and the old key is gone
        let mut doc = v2;
        doc["tracks"][0]["clips"][0]["fit"] = json!("fill");
        doc["tracks"][0]["clips"][1]["fit"] = json!("blur");
        let out = migrate_to_current(doc).unwrap();
        let clips = &out["tracks"][0]["clips"];
        assert_eq!(clips[0]["fitMode"], "fill");
        assert_eq!(clips[1]["fitMode"], "blur-bg");
        assert_eq!(out["tracks"][1]["clips"][0]["fitMode"], "fit"); // never chosen: it was letterboxed
        assert!(clips[0].get("fit").is_none() && clips[1].get("fit").is_none());
        // the migrated document is a valid current project
        let project: crate::project::Project = serde_json::from_value(out).unwrap();
        assert!(crate::project::validate(&project).is_ok());
    }

    #[test]
    fn v3_projects_get_a_background_that_keeps_their_bars_the_same_colour() {
        let v3: Value =
            serde_json::from_str(include_str!("../../../fixtures/project-v3.json")).unwrap();
        let v4: Value =
            serde_json::from_str(include_str!("../../../fixtures/project-v5.json")).unwrap();
        assert_eq!(migrate_to_current(v3.clone()).unwrap(), v4);

        // black project -> black; video-track clips only
        let out = migrate_to_current(v3.clone()).unwrap();
        assert_eq!(
            out["tracks"][0]["clips"][0]["fitBackground"],
            json!({"kind": "black"})
        );
        assert!(
            out["tracks"][1]["clips"][0].get("fitBackground").is_none(),
            "audio clips have no picture"
        );

        // a coloured project keeps that colour behind its clips
        let mut coloured = v3;
        coloured["settings"]["backgroundColor"] = json!("#204060");
        let out = migrate_to_current(coloured).unwrap();
        assert_eq!(
            out["tracks"][0]["clips"][1]["fitBackground"],
            json!({"kind": "color", "color": "#204060"})
        );
        let project: crate::project::Project = serde_json::from_value(out).unwrap();
        assert!(crate::project::validate(&project).is_ok());
    }

    #[test]
    fn v4_projects_only_get_the_new_version_number() {
        let v4: Value =
            serde_json::from_str(include_str!("../../../fixtures/project-v4.json")).unwrap();
        let v5: Value =
            serde_json::from_str(include_str!("../../../fixtures/project-v5.json")).unwrap();
        assert_eq!(migrate_to_current(v4).unwrap(), v5);
    }

    #[test]
    fn current_version_passes_through_untouched() {
        let doc = json!({"schemaVersion": 5, "name": "x"});
        assert_eq!(migrate_to_current(doc.clone()).unwrap(), doc);
    }

    #[test]
    fn runs_each_step_in_order_and_stamps_the_version() {
        let out = migrate_with(
            json!({"schemaVersion": 1, "name": "x"}),
            3,
            &[unused, v1_to_v2, v2_to_v3],
        )
        .unwrap();
        assert_eq!(out["schemaVersion"], 3);
        assert_eq!(out["title"], "x");
        assert_eq!(out["extra"], true);
    }

    #[test]
    fn rejects_future_missing_and_unmigratable_documents() {
        let future = migrate_to_current(json!({"schemaVersion": 99}))
            .unwrap_err()
            .to_string();
        assert!(future.contains("newer CutVii"), "{future}");
        assert!(migrate_to_current(json!({"name": "x"})).is_err());
        assert!(migrate_with(json!({"schemaVersion": 1}), 3, &[unused]).is_err()); // chain too short
        let failing = migrate_with(
            json!({"schemaVersion": 1}),
            3,
            &[unused, v1_to_v2, v2_to_v3],
        );
        // v1_to_v2 sets title to null, so v2_to_v3 fails and the error says where
        assert!(failing.unwrap_err().to_string().contains("version 2"));
    }
}
