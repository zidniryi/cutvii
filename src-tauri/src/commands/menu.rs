//! Native menu bar: File > New Project / Open Project / Save / Save As.
//! The menu only tells the webview *which* action was chosen; the flows (confirm discard, dialogs) live there.

use tauri::menu::{Menu, MenuItemBuilder, MenuItemKind, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager};

use super::recent;

pub const MENU_EVENT: &str = "menu-action";

/// (id, label, accelerator), in menu order.
pub const FILE_ITEMS: [(&str, &str, &str); 4] = [
    ("new-project", "New Project…", "CmdOrCtrl+N"),
    ("open-project", "Open Project…", "CmdOrCtrl+O"),
    ("save-project", "Save", "CmdOrCtrl+S"),
    ("save-project-as", "Save As…", "CmdOrCtrl+Shift+S"),
];

/// Our own About item: it opens CutVii's About window in the webview, where the layout is ours (the
/// system's About panel cannot centre its text).
pub const ABOUT_ID: &str = "about";

/// Opens the "Support CutVii" popup (donate, other ways to support) in the webview.
pub const SUPPORT_ID: &str = "support";
/// A manual update check, and the Settings window (both in the webview).
pub const UPDATES_ID: &str = "check-updates";
pub const SETTINGS_ID: &str = "settings";

/// Replace the default About item with ours, and put "Support & Donate" right under it.
fn install_about(app: &AppHandle, menu: &Menu<tauri::Wry>) -> tauri::Result<()> {
    let about = MenuItemBuilder::with_id(ABOUT_ID, "About CutVii").build(app)?;
    let support = MenuItemBuilder::with_id(SUPPORT_ID, "Support and Donate…").build(app)?;
    let updates = MenuItemBuilder::with_id(UPDATES_ID, "Check for Updates…").build(app)?;
    let settings = MenuItemBuilder::with_id(SETTINGS_ID, "Settings…")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;

    // macOS: the app menu is the first submenu and About is its first item
    for item in menu.items()? {
        let MenuItemKind::Submenu(sub) = item else {
            continue;
        };
        let existing = sub.items()?.into_iter().position(|i| match i {
            MenuItemKind::Predefined(p) => p.text().is_ok_and(|t| t.starts_with("About")),
            _ => false,
        });
        if let Some(index) = existing {
            sub.remove_at(index)?;
            sub.insert(&about, index)?;
            sub.insert(&support, index + 1)?;
            sub.insert(&updates, index + 2)?;
            sub.insert(&settings, index + 3)?;
            return Ok(());
        }
    }
    // Windows / Linux: About sits in Help. On Linux a predefined item has no text until the menu is attached
    // to a window, so the search above misses it; the default Help holds only that About, so drop every
    // predefined item there (otherwise GTK's own About dialog opens instead of ours).
    for item in menu.items()? {
        if let MenuItemKind::Submenu(sub) = item
            && sub.text().ok().as_deref() == Some("Help")
        {
            for (index, existing) in sub.items()?.into_iter().enumerate().rev() {
                if matches!(existing, MenuItemKind::Predefined(_)) {
                    sub.remove_at(index)?;
                }
            }
            sub.append(&about)?;
            sub.append(&support)?;
            sub.append(&updates)?;
            sub.append(&settings)?;
            break;
        }
    }
    Ok(())
}

pub const OPEN_RECENT_LABEL: &str = "Open Recent";

/// Only our own ids are forwarded to the webview.
pub fn is_file_action(id: &str) -> bool {
    FILE_ITEMS.iter().any(|(known, _, _)| *known == id)
}

/// Every id the webview acts on: the File items and About.
pub fn is_forwarded(id: &str) -> bool {
    is_file_action(id)
        || [ABOUT_ID, SUPPORT_ID, UPDATES_ID, SETTINGS_ID].contains(&id)
        || recent::index_of(id).is_some()
}

/// Start from the platform's default menu and add our items at the top of File (creating File if needed).
/// Passed to `Builder::menu`, which is what actually installs it (setting it from `setup` was overwritten).
pub fn build(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::default(app)?;
    let existing = menu.items()?.into_iter().find_map(|item| match item {
        MenuItemKind::Submenu(s) if s.text().ok().as_deref() == Some("File") => Some(s),
        _ => None,
    });
    let file = match existing {
        Some(f) => f,
        None => {
            let f = SubmenuBuilder::new(app, "File").build()?;
            menu.insert(&f, 1)?;
            f
        }
    };
    for (position, (id, label, accelerator)) in FILE_ITEMS.iter().enumerate() {
        let item = MenuItemBuilder::with_id(*id, *label)
            .accelerator(*accelerator)
            .build(app)?;
        file.insert(&item, position)?;
    }
    // Open Recent sits right under Open Project
    let recents = SubmenuBuilder::new(app, OPEN_RECENT_LABEL).build()?;
    file.insert(&recents, 2)?;
    if let Some(state) = app.try_state::<recent::RecentProjects>() {
        *state.menu.lock().unwrap() = Some(recents);
    }
    recent::load(app);
    recent::refresh_menu(app);
    file.insert(&PredefinedMenuItem::separator(app)?, FILE_ITEMS.len() + 1)?;
    install_about(app, &menu)?;
    Ok(menu)
}

pub fn handle(app: &AppHandle, id: &str) {
    if id == recent::CLEAR_ID {
        recent::clear(app);
    } else if is_forwarded(id) {
        app.emit(MENU_EVENT, id).ok();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_ids_are_forwarded_and_ids_are_unique() {
        assert!(is_file_action("new-project") && is_file_action("open-project"));
        assert!(is_file_action("save-project") && is_file_action("save-project-as"));
        assert!(!is_file_action("quit") && !is_file_action(""));
        assert!(is_forwarded(ABOUT_ID) && is_forwarded("save-project") && !is_forwarded("quit"));
        assert!(!is_file_action(ABOUT_ID), "About is not a file action");
        assert!(is_forwarded(SUPPORT_ID) && !is_file_action(SUPPORT_ID));
        assert!(is_forwarded(UPDATES_ID) && is_forwarded(SETTINGS_ID));
        assert!(is_forwarded("recent-0") && !is_forwarded(recent::CLEAR_ID));
        assert!(!is_forwarded("recent-none") && !is_forwarded("recent-99"));
        let mut ids: Vec<_> = FILE_ITEMS.iter().map(|i| i.0).collect();
        ids.dedup();
        assert_eq!(ids.len(), FILE_ITEMS.len());
    }
}
