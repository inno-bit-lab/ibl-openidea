//! Agents tool window: coding agent tasks of the project (over ACP). In a remote
//! window they run on the host, next to the project they work on.
use super::{Channel, Emit};
use crate::Host;
use crate::rpc::Dispatcher;
use ide_agent::registry::{AgentRegistry, RegistryPaths};
use ide_agent::{
    AgentChange, AgentCommand, AgentConfigChoice, AgentEntry, AgentEvent, AgentProbe, AgentPrompt, AgentProvider,
    AgentQueued, AgentTask, NewAgentTask,
};
use ide_core::{IdeError, IdeResult, IpcPath, RequestId};
use ide_tools::InstallEvent;

/// First use may download an adapter; completion itself always runs read-only.
const COMPLETE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);

/// Streams the project's agent events to this window; returns every task.
pub fn subscribe(host: &Host, window: &str, on_event: Emit<AgentEvent>) -> IdeResult<Vec<AgentTask>> {
    Ok(host.project(window)?.agents.subscribe(on_event))
}

pub fn providers(host: &Host, window: &str) -> IdeResult<Vec<AgentProvider>> {
    let mut providers = match host.project(window) {
        Ok(project) => project.agents.providers(),
        Err(_) => ide_agent::providers_from(&host.config_dir.join("agents"), &host.data_dir.join("agents/models.json")),
    };
    ide_agent::registry::mark_updates(&registry_paths(host), &mut providers);
    Ok(providers)
}

/// Stores additional arguments independently of native or registry agent definitions.
pub fn set_args(host: &Host, window: &str, provider: String, args: Vec<String>) -> IdeResult<Vec<AgentProvider>> {
    let mut providers = match host.project(window) {
        Ok(project) => project.agents.set_custom_args(&provider, &args)?,
        Err(_) => ide_agent::set_custom_args_in(
            &host.config_dir.join("agents"),
            &host.data_dir.join("agents/models.json"),
            &provider,
            &args,
        )?,
    };
    ide_agent::registry::mark_updates(&registry_paths(host), &mut providers);
    Ok(providers)
}

/// Answers one question in a throwaway session; no task is created.
pub async fn complete(
    host: &Host,
    window: &str,
    provider: String,
    prompt: String,
    config: Vec<AgentConfigChoice>,
) -> IdeResult<String> {
    host.require_trust(window)?;
    host.project(window)?.agents.complete(&provider, &prompt, &config, COMPLETE_TIMEOUT).await
}

/// Where ACP Registry agents are saved (`<config>/agents`, like the user's own) and installed.
pub(crate) fn registry_paths(host: &Host) -> RegistryPaths {
    RegistryPaths::new(&host.config_dir, &host.data_dir)
}

fn join_err(e: impl std::fmt::Display) -> IdeError {
    IdeError::internal(e.to_string())
}

/// Agents of the ACP Registry this machine can run, with what is installed; the list
/// saved earlier when the registry is unreachable. Cancel with `cancel_request(request)`.
pub async fn registry_list(host: &Host, _window: &str, request: RequestId) -> IdeResult<AgentRegistry> {
    let paths = registry_paths(host);
    let cancel = host.begin_request(request);
    let result =
        tokio::task::spawn_blocking(move || ide_agent::registry::list(&paths, &cancel)).await.map_err(join_err);
    host.end_request(request);
    result?
}

/// Installs the registry's current version of agent `id` (also to update it), streaming
/// progress through `on_event`; the agent then shows in `agent_providers`. Cancel with
/// `cancel_request(request)`.
pub async fn registry_install(
    host: &Host,
    _window: &str,
    id: String,
    request: RequestId,
    on_event: Channel<InstallEvent>,
) -> IdeResult<()> {
    let paths = registry_paths(host);
    let cancel = host.begin_request(request);
    let result = tokio::task::spawn_blocking(move || {
        ide_agent::registry::install(&paths, &id, &cancel, &|e| {
            let _ = on_event.send(e);
        })
    })
    .await
    .map_err(join_err);
    host.end_request(request);
    result?
}

/// Removes a registry agent: its agent file and installed files.
pub async fn registry_remove(host: &Host, _window: &str, id: String) -> IdeResult<()> {
    let paths = registry_paths(host);
    tokio::task::spawn_blocking(move || ide_agent::registry::remove(&paths, &id)).await.map_err(join_err)?
}

/// Slash commands to complete for `provider` in `task`'s directory, or in the project
/// before a task exists (skills and custom commands on disk included).
pub async fn commands(
    host: &Host,
    window: &str,
    provider: String,
    task: Option<String>,
) -> IdeResult<Vec<AgentCommand>> {
    host.project(window)?.agents.commands(&provider, task.as_deref()).await
}

