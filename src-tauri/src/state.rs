use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Running,
    Stopped,
    Building,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchEnvironment {
    pub branch_name: String,
    pub worktree_path: Option<String>,
    pub port: Option<u16>,
    pub backend_port: Option<u16>,
    pub socket_port: Option<u16>,
    pub status: Status,
    pub start_command: Option<String>,
    pub database_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    pub name: String,
    pub is_current: bool,
    pub environment: Option<BranchEnvironment>,
    /// Whether this worktree was created/managed by BranchPilot
    pub managed: bool,
    /// Filesystem path of the worktree
    pub worktree_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub project_path: Option<String>,
    pub base_port: u16,
    pub default_start_command: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            project_path: None,
            base_port: 3001,
            default_start_command: "npm run dev".to_string(),
        }
    }
}

pub struct AppState {
    pub settings: AppSettings,
    pub environments: HashMap<String, BranchEnvironment>,
    pub pids: HashMap<String, u32>,
    pub logs: HashMap<String, VecDeque<String>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            settings: AppSettings::default(),
            environments: HashMap::new(),
            pids: HashMap::new(),
            logs: HashMap::new(),
        }
    }

    pub fn project_path(&self) -> Option<PathBuf> {
        self.settings.project_path.as_ref().map(PathBuf::from)
    }

}

pub type SharedState = Mutex<AppState>;

pub struct SettingsStore;

impl SettingsStore {
    fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
        let dir = app
            .path()
            .app_config_dir()
            .map_err(|e| format!("Failed to get app config dir: {}", e))?;
        Ok(dir.join("settings.json"))
    }

    pub fn load(app: &AppHandle) -> AppSettings {
        let path = match Self::config_path(app) {
            Ok(p) => p,
            Err(_) => return AppSettings::default(),
        };
        match std::fs::read_to_string(&path) {
            Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
            Err(_) => AppSettings::default(),
        }
    }

    pub fn save(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
        let path = Self::config_path(app)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create config dir: {}", e))?;
        }
        let json = serde_json::to_string_pretty(settings)
            .map_err(|e| format!("Failed to serialize settings: {}", e))?;
        std::fs::write(&path, json)
            .map_err(|e| format!("Failed to write settings: {}", e))?;
        Ok(())
    }
}
