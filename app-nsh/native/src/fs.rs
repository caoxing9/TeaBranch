//! Synchronous files for TSX. QuickJS's own `fs/promises` is async and sandboxed to declared roots;
//! the app's stores, worktrees and logs were written against Node's sync calls, and a `#[module]`
//! function runs inside the TSX call, so these are the same calls with the same shape. Binary
//! content travels as base64.

use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use nsh_core::prelude::*;

/// What `stat` reports.
#[derive(Debug, Clone, JsObject)]
pub struct Stat {
    /// Size in bytes.
    pub size: f64,
    /// Last modification, milliseconds since the epoch.
    pub mtime_ms: f64,
    /// Creation (birth) time, milliseconds since the epoch, when known.
    pub birthtime_ms: Option<f64>,
    /// Unix mode bits.
    pub mode: u32,
    pub is_file: bool,
    pub is_directory: bool,
    pub is_symlink: bool,
}

/// One entry of a directory.
#[derive(Debug, Clone, JsObject)]
pub struct DirEntry {
    pub name: String,
    pub is_file: bool,
    pub is_directory: bool,
    pub is_symlink: bool,
}

fn err(path: &str, error: std::io::Error) -> String {
    let code = match error.kind() {
        std::io::ErrorKind::NotFound => "ENOENT",
        std::io::ErrorKind::PermissionDenied => "EACCES",
        std::io::ErrorKind::AlreadyExists => "EEXIST",
        _ => "EIO",
    };
    format!("{code}: {error}, '{path}'")
}

fn stat_of(path: &str, meta: fs::Metadata) -> Stat {
    let ms = |t: std::io::Result<std::time::SystemTime>| {
        t.ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64() * 1000.0)
    };
    let _ = path;
    Stat {
        size: meta.len() as f64,
        mtime_ms: ms(meta.modified()).unwrap_or(0.0),
        birthtime_ms: ms(meta.created()),
        mode: meta.permissions().mode(),
        is_file: meta.is_file(),
        is_directory: meta.is_dir(),
        is_symlink: meta.file_type().is_symlink(),
    }
}

/// Files, synchronously, Node's way.
#[module]
pub struct Fs;

#[module]
impl Fs {
    /// The file's text (UTF-8, lossy).
    pub fn read_file(path: String) -> Result<String, String> {
        fs::read(&path).map(|b| String::from_utf8_lossy(&b).into_owned()).map_err(|e| err(&path, e))
    }

    /// The file's bytes as base64.
    pub fn read_file_base64(path: String) -> Result<String, String> {
        fs::read(&path).map(|b| BASE64.encode(b)).map_err(|e| err(&path, e))
    }

    /// Writes `text`, creating or truncating the file; `mode` sets its permissions when given.
    pub fn write_file(path: String, text: String, mode: Option<u32>) -> Result<(), String> {
        fs::write(&path, text).map_err(|e| err(&path, e))?;
        if let Some(mode) = mode {
            fs::set_permissions(&path, fs::Permissions::from_mode(mode)).map_err(|e| err(&path, e))?;
        }
        Ok(())
    }

    /// Writes base64-encoded bytes, creating or truncating the file.
    pub fn write_file_base64(path: String, base64: String, mode: Option<u32>) -> Result<(), String> {
        let bytes = BASE64.decode(base64.as_bytes()).map_err(|e| format!("bad base64: {e}"))?;
        fs::write(&path, bytes).map_err(|e| err(&path, e))?;
        if let Some(mode) = mode {
            fs::set_permissions(&path, fs::Permissions::from_mode(mode)).map_err(|e| err(&path, e))?;
        }
        Ok(())
    }

    /// Appends `text`, creating the file if needed.
    pub fn append_file(path: String, text: String) -> Result<(), String> {
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .and_then(|mut f| f.write_all(text.as_bytes()))
            .map_err(|e| err(&path, e))
    }

    /// Whether anything is at `path`.
    pub fn exists(path: String) -> bool {
        Path::new(&path).exists()
    }

    /// Makes the directory, and its parents when `recursive`; an existing one is fine then.
    pub fn mkdir(path: String, recursive: Option<bool>) -> Result<(), String> {
        let result = if recursive.unwrap_or(true) { fs::create_dir_all(&path) } else { fs::create_dir(&path) };
        result.map_err(|e| err(&path, e))
    }