/// Entries of `task`'s conversation, or of its subagent `subagent`'s.
pub fn entries(host: &Host, window: &str, task: String, subagent: Option<String>) -> IdeResult<Vec<AgentEntry>> {
    host.project(window)?.agents.entries(&task, subagent)
}

pub async fn create(host: &Host, window: &str, mut request: NewAgentTask) -> IdeResult<AgentTask> {
    host.require_trust(window)?;
    let project = host.project(window)?;
    let root = project.root.clone();
    let requested = request.project_root.take();
    request.project_root = Some(IpcPath(
        host.blocking(move || validate_project_root(&root, requested.as_ref().map(|p| p.0.as_path()))).await?,
    ));
    project.agents.create(request).await
}

/// Sends a message; while the agent works it is queued, or with `now` it interrupts the turn.
pub async fn prompt(host: &Host, window: &str, task: String, prompt: AgentPrompt, now: bool) -> IdeResult<()> {
    host.require_trust(window)?;
    host.project(window)?.agents.prompt(&task, prompt, now).await
}

/// Drops a queued message and returns it (to edit it).
pub fn unqueue(host: &Host, window: &str, task: String, queued: String) -> IdeResult<AgentQueued> {
    host.project(window)?.agents.unqueue(&task, &queued)
}

/// Sends a queued message now, interrupting the current turn.
pub fn send_queued_now(host: &Host, window: &str, task: String, queued: String) -> IdeResult<()> {
    host.require_trust(window)?;
    host.project(window)?.agents.send_queued_now(&task, &queued)
}

/// Changes a session setting (model, mode, thinking effort…).
pub async fn set_config(host: &Host, window: &str, task: String, option: String, value: String) -> IdeResult<()> {
    host.require_trust(window)?;
    host.project(window)?.agents.set_config(&task, &option, value).await
}

/// Copies the task's conversation into a new task, up to its first `turns` turns (all when `None`).
pub async fn fork(host: &Host, window: &str, task: String, turns: Option<u32>) -> IdeResult<AgentTask> {
    host.require_trust(window)?;
    host.project(window)?.agents.fork(&task, turns).await
}

/// Drops the task's turns after its first `turns`; returns the message of the first dropped one.
pub async fn rollback(host: &Host, window: &str, task: String, turns: u32) -> IdeResult<Option<AgentPrompt>> {
    host.require_trust(window)?;
    host.project(window)?.agents.rollback(&task, turns).await
}

/// What the agent reports about itself when it starts, without opening a session.
pub async fn probe(host: &Host, window: &str, provider: String, refresh: bool) -> IdeResult<AgentProbe> {
    host.require_trust(window)?;
    host.project(window)?.agents.probe(&provider, refresh).await
}

/// Stops the task's current turn, or with `subagent` only that subagent's work.
pub fn cancel(host: &Host, window: &str, task: String, subagent: Option<String>) -> IdeResult<()> {
    host.project(window)?.agents.cancel(&task, subagent)
}

/// Answers a permission request; `option: None` cancels it.
pub fn respond(host: &Host, window: &str, task: String, permission: u32, option: Option<String>) -> IdeResult<()> {
    host.require_trust(window)?;
    host.project(window)?.agents.respond(&task, permission, option)
}

pub fn archive(host: &Host, window: &str, task: String) -> IdeResult<()> {
    host.project(window)?.agents.archive(&task)
}

pub fn unarchive(host: &Host, window: &str, task: String) -> IdeResult<()> {
    host.project(window)?.agents.unarchive(&task)
}

pub async fn delete(host: &Host, window: &str, task: String, remove_worktree: bool) -> IdeResult<()> {
    host.require_trust(window)?;
    host.project(window)?.agents.delete(&task, remove_worktree).await
}

pub async fn changes(host: &Host, window: &str, task: String) -> IdeResult<Vec<AgentChange>> {
    host.require_trust(window)?;
    host.project(window)?.agents.changes(&task).await
}

/// Content of `path` when the task started (left side of its diff).
pub async fn base_text(host: &Host, window: &str, task: String, path: IpcPath) -> IdeResult<Option<String>> {
    host.require_trust(window)?;
    host.project(window)?.agents.base_text(&task, path.into_path_buf()).await
}

