//! Agents and how to launch their ACP servers: the built-in ones, plus user-defined
//! agents from `<config>/agents/<id>.toml`.

use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ProviderSpec {
    pub id: String,
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    /// How to sign in when the agent reports it needs authentication.
    pub login_hint: String,
}

/// `(id, name, command line, sign-in hint)`. npm adapters are pinned so a session's
/// protocol does not change under the user.
const BUILTIN: &[(&str, &str, &[&str], &str)] = &[
    (
        "claude",
        "Claude Code",
        &["npx", "-y", "@agentclientprotocol/claude-agent-acp@0.97.0"],
        "Run `claude` in a terminal and sign in.",
    ),
    ("codex", "Codex", &["npx", "-y", "@agentclientprotocol/codex-acp@2.3.0"], "Run `codex login` in a terminal."),
    ("gemini", "Gemini CLI", &["gemini", "--experimental-acp"], "Run `gemini` in a terminal and sign in."),
    ("copilot", "GitHub Copilot", &["copilot", "--acp"], "Run `copilot` in a terminal and sign in."),
    ("agy", "Google Antigravity", &["agy_acp_server"], "Sign in with Google Antigravity first."),
    ("pi", "pi ACP", &["npx", "-y", "pi-acp@0.0.34"], "Run `pi` in a terminal and sign in."),
    ("cursor", "Cursor", &["cursor-agent", "acp"], "Run `cursor-agent login` in a terminal."),
    ("opencode", "OpenCode", &["opencode", "acp"], "Run `opencode auth login` in a terminal."),
    ("qwen", "Qwen Code", &["qwen", "--experimental-acp"], "Run `qwen` in a terminal and sign in."),
    ("kimi", "Kimi CLI", &["kimi", "acp"], "Run `kimi` in a terminal and sign in."),
    ("goose", "Goose", &["goose", "acp"], "Run `goose configure` in a terminal."),
    ("auggie", "Auggie", &["auggie", "--acp"], "Run `auggie login` in a terminal."),
    ("kiro", "Kiro", &["kiro-cli", "acp"], "Run `kiro-cli login` in a terminal."),
    ("vibe", "Mistral Vibe", &["vibe-acp"], "Run `vibe` in a terminal and sign in."),
];

fn builtins() -> Vec<ProviderSpec> {
    BUILTIN
        .iter()
        .map(|(id, name, cmd, hint)| ProviderSpec {
            id: (*id).into(),
            name: (*name).into(),
            command: cmd[0].into(),
            args: cmd[1..].iter().map(|a| (*a).to_owned()).collect(),
            env: Vec::new(),
            login_hint: (*hint).into(),
        })
        .collect()
}

#[derive(Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct CustomAgent {
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    command: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    args: Vec<String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    env: HashMap<String, String>,
}

/// Built-in agents, then the `*.toml` agents of `custom_dir`; a custom agent with a
/// built-in id replaces it.
pub(crate) fn load(custom_dir: Option<&Path>) -> Vec<ProviderSpec> {
    let mut specs = builtins();
    let mut files: Vec<PathBuf> = custom_dir
        .and_then(|d| std::fs::read_dir(d).ok())
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "toml"))
        .collect();
    files.sort();
    for path in files {
        let Some(id) = path.file_stem().and_then(|s| s.to_str()).map(str::to_owned) else { continue };
        let parsed = std::fs::read_to_string(&path)
            .map_err(|e| e.to_string())
            .and_then(|t| toml::from_str::<CustomAgent>(&t).map_err(|e| e.to_string()));
        let agent = match parsed {
            Ok(a) => a,
            Err(e) => {
                tracing::warn!("skipping agent {}: {e}", path.display());
                continue;
            }
        };
        let mut env: Vec<(String, String)> = agent.env.into_iter().collect();
        env.sort();
        let spec = ProviderSpec {
            name: agent.name.unwrap_or_else(|| id.clone()),
            command: agent.command,
            args: agent.args,
            env,
            login_hint: "Sign in with the agent's own command line first.".into(),
            id,
        };
        match specs.iter_mut().find(|s| s.id == spec.id) {
            Some(existing) => *existing = spec,
            None => specs.push(spec),
        }
    }
    specs
}

