//! File > Open Recent: the last projects opened or saved, kept in the app's data folder.
//! The webview only ever names an entry by its position in the menu; the path comes from this list, so it
//! can still never ask for an arbitrary file.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::menu::{MenuItemBuilder, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, Wry};

pub const MAX_RECENT: usize = 10;
/// Menu ids are `recent-0`, `recent-1`, … in menu order.
pub const RECENT_PREFIX: &str = "recent-";
pub const CLEAR_ID: &str = "recent-clear";
const STORE_FILE: &str = "recent-projects.json";
const MAX_STORE_BYTES: u64 = 64 * 1024;

#[derive(Default)]
pub struct RecentProjects {
    pub paths: Mutex<Vec<PathBuf>>,
    /// The Open Recent submenu, once the menu bar is built.
    pub menu: Mutex<Option<Submenu<Wry>>>,
}

/// `list` with `path` moved (or added) to the front, at most `MAX_RECENT` long.
pub fn remembered(list: &[PathBuf], path: &Path) -> Vec<PathBuf> {
    let mut next = vec![path.to_path_buf()];
    next.extend(list.iter().filter(|p| p.as_path() != path).cloned());
    next.truncate(MAX_RECENT);
    next
}

/// Read a stored list. The file is untrusted input: anything that is not a short list of absolute paths
/// is dropped.
pub fn parse(text: &str) -> Vec<PathBuf> {
    let Ok(items) = serde_json::from_str::<Vec<String>>(text) else {
        return Vec::new();
    };
    let mut list: Vec<PathBuf> = Vec::new();
    for item in items {
        let path = PathBuf::from(&item);
        if item.len() <= 4096 && path.is_absolute() && !list.contains(&path) {
            list.push(path);
        }
        if list.len() == MAX_RECENT {
            break;
        }
    }
    list
}

/// The position a menu id stands for (`recent-3` -> 3).
pub fn index_of(id: &str) -> Option<usize> {
    let index: usize = id.strip_prefix(RECENT_PREFIX)?.parse().ok()?;
    (index < MAX_RECENT).then_some(index)
}

/// What a recent project is called in the menu: its file name, and the folder it is in.
pub fn label(path: &Path) -> String {
    let name = path
        .file_stem()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());
    match path.parent().and_then(|p| p.file_name()) {
        Some(folder) => format!("{name}  —  {}", folder.to_string_lossy()),
        None => name,
    }
}

fn store_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(STORE_FILE))
}

fn write(app: &AppHandle, list: &[PathBuf]) {
    let Some(file) = store_path(app) else { return };
    let names: Vec<String> = list
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    if let (Some(dir), Ok(json)) = (file.parent(), serde_json::to_string_pretty(&names)) {
        // not being able to remember recent projects must never get in the way of opening or saving
        std::fs::create_dir_all(dir).ok();
        std::fs::write(&file, json).ok();
    }
}

/// Read the stored list into the app state (at startup).
pub fn load(app: &AppHandle) {
    let Some(state) = app.try_state::<RecentProjects>() else {
        return;
    };
    let list = store_path(app)
        .filter(|f| std::fs::metadata(f).is_ok_and(|m| m.len() <= MAX_STORE_BYTES))
        .and_then(|f| std::fs::read_to_string(f).ok())
        .map(|text| parse(&text))
        .unwrap_or_default();
    *state.paths.lock().unwrap() = list;
}

fn change(app: &AppHandle, edit: impl FnOnce(&[PathBuf]) -> Vec<PathBuf>) {
    let Some(state) = app.try_state::<RecentProjects>() else {
        return;
    };
    let next = {
        let mut paths = state.paths.lock().unwrap();
        *paths = edit(&paths);
        paths.clone()
    };
    write(app, &next);
    refresh_menu(app);
}

/// A project was opened or saved at `path`: it goes to the top of Open Recent.
pub fn remember(app: &AppHandle, path: &Path) {
    change(app, |list| remembered(list, path));
}

/// `path` can no longer be opened: take it out of Open Recent.
pub fn forget(app: &AppHandle, path: &Path) {
    change(app, |list| {
        list.iter()
            .filter(|p| p.as_path() != path)
            .cloned()
            .collect()
    });
}

pub fn clear(app: &AppHandle) {
    change(app, |_| Vec::new());
}

pub fn path_at(app: &AppHandle, index: usize) -> Option<PathBuf> {
    let state = app.try_state::<RecentProjects>()?;
    let paths = state.paths.lock().unwrap();
    paths.get(index).cloned()
}

/// Fill the Open Recent submenu from the list.
pub fn refresh_menu(app: &AppHandle) {
    let Some(state) = app.try_state::<RecentProjects>() else {
        return;
    };
    let Some(menu) = state.menu.lock().unwrap().clone() else {
        return;
    };
    let paths = state.paths.lock().unwrap().clone();
    let fill = || -> tauri::Result<()> {
        while !menu.items()?.is_empty() {
            menu.remove_at(0)?;
        }
        if paths.is_empty() {
            let none = MenuItemBuilder::with_id("recent-none", "No Recent Projects")
                .enabled(false)
                .build(app)?;
            return menu.append(&none);
        }
        for (index, path) in paths.iter().enumerate() {
            let item = MenuItemBuilder::with_id(format!("{RECENT_PREFIX}{index}"), label(path))
                .build(app)?;
            menu.append(&item)?;
        }
        menu.append(&PredefinedMenuItem::separator(app)?)?;
        menu.append(&MenuItemBuilder::with_id(CLEAR_ID, "Clear Menu").build(app)?)
    };
    fill().ok();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    #[test]
    fn the_newest_project_is_first_without_duplicates_and_the_list_stays_short() {
        let list = remembered(
            &[p("/a/one.cutvii"), p("/a/two.cutvii")],
            &p("/a/two.cutvii"),
        );
        assert_eq!(list, [p("/a/two.cutvii"), p("/a/one.cutvii")]);
        let mut long = Vec::new();
        for i in 0..15 {
            long = remembered(&long, &p(&format!("/a/{i}.cutvii")));
        }
        assert_eq!(long.len(), MAX_RECENT);
        assert_eq!(long[0], p("/a/14.cutvii"));
        assert_eq!(long[9], p("/a/5.cutvii"));
    }

    #[test]
    fn a_stored_list_is_read_as_untrusted_input() {
        assert_eq!(
            parse(r#"["/a/one.cutvii", "relative.cutvii", "/a/one.cutvii", "/b/two.cutvii"]"#),
            [p("/a/one.cutvii"), p("/b/two.cutvii")]
        );
        assert!(parse("not json").is_empty());
        assert!(parse(r#"{"paths": []}"#).is_empty());
        assert!(parse(r#"[1, 2]"#).is_empty());
        let many: Vec<String> = (0..50).map(|i| format!("/a/{i}.cutvii")).collect();
        assert_eq!(
            parse(&serde_json::to_string(&many).unwrap()).len(),
            MAX_RECENT
        );
        let long = format!("[\"/{}\"]", "x".repeat(5000));
        assert!(parse(&long).is_empty());
    }

    #[test]
    fn menu_ids_map_to_positions_and_labels_show_name_and_folder() {
        assert_eq!(index_of("recent-0"), Some(0));
        assert_eq!(index_of("recent-9"), Some(9));
        assert_eq!(index_of("recent-10"), None);
        assert_eq!(index_of("recent-clear"), None);
        assert_eq!(index_of("recent--1"), None);
        assert_eq!(index_of("open-project"), None);
        assert_eq!(label(&p("/Users/me/Films/Trip.cutvii")), "Trip  —  Films");
    }
}
