//! Pseudo-terminals for the built-in terminal tabs: a login shell on a pty, its output read on the
//! crate's runtime and delivered as UTF-8 text (a multi-byte character split across reads is kept
//! back until it completes), input and resizes from TSX, and the foreground process's name for the
//! tab title, as Terminal.app shows it.

use std::cell::RefCell;
use std::ffi::c_void;
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::rc::Rc;

use nsh_core::prelude::*;
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tokio::sync::mpsc;

use crate::process::{EnvVar, runtime};

enum Event {
    Data(String),
    Exit(i32),
}

/// A shell on a pseudo-terminal: configure, listen, `start()`, `wait()`.
#[class]
pub struct Pty {
    shell: String,
    args: Vec<String>,
    cwd: String,
    cols: u16,
    rows: u16,
    env: Vec<EnvVar>,
    master: Option<Box<dyn MasterPty + Send>>,
    writer: Option<Box<dyn Write + Send>>,
    child: Option<Box<dyn Child + Send + Sync>>,
    inbox: Option<mpsc::UnboundedReceiver<Event>>,
    listeners: Rc<RefCell<Vec<Callback<String>>>>,
    pid: u32,
    started: bool,
}

#[class]
impl Pty {
    /// A terminal of `cols`×`rows` for `shell` (with `args`) in `cwd`, `env` added to the login environment.
    pub fn new(shell: String, args: Option<Vec<String>>, cwd: String, cols: u32, rows: u32, env: Option<Vec<EnvVar>>) -> Self {
        Pty {
            shell,
            args: args.unwrap_or_default(),
            cwd,
            cols: cols.clamp(2, 1000) as u16,
            rows: rows.clamp(1, 1000) as u16,
            env: env.unwrap_or_default(),
            master: None,
            writer: None,
            child: None,
            inbox: None,
            listeners: Rc::default(),
            pid: 0,
            started: false,
        }
    }

    /// Called with each chunk of output (while `wait()` runs).
    pub fn on_data(&mut self, #[args(text)] listener: Callback<String>) {
        self.listeners.borrow_mut().push(listener);
    }

    /// Opens the pty and starts the shell; its process id, or 0 when that failed.
    pub fn start(&mut self) -> u32 {
        if self.started {
            return self.pid;
        }
        self.started = true;
        let (events, inbox) = mpsc::unbounded_channel::<Event>();
        self.inbox = Some(inbox);
        let size = PtySize { rows: self.rows, cols: self.cols, pixel_width: 0, pixel_height: 0 };
        let pair = match native_pty_system().openpty(size) {
            Ok(pair) => pair,
            Err(error) => {
                let _ = events.send(Event::Data(format!("\r\n[TeaBranch] could not open a terminal: {error}\r\n")));
                let _ = events.send(Event::Exit(-1));
                return 0;
            }
        };
        let mut command = CommandBuilder::new(&self.shell);
        command.args(&self.args);
        command.cwd(&self.cwd);
        command.env_clear();
        for (name, value) in crate::process::login_environment() {
            command.env(name, value);
        }
        for EnvVar { name, value } in &self.env {
            command.env(name, value);
        }
        let child = match pair.slave.spawn_command(command) {
            Ok(child) => child,
            Err(error) => {
                let _ = events.send(Event::Data(format!("\r\n[TeaBranch] could not start {}: {error}\r\n", self.shell)));
                let _ = events.send(Event::Exit(-1));
                return 0;
            }
        };
        drop(pair.slave);
        self.pid = child.process_id().unwrap_or(0);
        let reader = match pair.master.try_clone_reader() {
            Ok(reader) => reader,
            Err(error) => {
                let _ = events.send(Event::Data(format!("\r\n[TeaBranch] terminal output unavailable: {error}\r\n")));
                return self.pid;
            }
        };
        self.writer = pair.master.take_writer().ok();
        self.master = Some(pair.master);
        self.child = Some(child);
        runtime().spawn_blocking(move || read_loop(reader, events));
        self.pid
    }

