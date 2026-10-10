use tauri::Manager;

mod commands;
mod errors;
mod export;
mod media;
mod project;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::project::CurrentProjectPath::default())
        .manage(commands::export::ExportJob::default())
        .manage(commands::drop::DropState::default())
        .menu(commands::menu::build)
        .on_menu_event(|app, event| commands::menu::handle(app, event.id().as_ref()))
        .on_webview_event(|webview, event| {
            if let tauri::WebviewEvent::DragDrop(drag) = event {
                let scale = webview.window().scale_factor().unwrap_or(1.0);
                commands::drop::handle_drag_drop(webview.app_handle(), drag, scale);
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::export::export_project,
            commands::export::cancel_export,
            commands::drop::import_dropped_file,
            commands::media::import_media,
            commands::media::relink_media,
            commands::project::open_project,
            commands::project::save_project,
            commands::project::forget_project_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