    /// The directory's entries, with their kinds.
    pub fn readdir(path: String) -> Result<Vec<DirEntry>, String> {
        let mut entries = Vec::new();
        for entry in fs::read_dir(&path).map_err(|e| err(&path, e))? {
            let entry = entry.map_err(|e| err(&path, e))?;
            let kind = entry.file_type().map_err(|e| err(&path, e))?;
            entries.push(DirEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                is_file: kind.is_file(),
                is_directory: kind.is_dir(),
                is_symlink: kind.is_symlink(),
            });
        }
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(entries)
    }

    /// The file's metadata, following symlinks.
    pub fn stat(path: String) -> Result<Stat, String> {
        fs::metadata(&path).map(|m| stat_of(&path, m)).map_err(|e| err(&path, e))
    }

    /// The file's metadata, of the link itself.
    pub fn lstat(path: String) -> Result<Stat, String> {
        fs::symlink_metadata(&path).map(|m| stat_of(&path, m)).map_err(|e| err(&path, e))
    }

    /// Removes a file, or a directory tree when `recursive`; with `force`, a missing path is fine.
    pub fn rm(path: String, recursive: Option<bool>, force: Option<bool>) -> Result<(), String> {
        let target = Path::new(&path);
        let result = match fs::symlink_metadata(target) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && force.unwrap_or(false) => return Ok(()),
            Err(e) => Err(e),
            Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {
                if recursive.unwrap_or(false) { fs::remove_dir_all(target) } else { fs::remove_dir(target) }
            }
            Ok(_) => fs::remove_file(target),
        };
        result.map_err(|e| err(&path, e))
    }

    /// Moves `from` to `to`, replacing `to`.
    pub fn rename(from: String, to: String) -> Result<(), String> {
        fs::rename(&from, &to).map_err(|e| err(&from, e))
    }

    /// Copies one file.
    pub fn copy_file(from: String, to: String) -> Result<(), String> {
        fs::copy(&from, &to).map(|_| ()).map_err(|e| err(&from, e))
    }

    /// Sets the Unix mode bits.
    pub fn chmod(path: String, mode: u32) -> Result<(), String> {
        fs::set_permissions(&path, fs::Permissions::from_mode(mode)).map_err(|e| err(&path, e))
    }

    /// The canonical, symlink-free path.
    pub fn realpath(path: String) -> Result<String, String> {
        fs::canonicalize(&path).map(|p| p.to_string_lossy().into_owned()).map_err(|e| err(&path, e))
    }

    /// What a symlink points at.
    pub fn readlink(path: String) -> Result<String, String> {
        fs::read_link(&path).map(|p| p.to_string_lossy().into_owned()).map_err(|e| err(&path, e))
    }

    /// Makes a symlink at `path` pointing at `target`.
    pub fn symlink(target: String, path: String) -> Result<(), String> {
        std::os::unix::fs::symlink(&target, &path).map_err(|e| err(&path, e))
    }

    /// A fresh directory under the system's temporary one, named `prefix` plus random letters.
    pub fn mkdtemp(prefix: String) -> Result<String, String> {
        let base = std::env::temp_dir();
        for _ in 0..64 {
            let suffix: String = (0..6)
                .map(|_| {
                    let n = rand_byte() % 36;
                    (if n < 10 { b'0' + n } else { b'a' + n - 10 }) as char
                })
                .collect();
            let dir = base.join(format!("{prefix}{suffix}"));
            match fs::create_dir(&dir) {
                Ok(()) => return Ok(dir.to_string_lossy().into_owned()),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(err(&dir.to_string_lossy(), e)),
            }
        }
        Err("mkdtemp: no free name".to_owned())
    }

    /// The user's home directory.
    pub fn home_dir() -> String {
        std::env::var("HOME").unwrap_or_else(|_| "/".to_owned())
    }

    /// The system's temporary directory.
    pub fn tmp_dir() -> String {
        std::env::temp_dir().to_string_lossy().into_owned()
    }
}

fn rand_byte() -> u8 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
    let mixed = nanos ^ (std::process::id().wrapping_mul(2654435761)) ^ NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    (mixed ^ (mixed >> 13) ^ (mixed >> 7)) as u8
}

static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
