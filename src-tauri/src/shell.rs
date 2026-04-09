use std::process::Command;
use std::sync::OnceLock;

static USER_PATH: OnceLock<String> = OnceLock::new();

/// Resolve the user's full PATH by running their login shell.
/// macOS bundled apps don't inherit the shell PATH, so we need to
/// explicitly source it.
fn resolve_user_path() -> String {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());

    // Run the user's login shell to print PATH
    if let Ok(output) = Command::new(&shell)
        .args(["-lic", "echo $PATH"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
    {
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !path.is_empty() {
            eprintln!("[TeaBranch] Resolved user PATH from {}", shell);
            return path;
        }
    }

    // Fallback: try bash
    if shell != "/bin/bash" {
        if let Ok(output) = Command::new("/bin/bash")
            .args(["-lc", "echo $PATH"])
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
        {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                eprintln!("[TeaBranch] Resolved user PATH from /bin/bash");
                return path;
            }
        }
    }

    // Last resort: return current PATH
    eprintln!("[TeaBranch] Could not resolve user PATH, using current");
    std::env::var("PATH").unwrap_or_default()
}

/// Get the cached user PATH (resolved once on first call).
pub fn user_path() -> &'static str {
    USER_PATH.get_or_init(resolve_user_path)
}

/// Create a Command that runs a shell command string with the user's full PATH.
pub fn shell_command(cmd: &str) -> Command {
    let mut command = Command::new("sh");
    command.args(["-c", cmd]);
    command.env("PATH", user_path());
    command
}
