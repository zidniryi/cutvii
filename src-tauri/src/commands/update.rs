//! Update check: is there a newer CutVii release on GitHub? Notification only: nothing is downloaded or
//! installed. The request is made here, never by the webview, to one fixed address built from
//! [`UPDATE_REPO`]; it carries nothing but a `User-Agent` with the version. When and whether to ask (the
//! setting, once per 24 hours, a skipped version) is decided by the webview (`src/updates/updates.ts`).
//!
//! Everything that comes back is untrusted: the notes are cut down to plain text, and the release page is
//! only ever opened when its address is this project's releases on github.com.

use std::cmp::Ordering;
use std::time::Duration;

use serde::Serialize;

use super::support::open_in_browser;
use crate::errors::{AppError, AppResult};

/// The project's repository on GitHub, as `owner/name`. THE one place to set it.
pub const UPDATE_REPO: &str = "zidniryi/cutvii";

const API_HOST: &str = "https://api.github.com/";
const TIMEOUT: Duration = Duration::from_secs(5);
/// Longest release notes shown, in characters.
const MAX_NOTES: usize = 600;

/// `(owner, name)`, or `None` for the placeholder and for anything that is not a plain repository name.
pub fn parse_repo(repo: &str) -> Option<(&str, &str)> {
    let (owner, name) = repo.split_once('/')?;
    let plain = |s: &str| {
        !s.is_empty()
            && s.len() <= 100
            && !s.starts_with('.')
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
    };
    (repo != "OWNER/REPO" && plain(owner) && plain(name)).then_some((owner, name))
}

pub fn latest_url(owner: &str, name: &str) -> String {
    format!("{API_HOST}repos/{owner}/{name}/releases/latest")
}

/// A semantic version: `1.2.3` or `1.2.3-beta.1`. A leading `v` and build metadata (`+...`) are ignored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    core: [u64; 3],
    pre: Vec<String>,
}

