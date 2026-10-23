//! The "Support CutVii" popup's two links. The webview never passes a URL: it names which link, and the
//! address comes from `config/support.json`, checked here. A config that is missing a link or points
//! anywhere else falls back to the built-in addresses.

use std::process::Stdio;

use serde::Deserialize;

use crate::errors::{AppError, AppResult};
use crate::media::tools::command;

/// The only place a support link may point to.
const ALLOWED_PREFIX: &str = "https://cutvii.space/";
const DEFAULT_DONATE: &str = "https://cutvii.space/donate";
const DEFAULT_SUPPORT: &str = "https://cutvii.space/support";

const CONFIG: &str = include_str!("../../../config/support.json");

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SupportLink {
    Donate,
    Support,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Links {
    donate_url: String,
    support_url: String,
}

/// https, on cutvii.space, short, and made only of characters that mean nothing to a shell or a browser bar.
pub fn is_allowed(url: &str) -> bool {
    url.len() <= 200
        && url.starts_with(ALLOWED_PREFIX)
        && url[ALLOWED_PREFIX.len()..]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "/-_.?=&".contains(c))
        && !url.contains("..")
}

/// The address of a link from the config text, or the built-in one when the config is unusable.
pub fn link_from(config: &str, which: SupportLink) -> String {
    let fallback = match which {
        SupportLink::Donate => DEFAULT_DONATE,
        SupportLink::Support => DEFAULT_SUPPORT,
    };
    serde_json::from_str::<Links>(config)
        .ok()
        .map(|l| match which {
            SupportLink::Donate => l.donate_url,
            SupportLink::Support => l.support_url,
        })
        .filter(|url| is_allowed(url))
        .unwrap_or_else(|| fallback.to_string())
}

/// Open one of the two support pages in the default browser.
#[tauri::command]
pub fn open_support_link(which: SupportLink) -> AppResult<()> {
    open_in_browser(&link_from(CONFIG, which))
}

/// Open an address in the default browser. The caller has checked the address.
pub(crate) fn open_in_browser(url: &str) -> AppResult<()> {
    // argument vector, no shell
    let (program, args): (&str, Vec<&str>) = if cfg!(target_os = "macos") {
        ("open", vec![url])
    } else if cfg!(target_os = "windows") {
        ("explorer", vec![url])
    } else {
        ("xdg-open", vec![url])
    };
    command(std::path::Path::new(program))
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| AppError::InvalidInput(format!("could not open the browser: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shipped_config_points_at_the_two_pages() {
        assert_eq!(link_from(CONFIG, SupportLink::Donate), DEFAULT_DONATE);
        assert_eq!(link_from(CONFIG, SupportLink::Support), DEFAULT_SUPPORT);
        let v: serde_json::Value = serde_json::from_str(CONFIG).unwrap();
        for locale in ["en", "id"] {
            for key in ["title", "message", "donate", "other", "otherLine", "footer"] {
                let text = v["locales"][locale][key].as_str().unwrap_or("");
                assert!(!text.trim().is_empty(), "{locale}.{key}");
            }
        }
    }

    #[test]
    fn only_https_pages_on_cutvii_xyz_are_opened() {
        for good in [
            "https://cutvii.space/donate",
            "https://cutvii.space/a/b?x=1&y=2",
        ] {
            assert!(is_allowed(good), "{good}");
        }
        for bad in [
            "http://cutvii.space/donate",
            "https://cutvii.space.evil.com/donate",
            "https://evil.com/https://cutvii.space/",
            "https://cutvii.space@evil.com/",
            "https://cutvii.space/../x",
            "https://cutvii.space/a b",
            "https://cutvii.space/a;rm",
            "file:///etc/passwd",
            "",
        ] {
            assert!(!is_allowed(bad), "{bad}");
        }
        // a config that points elsewhere, or is broken, falls back to the built-in address
        let elsewhere =
            r#"{"donateUrl":"https://evil.com/","supportUrl":"https://cutvii.space/thanks"}"#;
        assert_eq!(link_from(elsewhere, SupportLink::Donate), DEFAULT_DONATE);
        assert_eq!(
            link_from(elsewhere, SupportLink::Support),
            "https://cutvii.space/thanks"
        );
        assert_eq!(link_from("not json", SupportLink::Support), DEFAULT_SUPPORT);
    }
}