    /// Delivers output to the listeners until the shell ends; resolves with its exit code.
    pub async fn wait(this: Instance<Self>) -> i32 {
        let (inbox, listeners) = this.with_mut(|pty| (pty.inbox.take(), pty.listeners.clone()));
        let Some(mut inbox) = inbox else { return -1 };
        let mut code = -1;
        while let Some(event) = inbox.recv().await {
            match event {
                Event::Data(text) => listeners.borrow().iter().for_each(|l| l.post(text.clone())),
                Event::Exit(c) => {
                    code = c;
                    break;
                }
            }
        }
        // The reader saw EOF; the child's status is ready or nearly so.
        let child = this.with_mut(|pty| pty.child.take());
        if let Some(mut child) = child {
            let status = runtime().spawn_blocking(move || child.wait().ok()).await.ok().flatten();
            if let Some(status) = status {
                code = status.exit_code() as i32;
            }
        }
        code
    }

    /// Sends keystrokes or pasted text to the shell.
    pub fn write(&mut self, text: String) {
        if let Some(writer) = &mut self.writer {
            let _ = writer.write_all(text.as_bytes());
            let _ = writer.flush();
        }
    }

    /// Tells the shell its new size.
    pub fn resize(&mut self, cols: u32, rows: u32) {
        self.cols = cols.clamp(2, 1000) as u16;
        self.rows = rows.clamp(1, 1000) as u16;
        if let Some(master) = &self.master {
            let _ = master.resize(PtySize { rows: self.rows, cols: self.cols, pixel_width: 0, pixel_height: 0 });
        }
    }

    /// Hangs the shell up (SIGHUP to its group), then kills what is left.
    pub fn kill(&mut self) {
        if self.pid > 0 {
            // SAFETY: a signal to the group of a process this app started.
            unsafe { libc::killpg(self.pid as i32, libc::SIGHUP) };
        }
        if let Some(child) = &mut self.child {
            let _ = child.kill();
        }
        self.writer = None;
    }

    /// The name of the process in the foreground (zsh, node, claude, vim…), or the shell's.
    pub fn process_name(&self) -> String {
        let fallback = || self.shell.rsplit('/').next().unwrap_or("sh").to_owned();
        let Some(master) = &self.master else { return fallback() };
        let Some(fd) = master.as_raw_fd() else { return fallback() };
        // SAFETY: tcgetpgrp on a pty master this app owns; -1 means no foreground group.
        let pgid = unsafe { libc::tcgetpgrp(fd.as_raw_fd()) };
        if pgid <= 0 {
            return fallback();
        }
        process_path(pgid).and_then(|p| p.rsplit('/').next().map(str::to_owned)).unwrap_or_else(fallback)
    }

    /// The shell's process id.
    #[getter]
    pub fn pid(&self) -> u32 {
        self.pid
    }
}

fn read_loop(mut reader: Box<dyn Read + Send>, events: mpsc::UnboundedSender<Event>) {
    let mut buffer = [0u8; 8192];
    let mut carry: Vec<u8> = Vec::new();
    loop {
        let n = match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        carry.extend_from_slice(&buffer[..n]);
        // Everything up to the last complete character goes out; an incomplete tail waits.
        let valid = match std::str::from_utf8(&carry) {
            Ok(_) => carry.len(),
            Err(error) => error.valid_up_to(),
        };
        let keep = if valid < carry.len() && carry.len() - valid < 4 { carry.len() - valid } else { 0 };
        let text = String::from_utf8_lossy(&carry[..carry.len() - keep]).into_owned();
        carry.drain(..carry.len() - keep);
        if !text.is_empty() && events.send(Event::Data(text)).is_err() {
            break;
        }
    }
    if !carry.is_empty() {
        let _ = events.send(Event::Data(String::from_utf8_lossy(&carry).into_owned()));
    }
    let _ = events.send(Event::Exit(0));
}

unsafe extern "C" {
    fn proc_pidpath(pid: i32, buffer: *mut c_void, buffersize: u32) -> i32;
}

/// The executable's path of `pid`, through libproc.
fn process_path(pid: i32) -> Option<String> {
    let mut buffer = vec![0u8; 4096];
    // SAFETY: a buffer of the stated size; the call writes at most that many bytes.
    let n = unsafe { proc_pidpath(pid, buffer.as_mut_ptr() as *mut c_void, buffer.len() as u32) };
    (n > 0).then(|| String::from_utf8_lossy(&buffer[..n as usize]).into_owned())
}
