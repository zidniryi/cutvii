//! Locating FFmpeg/FFprobe. Never assumes a global install: missing tools produce a clear error.
//! Order: explicit env var, then PATH (plus common macOS dirs, since GUI apps get a minimal PATH).
//! A bundled sidecar will be checked first once distribution builds exist (Phase 7).

use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::errors::{AppError, AppResult};

pub const FFMPEG_ENV: &str = "CUTVII_FFMPEG";
pub const FFPROBE_ENV: &str = "CUTVII_FFPROBE";

fn exe_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

pub fn find_in_dirs(exe: &str, dirs: &[PathBuf]) -> Option<PathBuf> {
    dirs.iter().map(|d| d.join(exe)).find(|c| c.is_file())
}

pub fn locate_tool(name: &str, env_var: &str) -> AppResult<PathBuf> {
    if let Some(value) = env::var_os(env_var) {
        let path = PathBuf::from(value);
        return if path.is_file() {
            Ok(path)
        } else {
            Err(AppError::ToolMissing(format!(
                "{env_var} points to {}, which is not a file",
                path.display()
            )))
        };
    }

    let mut dirs: Vec<PathBuf> = env::var_os("PATH")
        .map(|p| env::split_paths(&p).collect())
        .unwrap_or_default();
    #[cfg(target_os = "macos")]
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from));

    find_in_dirs(&exe_name(name), &dirs).ok_or_else(|| {
        AppError::ToolMissing(format!(
            "{name} not found. Install FFmpeg or set {env_var}."
        ))
    })
}

/// A `Command` that does not flash a console window on Windows.
pub fn command(program: &Path) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_executable_in_listed_dirs_only() {
        let dir = env::temp_dir().join(format!("cutvii-tools-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("faketool"), b"").unwrap();
        assert_eq!(
            find_in_dirs("faketool", std::slice::from_ref(&dir)),
            Some(dir.join("faketool"))
        );
        assert_eq!(find_in_dirs("missing", std::slice::from_ref(&dir)), None);
        std::fs::remove_dir_all(dir).ok();
    }
}
