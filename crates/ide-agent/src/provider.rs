//! Agents and how to launch them: the built-in ones, plus user-defined agents from
//! `<config>/agents/<id>.toml` (written by hand, or by installing one from the ACP
//! Registry, see `registry`).

use crate::AgentSource;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// The protocol an agent speaks. Native ones run behind an in-process ACP endpoint
/// (`native`), so tasks see every agent as ACP and read features from its capabilities.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Driver {
    #[default]
    Acp,
    /// `codex app-server`.
    Codex,
    /// `claude` in stream-json mode.
    Claude,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ProviderSpec {
    pub id: String,
    pub name: String,
    pub driver: Driver,
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    /// How to sign in when the agent reports it needs authentication.
    pub login_hint: String,
    pub source: AgentSource,
}

/// `(id, name, driver, command line, sign-in hint)`. npm adapters are pinned so a
/// session's protocol does not change under the user.
const BUILTIN: &[(&str, &str, Driver, &[&str], &str)] = &[
    ("claude", "Claude Code", Driver::Claude, &["claude"], "Run `claude` in a terminal and sign in."),
    ("codex", "Codex", Driver::Codex, &["codex", "app-server"], "Run `codex login` in a terminal."),
    (
        "claude-acp",
        "Claude Code (ACP)",
        Driver::Acp,
        &["npx", "-y", "@agentclientprotocol/claude-agent-acp@0.97.0"],
        "Run `claude` in a terminal and sign in.",
    ),
    (
        "codex-acp",
        "Codex (ACP)",
        Driver::Acp,
        &["npx", "-y", "@agentclientprotocol/codex-acp@2.3.0"],
        "Run `codex login` in a terminal.",
    ),
    ("gemini", "Gemini CLI", Driver::Acp, &["gemini", "--experimental-acp"], "Run `gemini` in a terminal and sign in."),
    ("copilot", "GitHub Copilot", Driver::Acp, &["copilot", "--acp"], "Run `copilot` in a terminal and sign in."),
    ("cursor", "Cursor", Driver::Acp, &["cursor-agent", "acp"], "Run `cursor-agent login` in a terminal."),
    ("opencode", "OpenCode", Driver::Acp, &["opencode", "acp"], "Run `opencode auth login` in a terminal."),
    ("qwen", "Qwen Code", Driver::Acp, &["qwen", "--experimental-acp"], "Run `qwen` in a terminal and sign in."),
    ("kimi", "Kimi CLI", Driver::Acp, &["kimi", "acp"], "Run `kimi` in a terminal and sign in."),
    ("goose", "Goose", Driver::Acp, &["goose", "acp"], "Run `goose configure` in a terminal."),
    ("auggie", "Auggie", Driver::Acp, &["auggie", "--acp"], "Run `auggie login` in a terminal."),
    ("kiro", "Kiro", Driver::Acp, &["kiro-cli", "acp"], "Run `kiro-cli login` in a terminal."),
    ("vibe", "Mistral Vibe", Driver::Acp, &["vibe-acp"], "Run `vibe` in a terminal and sign in."),
];

fn builtins() -> Vec<ProviderSpec> {
    BUILTIN
        .iter()
        .map(|(id, name, driver, cmd, hint)| ProviderSpec {
            id: (*id).into(),
            name: (*name).into(),
            driver: *driver,
            command: cmd[0].into(),
            args: cmd[1..].iter().map(|a| (*a).to_owned()).collect(),
            env: Vec::new(),
            login_hint: (*hint).into(),
            source: AgentSource::Builtin,
        })
        .collect()
}

/// Whether `id` names a built-in agent.
pub(crate) fn is_builtin(id: &str) -> bool {
    BUILTIN.iter().any(|b| b.0 == id)
}

/// An agent file, `<config>/agents/<id>.toml`.
#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CustomAgent {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Driver::is_acp")]
    pub driver: Driver,
    pub command: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    /// Set when the agent was installed from the ACP Registry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registry: Option<RegistryRef>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RegistryRef {
    pub id: String,
    pub version: String,
}

impl Driver {
    fn is_acp(&self) -> bool {
        *self == Driver::Acp
    }
}

impl CustomAgent {
    pub(crate) fn read(path: &Path) -> Result<Self, String> {
        std::fs::read_to_string(path)
            .map_err(|e| e.to_string())
            .and_then(|t| toml::from_str::<CustomAgent>(&t).map_err(|e| e.to_string()))
    }

    /// Writes atomically without widening an existing file's Unix permissions.
    pub(crate) fn write(&self, path: &Path) -> std::io::Result<()> {
        let text = toml::to_string(self).map_err(std::io::Error::other)?;
        let permissions = match std::fs::metadata(path) {
            Ok(metadata) => Some(metadata.permissions()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error),
        };
        atomic_write_private(path, text.as_bytes(), permissions.as_ref())
    }
}

