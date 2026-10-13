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
        .manage(commands::export::BatchFolder::default())
        .manage(commands::drop::DropState::default())
        .manage(commands::ai::AiJob::default())
        .manage(commands::recent::RecentProjects::default())
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
            commands::export::export_clips,
            commands::export::choose_clips_folder,
            commands::export::reveal_last_export,
            commands::drop::import_dropped_file,
            commands::clip_tools::prepare_reverse_preview,
            commands::clip_tools::extract_freeze_frame,
            commands::clip_tools::prepare_image_preview,
            commands::clip_tools::prepare_waveform,
            commands::clip_tools::render_text,
            commands::clip_tools::text_style_preview,
            commands::clip_tools::bake_color_lut,
            commands::clip_tools::look_previews,
            commands::clip_tools::export_color_preset,
            commands::clip_tools::import_color_presets,
            commands::clip_tools::import_color_luts,
            commands::clip_tools::color_luts,
            commands::clip_tools::delete_color_lut,
            commands::clip_tools::open_lyrics_file,
            commands::clip_tools::export_srt,
            commands::support::open_support_link,
            commands::update::check_for_update,
            commands::update::open_release_page,
            commands::clip_tools::make_instrumental,
            commands::clip_tools::audio_clean_sample,
            commands::clip_tools::export_text_style,
            commands::clip_tools::import_text_styles,
            commands::clip_tools::export_style_pack,
            commands::clip_tools::open_style_pack,
            commands::drop::read_dropped_pack,
            commands::ai::whisper_models,
            commands::ai::download_whisper_model,
            commands::ai::cancel_ai_job,
            commands::ai::delete_whisper_model,
            commands::ai::transcribe_media,
            commands::clipper::find_clips_in_media,
            commands::tts::tts_status,
            commands::tts::download_tts_model,
            commands::tts::delete_tts_model,
            commands::tts::speak_text,
            commands::upscale::upscale_models,
            commands::upscale::download_upscale_model,
            commands::upscale::delete_upscale_model,
            commands::upscale::upscale_image,
            commands::upscale::upscale_video,
            commands::clip_tools::media_details,
            commands::clip_tools::reveal_media,
            commands::clip_tools::text_fonts,
            commands::clip_tools::import_text_font,
            commands::media::import_media,
            commands::media::relink_media,
            commands::media::pick_image,
            commands::project::open_project,
            commands::project::open_recent_project,
            commands::project::save_project,
            commands::project::forget_project_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
