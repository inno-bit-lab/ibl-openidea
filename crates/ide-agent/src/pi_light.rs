//! Pi light execution profile for commit suggestions (Unità 5 / Lane 4).
//!
//! Generates a standalone light launcher wrapper that enforces `--no-tools` and other
//! stripping flags, ensuring Pi runs in a strictly non-agentic, text-only profile.

use ide_core::{IdeError, IdeResult};
use std::path::{Path, PathBuf};

pub const PI_LIGHT_FLAGS: &[&str] =
    &["--no-tools", "--no-mcp", "--no-skills", "--no-extensions", "--no-context-files", "--no-prompt-templates"];

/// Resolves the absolute path to the `pi` CLI executable.
pub fn resolve_pi_executable() -> IdeResult<PathBuf> {
    let search = ide_core::process::shell_env()
        .find(|(k, _)| k == "PATH")
        .map(|(_, v)| v)
        .or_else(|| ide_core::process::host_var_os("PATH"))
        .unwrap_or_default();

    #[cfg(windows)]
    {
        for candidate in ["pi.cmd", "pi.exe", "pi.bat", "pi"] {
            if let Some(path) = ide_core::process::find_executable(candidate, &search) {
                return Ok(dunce::canonicalize(&path).unwrap_or(path));
            }
        }
    }

    #[cfg(not(windows))]
    {
        if let Some(path) = ide_core::process::find_executable("pi", &search) {
            return Ok(dunce::canonicalize(&path).unwrap_or(path));
        }
    }

    Err(IdeError::unavailable(
        "cannot find 'pi' executable in PATH. Ensure Pi is installed (`npm i -g @earendil-works/pi-coding-agent`)."
            .to_string(),
    ))
}

/// Atomically creates or ensures the existence of the lightweight `pi-light` wrapper script.
///
/// On Windows, creates `pi-light.cmd`; on Unix, creates `pi-light.sh` (marked executable).
pub fn ensure_pi_light_launcher(base_dir: &Path, _pi_exe: &Path) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(base_dir)?;

    #[cfg(windows)]
    let (launcher_name, script_content) =
        ("pi-light.cmd", format!("@echo off\r\n\"%PI_EXE%\" %* {}\r\n", PI_LIGHT_FLAGS.join(" ")));

    #[cfg(not(windows))]
    let (launcher_name, script_content) =
        ("pi-light.sh", format!("#!/bin/sh\nexec \"$PI_EXE\" \"$@\" {}\n", PI_LIGHT_FLAGS.join(" ")));

    let launcher_path = base_dir.join(launcher_name);
    let tmp_path = base_dir.join(format!(".tmp-launcher-{}", uuid::Uuid::new_v4()));

    std::fs::write(&tmp_path, script_content.as_bytes())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o755);
        let _ = std::fs::set_permissions(&tmp_path, perms);
    }

    std::fs::rename(&tmp_path, &launcher_path)?;
    Ok(launcher_path)
}

/// Prepares local settings in `cwd` to suppress banner messages (`quietStartup: true`)
/// and an empty agent directory to avoid contamination from global configurations.
pub fn prepare_pi_light_settings(cwd: &Path) -> std::io::Result<()> {
    let pi_dir = cwd.join(".pi");
    std::fs::create_dir_all(&pi_dir)?;
    let settings_file = pi_dir.join("settings.json");
    std::fs::write(&settings_file, b"{\n  \"quietStartup\": true\n}\n")?;

    let empty_agent_dir = cwd.join(".pi-agent-empty");
    std::fs::create_dir_all(&empty_agent_dir)?;

    Ok(())
}