/// Saves or clears custom CLI arguments for `id` in `<custom_dir>/<id>.toml`.
pub(crate) fn set_custom_args(custom_dir: &Path, id: &str, extra_args: &[String]) -> std::io::Result<()> {
    let cleaned: Vec<String> = extra_args.iter().map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()).collect();
    let file = custom_dir.join(format!("{id}.toml"));
    let builtin = builtins().into_iter().find(|b| b.id == id);
    let existing_file = std::fs::read_to_string(&file)
        .ok()
        .and_then(|t| toml::from_str::<CustomAgent>(&t).ok());

    let custom = match (builtin, existing_file) {
        (Some(b), existing) => {
            let has_custom_overrides = existing.as_ref().is_some_and(|e| {
                !e.env.is_empty()
                    || e.command != b.command
                    || e.name.as_deref().is_some_and(|n| n != b.name)
            });
            if cleaned.is_empty() && !has_custom_overrides {
                if file.exists() {
                    let _ = std::fs::remove_file(&file);
                }
                return Ok(());
            }
            let mut args = b.args;
            args.extend(cleaned);
            CustomAgent {
                name: existing.as_ref().and_then(|e| e.name.clone()).or(Some(b.name)),
                command: existing.as_ref().map_or(b.command, |e| e.command.clone()),
                args,
                env: existing.map_or_else(HashMap::new, |e| e.env),
            }
        }
        (None, Some(mut existing)) => {
            existing.args = cleaned;
            existing
        }
        (None, None) => {
            return Err(std::io::Error::new(std::io::ErrorKind::NotFound, "unknown agent"));
        }
    };
    std::fs::create_dir_all(custom_dir)?;
    let text = toml::to_string_pretty(&custom).map_err(std::io::Error::other)?;
    std::fs::write(file, text)
}

fn search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> =
        std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from) {
        for rel in [".local/bin", ".cargo/bin", "AppData/Roaming/npm", "AppData/Local/pnpm", ".bun/bin", ".volta/bin"] {
            dirs.push(home.join(rel));
        }
    }
    #[cfg(windows)]
    {
        if let Some(appdata) = std::env::var_os("APPDATA").map(PathBuf::from) {
            dirs.push(appdata.join("npm"));
        }
        for d in [r"C:\Program Files\nodejs", r"C:\Program Files\Git\bin", r"C:\Program Files\Git\usr\bin"] {
            dirs.push(PathBuf::from(d));
        }
    }
    dirs
}

fn find_agy_in_versions_dir(root: &Path) -> Option<PathBuf> {
    let bin = if cfg!(windows) { "agy_acp_server.exe" } else { "agy_acp_server" };
    let direct = root.join(bin);
    if is_executable(&direct) {
        return Some(direct);
    }
    let mut versions: Vec<PathBuf> = std::fs::read_dir(root)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    versions.sort();
    versions.into_iter().rev().map(|v| v.join(bin)).find(|p| is_executable(p))
}

fn agy_search_roots(managed: Option<&Path>, home: Option<&Path>, exe_dir: Option<&Path>) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(m) = managed {
        roots.push(m.join("antigravity-acp"));
    }
    if let Some(h) = home {
        for base in [
            h.join("AppData").join("Local"),
            h.join("AppData").join("Roaming"),
            h.join(".local").join("share"),
            h.join("Library").join("Application Support"),
        ] {
            roots.push(base.join("JetBrains"));
        }
    }
    if let Some(dir) = exe_dir {
        roots.push(dir.join("acp-agents").join("antigravity-acp"));
        roots.push(dir.to_path_buf());
    }
    roots
}

fn find_agy_acp_server(managed_agents_dir: Option<&Path>) -> Option<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from);
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf));
    for root in agy_search_roots(managed_agents_dir, home.as_deref(), exe_dir.as_deref()) {
        if root.file_name().is_some_and(|n| n == "JetBrains") {
            if let Ok(jb_dirs) = std::fs::read_dir(&root) {
                let mut jb: Vec<PathBuf> = jb_dirs.flatten().map(|e| e.path()).collect();
                jb.sort();
                for dir in jb.into_iter().rev() {
                    if let Some(found) = find_agy_in_versions_dir(&dir.join("acp-agents").join("antigravity-acp")) {
                        return Some(found);
                    }
                }
            }
        } else if let Some(found) = find_agy_in_versions_dir(&root) {
            return Some(found);
        }
    }
    None
}