/// Commands of this module the remote server answers.
pub(crate) fn register(d: &mut Dispatcher) {
    d.add("agent_subscribe", |c| async move { subscribe(&c.host, &c.window, c.channel("onEvent")?) });
    d.add("agent_providers", |c| async move { providers(&c.host, &c.window) });
    d.add("agent_set_args", |c| async move { set_args(&c.host, &c.window, c.arg("provider")?, c.arg("args")?) });
    d.add("agent_complete", |c| async move {
        complete(&c.host, &c.window, c.arg("provider")?, c.arg("prompt")?, c.arg("config")?).await
    });
    d.add("agent_registry_list", |c| async move { registry_list(&c.host, &c.window, c.arg("request")?).await });
    d.add("agent_registry_install", |c| async move {
        registry_install(&c.host, &c.window, c.arg("id")?, c.arg("request")?, c.sender("onEvent")?).await
    });
    d.add("agent_registry_remove", |c| async move { registry_remove(&c.host, &c.window, c.arg("id")?).await });
    d.add("agent_commands", |c| async move { commands(&c.host, &c.window, c.arg("provider")?, c.arg("task")?).await });
    d.add("agent_entries", |c| async move { entries(&c.host, &c.window, c.arg("task")?, c.arg("subagent")?) });
    d.add("agent_create", |c| async move { create(&c.host, &c.window, c.arg("request")?).await });
    d.add("agent_prompt", |c| async move {
        prompt(&c.host, &c.window, c.arg("task")?, c.arg("prompt")?, c.arg("now")?).await
    });
    d.add("agent_unqueue", |c| async move { unqueue(&c.host, &c.window, c.arg("task")?, c.arg("queued")?) });
    d.add(
        "agent_send_queued_now",
        |c| async move { send_queued_now(&c.host, &c.window, c.arg("task")?, c.arg("queued")?) },
    );
    d.add("agent_set_config", |c| async move {
        set_config(&c.host, &c.window, c.arg("task")?, c.arg("option")?, c.arg("value")?).await
    });
    d.add("agent_fork", |c| async move { fork(&c.host, &c.window, c.arg("task")?, c.arg("turns")?).await });
    d.add("agent_rollback", |c| async move { rollback(&c.host, &c.window, c.arg("task")?, c.arg("turns")?).await });
    d.add("agent_probe", |c| async move { probe(&c.host, &c.window, c.arg("provider")?, c.arg("refresh")?).await });
    d.add("agent_cancel", |c| async move { cancel(&c.host, &c.window, c.arg("task")?, c.arg("subagent")?) });
    d.add("agent_respond", |c| async move {
        respond(&c.host, &c.window, c.arg("task")?, c.arg("permission")?, c.arg("option")?)
    });
    d.add("agent_unarchive", |c| async move { unarchive(&c.host, &c.window, c.arg("task")?) });
    d.add("agent_archive", |c| async move { archive(&c.host, &c.window, c.arg("task")?) });
    d.add(
        "agent_delete",
        |c| async move { delete(&c.host, &c.window, c.arg("task")?, c.arg("removeWorktree")?).await },
    );
    d.add("agent_changes", |c| async move { changes(&c.host, &c.window, c.arg("task")?).await });
    d.add("agent_base_text", |c| async move { base_text(&c.host, &c.window, c.arg("task")?, c.arg("path")?).await });
}