use std::io::{self, Write as _};

// Project windows share a process. Readers see either complete version of the store.
static EXTRA_ARGS_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());
type ExtraArgs = BTreeMap<String, Vec<String>>;
const EXTRA_ARGS_FILE: &str = "extra-args.json";

fn read_extra_args(dir: &Path) -> io::Result<ExtraArgs> {
    let bytes = match std::fs::read(dir.join(EXTRA_ARGS_FILE)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(ExtraArgs::new()),
        Err(error) => return Err(error),
    };
    serde_json::from_slice(&bytes).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("invalid extra-args.json at line {}, column {}", error.line(), error.column()),
        )
    })
}

pub(crate) fn extra_args(custom_dir: Option<&Path>) -> ExtraArgs {
    let Some(dir) = custom_dir else { return ExtraArgs::new() };
    match read_extra_args(dir) {
        Ok(args) => args,
        Err(error) => {
            tracing::warn!("not applying extra arguments from {}: {error}", dir.display());
            ExtraArgs::new()
        }
    }
}

fn atomic_write_private(path: &Path, bytes: &[u8], _permissions: Option<&std::fs::Permissions>) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| io::Error::other("file has no parent"))?;
    std::fs::create_dir_all(parent)?;
    let name = path.file_name().ok_or_else(|| io::Error::other("file has no name"))?.to_string_lossy();
    let tmp = parent.join(format!(".{name}.{}.tmp", uuid::Uuid::new_v4()));
    let mut created = false;
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            options.mode(_permissions.map(|permissions| permissions.mode() & 0o777).unwrap_or(0o600));
        }
        let mut file = options.open(&tmp)?;
        created = true;
        #[cfg(unix)]
        if let Some(permissions) = _permissions {
            file.set_permissions(permissions.clone())?;
        }
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() && created {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

fn write_extra_args(dir: &Path, args: &ExtraArgs) -> io::Result<()> {
    let path = dir.join(EXTRA_ARGS_FILE);
    if args.is_empty() {
        return match std::fs::remove_file(path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            result => result,
        };
    }
    let bytes = serde_json::to_vec_pretty(args).map_err(io::Error::other)?;
    atomic_write_private(&path, &bytes, None)
}

/// Persists only user arguments, so native drivers and registry metadata stay untouched.
pub(crate) fn set_custom_args(custom_dir: &Path, id: &str, args: &[String]) -> io::Result<()> {
    let _guard = EXTRA_ARGS_LOCK.lock();
    if !load(Some(custom_dir)).iter().any(|spec| spec.id == id) {
        return Err(io::Error::new(io::ErrorKind::NotFound, "unknown agent"));
    }
    let mut map = read_extra_args(custom_dir)?;
    let before = map.clone();
    let cleaned: Vec<String> = args.iter().map(|arg| arg.trim().to_owned()).filter(|arg| !arg.is_empty()).collect();
    if cleaned.is_empty() {
        map.remove(id);
    } else {
        map.insert(id.to_owned(), cleaned);
    }
    if map == before && !map.is_empty() {
        return Ok(());
    }
    write_extra_args(custom_dir, &map)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyAgent {
    name: Option<String>,
    #[serde(default)]
    driver: Driver,
    command: Option<String>,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    extra_args: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    registry: Option<RegistryRef>,
}

fn legacy_id(id: &str) -> &str {
    match id {
        "codex" => "codex-acp",
        "claude" => "claude-acp",
        "agy" => "antigravity-acp",
        "pi" => "pi-acp",
        other => other,
    }
}

fn backup_files(path: &Path) -> io::Result<Vec<(usize, PathBuf)>> {
    let parent = path.parent().ok_or_else(|| io::Error::other("agent file has no parent"))?;
    let prefix = format!(
        "{}.v02",
        path.file_name().ok_or_else(|| io::Error::other("agent file has no name"))?.to_string_lossy()
    );
    let mut backups = Vec::new();
    for entry in std::fs::read_dir(parent)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let number = if name == prefix {
            Some(0)
        } else {
            name.strip_prefix(&format!("{prefix}.")).and_then(|tail| tail.parse::<usize>().ok())
        };
        if let Some(number) = number {
            backups.push((number, entry.path()));
        }
    }
    backups.sort_by_key(|(number, _)| *number);
    Ok(backups)
}

fn next_backup(path: &Path, backups: &[(usize, PathBuf)]) -> io::Result<PathBuf> {
    let suffix = match backups.last() {
        Some((n, _)) => format!(".v02.{}", n.checked_add(1).ok_or_else(|| io::Error::other("too many backups"))?),
        None => ".v02".to_owned(),
    };
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    Ok(PathBuf::from(name))
}

fn archive_legacy(path: &Path) -> io::Result<()> {
    let backup = next_backup(path, &backup_files(path)?)?;
    std::fs::rename(path, &backup)?;
    tracing::info!("archived legacy agent {} as {}", path.display(), backup.display());
    Ok(())
}

fn replace_legacy(path: &Path, original: &[u8], agent: &CustomAgent) -> io::Result<()> {
    let backups = backup_files(path)?;
    let reuse = match backups.last() {
        Some((_, backup)) => std::fs::read(backup)? == original,
        None => false,
    };
    if !reuse {
        let backup = next_backup(path, &backups)?;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&backup)?;
        file.write_all(original)?;
        file.sync_all()?;
        tracing::info!("preserved legacy agent {} in {}", path.display(), backup.display());
    }
    agent.write(path)?;
    tracing::info!("rewrote legacy agent {}", path.display());
    Ok(())
}