impl Version {
    pub fn parse(text: &str) -> Option<Self> {
        let text = text.trim().trim_start_matches(['v', 'V']);
        let text = text.split('+').next()?;
        let (core, pre) = match text.split_once('-') {
            Some((core, pre)) => (core, Some(pre)),
            None => (text, None),
        };
        let mut numbers = core.split('.').map(|n| {
            (!n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
                .then(|| n.parse::<u64>().ok())
                .flatten()
        });
        let core = [numbers.next()??, numbers.next()??, numbers.next()??];
        if numbers.next().is_some() {
            return None;
        }
        let pre: Vec<String> = match pre {
            None => vec![],
            Some(p) => p.split('.').map(str::to_string).collect(),
        };
        let ok = |id: &String| {
            !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        };
        pre.iter().all(ok).then_some(Self { core, pre })
    }

    pub fn is_prerelease(&self) -> bool {
        !self.pre.is_empty()
    }
}

impl Ord for Version {
    /// Semver precedence: the numbers first; a pre-release comes before its release; pre-release parts
    /// compare as numbers when both are numbers, numbers before words, and fewer parts first.
    fn cmp(&self, other: &Self) -> Ordering {
        self.core
            .cmp(&other.core)
            .then_with(|| match (self.pre.is_empty(), other.pre.is_empty()) {
                (true, true) => Ordering::Equal,
                (true, false) => Ordering::Greater,
                (false, true) => Ordering::Less,
                (false, false) => {
                    for (a, b) in self.pre.iter().zip(&other.pre) {
                        let order = match (a.parse::<u64>(), b.parse::<u64>()) {
                            (Ok(x), Ok(y)) => x.cmp(&y),
                            (Ok(_), Err(_)) => Ordering::Less,
                            (Err(_), Ok(_)) => Ordering::Greater,
                            (Err(_), Err(_)) => a.cmp(b),
                        };
                        if order != Ordering::Equal {
                            return order;
                        }
                    }
                    self.pre.len().cmp(&other.pre.len())
                }
            })
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// Is `url` a page of this project's releases on github.com, over https, and nothing else?
pub fn is_release_page(url: &str, owner: &str, name: &str) -> bool {
    let prefix = format!("https://github.com/{owner}/{name}/releases");
    let Some(rest) = url.strip_prefix(&prefix) else {
        return false;
    };
    url.len() <= 300
        && (rest.is_empty() || rest.starts_with('/'))
        && !rest.contains("..")
        && rest
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "/-_.".contains(c))
}

/// Release notes as plain text: no control characters, runs of blank lines closed up, cut to a few lines.
/// Whatever markup they contain stays visible as the characters it is; nothing is rendered or followed.
pub fn plain_notes(body: &str) -> String {
    let clean: String = body
        .chars()
        .filter(|c| *c == '\n' || !c.is_control())
        .collect();
    let lines: Vec<&str> = clean
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    let joined = lines.join("\n");
    if joined.chars().count() <= MAX_NOTES {
        return joined;
    }
    let cut: String = joined.chars().take(MAX_NOTES).collect();
    format!("{}…", cut.trim_end())
}

/// Something that fetches the text at an address. The real one is [`GitHub`]; tests use their own.
pub trait Fetch {
    fn get(&self, url: &str) -> Result<String, String>;
}

/// The real request: https to api.github.com only, 5 seconds at most, a `User-Agent` and nothing else.
pub struct GitHub;

impl Fetch for GitHub {
    fn get(&self, url: &str) -> Result<String, String> {
        if !url.starts_with(API_HOST) {
            return Err("refused: not the GitHub API".into());
        }
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(TIMEOUT))
            .build();
        let agent = ureq::Agent::new_with_config(config);
        let mut response = agent
            .get(url)
            .header("User-Agent", concat!("CutVii/", env!("CARGO_PKG_VERSION")))
            .header("Accept", "application/vnd.github+json")
            .call()
            .map_err(|e| e.to_string())?;
        response
            .body_mut()
            .with_config()
            .limit(512 * 1024)
            .read_to_string()
            .map_err(|e| e.to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum UpdateStatus {
    /// [`UPDATE_REPO`] is not set: nothing was asked.
    Placeholder,
    #[serde(rename_all = "camelCase")]
    UpToDate { current: String },
    #[serde(rename_all = "camelCase")]
    Available {
        version: String,
        notes: String,
        url: String,
    },
}

/// Ask for the latest release of `repo` and compare it with `current`. Drafts, pre-releases and releases
/// whose page is not this project's are treated as "nothing newer".
pub fn check(fetch: &dyn Fetch, repo: &str, current: &str) -> Result<UpdateStatus, String> {
    let Some((owner, name)) = parse_repo(repo) else {
        return Ok(UpdateStatus::Placeholder);
    };
    let running = Version::parse(current).ok_or("this build has no readable version")?;
    let up_to_date = || UpdateStatus::UpToDate {
        current: current.to_string(),
    };
    let text = fetch.get(&latest_url(owner, name))?;
    let release: serde_json::Value =
        serde_json::from_str(&text).map_err(|_| "GitHub's answer could not be read")?;
    let flag = |key: &str| release[key].as_bool().unwrap_or(false);
    if flag("draft") || flag("prerelease") {
        return Ok(up_to_date());
    }
    let Some(latest) = release["tag_name"].as_str().and_then(Version::parse) else {
        return Err("the latest release has no readable version".into());
    };
    if latest.is_prerelease() || latest <= running {
        return Ok(up_to_date());
    }
    let url = release["html_url"].as_str().unwrap_or_default();
    if !is_release_page(url, owner, name) {
        return Err("the release page is not this project's page on github.com".into());
    }
    let tag = release["tag_name"].as_str().unwrap_or_default();
    Ok(UpdateStatus::Available {
        version: tag.trim().trim_start_matches(['v', 'V']).to_string(),
        notes: plain_notes(release["body"].as_str().unwrap_or_default()),
        url: url.to_string(),
    })
}

/// Look for a newer release. Errors are returned as text; the caller decides whether to show them.
#[tauri::command]
pub async fn check_for_update() -> AppResult<UpdateStatus> {
    tauri::async_runtime::spawn_blocking(|| {
        check(&GitHub, UPDATE_REPO, env!("CARGO_PKG_VERSION")).map_err(AppError::InvalidInput)
    })
    .await
    .map_err(|e| AppError::InvalidInput(format!("update check failed: {e}")))?
}

/// Open a release page in the default browser, after checking again that it is this project's.
#[tauri::command]
pub fn open_release_page(url: String) -> AppResult<()> {
    let ours =
        parse_repo(UPDATE_REPO).is_some_and(|(owner, name)| is_release_page(&url, owner, name));
    if !ours {
        return Err(AppError::InvalidInput(
            "that is not this project's release page".into(),
        ));
    }
    open_in_browser(&url)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// Answers with a fixed text (or an error) and remembers what was asked.
    struct Fake {
        answer: Result<String, String>,
        asked: RefCell<Vec<String>>,
    }
    impl Fake {
        fn new(answer: Result<&str, &str>) -> Self {
            Self {
                answer: answer.map(str::to_string).map_err(str::to_string),
                asked: RefCell::new(vec![]),
            }
        }
    }
    impl Fetch for Fake {
        fn get(&self, url: &str) -> Result<String, String> {
            self.asked.borrow_mut().push(url.to_string());
            self.answer.clone()
        }
    }
    const REPO: &str = "cutvii/cutvii";
    fn release(tag: &str, extra: &str) -> String {
        format!(
            r#"{{"tag_name":"{tag}","draft":false,"prerelease":false,"body":"Fixes\r\n\r\n<b>bold</b> [x](http://evil)","html_url":"https://github.com/cutvii/cutvii/releases/tag/{tag}"{extra}}}"#
        )
    }
    fn v(text: &str) -> Version {
        Version::parse(text).unwrap_or_else(|| panic!("{text}"))
    }

    #[test]
    fn versions_compare_like_semver() {
        assert!(v("1.2.3") == v("v1.2.3") && v("1.2.3") == v("1.2.3+build.5"));
        assert!(v("1.2.4") > v("1.2.3") && v("1.10.0") > v("1.9.9") && v("2.0.0") > v("1.99.99"));
        assert!(
            v("1.0.0") > v("1.0.0-rc.1"),
            "a release is newer than its pre-release"
        );
        assert!(v("1.0.0-rc.2") > v("1.0.0-rc.1") && v("1.0.0-rc.10") > v("1.0.0-rc.2"));
        assert!(v("1.0.0-beta") > v("1.0.0-alpha") && v("1.0.0-alpha.1") > v("1.0.0-alpha"));
        assert!(v("1.0.0-alpha") > v("1.0.0-1"), "numbers come before words");
        assert!(v("1.0.0-rc.1").is_prerelease() && !v("1.0.0").is_prerelease());
        for bad in [
            "",
            "1.2",
            "1.2.3.4",
            "1.x.3",
            "one",
            "1.2.3-",
            "1.2.3-a..b",
            "-1.2.3",
        ] {
            assert!(Version::parse(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn a_newer_release_is_offered_and_equal_or_older_ones_are_not() {
        let newer = Fake::new(Ok(&release("v0.2.0", "")));
        let status = check(&newer, REPO, "0.1.0").unwrap();
        assert_eq!(
            status,
            UpdateStatus::Available {
                version: "0.2.0".into(),
                // plain text: the markup stays as characters, blank lines are closed up
                notes: "Fixes\n<b>bold</b> [x](http://evil)".into(),
                url: "https://github.com/cutvii/cutvii/releases/tag/v0.2.0".into(),
            }
        );
        // only the one allowed address was asked
        assert_eq!(
            *newer.asked.borrow(),
            vec!["https://api.github.com/repos/cutvii/cutvii/releases/latest"]
        );
        let up_to_date = UpdateStatus::UpToDate {
            current: "0.2.0".into(),
        };
        for tag in ["v0.2.0", "0.1.9", "v0.2.0-rc.1"] {
            let same = Fake::new(Ok(&release(tag, "")));
            assert_eq!(check(&same, REPO, "0.2.0").unwrap(), up_to_date, "{tag}");
        }
        // a pre-release build is offered the release it leads up to
        let fin = Fake::new(Ok(&release("v0.2.0", "")));
        assert!(matches!(
            check(&fin, REPO, "0.2.0-rc.1").unwrap(),
            UpdateStatus::Available { .. }
        ));
    }

    #[test]
    fn drafts_and_prereleases_are_ignored() {
        for flag in ["draft", "prerelease"] {
            let text = release("v9.0.0", "")
                .replace(&format!(r#""{flag}":false"#), &format!(r#""{flag}":true"#));
            let fake = Fake::new(Ok(&text));
            assert!(
                matches!(
                    check(&fake, REPO, "0.1.0").unwrap(),
                    UpdateStatus::UpToDate { .. }
                ),
                "{flag}"
            );
        }
        let tagged = Fake::new(Ok(&release("v9.0.0-beta.1", "")));
        assert!(matches!(
            check(&tagged, REPO, "0.1.0").unwrap(),
            UpdateStatus::UpToDate { .. }
        ));
    }

    #[test]
    fn the_placeholder_repo_asks_nothing() {
        for repo in [
            "OWNER/REPO",
            "",
            "no-slash",
            "a/b/c",
            "a b/c",
            "a/.git",
            "../x",
        ] {
            let fake = Fake::new(Ok(&release("v9.0.0", "")));
            if repo == "a/b/c" {
                // "a" / "b/c": the name is not plain
                assert!(parse_repo(repo).is_none());
            }
            assert_eq!(
                check(&fake, repo, "0.1.0").unwrap(),
                UpdateStatus::Placeholder,
                "{repo}"
            );
            assert!(fake.asked.borrow().is_empty(), "{repo}: no request");
        }
        assert_eq!(parse_repo("cutvii/cutvii"), Some(("cutvii", "cutvii")));
    }

    #[test]
    fn failures_come_back_as_errors_for_the_caller_to_show_or_swallow() {
        let offline = Fake::new(Err("timed out"));
        assert_eq!(check(&offline, REPO, "0.1.0").unwrap_err(), "timed out");
        let garbage = Fake::new(Ok("<html>rate limited</html>"));
        assert!(check(&garbage, REPO, "0.1.0").is_err());
        let no_tag = Fake::new(Ok(r#"{"message":"Not Found"}"#));
        assert!(check(&no_tag, REPO, "0.1.0").is_err());
        // the real fetcher refuses any other host before touching the network
        assert!(
            GitHub
                .get("https://example.com/repos/a/b/releases/latest")
                .is_err()
        );
        assert!(
            GitHub
                .get("http://api.github.com/repos/a/b/releases/latest")
                .is_err()
        );
    }

    #[test]
    fn only_this_projects_release_pages_on_github_are_accepted() {
        let ok = |url: &str| is_release_page(url, "cutvii", "cutvii");
        assert!(ok("https://github.com/cutvii/cutvii/releases/tag/v0.2.0"));
        assert!(ok("https://github.com/cutvii/cutvii/releases"));
        for bad in [
            "http://github.com/cutvii/cutvii/releases/tag/v1",
            "https://github.com/other/cutvii/releases/tag/v1",
            "https://github.com/cutvii/cutvii-evil/releases/tag/v1",
            "https://github.com.evil.com/cutvii/cutvii/releases/tag/v1",
            "https://evil.com/?https://github.com/cutvii/cutvii/releases/",
            "https://github.com/cutvii/cutvii/releasesX",
            "https://github.com/cutvii/cutvii/releases/../../../evil",
            "https://github.com/cutvii/cutvii/releases/tag/v1?x=<script>",
            "",
        ] {
            assert!(!ok(bad), "{bad}");
        }
        // a newer release whose page is somewhere else is not offered
        let elsewhere =
            release("v9.0.0", "").replace("github.com/cutvii/cutvii", "evil.com/cutvii/cutvii");
        assert!(check(&Fake::new(Ok(&elsewhere)), REPO, "0.1.0").is_err());
        assert!(
            open_release_page("https://github.com/cutvii/cutvii/releases/tag/v1".into()).is_err(),
            "with the placeholder repo nothing is opened"
        );
    }

    #[test]
    fn notes_are_cut_to_plain_text() {
        assert_eq!(
            plain_notes("  a \r\n\r\n\r\n b\t\u{7}\u{1b}[31m "),
            "a\nb[31m"
        );
        let long = "x".repeat(2000);
        let cut = plain_notes(&long);
        assert_eq!(cut.chars().count(), MAX_NOTES + 1);
        assert!(cut.ends_with('…'));
        assert_eq!(plain_notes(""), "");
    }
}
