//! TeaBranch's Rust base: what `App.tsx` imports from `teabranch/native`. The TSX side owns the UI
//! and the orchestration; this crate owns what QuickJS cannot do or the sandbox gates: child
//! processes with their environment, sockets that listen, synchronous files, the keychain,
//! notifications, the menu bar.

mod desktop;
mod fs;
mod http;
mod keychain;
mod process;
mod pty;
mod sys;

use nsh_core::prelude::*;

pub use crate::desktop::{Desktop, Dialog, Notify, Power};
pub use crate::fs::Fs;
pub use crate::http::HttpServer;
pub use crate::keychain::Keychain;
pub use crate::process::{Process, Shell};
pub use crate::pty::Pty;
pub use crate::sys::{Net, Sys};

/// The crate's UI set (`nsh.json` `"rust"`).
#[native_module("teabranch/native")]
fn native(registry: &mut Registry) {
    registry
        .class::<Process>()
        .class::<HttpServer>()
        .class::<Pty>()
        .module::<Shell>()
        .module::<Fs>()
        .module::<Keychain>()
        .module::<Sys>()
        .module::<Net>()
        .module::<Dialog>()
        .module::<Desktop>()
        .module::<Notify>()
        .module::<Power>();
}