pub(crate) fn resolve_executable(command: &str, managed_agents_dir: Option<&Path>) -> Option<PathBuf> {
    let p = Path::new(command);
    let exts: &[&str] = if cfg!(windows) { &["exe", "cmd", "bat"] } else { &[] };
    if p.components().count() > 1 {
        if is_executable(p) {
            return Some(p.to_path_buf());
        }
        if p.extension().is_none() {
            for ext in exts {
                let with_ext = p.with_extension(ext);
                if is_executable(&with_ext) {
                    return Some(with_ext);
                }
            }
        }
        if p.file_stem().and_then(|s| s.to_str()) == Some("agy_acp_server") {
            return find_agy_acp_server(managed_agents_dir);
        }
        return None;
    }
    for dir in search_dirs() {
        let candidate = dir.join(command);
        if cfg!(windows) && candidate.extension().is_none() {
            for ext in exts {
                let with_ext = candidate.with_extension(ext);
                if is_executable(&with_ext) {
                    return Some(with_ext);
                }
            }
        }
        if is_executable(&candidate) {
            return Some(candidate);
        }
        if !cfg!(windows) {
            for ext in exts {
                let with_ext = candidate.with_extension(ext);
                if is_executable(&with_ext) {
                    return Some(with_ext);
                }
            }
        }
    }
    if matches!(command, "agy_acp_server" | "agy_acp_server.exe") {
        return find_agy_acp_server(managed_agents_dir);
    }
    None
}

/// Resolves the command and argument list to pass to `Command::new`.
/// On Windows, `npx` is resolved either to a native `npx.exe` shim or to `node.exe` + `npx-cli.js`
/// so `cmd.exe` never mangles special characters in arguments.
pub(crate) fn resolve_spawn(spec: &ProviderSpec, managed_agents_dir: Option<&Path>) -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        let is_npx = spec.command.eq_ignore_ascii_case("npx")
            || Path::new(&spec.command)
                .file_stem()
                .and_then(|s| s.to_str())
                .is_some_and(|s| s.eq_ignore_ascii_case("npx"));
        if is_npx {
            for dir in search_dirs() {
                let npx_exe = dir.join("npx.exe");
                if is_executable(&npx_exe) {
                    return (npx_exe.to_string_lossy().into_owned(), spec.args.clone());
                }
            }
            for dir in search_dirs() {
                let node_exe = dir.join("node.exe");
                let npx_cli = dir.join("node_modules").join("npm").join("bin").join("npx-cli.js");
                if is_executable(&node_exe) && npx_cli.is_file() {
                    let mut args = Vec::with_capacity(spec.args.len() + 1);
                    args.push(npx_cli.to_string_lossy().into_owned());
                    args.extend(spec.args.iter().cloned());
                    return (node_exe.to_string_lossy().into_owned(), args);
                }
            }
        }
    }
    match resolve_executable(&spec.command, managed_agents_dir) {
        Some(path) => (path.to_string_lossy().into_owned(), spec.args.clone()),
        None => (spec.command.clone(), spec.args.clone()),
    }
}

/// Whether `command` resolves to an executable (a path, or a name on `PATH`).
pub(crate) fn installed(command: &str, managed_agents_dir: Option<&Path>) -> bool {
    resolve_executable(command, managed_agents_dir).is_some()
}

