use serde::Serialize;

/// Error type returned from Tauri commands. Serialized as a plain message for the webview.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("media tool not found: {0}")]
    ToolMissing(String),
    #[error("media backend does not support this operation yet: {0}")]
    #[allow(dead_code)]
    Unsupported(&'static str),
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("export cancelled")]
    Cancelled,
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