fn merge_legacy_extra(map: &mut ExtraArgs, id: &str, args: &[String]) -> bool {
    let args: Vec<String> = args.iter().map(|arg| arg.trim().to_owned()).filter(|arg| !arg.is_empty()).collect();
    if args.is_empty() {
        return false;
    }
    if let Some(existing) = map.get(id) {
        if existing != &args {
            tracing::warn!("kept existing extra arguments for {id}; legacy arguments remain in the backup");
        }
        return false;
    }
    map.insert(id.to_owned(), args);
    true
}

fn registry_command_at_current_root(agent: &CustomAgent, tools_dir: &Path) -> Option<String> {
    let registry = agent.registry.as_ref()?;
    let old = Path::new(&agent.command);
    if !old.is_absolute() || old.starts_with(tools_dir) {
        return None;
    }
    let components: Vec<_> = old.components().collect();
    for index in 0..components.len().saturating_sub(4) {
        if components[index].as_os_str() != "agents"
            || components[index + 1].as_os_str() != "tools"
            || components[index + 2].as_os_str() != registry.id.as_str()
            || components[index + 3].as_os_str() != registry.version.as_str()
        {
            continue;
        }
        let tail = &components[index + 4..];
        if tail.is_empty() || !tail.iter().all(|part| matches!(part, std::path::Component::Normal(_))) {
            return None;
        }
        let mut target = tools_dir.join(&registry.id).join(&registry.version);
        for part in tail {
            target.push(part.as_os_str());
        }
        return target.is_file().then(|| target.to_string_lossy().into_owned());
    }
    None
}

