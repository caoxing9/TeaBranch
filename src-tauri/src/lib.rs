mod commands;
mod git;
mod process;
pub mod shell;
mod state;
mod tray;
mod watcher;

use tauri::Manager;

use state::{AppState, SettingsStore, SharedState};
use std::sync::Mutex;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Mutex::new(AppState::new()) as SharedState)
        .setup(|app| {
            tray::setup_tray(app)?;
            // Load persisted settings
            let saved = SettingsStore::load(app.handle());
            let state = app.state::<SharedState>();
            let mut s = state.lock().unwrap();
            s.settings = saved;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::git::list_branches,
            commands::git::remove_worktree,
            commands::git::create_worktree,
            commands::git::open_in_vscode,
            commands::git::open_in_terminal,
            commands::git::list_worktree_db_info,
            commands::service::start_branch,
            commands::service::stop_branch,
            commands::service::get_environments,
            commands::service::get_branch_logs,
            commands::service::open_preview_window,
            commands::service::get_worktree_env,
            commands::service::update_worktree_env,
            commands::settings::get_settings,
            commands::settings::set_project_path,
            commands::settings::update_settings,
            commands::ngrok::start_ngrok,
            commands::ngrok::stop_ngrok,
            commands::ngrok::get_ngrok_status,
            commands::ngrok::get_ngrok_logs,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Hide the window instead of closing it; quit via Cmd+Q or tray menu
                window.hide().unwrap_or_default();
                api.prevent_close();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let state = app.state::<SharedState>();
                process::manager::cleanup_all(&state);
            }
        });
}
