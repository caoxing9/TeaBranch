//! Child processes the app controls fully: the login shell's PATH plus the caller's variables, a
//! working directory, a process group of their own, stdin on demand, stdout and stderr read line by
//! line, and a kill of the whole group after a grace period. TSX's own `process.spawn` passes no
//! environment and is gated per binary, so agents, git and gh all come through here.
//!
//! Threads: the child's pipes are read on this crate's own tokio runtime (a class method called
//! from TSX runs outside nsh's runtime context); what they read goes through a channel to `wait`,
//! an async member polled on the engine thread, which is the only place a TSX callback may be
//! called from.

use std::cell::RefCell;
use std::collections::HashMap;
use std::os::unix::process::ExitStatusExt;
use std::process::Stdio;
use std::rc::Rc;
use std::sync::OnceLock;
use std::time::Duration;

use nsh_core::prelude::*;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;

/// One environment variable of a child.
#[derive(Debug, Clone, JsObject)]
pub struct EnvVar {
    /// The variable's name.
    pub name: String,
    /// Its value.
    pub value: String,
}

/// How to start a child.
#[derive(Debug, Clone, Default, JsObject)]
pub struct SpawnOptions {
    /// The working directory (the app's own when left out).
    pub cwd: Option<String>,
    /// Variables added to, or replacing, the login environment.
    pub env: Option<Vec<EnvVar>>,
    /// Keep stdin open for `write` (closed at once when left out).
    pub stdin: Option<bool>,
    /// Run `command` as a `/bin/sh -c` line, `args` appended as `$1…`.
    pub shell: Option<bool>,
}

/// Why a child ended.
#[derive(Debug, Clone, JsObject)]
pub struct Exit {
    /// The exit code, or null when a signal ended it.
    pub code: Option<i32>,
    /// The signal's name when one ended it (`SIGTERM`, `SIGKILL`…).
    pub signal: Option<String>,
    /// Set when the child could not be started at all.
    pub error: Option<String>,
}

impl Exit {
    fn failed(error: impl ToString) -> Self {
        Exit { code: None, signal: None, error: Some(error.to_string()) }
    }
}

enum Event {
    Stdout(String),
    Stderr(String),
    Exit(Exit),
}

enum Control {
    Write(String),
    End,
}

#[derive(Default)]
struct Listeners {
    stdout: Vec<Callback<String>>,
    stderr: Vec<Callback<String>>,
}

/// A child process: configure it, listen, `start()` it, then `wait()` for its end.
#[class]
pub struct Process {
    command: String,
    args: Vec<String>,
    options: SpawnOptions,
    listeners: Rc<RefCell<Listeners>>,
    control: Option<mpsc::UnboundedSender<Control>>,
    inbox: Option<mpsc::UnboundedReceiver<Event>>,
    pid: u32,
    started: bool,
}

#[class]
impl Process {
    /// A child to start: `command` with `args`, per `options`.
    pub fn new(command: String, args: Option<Vec<String>>, options: Option<SpawnOptions>) -> Self {
        Process {
            command,
            args: args.unwrap_or_default(),
            options: options.unwrap_or_default(),
            listeners: Rc::default(),
            control: None,
            inbox: None,
            pid: 0,
            started: false,
        }
    }

    /// Called with each complete line of stdout (while `wait()` runs).
    pub fn on_stdout(&mut self, #[args(line)] listener: Callback<String>) {
        self.listeners.borrow_mut().stdout.push(listener);
    }

    /// Called with each complete line of stderr (while `wait()` runs).
    pub fn on_stderr(&mut self, #[args(line)] listener: Callback<String>) {
        self.listeners.borrow_mut().stderr.push(listener);
    }

