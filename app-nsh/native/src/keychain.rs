//! Secrets in the macOS keychain: the Teable token, a Feishu app secret, a Magpie key. Generic
//! passwords under one service name, one account per secret, as Electron's `safeStorage` kept
//! them encrypted on disk before.

use nsh_core::prelude::*;
use security_framework::passwords::{delete_generic_password, get_generic_password, set_generic_password};

const SERVICE: &str = "TeaBranch";

/// The keychain, as a small map of named secrets.
#[module]
pub struct Keychain;

#[module]
impl Keychain {
    /// The secret called `name`, or null when there is none.
    pub fn get(name: String) -> Result<Option<String>, String> {
        match get_generic_password(SERVICE, &name) {
            Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
            Err(error) if error.code() == -25300 => Ok(None), // errSecItemNotFound
            Err(error) => Err(error.to_string()),
        }
    }

    /// Stores `value` as the secret called `name`, replacing any before it.
    pub fn set(name: String, value: String) -> Result<(), String> {
        set_generic_password(SERVICE, &name, value.as_bytes()).map_err(|e| e.to_string())
    }

    /// Removes the secret called `name`; a missing one is fine.
    pub fn delete(name: String) -> Result<(), String> {
        match delete_generic_password(SERVICE, &name) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == -25300 => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}
