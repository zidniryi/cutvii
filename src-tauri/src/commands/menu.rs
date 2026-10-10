//! Native menu bar: File > New Project / Open Project / Save / Save As.
//! The menu only tells the webview *which* action was chosen; the flows (confirm discard, dialogs) live there.

use tauri::menu::{
    AboutMetadata, Menu, MenuItemBuilder, MenuItemKind, PredefinedMenuItem, SubmenuBuilder,
};
use tauri::{AppHandle, Emitter};

pub const MENU_EVENT: &str = "menu-action";

/// (id, label, accelerator), in menu order.
pub const FILE_ITEMS: [(&str, &str, &str); 4] = [
    ("new-project", "New Project…", "CmdOrCtrl+N"),
    ("open-project", "Open Project…", "CmdOrCtrl+O"),
    ("save-project", "Save", "CmdOrCtrl+S"),
    ("save-project-as", "Save As…", "CmdOrCtrl+Shift+S"),
];

pub const ABOUT_TEXT: &str = "Cut fast. Keep it local.\n\nAn open-source video editor that works offline.\nYour media never leaves your computer.";

/// Replace the default About item with one that carries the app icon and tagline.
fn install_about(app: &AppHandle, menu: &Menu<tauri::Wry>) -> tauri::Result<()> {
    let info = app.package_info();
    let metadata = AboutMetadata {
        name: Some("CutVii".into()),
        version: Some(info.version.to_string()),
        // macOS shows `credits`; Windows/Linux show `comments`
        comments: Some(ABOUT_TEXT.into()),
        credits: Some(ABOUT_TEXT.into()),
        copyright: Some("© CutVii contributors".into()),
        icon: app.default_window_icon().cloned(),
        ..Default::default()
    };
    let about = PredefinedMenuItem::about(app, Some("About CutVii"), Some(metadata))?;

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
            return Ok(());
        }
    }
    // platforms whose default menu has no About: put it in Help, or leave the menu unchanged
    for item in menu.items()? {
        if let MenuItemKind::Submenu(sub) = item
            && sub.text().ok().as_deref() == Some("Help")
        {
            sub.append(&about)?;
            break;
        }
    }
    Ok(())
}

/// Only our own ids are forwarded to the webview.
pub fn is_file_action(id: &str) -> bool {
    FILE_ITEMS.iter().any(|(known, _, _)| *known == id)
}

/// Start from the platform's default menu and add our items at the top of File (creating File if needed).
pub fn install(app: &AppHandle) -> tauri::Result<()> {
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
    file.insert(&PredefinedMenuItem::separator(app)?, FILE_ITEMS.len())?;
    install_about(app, &menu)?;
    app.set_menu(menu)?;
    Ok(())
}

pub fn handle(app: &AppHandle, id: &str) {
    if is_file_action(id) {
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
        let mut ids: Vec<_> = FILE_ITEMS.iter().map(|i| i.0).collect();
        ids.dedup();
        assert_eq!(ids.len(), FILE_ITEMS.len());
    }
}
