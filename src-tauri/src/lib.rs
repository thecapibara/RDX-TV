#[cfg(not(target_os = "android"))]
pub mod audio;
pub mod cdn;
pub mod client;
pub mod commands;
pub mod mirror;
pub mod parser;
pub mod storage;
pub mod tmdb;
pub mod turbo;

use std::sync::Arc;
use client::{default_cookie_path, HttpClient, PersistentCookieStore};
use commands::AppState;
use storage::{default_db_path, Storage};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            use tauri::Manager;

            let data_dir = app.path().app_data_dir().ok();
            if let Some(dir) = &data_dir {
                let _ = std::fs::create_dir_all(dir);
            }

            let db_path = data_dir
                .as_ref()
                .map(|d| d.join("rdx.db"))
                .unwrap_or_else(default_db_path);
            let storage = Arc::new(Storage::new(&db_path).unwrap_or_else(|e| {
                eprintln!("Warning: failed to open SQLite at {:?}: {}. Using in-memory.", db_path, e);
                Storage::in_memory().expect("in-memory db fallback")
            }));

            let cookie_path = data_dir
                .as_ref()
                .map(|d| d.join("cookies.json"))
                .unwrap_or_else(default_cookie_path);
            let cookie_store = Arc::new(PersistentCookieStore::new(Some(&cookie_path)));

            let proxy_url = storage
                .get_settings()
                .ok()
                .map(|s| s.proxy_url)
                .filter(|p| !p.trim().is_empty());

            let client = Arc::new(
                HttpClient::new(cookie_store, proxy_url.as_deref())
                    .expect("failed to initialize HTTP client"),
            );

            let turbo = Arc::new(turbo::TurboServer::new(client.get_reqwest_client()));
            let tmdb = Arc::new(tmdb::TmdbService::new());
            let turbo_spawn = turbo.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = turbo_spawn.start().await {
                    eprintln!("[RDX Turbo] Server start warning: {}", e);
                }
            });

            let state = AppState { storage, client, turbo, tmdb };

            #[cfg(not(target_os = "android"))]
            {
                if let Ok(settings) = state.storage.get_settings() {
                    if settings.startup_sound {
                        audio::play_startup_sound(None);
                    }
                }
            }

            app.manage(state);

            #[cfg(target_os = "linux")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.with_webview(|webview| {
                        use webkit2gtk::{SettingsExt, WebViewExt};
                        let wk = webview.inner();
                        if let Some(settings) = wk.settings() {
                            settings.set_enable_smooth_scrolling(true);
                            settings.set_enable_page_cache(true);
                            settings.set_media_playback_requires_user_gesture(false);
                        }
                    });
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::update_settings,
            commands::save_watch_progress,
            commands::get_watch_progress,
            commands::get_continue_watching,
            commands::delete_watch_progress,
            commands::get_episode_progress,
            commands::open_url,
            commands::toggle_bookmark,
            commands::get_bookmarks,
            commands::is_bookmarked,
            commands::check_mirror_status,
            commands::check_all_mirrors,
            commands::smart_select_mirror,
            commands::get_active_mirror,
            commands::set_active_mirror,
            commands::open_captcha_window,
            commands::get_home_catalog,
            commands::get_category_catalog,
            commands::search_media,
            commands::search_autocomplete,
            commands::get_media_details,
            commands::get_stream,
            commands::get_episodes,
            commands::set_fullscreen_mode,
            commands::start_drag_window,
            commands::get_turbo_stream_url,
            commands::get_turbo_stats,
            commands::select_fastest_cdn,
            commands::get_backdrop,
            commands::get_tmdb_recommendations,
            commands::get_system_time,
            commands::play_ui_sound,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