/// Upgrades fork-written overrides before providers are loaded. Original bytes are retained.
pub(crate) fn migrate_legacy(custom_dir: &Path, tools_dir: &Path) -> io::Result<()> {
    let _guard = EXTRA_ARGS_LOCK.lock();
    let entries = match std::fs::read_dir(custom_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    let mut paths: Vec<_> = entries
        .collect::<io::Result<Vec<_>>>()?
        .into_iter()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "toml"))
        .collect();
    paths.sort();
    let mut extra = read_extra_args(custom_dir)?;
    for path in paths {
        let Some(id) = path.file_stem().and_then(|name| name.to_str()) else { continue };
        let bytes = std::fs::read(&path)?;
        let Ok(text) = std::str::from_utf8(&bytes) else {
            tracing::warn!("not migrating non-UTF8 agent {}", path.display());
            continue;
        };
        let Ok(value) = toml::from_str::<toml::Value>(text) else { continue };
        let Ok(legacy) = toml::from_str::<LegacyAgent>(text) else { continue };
        let legacy_shape = value.get("extra_args").is_some() || legacy.command.is_none();
        let target_id = legacy_id(id);
        let native_adapter = matches!(id, "codex" | "claude")
            .then(|| builtins().into_iter().find(|spec| spec.id == target_id))
            .flatten();
        let old_native = legacy.driver == Driver::Acp
            && legacy.registry.is_none()
            && legacy.command.as_deref() == Some("npx")
            && native_adapter.as_ref().is_some_and(|base| legacy.args.starts_with(&base.args));
        let old_alias = legacy.driver == Driver::Acp
            && legacy.registry.is_none()
            && match id {
                "agy" => legacy.command.as_deref() == Some("agy_acp_server"),
                "pi" => {
                    legacy.command.as_deref() == Some("npx")
                        && legacy.args.starts_with(&["-y".into(), "pi-acp@0.0.34".into()])
                }
                _ => false,
            };
        if old_native || old_alias || (legacy_shape && legacy.command.is_none()) {
            let prefix = if old_native {
                native_adapter.as_ref().map(|base| base.args.len()).unwrap_or(0)
            } else if old_alias && id == "pi" {
                2
            } else {
                0
            };
            let mut migrated_args = if old_native || old_alias { legacy.args[prefix..].to_vec() } else { Vec::new() };
            migrated_args.extend(legacy.extra_args.clone());
            if let Some(base) = native_adapter {
                if legacy.name.is_some() || !legacy.env.is_empty() || (!old_native && !legacy.args.is_empty()) {
                    let destination = custom_dir.join(format!("{target_id}.toml"));
                    if destination.try_exists()? {
                        tracing::warn!("kept existing agent {target_id}; legacy name/environment remain in the backup");
                    } else {
                        CustomAgent {
                            name: legacy.name,
                            driver: Driver::Acp,
                            command: base.command,
                            args: if !old_native && !legacy.args.is_empty() { legacy.args } else { base.args },
                            env: legacy.env,
                            registry: None,
                        }
                        .write(&destination)?;
                        tracing::warn!(
                            "preserved legacy metadata for {id} in {target_id}; its ACP adapter pin stays fixed"
                        );
                    }
                }
            } else if matches!(id, "agy" | "pi") {
                if !legacy.env.is_empty() {
                    tracing::warn!(
                        "legacy {id} environment keys remain only in its backup: {:?}",
                        legacy.env.keys().collect::<Vec<_>>()
                    );
                }
            } else if legacy.name.is_some() || !legacy.env.is_empty() || !legacy.args.is_empty() {
                let Some(base) = builtins().into_iter().find(|spec| spec.id == id) else { continue };
                let mut args = if legacy.args.is_empty() { base.args } else { legacy.args };
                args.extend(legacy.extra_args);
                replace_legacy(
                    &path,
                    &bytes,
                    &CustomAgent {
                        name: legacy.name,
                        driver: base.driver,
                        command: base.command,
                        args,
                        env: legacy.env,
                        registry: None,
                    },
                )?;
                continue;
            }
            if merge_legacy_extra(&mut extra, target_id, &migrated_args) {
                write_extra_args(custom_dir, &extra)?;
            }
            archive_legacy(&path)?;
        } else if legacy_shape && legacy.command.is_some() {
            let mut args = legacy.args;
            args.extend(legacy.extra_args);
            let mut normalized = CustomAgent {
                name: legacy.name,
                driver: legacy.driver,
                command: legacy.command.unwrap_or_default(),
                args,
                env: legacy.env,
                registry: legacy.registry,
            };
            if let Some(command) = registry_command_at_current_root(&normalized, tools_dir) {
                normalized.command = command;
            }
            replace_legacy(&path, &bytes, &normalized)?;
        } else if let Ok(mut agent) = CustomAgent::read(&path)
            && let Some(command) = registry_command_at_current_root(&agent, tools_dir)
        {
            agent.command = command;
            replace_legacy(&path, &bytes, &agent)?;
        }
    }
    Ok(())
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
        let agent = match CustomAgent::read(&path) {
            Ok(a) => a,
            Err(e) => {
                tracing::warn!("skipping agent {}: {e}", path.display());
                continue;
            }
        };
        let env: Vec<(String, String)> = agent.env.into_iter().collect();
        let source = match agent.registry {
            Some(r) => AgentSource::Registry { version: r.version, update: None },
            None => AgentSource::Custom,
        };
        let spec = ProviderSpec {
            name: agent.name.unwrap_or_else(|| id.clone()),
            driver: agent.driver,
            command: agent.command,
            args: agent.args,
            env,
            login_hint: "Sign in with the agent's own command line first.".into(),
            source,
            id,
        };
        match specs.iter_mut().find(|s| s.id == spec.id) {
            Some(existing) => *existing = spec,
            None => specs.push(spec),
        }
    }
    let extra = extra_args(custom_dir);
    for spec in &mut specs {
        if let Some(args) = extra.get(&spec.id) {
            spec.args.extend(args.iter().cloned());
        }
    }
    specs
}

