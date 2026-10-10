//! Upgrading older project files to the current schema.
//!
//! `MIGRATIONS[n]` upgrades a document from `schemaVersion` n to n + 1. Version 1 is the first released
//! format, so the chain is empty today; the machinery is exercised with a synthetic chain in tests.
//! Add one function per schema bump and never edit an existing one.

use serde_json::Value;

use super::model::SCHEMA_VERSION;
use crate::errors::{AppError, AppResult};

pub type Migration = fn(Value) -> Result<Value, String>;

const MIGRATIONS: &[Migration] = &[];

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
    fn current_version_passes_through_untouched() {
        let doc = json!({"schemaVersion": 1, "name": "x"});
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