fn validate_project_root(root: &std::path::Path, requested: Option<&std::path::Path>) -> IdeResult<std::path::PathBuf> {
    let Some(requested) = requested else {
        return Ok(root.to_path_buf());
    };
    if !requested.is_absolute() {
        return Err(IdeError::invalid("Choose an absolute project root"));
    }
    let requested = dunce::canonicalize(requested)?;
    let window_root = dunce::canonicalize(root)?;
    if requested == window_root
        || ide_workspace::workspace::Workspace::load(root)?.is_some_and(|w| w.projects.contains(&requested))
    {
        return Ok(requested);
    }
    Err(IdeError::invalid("Agent project must be the window project or a workspace member"))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn profile_host(root: &std::path::Path) -> Host {
        Host::new(crate::HostConfig {
            config_dir: root.join("config"),
            data_dir: root.join("data"),
            languages: std::sync::Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
            syntax: std::sync::Arc::default(),
            sink_for: Box::new(|_| std::sync::Arc::new(ide_core::NullSink)),
            owner: |window| window,
            runtime: tokio::runtime::Handle::current(),
            project_environment: false,
        })
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn welcome_agent_providers_migrate_the_profile_and_keep_registry_updates() {
        let tmp = tempfile::tempdir().unwrap();
        let host = profile_host(tmp.path());
        let paths = registry_paths(&host);
        std::fs::create_dir_all(&paths.agents_dir).unwrap();
        std::fs::create_dir_all(paths.cache_file.parent().unwrap()).unwrap();
        std::fs::write(
            paths.agents_dir.join("codex.toml"),
            "command = \"npx\"\nargs = [\"-y\", \"@agentclientprotocol/codex-acp@2.3.0\", \"--legacy\"]\n",
        )
        .unwrap();
        std::fs::write(
            paths.agents_dir.join("fixture.toml"),
            format!(
                "command = {}\n[registry]\nid = \"fixture\"\nversion = \"1.0.0\"\n",
                serde_json::to_string(&std::env::current_exe().unwrap().to_string_lossy()).unwrap()
            ),
        )
        .unwrap();
        std::fs::write(&paths.cache_file, r#"{"agents":[{"id":"fixture","name":"Fixture","version":"2.0.0"}]}"#)
            .unwrap();
        std::fs::write(host.data_dir.join("agents/models.json"),r#"{"codex":{"config":[{"id":"model","name":"Model","category":"model","current":"cached-model","values":[{"value":"cached-model","name":"Cached model"}],"via":"option"}]}}"#).unwrap();
        assert!(host.project("welcome").is_err());
        let list = providers(&host, "welcome").unwrap();
        let codex = list.iter().find(|provider| provider.id == "codex").unwrap();
        assert!(codex.command.starts_with("codex app-server"));
        assert!(codex.extra_args.is_empty());
        assert!(codex.config.iter().any(|option| option.current.as_deref() == Some("cached-model")));
        assert_eq!(list.iter().find(|provider| provider.id == "codex-acp").unwrap().extra_args, ["--legacy"]);
        assert!(paths.agents_dir.join("codex.toml.v02").is_file());
        assert!(!paths.agents_dir.join("codex.toml").exists());
        let registry = list.iter().find(|provider| provider.id == "fixture").unwrap();
        assert!(registry.installed);
        assert_eq!(
            registry.source,
            ide_agent::AgentSource::Registry { version: "1.0.0".into(), update: Some("2.0.0".into()) }
        );
        assert_eq!(providers(&host, "welcome").unwrap().len(), list.len());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn welcome_agent_arguments_are_shared_with_an_open_project() {
        let tmp = tempfile::tempdir().unwrap();
        let host = profile_host(tmp.path());
        assert!(host.project("welcome").is_err());
        let list = set_args(&host, "welcome", "codex".into(), vec!["--fixture-extra".into()]).unwrap();
        assert_eq!(list.iter().find(|provider| provider.id == "codex").unwrap().extra_args, ["--fixture-extra"]);
        assert!(!host.config_dir.join("agents/codex.toml").exists());
        let root = tmp.path().join("project");
        std::fs::create_dir_all(&root).unwrap();
        let project = host.open_project("main", &root).unwrap();
        let codex = project.agents.providers().into_iter().find(|provider| provider.id == "codex").unwrap();
        assert_eq!(codex.extra_args, ["--fixture-extra"]);
        set_args(&host, "main", "codex".into(), Vec::new()).unwrap();
        assert!(
            providers(&host, "welcome")
                .unwrap()
                .into_iter()
                .find(|provider| provider.id == "codex")
                .unwrap()
                .extra_args
                .is_empty()
        );
        let store = host.config_dir.join("agents/extra-args.json");
        assert!(!store.exists());
        std::fs::write(&store, "{ malformed store").unwrap();
        assert!(set_args(&host, "welcome", "codex".into(), Vec::new()).is_err());
        assert_eq!(std::fs::read_to_string(store).unwrap(), "{ malformed store");
    }

    #[test]
    fn agent_roots_are_exact_window_or_workspace_members() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("workspace");
        let member = tmp.path().join("member");
        let other = tmp.path().join("other");
        for dir in [&root, &member, &other, &member.join("child")] {
            std::fs::create_dir_all(dir).unwrap();
        }
        assert_eq!(validate_project_root(&root, None).unwrap(), root);
        assert_eq!(validate_project_root(&root, Some(&root)).unwrap(), dunce::canonicalize(&root).unwrap());
        assert!(validate_project_root(&root, Some(&member)).is_err());
        ide_workspace::workspace::Workspace::save(&root, "Workspace", vec![member.clone()], true).unwrap();
        assert_eq!(validate_project_root(&root, Some(&member)).unwrap(), dunce::canonicalize(&member).unwrap());
        for rejected in [other, member.join("child"), member.join("../other"), "relative".into()] {
            assert!(validate_project_root(&root, Some(&rejected)).is_err(), "{rejected:?}");
        }
    }
}