/// Whether `command` resolves to an executable (a path, or a name on `PATH`).
pub(crate) fn installed(command: &str) -> bool {
    let p = Path::new(command);
    if p.components().count() > 1 {
        return is_executable(p);
    }
    let exts: &[&str] = if cfg!(windows) { &["exe", "cmd", "bat"] } else { &[] };
    std::env::var_os("PATH").is_some_and(|path| {
        std::env::split_paths(&path).any(|dir| {
            let c = dir.join(command);
            is_executable(&c) || exts.iter().any(|e| is_executable(&c.with_extension(e)))
        })
    })
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
        assert!(!specs.iter().any(|s| s.id == "broken"));
        assert_eq!(specs.iter().filter(|s| s.id == "claude").count(), 1);
        assert!(!installed("/definitely/not/here"));
        assert!(installed("sh"));
    }

    #[test]
    fn agent_files_round_trip_with_their_registry_table() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agents").join("amp-acp.toml");
        let agent = CustomAgent {
            name: Some("Amp".into()),
            driver: Driver::Acp,
            command: "/data/agents/tools/amp-acp/0.10.0/amp-acp".into(),
            args: vec!["acp".into()],
            env: BTreeMap::from([("K".to_owned(), "v".to_owned())]),
            registry: Some(RegistryRef { id: "amp-acp".into(), version: "0.10.0".into() }),
        };
        agent.write(&path).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("[registry]") && !text.contains("driver"), "{text}");
        assert_eq!(CustomAgent::read(&path).unwrap(), agent);
        let spec = load(Some(path.parent().unwrap())).into_iter().find(|s| s.id == "amp-acp").unwrap();
        assert_eq!(spec.source, AgentSource::Registry { version: "0.10.0".into(), update: None });
        assert!(toml::from_str::<CustomAgent>("command = \"x\"\n[registry]\nid = \"x\"\n").is_err());
    }

    fn write_agent(dir: &Path, id: &str, text: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join(format!("{id}.toml")), text).unwrap();
    }

    fn extra_store(dir: &Path) -> BTreeMap<String, Vec<String>> {
        serde_json::from_slice(&std::fs::read(dir.join("extra-args.json")).unwrap()).unwrap()
    }

    fn spec(dir: &Path, id: &str) -> ProviderSpec {
        load(Some(dir)).into_iter().find(|s| s.id == id).unwrap()
    }

    fn files(dir: &Path) -> BTreeMap<String, Vec<u8>> {
        std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .filter(|e| e.path().is_file())
            .map(|e| (e.file_name().to_string_lossy().into_owned(), std::fs::read(e.path()).unwrap()))
            .collect()
    }

    #[test]
    fn extra_args_apply_to_builtin_native_registry_and_custom_agents() {
        let dir = tempfile::tempdir().unwrap();
        write_agent(dir.path(), "mine", "command = \"mine\"\nargs = [\"base\"]\n[env]\nKEEP = \"yes\"\n");
        write_agent(
            dir.path(),
            "registered",
            "command = \"registry-bin\"\nargs = [\"acp\"]\n[registry]\nid = \"registered\"\nversion = \"1\"\n",
        );
        for id in ["claude", "codex", "codex-acp", "mine", "registered"] {
            let before = spec(dir.path(), id);
            set_custom_args(dir.path(), id, &[" --extra ".into(), "".into(), " value ".into()]).unwrap();
            let after = spec(dir.path(), id);
            assert_eq!(after.args, [before.args.clone(), vec!["--extra".into(), "value".into()]].concat());
            assert_eq!(
                (after.driver, after.command, after.env, after.source),
                (before.driver, before.command, before.env, before.source)
            );
        }
    }

    #[test]
    fn set_custom_args_never_writes_agent_files() {
        let dir = tempfile::tempdir().unwrap();
        write_agent(
            dir.path(),
            "mine",
            "name = \"Custom\"\ncommand = \"mine\"\nargs = [\"base\"]\n[env]\nKEY = \"value\"\n",
        );
        write_agent(
            dir.path(),
            "registered",
            "command = \"installed\"\n[registry]\nid = \"registered\"\nversion = \"1\"\n",
        );
        let before = files(dir.path());
        for id in ["claude", "codex", "mine", "registered"] {
            set_custom_args(dir.path(), id, &["--extra".into()]).unwrap();
        }
        for (name, bytes) in before {
            assert_eq!(std::fs::read(dir.path().join(name)).unwrap(), bytes);
        }
        assert!(!dir.path().join("claude.toml").exists());
        assert!(!dir.path().join("codex.toml").exists());
        assert_eq!(extra_store(dir.path()).len(), 4);
    }

    #[test]
    fn set_custom_args_clears_entry_and_removes_empty_store() {
        let dir = tempfile::tempdir().unwrap();
        set_custom_args(dir.path(), "claude", &["--one".into()]).unwrap();
        set_custom_args(dir.path(), "codex", &["--two".into()]).unwrap();
        set_custom_args(dir.path(), "claude", &[]).unwrap();
        assert_eq!(extra_store(dir.path()).keys().cloned().collect::<Vec<_>>(), ["codex"]);
        set_custom_args(dir.path(), "codex", &[" ".into()]).unwrap();
        assert!(!dir.path().join("extra-args.json").exists());
        assert!(spec(dir.path(), "claude").args.is_empty());
    }

    #[test]
    fn set_custom_args_rejects_unknown_ids() {
        let dir = tempfile::tempdir().unwrap();
        let error = set_custom_args(dir.path(), "../unknown", &["--x".into()]).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
        assert!(files(dir.path()).is_empty());
    }

    #[test]
    fn extra_args_survive_a_registry_reinstall() {
        let dir = tempfile::tempdir().unwrap();
        write_agent(dir.path(), "registered", "command = \"old\"\n[registry]\nid = \"registered\"\nversion = \"1\"\n");
        set_custom_args(dir.path(), "registered", &["--user".into()]).unwrap();
        write_agent(
            dir.path(),
            "registered",
            "command = \"updated\"\nargs = [\"new-base\"]\n[registry]\nid = \"registered\"\nversion = \"2\"\n",
        );
        let current = spec(dir.path(), "registered");
        assert_eq!(current.command, "updated");
        assert_eq!(current.args, ["new-base", "--user"]);
        assert_eq!(current.source, AgentSource::Registry { version: "2".into(), update: None });
    }

    #[test]
    fn migrates_v021_codex_and_claude_overrides_to_native() {
        let dir = tempfile::tempdir().unwrap();
        for (id, pin, driver) in [
            ("codex", "@agentclientprotocol/codex-acp@2.3.0", Driver::Codex),
            ("claude", "@agentclientprotocol/claude-agent-acp@0.97.0", Driver::Claude),
        ] {
            let text = format!("command = \"npx\"\nargs = [\"-y\", \"{pin}\", \"--user\"]\n");
            write_agent(dir.path(), id, &text);
            migrate_legacy(dir.path(), &dir.path().join("tools")).unwrap();
            assert_eq!(spec(dir.path(), id).driver, driver);
            assert_eq!(extra_store(dir.path())[&format!("{id}-acp")], ["--user"]);
            assert_eq!(std::fs::read_to_string(dir.path().join(format!("{id}.toml.v02"))).unwrap(), text);
            assert!(!dir.path().join(format!("{id}.toml")).exists());
        }
    }

    #[test]
    fn migrates_v021_override_with_env_to_an_acp_file() {
        let dir = tempfile::tempdir().unwrap();
        write_agent(
            dir.path(),
            "codex",
            "name = \"My Codex\"\ncommand = \"npx\"\nargs = [\"-y\", \"@agentclientprotocol/codex-acp@2.3.0\", \"--user\"]\n[env]\nTOKEN = \"fixture-secret\"\n",
        );
        migrate_legacy(dir.path(), &dir.path().join("tools")).unwrap();
        let acp = CustomAgent::read(&dir.path().join("codex-acp.toml")).unwrap();
        assert_eq!(acp.driver, Driver::Acp);
        assert_eq!(acp.name.as_deref(), Some("My Codex"));
        assert_eq!(acp.env["TOKEN"], "fixture-secret");
        assert_eq!(acp.args, ["-y", "@agentclientprotocol/codex-acp@2.3.0"]);
        assert_eq!(spec(dir.path(), "codex").driver, Driver::Codex);
        assert_eq!(spec(dir.path(), "codex-acp").args.last().unwrap(), "--user");
    }

    #[test]
    fn migrates_mtb_extra_args_files() {
        let dir = tempfile::tempdir().unwrap();
        write_agent(dir.path(), "codex", "extra_args = [\"--codex\"]\n");
        write_agent(dir.path(), "gemini", "extra_args = [\"--gemini\"]\n");
        write_agent(
            dir.path(),
            "mine",
            "name = \"Mine\"\ncommand = \"mine\"\nargs = [\"base\"]\nextra_args = [\"--mine\"]\n",
        );
        let original = std::fs::read(dir.path().join("mine.toml")).unwrap();
        migrate_legacy(dir.path(), &dir.path().join("tools")).unwrap();
        assert_eq!(extra_store(dir.path())["codex-acp"], ["--codex"]);
        assert_eq!(extra_store(dir.path())["gemini"], ["--gemini"]);
        assert_eq!(spec(dir.path(), "mine").args, ["base", "--mine"]);
        assert!(!std::fs::read_to_string(dir.path().join("mine.toml")).unwrap().contains("extra_args"));
        assert!(dir.path().join("mine.toml.v02").exists());
        assert_eq!(spec(dir.path(), "codex").driver, Driver::Codex);
        assert_eq!(std::fs::read(dir.path().join("mine.toml.v02")).unwrap(), original);
    }

    #[test]
    fn migrates_mtb_codex_file_with_env_to_an_acp_file() {
        let dir = tempfile::tempdir().unwrap();
        write_agent(
            dir.path(),
            "codex",
            "name = \"Personal\"\nextra_args = [\"--custom\"]\n[env]\nOPENAI_API_KEY = \"fixture-value\"\n",
        );
        migrate_legacy(dir.path(), &dir.path().join("tools")).unwrap();
        let acp = CustomAgent::read(&dir.path().join("codex-acp.toml")).unwrap();
        assert_eq!(acp.name.as_deref(), Some("Personal"));
        assert_eq!(acp.env["OPENAI_API_KEY"], "fixture-value");
        assert_eq!(acp.command, "npx");
        assert_eq!(spec(dir.path(), "codex").driver, Driver::Codex);
        assert_eq!(extra_store(dir.path())["codex-acp"], ["--custom"]);
    }

    #[test]
    fn migrates_agy_and_pi_files_without_creating_registry_files() {
        let dir = tempfile::tempdir().unwrap();
        write_agent(dir.path(), "agy", "command = \"agy_acp_server\"\nargs = [\"--agy\"]\n");
        write_agent(dir.path(), "pi", "command = \"npx\"\nargs = [\"-y\", \"pi-acp@0.0.34\", \"--pi\"]\n");
        migrate_legacy(dir.path(), &dir.path().join("tools")).unwrap();
        let store = extra_store(dir.path());
        assert_eq!(store["antigravity-acp"], ["--agy"]);
        assert_eq!(store["pi-acp"], ["--pi"]);
        for id in ["antigravity-acp", "pi-acp"] {
            assert!(!dir.path().join(format!("{id}.toml")).exists());
        }
        for id in ["agy", "pi"] {
            assert!(dir.path().join(format!("{id}.toml.v02")).exists());
        }
    }

    #[test]
    fn rehomes_registry_commands_copied_from_another_identifier() {
        let dir = tempfile::tempdir().unwrap();
        let custom = dir.path().join("new-profile/agents");
        let tools = dir.path().join("new-profile/data/agents/tools");
        let old = dir.path().join("ai.l0ng.openidea/agents/tools/amp/1/bin/amp.exe");
        let current = tools.join("amp/1/bin/amp.exe");
        std::fs::create_dir_all(current.parent().unwrap()).unwrap();
        std::fs::write(&current, "fixture").unwrap();
        let agent = CustomAgent {
            name: Some("Amp".into()),
            driver: Driver::Acp,
            command: old.to_string_lossy().into_owned(),
            args: vec!["base".into()],
            env: BTreeMap::from([("KEY".into(), "keep".into())]),
            registry: Some(RegistryRef { id: "amp".into(), version: "1".into() }),
        };
        agent.write(&custom.join("amp.toml")).unwrap();
        migrate_legacy(&custom, &tools).unwrap();
        let updated = CustomAgent::read(&custom.join("amp.toml")).unwrap();
        assert_eq!(Path::new(&updated.command), current.as_path());
        assert_eq!((updated.args, updated.env, updated.registry), (agent.args, agent.env, agent.registry));
    }

    #[test]
    fn leaves_user_custom_agents_alone() {
        let dir = tempfile::tempdir().unwrap();
        write_agent(dir.path(), "mine", "name = \"Mine\"\ncommand = \"my-cli\"\nargs = [\"custom\"]\n");
        write_agent(dir.path(), "codex", "command = \"my-codex-wrapper\"\nargs = [\"intentional\"]\n");
        let before = files(dir.path());
        migrate_legacy(dir.path(), &dir.path().join("tools")).unwrap();
        assert_eq!(files(dir.path()), before);
    }

    #[test]
    fn migration_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        write_agent(dir.path(), "codex", "extra_args = [\"--one\"]\n");
        migrate_legacy(dir.path(), &dir.path().join("tools")).unwrap();
        let before = files(dir.path());
        migrate_legacy(dir.path(), &dir.path().join("tools")).unwrap();
        assert_eq!(files(dir.path()), before);
    }

    #[test]
    fn malformed_extra_args_store_is_never_rewritten() {
        let dir = tempfile::tempdir().unwrap();
        let bad = b"{ malformed store";
        std::fs::write(dir.path().join("extra-args.json"), bad).unwrap();
        write_agent(dir.path(), "codex", "extra_args = [\"--one\"]\n");
        let before = files(dir.path());
        assert!(load(Some(dir.path())).iter().any(|s| s.id == "claude"));
        let error = set_custom_args(dir.path(), "claude", &["--x".into()]).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
        assert!(migrate_legacy(dir.path(), &dir.path().join("tools")).is_err());
        assert_eq!(files(dir.path()), before);
    }

    #[test]
    fn migration_keeps_existing_destinations_and_the_full_legacy_backup() {
        let dir = tempfile::tempdir().unwrap();
        let legacy = "name = \"Old\"\nextra_args = [\"--old\"]\n[env]\nTOKEN = \"old\"\n";
        write_agent(dir.path(), "codex", legacy);
        write_agent(dir.path(), "codex-acp", "command = \"my-adapter\"\n[env]\nTOKEN = \"new\"\n");
        std::fs::write(dir.path().join("extra-args.json"), r#"{"codex-acp":["--new"]}"#).unwrap();
        let destination = std::fs::read(dir.path().join("codex-acp.toml")).unwrap();
        migrate_legacy(dir.path(), &dir.path().join("tools")).unwrap();
        assert_eq!(std::fs::read(dir.path().join("codex-acp.toml")).unwrap(), destination);
        assert_eq!(extra_store(dir.path())["codex-acp"], ["--new"]);
        assert_eq!(std::fs::read_to_string(dir.path().join("codex.toml.v02")).unwrap(), legacy);
    }

    #[test]
    fn migration_never_overwrites_an_existing_backup() {
        let dir = tempfile::tempdir().unwrap();
        write_agent(dir.path(), "codex", "extra_args = [\"--one\"]\n");
        let original = std::fs::read(dir.path().join("codex.toml")).unwrap();
        std::fs::write(dir.path().join("codex.toml.v02"), "older backup").unwrap();
        migrate_legacy(dir.path(), &dir.path().join("tools")).unwrap();
        assert_eq!(std::fs::read_to_string(dir.path().join("codex.toml.v02")).unwrap(), "older backup");
        assert_eq!(std::fs::read(dir.path().join("codex.toml.v02.1")).unwrap(), original);
    }

    #[test]
    fn concurrent_extra_args_updates_keep_both_providers() {
        let dir = tempfile::tempdir().unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        std::thread::scope(|scope| {
            for id in ["claude", "codex"] {
                let barrier = barrier.clone();
                let path = dir.path();
                scope.spawn(move || {
                    barrier.wait();
                    for n in 0..20 {
                        set_custom_args(path, id, &[n.to_string()]).unwrap();
                    }
                });
            }
        });
        let map = extra_store(dir.path());
        assert_eq!(map["claude"], ["19"]);
        assert_eq!(map["codex"], ["19"]);
    }

    #[test]
    fn in_place_migration_keeps_original_bytes_and_reuses_an_identical_backup() {
        let dir = tempfile::tempdir().unwrap();
        let original = "command = \"custom\"\nargs = [\"base\"]\nextra_args = [\"--user\"]\n";
        write_agent(dir.path(), "mine", original);
        // Fault fixture: a previous process stopped after copying the backup.
        std::fs::write(dir.path().join("mine.toml.v02"), original).unwrap();
        migrate_legacy(dir.path(), &dir.path().join("tools")).unwrap();
        assert_eq!(std::fs::read_to_string(dir.path().join("mine.toml.v02")).unwrap(), original);
        assert!(!dir.path().join("mine.toml.v02.1").exists());
        let normalized = CustomAgent::read(&dir.path().join("mine.toml")).unwrap();
        assert_eq!(normalized.args, ["base", "--user"]);
    }

    #[cfg(unix)]
    #[test]
    fn migration_keeps_agent_environment_files_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        write_agent(
            dir.path(),
            "codex",
            "command = \"npx\"\nargs = [\"-y\", \"@agentclientprotocol/codex-acp@2.3.0\"]\n[env]\nTOKEN = \"fixture-secret\"\n",
        );
        write_agent(
            dir.path(),
            "mine",
            "command = \"mine\"\nextra_args = [\"--user\"]\n[env]\nTOKEN = \"fixture-secret\"\n",
        );
        let original = std::fs::read(dir.path().join("mine.toml")).unwrap();
        for id in ["codex", "mine"] {
            std::fs::set_permissions(dir.path().join(format!("{id}.toml")), std::fs::Permissions::from_mode(0o600))
                .unwrap();
        }
        migrate_legacy(dir.path(), &dir.path().join("tools")).unwrap();
        for name in ["codex-acp.toml", "codex.toml.v02", "mine.toml", "mine.toml.v02"] {
            assert_eq!(std::fs::metadata(dir.path().join(name)).unwrap().permissions().mode() & 0o777, 0o600, "{name}");
        }
        assert_eq!(std::fs::read(dir.path().join("mine.toml.v02")).unwrap(), original);
    }
}
