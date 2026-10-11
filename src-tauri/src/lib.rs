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
        .manage(commands::export::LastExport::default())
        .manage(commands::drop::DropState::default())
        .setup(|app| {
            commands::clip_tools::load_fonts(app.handle());
            Ok(())
        })
        .menu(commands::menu::build)
        .on_menu_event(|app, event| commands::menu::handle(app, event.id().as_ref()))
        // OS file drags arrive as *window* events (the webview-event hook never sees them).
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(drag) = event {
                let scale = window.scale_factor().unwrap_or(1.0);
                commands::drop::handle_drag_drop(window.app_handle(), drag, scale);
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::export::export_project,
            commands::export::cancel_export,
            commands::export::reveal_last_export,
            commands::drop::import_dropped_file,
            commands::clip_tools::prepare_reverse_preview,
            commands::clip_tools::extract_freeze_frame,
            commands::clip_tools::prepare_image_preview,
            commands::clip_tools::prepare_waveform,
            commands::clip_tools::render_text,
            commands::clip_tools::media_details,
            commands::clip_tools::reveal_media,
            commands::clip_tools::text_fonts,
            commands::clip_tools::import_text_font,
            commands::media::import_media,
            commands::media::relink_media,
            commands::media::pick_image,
            commands::project::open_project,
            commands::project::save_project,
            commands::project::forget_project_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