    /// Starts the child; its process id, or 0 when it could not start (`wait()` says why).
    pub fn start(&mut self) -> u32 {
        if self.started {
            return self.pid;
        }
        self.started = true;
        let (events, inbox) = mpsc::unbounded_channel::<Event>();
        let (control, mut commands) = mpsc::unbounded_channel::<Control>();
        self.inbox = Some(inbox);
        self.control = Some(control);

        let _runtime = runtime().enter();
        let mut child = match self.command_line().spawn() {
            Ok(child) => child,
            Err(error) => {
                let _ = events.send(Event::Exit(Exit::failed(error)));
                return 0;
            }
        };
        self.pid = child.id().unwrap_or(0);

        if let Some(stdout) = child.stdout.take() {
            let events = events.clone();
            runtime().spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if events.send(Event::Stdout(line)).is_err() {
                        break;
                    }
                }
            });
        }
        if let Some(stderr) = child.stderr.take() {
            let events = events.clone();
            runtime().spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if events.send(Event::Stderr(line)).is_err() {
                        break;
                    }
                }
            });
        }
        if let Some(mut stdin) = child.stdin.take() {
            runtime().spawn(async move {
                while let Some(command) = commands.recv().await {
                    match command {
                        Control::Write(text) => {
                            if stdin.write_all(text.as_bytes()).await.is_err() {
                                break;
                            }
                        }
                        Control::End => break,
                    }
                }
                let _ = stdin.shutdown().await;
            });
        }
        runtime().spawn(async move {
            let exit = match child.wait().await {
                Ok(status) => Exit { code: status.code(), signal: status.signal().map(signal_name), error: None },
                Err(error) => Exit::failed(error),
            };
            let _ = events.send(Event::Exit(exit));
        });
        self.pid
    }

    /// Delivers the child's lines to the listeners until it ends; resolves with why it ended.
    /// Call it once, right after `start()`.
    pub async fn wait(this: Instance<Self>) -> Exit {
        let (inbox, listeners) = this.with_mut(|process| (process.inbox.take(), process.listeners.clone()));
        let Some(mut inbox) = inbox else {
            return Exit::failed("wait() needs start() first, and runs once");
        };
        while let Some(event) = inbox.recv().await {
            let listeners = listeners.borrow();
            match event {
                Event::Stdout(line) => listeners.stdout.iter().for_each(|l| l.post(line.clone())),
                Event::Stderr(line) => listeners.stderr.iter().for_each(|l| l.post(line.clone())),
                Event::Exit(exit) => return exit,
            }
        }
        Exit::failed("the child's pipes closed without an exit")
    }

    /// Writes to the child's stdin (started with `stdin: true`).
    pub fn write(&mut self, text: String) {
        if let Some(control) = &self.control {
            let _ = control.send(Control::Write(text));
        }
    }

    /// Closes the child's stdin.
    pub fn end(&mut self) {
        if let Some(control) = &self.control {
            let _ = control.send(Control::End);
        }
    }

    /// Ends the child's whole process group: SIGTERM now, SIGKILL after `graceMs` (300 when left out).
    pub fn kill(&mut self, grace_ms: Option<u32>) {
        if self.pid == 0 {
            return;
        }
        let pgid = self.pid as i32;
        // SAFETY: a signal to a process group id this app started.
        unsafe { libc::killpg(pgid, libc::SIGTERM) };
        let grace = Duration::from_millis(grace_ms.unwrap_or(300) as u64);
        runtime().spawn(async move {
            tokio::time::sleep(grace).await;
            // SAFETY: as above; a group already gone is a harmless ESRCH.
            unsafe { libc::killpg(pgid, libc::SIGKILL) };
        });
    }

    /// Whether the child's process group still has a member.
    pub fn alive(&self) -> bool {
        // SAFETY: signal 0 only checks; ESRCH means the group is gone.
        self.pid != 0 && unsafe { libc::killpg(self.pid as i32, 0) } == 0
    }

    /// The child's process id (0 before `start()` or when it could not start).
    #[getter]
    pub fn pid(&self) -> u32 {
        self.pid
    }
}

impl Process {
    fn command_line(&self) -> Command {
        let mut command = if self.options.shell.unwrap_or(false) {
            // A GUI app inherits launchd's 256 descriptors: far too low for dev servers.
            let mut c = Command::new("/bin/sh");
            c.arg("-c").arg(format!("ulimit -n 10240 2>/dev/null; {}", self.command)).arg("sh").args(&self.args);
            c
        } else {
            let mut c = Command::new(&self.command);
            c.args(&self.args);
            c
        };
        if let Some(cwd) = &self.options.cwd {
            command.current_dir(cwd);
        }
        command.env_clear().envs(login_environment());
        for EnvVar { name, value } in self.options.env.iter().flatten() {
            command.env(name, value);
        }
        command
            .stdin(if self.options.stdin.unwrap_or(false) { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .kill_on_drop(false);
        command
    }
}

fn signal_name(signal: i32) -> String {
    match signal {
        libc::SIGHUP => "SIGHUP".to_owned(),
        libc::SIGINT => "SIGINT".to_owned(),
        libc::SIGKILL => "SIGKILL".to_owned(),
        libc::SIGTERM => "SIGTERM".to_owned(),
        libc::SIGSEGV => "SIGSEGV".to_owned(),
        libc::SIGABRT => "SIGABRT".to_owned(),
        n => format!("SIG{n}"),
    }
}

static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();

/// The crate's I/O runtime: pipes, timers and sockets, off the engine thread.
pub(crate) fn runtime() -> &'static tokio::runtime::Runtime {
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .worker_threads(2)
            .thread_name("teabranch-io")
            .build()
            .expect("tokio runtime")
    })
}

static LOGIN_ENVIRONMENT: OnceLock<HashMap<String, String>> = OnceLock::new();

/// The environment children get: the app's own, with PATH from the user's login shell so the
/// tools they installed (claude, gh, node…) are found when the app was started from the Dock.
pub(crate) fn login_environment() -> &'static HashMap<String, String> {
    LOGIN_ENVIRONMENT.get_or_init(|| {
        let mut env: HashMap<String, String> = std::env::vars().collect();
        if let Some(path) = login_path() {
            env.insert("PATH".to_owned(), path);
        }
        env
    })
}

/// PATH as the user's login shell sets it: zsh's interactive login (where .zshrc lives), then
/// bash's login, the last line of output in case a profile prints; None when both fail.
fn login_path() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_owned());
    let probe = |bin: &str, flag: &str| -> Option<String> {
        let output = std::process::Command::new(bin)
            .args([flag, "echo $PATH"])
            .stdin(Stdio::null())
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&output.stdout);
        let path = text.lines().last()?.trim().to_owned();
        (output.status.success() && path.contains('/')).then_some(path)
    };
    probe(&shell, "-lic").or_else(|| probe("/bin/bash", "-lc"))
}

/// The user's shell, for TSX to show and to pass on.
#[module]
pub struct Shell;

#[module]
impl Shell {
    /// PATH as children see it: the login shell's, resolved once.
    pub fn path() -> String {
        login_environment().get("PATH").cloned().unwrap_or_default()
    }

    /// The app's own value of `name`, or null.
    pub fn env(name: String) -> Option<String> {
        login_environment().get(&name).cloned()
    }
}
