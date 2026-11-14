use std::sync::Arc;
use tauri::{AppHandle, Manager, State};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri::{WebviewUrl, WebviewWindowBuilder};
use serde::{Deserialize, Serialize};

use crate::client::HttpClient;
use crate::mirror::{MirrorManager, MirrorStatus, SmartRotationResult, PRESET_MIRRORS};
use crate::parser::{
    EpisodeTab, MediaCard, MediaDetails, RezkaParser, SearchItem, SeasonTab, StreamData,
};
use crate::storage::{AppSettings, Bookmark, EpisodeProgress, Storage, WatchProgress};

pub struct AppState {
    pub storage: Arc<Storage>,
    pub client: Arc<HttpClient>,
    pub turbo: Arc<crate::turbo::TurboServer>,
    pub tmdb: Arc<crate::tmdb::TmdbService>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EpisodesData {
    pub seasons: Vec<SeasonTab>,
    pub episodes: Vec<EpisodeTab>,
    pub stream_data: Option<StreamData>,
}

// ==================== Storage Commands ====================

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    state.storage.get_settings().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_settings(state: State<'_, AppState>, settings: AppSettings) -> Result<(), String> {
    state.client.set_proxy(Some(&settings.proxy_url));
    state.storage.update_settings(&settings).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_watch_progress(state: State<'_, AppState>, progress: WatchProgress) -> Result<(), String> {
    state.storage.save_watch_progress(&progress).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_watch_progress(state: State<'_, AppState>, media_id: String) -> Result<Option<WatchProgress>, String> {
    state.storage.get_watch_progress(&media_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_continue_watching(state: State<'_, AppState>, limit: Option<usize>) -> Result<Vec<WatchProgress>, String> {
    state.storage.get_continue_watching(limit.unwrap_or(20)).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_watch_progress(state: State<'_, AppState>, media_id: String) -> Result<bool, String> {
    state.storage.delete_watch_progress(&media_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_episode_progress(
    state: State<'_, AppState>,
    media_id: String,
) -> Result<Vec<EpisodeProgress>, String> {
    state.storage.get_episode_progress(&media_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn toggle_bookmark(state: State<'_, AppState>, bookmark: Bookmark) -> Result<bool, String> {
    state.storage.toggle_bookmark(&bookmark).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_bookmarks(state: State<'_, AppState>, category: Option<String>) -> Result<Vec<Bookmark>, String> {
    state.storage.get_bookmarks(category.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn is_bookmarked(state: State<'_, AppState>, media_id: String) -> Result<Option<String>, String> {
    state.storage.is_bookmarked(&media_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn open_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", "", &url])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ==================== Mirror Commands ====================

#[tauri::command]
pub async fn check_mirror_status(state: State<'_, AppState>, mirror_url: String) -> Result<MirrorStatus, String> {
    let status = MirrorManager::check_mirror_status(&state.client, &mirror_url).await;
    Ok(status)
}

#[tauri::command]
pub async fn check_all_mirrors(
    state: State<'_, AppState>,
    mirror_urls: Vec<String>,
) -> Result<Vec<MirrorStatus>, String> {
    let statuses = MirrorManager::check_all_mirrors(state.client.clone(), mirror_urls).await;
    Ok(statuses)
}

#[tauri::command]
pub async fn smart_select_mirror(
    state: State<'_, AppState>,
    force_rotate: Option<bool>,
) -> Result<SmartRotationResult, String> {
    let mut settings = state.storage.get_settings().map_err(|e| e.to_string())?;
    let current_active = MirrorManager::normalize_url(&settings.active_mirror);

    let mut extra = vec![current_active.clone()];
    for m in &settings.custom_mirrors {
        extra.push(m.clone());
    }

    let statuses = MirrorManager::discover_mirrors(state.client.clone(), &extra).await;

    // Persist any newly discovered working public mirrors into custom_mirrors
    let preset_set: Vec<String> = PRESET_MIRRORS.iter().map(|s| s.to_string()).collect();
    let mut custom_changed = false;
    for st in &statuses {
        if st.online
            && st.catalog_available
            && !preset_set.contains(&st.mirror_url)
            && !settings.custom_mirrors.contains(&st.mirror_url)
        {
            settings.custom_mirrors.push(st.mirror_url.clone());
            custom_changed = true;
        }
    }

    let working: Vec<&MirrorStatus> = statuses
        .iter()
        .filter(|s| s.online && s.catalog_available)
        .collect();

    let chosen = if force_rotate.unwrap_or(false) && working.len() > 1 {
        working
            .iter()
            .find(|s| s.mirror_url != current_active)
            .copied()
            .or_else(|| working.first().copied())
    } else {
        working.first().copied()
    };

    let (selected_mirror, switched) = if let Some(best) = chosen {
        let changed = best.mirror_url != current_active;
        if changed || custom_changed {
            settings.active_mirror = best.mirror_url.clone();
            let _ = state.storage.update_settings(&settings);
        }
        (best.mirror_url.clone(), changed)
    } else {
        if custom_changed {
            let _ = state.storage.update_settings(&settings);
        }
        (current_active, false)
    };

    Ok(SmartRotationResult {
        selected_mirror,
        switched,
        statuses,
    })
}

#[tauri::command]
pub async fn get_active_mirror(state: State<'_, AppState>) -> Result<String, String> {
    let settings = state.storage.get_settings().map_err(|e| e.to_string())?;
    Ok(settings.active_mirror)
}

#[tauri::command]
pub async fn set_active_mirror(state: State<'_, AppState>, mirror_url: String) -> Result<(), String> {
    let mut settings = state.storage.get_settings().map_err(|e| e.to_string())?;
    settings.active_mirror = MirrorManager::normalize_url(&mirror_url);
    state.storage.update_settings(&settings).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn open_captcha_window(app_handle: AppHandle, state: State<'_, AppState>, mirror_url: Option<String>) -> Result<(), String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = (app_handle, state, mirror_url);
        return Err("Captcha bridge window is not supported on TV/mobile".to_string());
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let target_url = if let Some(url) = mirror_url {
            url
        } else {
            state.storage.get_settings().map_err(|e| e.to_string())?.active_mirror
        };

        let parsed_url: url::Url = target_url.parse().map_err(|e: url::ParseError| e.to_string())?;
        let window_url = WebviewUrl::External(parsed_url);

        WebviewWindowBuilder::new(&app_handle, "captcha_bridge", window_url)
            .title("RDX — Перевірка захисту")
            .inner_size(860.0, 680.0)
            .resizable(true)
            .build()
            .map_err(|e| format!("Failed to open captcha window: {}", e))?;

        Ok(())
    }
}

// ==================== Parser & Streaming Commands ====================

async fn failover_to_best_mirror(state: &AppState, failed_mirror: &str) -> Option<String> {
    let mut settings = state.storage.get_settings().ok()?;
    let failed_norm = MirrorManager::normalize_url(failed_mirror);

    let mut extra = vec![MirrorManager::normalize_url(&settings.active_mirror)];
    for m in &settings.custom_mirrors {
        extra.push(m.clone());
    }

    let statuses = MirrorManager::discover_mirrors(state.client.clone(), &extra).await;

    // Persist any newly discovered working public mirrors into custom_mirrors
    let preset_set: Vec<String> = PRESET_MIRRORS.iter().map(|s| s.to_string()).collect();
    for st in &statuses {
        if st.online
            && st.catalog_available
            && !preset_set.contains(&st.mirror_url)
            && !settings.custom_mirrors.contains(&st.mirror_url)
        {
            settings.custom_mirrors.push(st.mirror_url.clone());
        }
    }

    let mut candidates: Vec<&MirrorStatus> = statuses
        .iter()
        .filter(|s| s.online && s.catalog_available && s.mirror_url != failed_norm)
        .collect();

    candidates.sort_by(|a, b| {
        b.stream_available
            .cmp(&a.stream_available)
            .then_with(|| b.health_score.cmp(&a.health_score))
            .then_with(|| a.latency_ms.cmp(&b.latency_ms))
    });

    let best = candidates.first()?;
    let best_url = best.mirror_url.clone();

    settings.active_mirror = best_url.clone();
    let _ = state.storage.update_settings(&settings);

    Some(best_url)
}

#[tauri::command]
pub async fn get_home_catalog(
    state: State<'_, AppState>,
    filter: Option<String>,
    genre: Option<String>,
    page: Option<u32>,
) -> Result<Vec<MediaCard>, String> {
    let mirror = state.storage.get_settings().map_err(|e| e.to_string())?.active_mirror;
    RezkaParser::get_home_catalog(&state.client, &mirror, filter.as_deref(), genre.as_deref(), page)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_category_catalog(
    state: State<'_, AppState>,
    category: String,
    genre: Option<String>,
    filter: Option<String>,
    page: Option<u32>,
) -> Result<Vec<MediaCard>, String> {
    let mirror = state.storage.get_settings().map_err(|e| e.to_string())?.active_mirror;
    RezkaParser::get_category_catalog(
        &state.client,
        &mirror,
        &category,
        genre.as_deref(),
        filter.as_deref(),
        page,
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn search_media(state: State<'_, AppState>, query: String) -> Result<Vec<MediaCard>, String> {
    let mirror = state.storage.get_settings().map_err(|e| e.to_string())?.active_mirror;
    RezkaParser::search_media(&state.client, &mirror, &query)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn search_autocomplete(state: State<'_, AppState>, query: String) -> Result<Vec<SearchItem>, String> {
    let mirror = state.storage.get_settings().map_err(|e| e.to_string())?.active_mirror;
    RezkaParser::search_autocomplete(&state.client, &mirror, &query)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_media_details(state: State<'_, AppState>, item_url: String) -> Result<MediaDetails, String> {
    let mirror = state.storage.get_settings().map_err(|e| e.to_string())?.active_mirror;
    let start = std::time::Instant::now();
    let initial_res = RezkaParser::get_media_details(&state.client, &mirror, &item_url).await;

    let mut details = match initial_res {
        Ok(d) => {
            MirrorManager::record_outcome(&mirror, true, start.elapsed().as_millis() as u64, None);
            d
        }
        Err(e) => {
            MirrorManager::record_outcome(&mirror, false, 0, None);
            if let Some(new_mirror) = failover_to_best_mirror(&state, &mirror).await {
                let retry_start = std::time::Instant::now();
                match RezkaParser::get_media_details(&state.client, &new_mirror, &item_url).await {
                    Ok(d) => {
                        MirrorManager::record_outcome(&new_mirror, true, retry_start.elapsed().as_millis() as u64, None);
                        d
                    }
                    Err(retry_err) => return Err(retry_err.to_string()),
                }
            } else {
                return Err(e.to_string());
            }
        }
    };

    if let Some(ref mut s) = details.initial_streams {
        crate::cdn::CdnSelector::optimize_stream(&state.client, s).await;
    }

    Ok(details)
}

#[tauri::command]
pub async fn get_stream(
    state: State<'_, AppState>,
    media_id: String,
    translator_id: Option<String>,
    season: Option<i32>,
    episode: Option<i32>,
    is_series: bool,
    referer_url: String,
) -> Result<StreamData, String> {
    let mirror = state.storage.get_settings().map_err(|e| e.to_string())?.active_mirror;
    let start = std::time::Instant::now();
    let initial_res = RezkaParser::get_stream(
        &state.client,
        &mirror,
        &media_id,
        translator_id.as_deref(),
        season,
        episode,
        is_series,
        &referer_url,
    )
    .await;

    let is_bad = match &initial_res {
        Ok(s) => s.qualities.is_empty() && !s.is_premium,
        Err(_) => true,
    };

    let mut stream = if !is_bad {
        MirrorManager::record_outcome(&mirror, true, start.elapsed().as_millis() as u64, Some(true));
        initial_res.map_err(|e| e.to_string())?
    } else {
        // Step A (Session Warmup on current mirror)
        let warmup_details = RezkaParser::get_media_details(&state.client, &mirror, &referer_url).await.ok();
        let retry_start = std::time::Instant::now();
        let step_a_res = RezkaParser::get_stream(
            &state.client,
            &mirror,
            &media_id,
            translator_id.as_deref(),
            season,
            episode,
            is_series,
            &referer_url,
        )
        .await;

        let step_a_bad = match &step_a_res {
            Ok(s) => s.qualities.is_empty() && !s.is_premium,
            Err(_) => true,
        };

        if !step_a_bad {
            MirrorManager::record_outcome(&mirror, true, retry_start.elapsed().as_millis() as u64, Some(true));
            step_a_res.map_err(|e| e.to_string())?
        } else if let Some(fallback) = warmup_details.and_then(|d| d.initial_streams).filter(|s| !s.qualities.is_empty() || s.is_premium) {
            MirrorManager::record_outcome(&mirror, true, retry_start.elapsed().as_millis() as u64, Some(true));
            fallback
        } else {
            // Step B (Zero-Downtime Mirror Failover)
            MirrorManager::record_outcome(&mirror, false, 0, Some(false));
            if let Some(new_mirror) = failover_to_best_mirror(&state, &mirror).await {
                let new_warmup_details = RezkaParser::get_media_details(&state.client, &new_mirror, &referer_url).await.ok();
                let step_b_start = std::time::Instant::now();
                let step_b_res = RezkaParser::get_stream(
                    &state.client,
                    &new_mirror,
                    &media_id,
                    translator_id.as_deref(),
                    season,
                    episode,
                    is_series,
                    &referer_url,
                )
                .await;

                match step_b_res {
                    Ok(s) if !s.qualities.is_empty() || s.is_premium => {
                        MirrorManager::record_outcome(&new_mirror, true, step_b_start.elapsed().as_millis() as u64, Some(true));
                        s
                    }
                    _ => {
                        if let Some(fallback) = new_warmup_details.and_then(|d| d.initial_streams).filter(|s| !s.qualities.is_empty() || s.is_premium) {
                            MirrorManager::record_outcome(&new_mirror, true, step_b_start.elapsed().as_millis() as u64, Some(true));
                            fallback
                        } else {
                            MirrorManager::record_outcome(&new_mirror, false, 0, Some(false));
                            return Err("Потоки відтворення недоступні для обраного перекладу".to_string());
                        }
                    }
                }
            } else {
                return Err(initial_res.err().map(|e| e.to_string()).unwrap_or_else(|| "Потоки недоступні".to_string()));
            }
        }
    };

    crate::cdn::CdnSelector::optimize_stream(&state.client, &mut stream).await;
    Ok(stream)
}

#[tauri::command]
pub async fn get_episodes(
    state: State<'_, AppState>,
    media_id: String,
    translator_id: String,
    referer_url: String,
) -> Result<EpisodesData, String> {
    let mirror = state.storage.get_settings().map_err(|e| e.to_string())?.active_mirror;
    let start = std::time::Instant::now();
    let initial_res = RezkaParser::get_episodes(
        &state.client,
        &mirror,
        &media_id,
        &translator_id,
        &referer_url,
    )
    .await;

    let (seasons, episodes, mut stream_data) = match initial_res {
        Ok(data) => {
            MirrorManager::record_outcome(&mirror, true, start.elapsed().as_millis() as u64, None);
            data
        }
        Err(e) => {
            MirrorManager::record_outcome(&mirror, false, 0, None);
            if let Some(new_mirror) = failover_to_best_mirror(&state, &mirror).await {
                let retry_start = std::time::Instant::now();
                match RezkaParser::get_episodes(
                    &state.client,
                    &new_mirror,
                    &media_id,
                    &translator_id,
                    &referer_url,
                )
                .await
                {
                    Ok(data) => {
                        MirrorManager::record_outcome(&new_mirror, true, retry_start.elapsed().as_millis() as u64, None);
                        data
                    }
                    Err(retry_err) => return Err(retry_err.to_string()),
                }
            } else {
                return Err(e.to_string());
            }
        }
    };

    if let Some(ref mut s) = stream_data {
        crate::cdn::CdnSelector::optimize_stream(&state.client, s).await;
    }

    Ok(EpisodesData {
        seasons,
        episodes,
        stream_data,
    })
}

#[tauri::command]
pub fn get_turbo_stream_url(state: State<'_, AppState>, raw_url: String) -> String {
    state.turbo.get_turbo_url(&raw_url)
}

#[tauri::command]
pub fn get_turbo_stats(state: State<'_, AppState>) -> crate::turbo::TurboStats {
    state.turbo.get_stats()
}

#[tauri::command]
pub async fn select_fastest_cdn(state: State<'_, AppState>, stream_url: String) -> Result<(String, u64), String> {
    Ok(crate::cdn::CdnSelector::select_fastest_cdn(&state.client, &stream_url).await)
}

// ==================== Window & Player Helper Commands ====================

#[tauri::command]
pub async fn set_fullscreen_mode(app_handle: AppHandle, enabled: bool) -> Result<bool, String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = (app_handle, enabled);
        return Ok(true);
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let window = app_handle
            .get_webview_window("main")
            .ok_or_else(|| "Main window not found".to_string())?;

        let _ = window.set_fullscreen(enabled);

        #[cfg(target_os = "linux")]
        {
            if std::env::var_os("NIRI_SOCKET").is_some() {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                if let (Ok(win_size), Ok(Some(monitor))) = (window.inner_size(), window.current_monitor()) {
                    let mon_size = monitor.size();
                    let is_currently_full = win_size.width >= mon_size.width.saturating_sub(2)
                        && win_size.height >= mon_size.height.saturating_sub(2);
                    if enabled && !is_currently_full {
                        let _ = std::process::Command::new("niri")
                            .args(["msg", "action", "fullscreen-window"])
                            .status();
                    } else if !enabled && is_currently_full {
                        let _ = std::process::Command::new("niri")
                            .args(["msg", "action", "fullscreen-window"])
                            .status();
                    }
                }
            }
        }

        Ok(enabled)
    }
}

#[tauri::command]
pub async fn start_drag_window(app_handle: AppHandle) -> Result<(), String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    if let Some(window) = app_handle.get_webview_window("main") {
        let _ = window.start_dragging();
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    let _ = app_handle;
    Ok(())
}

// ==================== TMDB Backdrop Commands ====================

#[tauri::command]
pub async fn get_backdrop(
    title: String,
    orig_title: Option<String>,
    year: Option<String>,
    media_type: Option<String>,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    Ok(state
        .tmdb
        .get_backdrop(
            &title,
            orig_title.as_deref(),
            year.as_deref(),
            media_type.as_deref(),
        )
        .await)
}

#[tauri::command]
pub async fn get_tmdb_recommendations(
    title: String,
    orig_title: Option<String>,
    year: Option<String>,
    media_type: Option<String>,
    exclude_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<MediaCard>, String> {
    let mirror = state
        .storage
        .get_settings()
        .map_err(|e| e.to_string())?
        .active_mirror;

    let cache_key = format!(
        "{}:{}:{}:{}:{}",
        mirror,
        title.trim(),
        orig_title.as_deref().unwrap_or("").trim(),
        year.as_deref().unwrap_or("").trim(),
        media_type.as_deref().unwrap_or("").trim()
    );

    if let Some(cached) = state.tmdb.get_cached_recommendations(&cache_key).await {
        return Ok(cached);
    }

    let recs = state
        .tmdb
        .get_recommendations_list(
            &title,
            orig_title.as_deref(),
            year.as_deref(),
            media_type.as_deref(),
        )
        .await;

    if recs.is_empty() {
        return Ok(vec![]);
    }

    let mut join_set = tokio::task::JoinSet::new();
    let exclude = exclude_id.unwrap_or_default();

    for (idx, rec) in recs.into_iter().enumerate() {
        let client = state.client.clone();
        let mirror_clone = mirror.clone();
        let exclude_clone = exclude.clone();
        let expected_type = media_type.clone();

        join_set.spawn(async move {
            let mut results = RezkaParser::search_media(&client, &mirror_clone, &rec.title)
                .await
                .unwrap_or_default();
            if results.is_empty() {
                if let Some(ref orig) = rec.orig_title {
                    results = RezkaParser::search_media(&client, &mirror_clone, orig)
                        .await
                        .unwrap_or_default();
                }
            }

            let best = results.into_iter().find(|card| {
                if !exclude_clone.is_empty() && card.id == exclude_clone {
                    return false;
                }
                if let Some(ref exp_t) = expected_type {
                    let is_card_series = card.entity_type.to_lowercase().contains("сериал")
                        || card.entity_type.to_lowercase().contains("серіал")
                        || card.url.contains("/series/");
                    if exp_t == "tv" && !is_card_series {
                        return false;
                    }
                    if exp_t == "movie" && is_card_series {
                        return false;
                    }
                }
                if let Some(ref rec_y) = rec.year {
                    if card.misc_info.contains(rec_y) {
                        return true;
                    }
                }
                true
            });

            best.map(|card| (idx, card))
        });
    }

    let mut matched: Vec<(usize, MediaCard)> = Vec::new();
    let mut seen_ids = std::collections::HashSet::new();
    while let Some(res) = join_set.join_next().await {
        if let Ok(Some((idx, card))) = res {
            if seen_ids.insert(card.id.clone()) {
                matched.push((idx, card));
            }
        }
    }

    matched.sort_by_key(|(idx, _)| *idx);
    let cards: Vec<MediaCard> = matched.into_iter().map(|(_, c)| c).collect();

    if !cards.is_empty() {
        state.tmdb.cache_recommendations(cache_key, cards.clone()).await;
    }

    Ok(cards)
}

// ==================== System & Clock Commands ====================

#[tauri::command]
pub fn get_system_time() -> String {
    chrono::Local::now().format("%H:%M").to_string()
}

// ==================== Native UI Audio Commands ====================

#[tauri::command]
pub fn play_ui_sound(sound_type: String) {
    #[cfg(not(target_os = "android"))]
    {
        crate::audio::play_ui_sound(&sound_type);
    }
    #[cfg(target_os = "android")]
    {
        let _ = sound_type;
    }
}



