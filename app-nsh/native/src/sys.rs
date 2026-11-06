//! Small system calls TSX has no way to make: signals to processes and groups, a free-port check.

use std::net::{SocketAddr, TcpListener};

use nsh_core::prelude::*;

fn signal_number(name: &str) -> Option<i32> {
    Some(match name {
        "NONE" | "0" => 0,
        "SIGTERM" => libc::SIGTERM,
        "SIGKILL" => libc::SIGKILL,
        "SIGINT" => libc::SIGINT,
        "SIGHUP" => libc::SIGHUP,
        "SIGUSR1" => libc::SIGUSR1,
        "SIGUSR2" => libc::SIGUSR2,
        _ => return None,
    })
}

/// Signals and the like.
#[module]
pub struct Sys;

#[module]
impl Sys {
    /// Sends `signal` (`SIGTERM`, `SIGKILL`, `SIGINT`, `SIGHUP`, or `NONE` to only check) to one
    /// process; false when it is gone or the signal is unknown.
    pub fn signal(pid: u32, signal: String) -> bool {
        let Some(number) = signal_number(&signal) else { return false };
        // SAFETY: a plain kill(2); an unknown pid is ESRCH, reported as false.
        pid > 0 && unsafe { libc::kill(pid as i32, number) } == 0
    }

    /// The same, to a whole process group.
    pub fn signal_group(pgid: u32, signal: String) -> bool {
        let Some(number) = signal_number(&signal) else { return false };
        // SAFETY: a plain killpg(2); a gone group is ESRCH, reported as false.
        pgid > 0 && unsafe { libc::killpg(pgid as i32, number) } == 0
    }

    /// The app's own process id.
    pub fn pid() -> u32 {
        std::process::id()
    }

    /// The user's id.
    pub fn uid() -> u32 {
        // SAFETY: getuid(2) cannot fail.
        unsafe { libc::getuid() }
    }
}

/// Ports.
#[module]
pub struct Net;

#[module]
impl Net {
    /// Whether 127.0.0.1:`port` can be bound right now.
    pub fn port_free(port: u32) -> bool {
        TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port as u16))).is_ok()
    }
}
