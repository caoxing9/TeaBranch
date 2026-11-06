//! Desktop services Electron used to provide: file dialogs, opening and revealing paths, user
//! notifications, keeping the Mac awake. Dialogs and paths go through nsh's own services (an
//! async module function runs as a task of the core, where they may be awaited); the rest is
//! macOS directly.

use std::ffi::{CString, c_char, c_void};
use std::sync::Mutex;

use nsh_core::file_dialog::OpenDialog;
use nsh_core::prelude::*;

/// File dialogs.
#[module]
pub struct Dialog;

#[module]
impl Dialog {
    /// Shows the system's open dialog; resolves with the paths picked, empty when cancelled.
    pub async fn pick_paths(folders: bool, multiple: bool, title: Option<String>) -> Result<Vec<String>, String> {
        let mut dialog = if folders { OpenDialog::folders() } else { OpenDialog::files() }.multiple(multiple);
        if let Some(title) = title {
            dialog = dialog.title(title.clone()).button_label(title);
        }
        let picked = pick_paths(dialog).await?;
        Ok(picked.unwrap_or_default().into_iter().map(|p| p.to_string_lossy().into_owned()).collect())
    }
}

/// Paths in the Finder and their default apps.
#[module]
pub struct Desktop;

#[module]
impl Desktop {
    /// Opens the file or folder in its default app.
    pub async fn open_path(path: String) -> Result<(), String> {
        nsh_core::prelude::open_path(path).await
    }

    /// Shows the item selected in the Finder.
    pub async fn reveal_path(path: String) -> Result<(), String> {
        nsh_core::prelude::reveal_path(path).await
    }
}

/// User notifications. Until the app is a signed bundle, through `osascript`, which every macOS
/// has and which needs no bundle identifier; a bundled app can switch to UNUserNotificationCenter.
#[module]
pub struct Notify;

#[module]
impl Notify {
    /// Posts a notification; `sound` names a system sound (`Glass`) or is left out.
    pub fn show(title: String, body: String, sound: Option<String>) {
        let escape = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
        let mut script = format!("display notification \"{}\" with title \"{}\"", escape(&body), escape(&title));
        if let Some(sound) = sound {
            script.push_str(&format!(" sound name \"{}\"", escape(&sound)));
        }
        let _ = std::process::Command::new("/usr/bin/osascript")
            .arg("-e")
            .arg(script)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
    }
}

type CFStringRef = *const c_void;
type CFAllocatorRef = *const c_void;

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFStringCreateWithCString(alloc: CFAllocatorRef, string: *const c_char, encoding: u32) -> CFStringRef;
    fn CFRelease(cf: *const c_void);
}

#[link(name = "IOKit", kind = "framework")]
unsafe extern "C" {
    fn IOPMAssertionCreateWithName(kind: CFStringRef, level: u32, name: CFStringRef, id: *mut u32) -> i32;
    fn IOPMAssertionRelease(id: u32) -> i32;
}

const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
const K_IOPM_ASSERTION_LEVEL_ON: u32 = 255;

static ASSERTION: Mutex<Option<u32>> = Mutex::new(None);

/// Sleep prevention, as Electron's `powerSaveBlocker('prevent-app-suspension')`.
#[module]
pub struct Power;

#[module]
impl Power {
    /// Keeps the Mac from idle-sleeping while `on`; releases it when off.
    pub fn keep_awake(on: bool) -> bool {
        let mut held = ASSERTION.lock().unwrap_or_else(|e| e.into_inner());
        match (on, *held) {
            (true, None) => {
                let kind = CString::new("PreventUserIdleSystemSleep").unwrap();
                let name = CString::new("TeaBranch keeps its agents running").unwrap();
                let mut id: u32 = 0;
                // SAFETY: valid C strings; the CFStrings are released after the call copies them.
                let ok = unsafe {
                    let kind = CFStringCreateWithCString(std::ptr::null(), kind.as_ptr(), K_CF_STRING_ENCODING_UTF8);
                    let name = CFStringCreateWithCString(std::ptr::null(), name.as_ptr(), K_CF_STRING_ENCODING_UTF8);
                    let status = IOPMAssertionCreateWithName(kind, K_IOPM_ASSERTION_LEVEL_ON, name, &mut id);
                    CFRelease(kind);
                    CFRelease(name);
                    status == 0
                };
                if ok {
                    *held = Some(id);
                }
                ok
            }
            (false, Some(id)) => {
                // SAFETY: an id this module created.
                unsafe { IOPMAssertionRelease(id) };
                *held = None;
                true
            }
            _ => true,
        }
    }

    /// Whether an assertion is held.
    pub fn awake() -> bool {
        ASSERTION.lock().map(|h| h.is_some()).unwrap_or(false)
    }
}