fn is_executable(p: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        p.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        p.is_file()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_agents_extend_and_override_the_builtins() {
        let dir = tempfile::tempdir().unwrap();
        let write = |name: &str, text: &str| std::fs::write(dir.path().join(name), text).unwrap();
        write("mine.toml", "name = \"Mine\"\ncommand = \"/opt/mine\"\nargs = [\"acp\"]\n[env]\nK = \"v\"\n");
        write("gemini.toml", "command = \"gemini\"\nargs = [\"--acp\"]\n");
        write("broken.toml", "nope = 1\n");
        let specs = load(Some(dir.path()));
        let mine = specs.iter().find(|s| s.id == "mine").unwrap();
        assert_eq!((mine.name.as_str(), mine.command.as_str()), ("Mine", "/opt/mine"));
        assert_eq!(mine.env, vec![("K".to_owned(), "v".to_owned())]);
        let gemini = specs.iter().find(|s| s.id == "gemini").unwrap();
        assert_eq!((gemini.name.as_str(), gemini.args.as_slice()), ("gemini", &["--acp".to_owned()][..]));
        assert!(specs.iter().any(|s| s.id == "agy" && s.name == "Google Antigravity"));
        assert!(specs.iter().any(|s| s.id == "pi" && s.name == "pi ACP"));
        assert!(!specs.iter().any(|s| s.id == "broken"));
        assert_eq!(specs.iter().filter(|s| s.id == "claude").count(), 1);
        assert!(!installed("/definitely/not/here", None));
        assert!(installed("sh", None));
    }

    #[test]
    fn set_custom_args_persists_and_resets_builtin_and_custom_agents() {
        let dir = tempfile::tempdir().unwrap();
        set_custom_args(dir.path(), "codex", &["--full-auto".into()]).unwrap();
        let specs = load(Some(dir.path()));
        let codex = specs.iter().find(|s| s.id == "codex").unwrap();
        assert_eq!(codex.args, ["-y", "@agentclientprotocol/codex-acp@2.3.0", "--full-auto"]);

        // Calling again replaces previous custom args instead of appending.
        set_custom_args(dir.path(), "codex", &["--sandbox".into(), "read-only".into()]).unwrap();
        let specs = load(Some(dir.path()));
        let codex = specs.iter().find(|s| s.id == "codex").unwrap();
        assert_eq!(codex.args, ["-y", "@agentclientprotocol/codex-acp@2.3.0", "--sandbox", "read-only"]);

        set_custom_args(dir.path(), "codex", &[]).unwrap();
        assert!(!dir.path().join("codex.toml").exists());
        let specs = load(Some(dir.path()));
        let codex = specs.iter().find(|s| s.id == "codex").unwrap();
        assert_eq!(codex.args, ["-y", "@agentclientprotocol/codex-acp@2.3.0"]);

        // Builtin agent with custom env preserves env when updating and clearing args.
        std::fs::write(
            dir.path().join("codex.toml"),
            "command = \"npx\"\nargs = [\"-y\", \"@agentclientprotocol/codex-acp@2.3.0\"]\n[env]\nOPENAI_API_KEY = \"sk-test\"\n",
        )
        .unwrap();
        set_custom_args(dir.path(), "codex", &["--full-auto".into()]).unwrap();
        let codex = load(Some(dir.path())).into_iter().find(|s| s.id == "codex").unwrap();
        assert_eq!(codex.args, ["-y", "@agentclientprotocol/codex-acp@2.3.0", "--full-auto"]);
        assert_eq!(codex.env, vec![("OPENAI_API_KEY".to_owned(), "sk-test".to_owned())]);

        set_custom_args(dir.path(), "codex", &[]).unwrap();
        assert!(dir.path().join("codex.toml").exists());
        let codex = load(Some(dir.path())).into_iter().find(|s| s.id == "codex").unwrap();
        assert_eq!(codex.args, ["-y", "@agentclientprotocol/codex-acp@2.3.0"]);
        assert_eq!(codex.env, vec![("OPENAI_API_KEY".to_owned(), "sk-test".to_owned())]);

        // Custom non-builtin agent replaces args instead of accumulating them.
        std::fs::write(
            dir.path().join("mine.toml"),
            "name = \"Mine\"\ncommand = \"/opt/mine\"\nargs = [\"acp\"]\n[env]\nK = \"v\"\n",
        )
        .unwrap();
        set_custom_args(dir.path(), "mine", &["--foo".into()]).unwrap();
        set_custom_args(dir.path(), "mine", &["--bar".into()]).unwrap();
        let mine = load(Some(dir.path())).into_iter().find(|s| s.id == "mine").unwrap();
        assert_eq!(mine.args, ["--bar"]);
        assert_eq!(mine.env, vec![("K".to_owned(), "v".to_owned())]);
    }

    #[test]
    fn agy_search_roots_stay_in_the_current_user_dirs() {
        let (m, h, e) = (Path::new("/m"), Path::new("/h"), Path::new("/e"));
        let roots = agy_search_roots(Some(m), Some(h), Some(e));
        assert!(!roots.is_empty());
        assert!(roots.iter().any(|r| r.starts_with(m)));
        assert!(roots.iter().any(|r| r.starts_with(h) && r.ends_with("JetBrains")));
        assert!(roots.iter().any(|r| r.starts_with(e)));
        for r in &roots {
            assert!(
                r.starts_with(m) || r.starts_with(h) || r.starts_with(e),
                "unexpected search root outside user dirs: {}",
                r.display()
            );
            assert!(
                !r.to_string_lossy().contains("ai.l0ng.openidea"),
                "hard-coded app identifier in search root: {}",
                r.display()
            );
        }
        assert!(agy_search_roots(None, None, None).is_empty());
    }
}
