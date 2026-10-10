//! Project file model (mirrors `src/project/model.ts`), validation, migration and persistence.
//! Both sides are tested against `fixtures/project-v1.json` so the schemas stay in sync.

mod migrate;
mod model;
pub mod persistence;
mod validation;

pub use model::*;
pub use validation::validate;
