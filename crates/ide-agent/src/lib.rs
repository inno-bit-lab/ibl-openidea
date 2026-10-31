//! Coding agents (Claude Code, Codex, Gemini CLI…) driven over the Agent Client Protocol.
//!
//! A task is one agent conversation, working in its own git worktree or in the project
//! checkout. Each task runs its agent's ACP server as a child process (newline-delimited
//! JSON-RPC over stdio), folds `session/update` notifications into a timeline, and streams
//! timeline and status changes to the subscribed window. Tasks are saved under the
//! project's store directory and survive restarts; the agent session is reloaded on the
//! next prompt when the agent supports `session/load`.

mod config;
mod model;
mod provider;
mod skills;
mod timeline;
mod worktree;

pub use model::*;

use ide_core::{IdeError, IdeResult, IpcPath};
use ide_jsonrpc::{Framing, Handler, Peer, RpcError, codes};
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;
use timeline::Timeline;

/// Receives the events of one project's tasks.
pub type AgentSink = Arc<dyn Fn(AgentEvent) + Send + Sync>;

/// Entry changes are batched for this long before they are sent.
const FLUSH_DELAY: Duration = Duration::from_millis(40);
/// Updates that arrive this late after `session/load` returns are still replayed history.
const REPLAY_GRACE: Duration = Duration::from_millis(300);
/// Notifications are delivered on their own thread: the last `session/update`s of a turn
/// can trail its `session/prompt` response by this much.
const TURN_GRACE: Duration = Duration::from_millis(100);
const STDERR_LINES: usize = 20;
/// Referenced files up to this size are embedded in the prompt (when the agent takes it).
const MAX_EMBED: u64 = 256 * 1024;

/// The agent tasks of one project.
pub struct AgentManager {
    shared: Arc<Shared>,
    tasks: RwLock<HashMap<String, Arc<Task>>>,
}

pub struct AgentPaths {
    pub project_root: PathBuf,
    /// One `<task id>.json` per task.
    pub store_dir: PathBuf,
    /// Parent of the tasks' worktrees.
    pub worktrees_dir: PathBuf,
    /// Settings each agent offered last time (shared by all projects), and its commands per project.
    pub models_file: PathBuf,
    /// User-defined agents, one `<id>.toml` each (`name`, `command`, `args`, `env`).
    pub custom_agents_dir: Option<PathBuf>,
    /// Managed ACP agent binaries (`<app_local_data>/acp-agents`).
    pub managed_agents_dir: Option<PathBuf>,
    /// The user's home: its `.claude` holds their own skills and commands.
    pub home_dir: Option<PathBuf>,
}

/// Starts the ACP server of a provider in a directory, speaking to `client`.
type Connector = Arc<
    dyn Fn(&provider::ProviderSpec, &Path, Arc<dyn Handler>, Box<dyn Fn(String) + Send + Sync>) -> std::io::Result<Peer>
        + Send
        + Sync,
>;

struct Shared {
    paths: AgentPaths,
    runtime: tokio::runtime::Handle,
    connector: Connector,
    sink: RwLock<Option<AgentSink>>,
    known: Mutex<HashMap<String, Known>>,
    providers: RwLock<Vec<provider::ProviderSpec>>,
}

/// What an agent offered in its last session, for the New Task page.
#[derive(Clone, Default, Serialize, Deserialize)]
struct Known {
    #[serde(default)]
    config: Vec<AgentConfigOption>,
    /// By project root: skills and custom commands differ per project.
    #[serde(default, rename = "projectCommands")]
    commands: HashMap<String, Vec<AgentCommand>>,
}

impl Shared {
    fn spec(&self, id: &str) -> Option<provider::ProviderSpec> {
        self.providers.read().iter().find(|p| p.id == id).cloned()
    }

    fn emit(&self, event: AgentEvent) {
        let sink = self.sink.read().clone();
        if let Some(sink) = sink {
            sink(event);
        }
    }

    fn known_config(&self, provider: &str) -> Vec<AgentConfigOption> {
        let cached = self.known.lock().get(provider).map(|k| k.config.clone()).unwrap_or_default();
        if cached.is_empty() { default_known_config(provider) } else { cached }
    }

    /// The commands the agent offered last time in this project.
    fn known_commands(&self, provider: &str) -> Vec<AgentCommand> {
        let cache = self.known.lock();
        cache.get(provider).and_then(|k| k.commands.get(&self.root_key())).cloned().unwrap_or_default()
    }

    fn root_key(&self) -> String {
        self.paths.project_root.to_string_lossy().into_owned()
    }

    fn remember(&self, provider: &str, config: Option<&[AgentConfigOption]>, commands: Option<&[AgentCommand]>) {
        let snapshot = {
            let mut cache = self.known.lock();
            let known = cache.entry(provider.to_owned()).or_default();
            let mut changed = false;
            if let Some(c) = config.filter(|c| !c.is_empty() && known.config != *c) {
                known.config = c.to_vec();
                changed = true;
            }
            let root = self.root_key();
            if let Some(c) =
                commands.filter(|c| !c.is_empty() && known.commands.get(&root).map(Vec::as_slice) != Some(c))
            {
                known.commands.insert(root, c.to_vec());
                changed = true;
            }
            if !changed {
                return;
            }
            serde_json::to_vec_pretty(&*cache)
        };
        if let Ok(bytes) = snapshot
            && let Err(e) = write_file(&self.paths.models_file, &bytes)
        {
            tracing::warn!("saving agent settings: {e}");
        }
    }
}

/// Lists agents and their known/default settings without requiring an open project.
pub fn providers_from(
    custom_agents_dir: Option<&Path>,
    models_file: &Path,
    managed_agents_dir: Option<&Path>,
) -> Vec<AgentProvider> {
    let known: HashMap<String, Known> =
        std::fs::read(models_file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    provider::load(custom_agents_dir)
        .into_iter()
        .map(|p| {
            let config = known
                .get(&p.id)
                .map(|k| k.config.clone())
                .filter(|c| !c.is_empty())
                .unwrap_or_else(|| default_known_config(&p.id));
            AgentProvider {
                id: p.id,
                name: p.name,
                command: std::iter::once(p.command.as_str())
                    .chain(p.args.iter().map(String::as_str))
                    .collect::<Vec<_>>()
                    .join(" "),
                installed: provider::installed(&p.command, managed_agents_dir),
                config,
                commands: Vec::new(),
            }
        })
        .collect()
}

/// Saves or resets custom CLI arguments for `provider` in `<custom_agents_dir>/<provider>.toml`.
pub fn set_custom_args_in(
    custom_agents_dir: &Path,
    models_file: &Path,
    managed_agents_dir: Option<&Path>,
    provider: &str,
    args: &[String],
) -> IdeResult<Vec<AgentProvider>> {
    provider::set_custom_args(custom_agents_dir, provider, args).map_err(|e| IdeError::internal(e.to_string()))?;
    Ok(providers_from(Some(custom_agents_dir), models_file, managed_agents_dir))
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskFile {
    task: AgentTask,
    session_id: Option<String>,
    entries: Vec<AgentEntry>,
    /// Settings the user chose, re-applied to every new or reloaded session.
    #[serde(default)]
    wanted: Vec<AgentConfigChoice>,
    /// In the project's own checkout: files already changed when the task started.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    before: BTreeMap<String, worktree::Stamp>,
}

struct TaskState {
    task: AgentTask,
    session_id: Option<String>,
    timeline: Timeline,
    wanted: Vec<AgentConfigChoice>,
    before: Arc<BTreeMap<String, worktree::Stamp>>,
    /// A turn is running or about to (prompts arriving now are queued).
    busy: bool,
}

/// A running agent and its session.
#[derive(Clone)]
struct Live {
    peer: Peer,
    session: String,
    /// `promptCapabilities.image`.
    images: bool,
    /// `promptCapabilities.embeddedContext`: referenced files are sent with their text.
    embedded: bool,
}

struct Task {
    id: String,
    shared: Arc<Shared>,
    state: Mutex<TaskState>,
    live: Mutex<Option<Live>>,
    /// Serializes starting the agent.
    connecting: tokio::sync::Mutex<()>,
    /// Unanswered permission requests: where to send the chosen option id.
    permissions: Mutex<HashMap<u32, std::sync::mpsc::Sender<Option<String>>>>,
    next_permission: AtomicU32,
    /// Set while `session/load` replays history we already have.
    replaying: AtomicBool,
    /// The current turn is being cancelled to send the first queued message right away.
    send_now: AtomicBool,
    dirty: Mutex<BTreeSet<usize>>,
    flush_scheduled: AtomicBool,
    stderr: Mutex<VecDeque<String>>,
    /// Set by `delete`; held while saving.
    deleted: Mutex<bool>,
}

impl AgentManager {
    /// Loads the project's saved tasks. Spawned work runs on `runtime`.
    pub fn new(paths: AgentPaths, runtime: tokio::runtime::Handle) -> Self {
        let managed = paths.managed_agents_dir.clone();
        let connector: Connector = Arc::new(move |spec, cwd, client, on_stderr| {
            let (command, args) = provider::resolve_spawn(spec, managed.as_deref());
            Peer::spawn_framed(&command, &args, cwd, &spec.env, client, on_stderr, Framing::Lines)
        });
        Self::with_connector(paths, runtime, connector)
    }

    fn with_connector(paths: AgentPaths, runtime: tokio::runtime::Handle, connector: Connector) -> Self {
        let known =
            std::fs::read(&paths.models_file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let providers = RwLock::new(provider::load(paths.custom_agents_dir.as_deref()));
        let shared = Arc::new(Shared {
            paths,
            runtime,
            connector,
            sink: RwLock::new(None),
            known: Mutex::new(known),
            providers,
        });
        let mut tasks = HashMap::new();
        for file in std::fs::read_dir(&shared.paths.store_dir).into_iter().flatten().flatten() {
            let path = file.path();
            if path.extension().is_none_or(|e| e != "json") {
                continue;
            }
            match std::fs::read(&path)
                .map_err(|e| e.to_string())
                .and_then(|b| serde_json::from_slice::<Value>(&b).map_err(|e| e.to_string()))
                .and_then(|v| serde_json::from_value::<TaskFile>(upgrade(v)).map_err(|e| e.to_string()))
            {
                Ok(mut f) => {
                    // The agent process did not survive the restart: whatever was in flight is over.
                    if matches!(f.task.status, AgentStatus::Running | AgentStatus::NeedsInput | AgentStatus::Starting) {
                        f.task.status = AgentStatus::Ready;
                        let mut timeline = Timeline::from_entries(std::mem::take(&mut f.entries));
                        timeline.end_turn(None);
                        f.entries = timeline.entries;
                    }
                    let task = Task::restore(f, shared.clone());
                    tasks.insert(task.id.clone(), task);
                }
                Err(e) => tracing::warn!("skipping agent task {}: {e}", path.display()),
            }
        }
        Self { shared, tasks: RwLock::new(tasks) }
    }

    /// Routes events to `sink` (replacing the previous subscriber); returns every task.
    pub fn subscribe(&self, sink: AgentSink) -> Vec<AgentTask> {
        *self.shared.sink.write() = Some(sink);
        let mut tasks: Vec<AgentTask> = self.tasks.read().values().map(|t| t.state.lock().task.clone()).collect();
        tasks.sort_by(|a, b| b.updated_ms.total_cmp(&a.updated_ms));
        tasks
    }

    /// The agents (custom ones re-read), whether each is installed, and what they offered last time.
    pub fn providers(&self) -> Vec<AgentProvider> {
        let specs = provider::load(self.shared.paths.custom_agents_dir.as_deref());
        let list = specs
            .iter()
            .map(|p| AgentProvider {
                id: p.id.clone(),
                name: p.name.clone(),
                command: std::iter::once(p.command.as_str())
                    .chain(p.args.iter().map(String::as_str))
                    .collect::<Vec<_>>()
                    .join(" "),
                installed: provider::installed(&p.command, self.shared.paths.managed_agents_dir.as_deref()),
                config: self.shared.known_config(&p.id),
                commands: self.shared.known_commands(&p.id),
            })
            .collect();
        *self.shared.providers.write() = specs;
        list
    }

    /// Saves or resets custom CLI arguments for `provider` and returns the updated provider list.
    pub fn set_custom_args(&self, provider: &str, args: &[String]) -> IdeResult<Vec<AgentProvider>> {
        let dir = self
            .shared
            .paths
            .custom_agents_dir
            .as_deref()
            .ok_or_else(|| IdeError::unavailable("custom agents directory is not configured"))?;
        provider::set_custom_args(dir, provider, args).map_err(|e| IdeError::internal(e.to_string()))?;
        Ok(self.providers())
    }

    /// Asks `provider` one question and returns its answer. The agent runs in a throwaway
    /// session in an empty temporary directory, which is not kept as a task, in a restrictive
    /// (`read-only` / `read_only` / `default`) mode, and can only answer in text: every
    /// permission it asks for is refused.
    pub async fn complete(
        &self,
        provider: &str,
        prompt: &str,
        config: &[AgentConfigChoice],
        timeout: Duration,
    ) -> IdeResult<String> {
        let prompt = prompt.trim();
        if prompt.is_empty() {
            return Err(IdeError::invalid("nothing to ask"));
        }
        let spec = provider::load(self.shared.paths.custom_agents_dir.as_deref())
            .into_iter()
            .find(|p| p.id == provider)
            .ok_or_else(|| IdeError::invalid(format!("unknown agent {provider}")))?;
        let collector = Arc::new(Collector::default());
        let stderr: Arc<Mutex<VecDeque<String>>> = Arc::default();
        let on_stderr: Box<dyn Fn(String) + Send + Sync> = {
            let stderr = stderr.clone();
            Box::new(move |line| {
                let mut buf = stderr.lock();
                if buf.len() == STDERR_LINES {
                    buf.pop_front();
                }
                buf.push_back(line);
            })
        };
        let cwd = std::env::temp_dir().join(format!("ibl-suggest-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&cwd)
            .map_err(|e| IdeError::internal(format!("cannot create temporary directory {}: {e}", cwd.display())))?;
        let fallback_config = self.shared.known_config(&spec.id);
        let peer = match (self.shared.connector)(&spec, &cwd, collector.clone(), on_stderr) {
            Ok(p) => p,
            Err(e) => {
                if let Err(rm_err) = std::fs::remove_dir_all(&cwd) {
                    tracing::warn!("complete: removing temporary cwd {} failed: {rm_err}", cwd.display());
                }
                return Err(IdeError::unavailable(format!("Couldn't start {} (`{}`): {e}", spec.name, spec.command)));
            }
        };
        let outcome =
            match tokio::time::timeout(timeout, ask(&peer, &spec, &cwd, prompt, config, &fallback_config, &collector))
                .await
            {
                Ok(Ok((stop, options))) => {
                    if !options.is_empty() {
                        self.shared.remember(&spec.id, Some(&options), None);
                    }
                    if stop == "refusal" {
                        Err(format!("{} refused to answer.", spec.name))
                    } else if stop == "cancelled" {
                        Err(format!("{} stopped before answering.", spec.name))
                    } else {
                        // The last updates of a turn can trail its response.
                        tokio::time::sleep(TURN_GRACE).await;
                        Ok(collector.text.lock().trim().to_owned())
                    }
                }
                Ok(Err(AskError::ReadOnly(message))) => Err(message),
                // Signed out, or the account was refused (Claude Code: "API Error: 403").
                Ok(Err(AskError::Rpc(RpcError::Server { message, .. }))) if message.to_lowercase().contains("auth") => {
                    Err(format!("{} needs you to sign in. {}", spec.name, spec.login_hint))
                }
                Ok(Err(AskError::Rpc(e))) => Err(describe_error(e, &stderr.lock())),
                Err(_) => Err(format!("{} didn't answer within {} seconds.", spec.name, timeout.as_secs())),
            };
        peer.kill();
        if let Err(e) = std::fs::remove_dir_all(&cwd) {
            tracing::warn!("complete: removing temporary cwd {} failed: {e}", cwd.display());
        }
        match outcome {
            Ok(text) if !text.is_empty() => Ok(text),
            Ok(_) => Err(IdeError::unavailable(format!("{} returned no text.", spec.name))),
            Err(message) => Err(IdeError::unavailable(message)),
        }
    }

    /// The slash commands to complete for `provider`, in `task`'s directory or (without one)
    /// in the project: what the agent offered last time there, plus, for Claude Code, the
    /// skills and custom commands on disk it has not listed.
    pub async fn commands(&self, provider: &str, task: Option<&str>) -> IdeResult<Vec<AgentCommand>> {
        let (provider, offered, cwd) = match task {
            Some(id) => {
                let task = self.task(id)?;
                let s = task.state.lock();
                (s.task.provider.clone(), s.task.commands.clone(), s.task.cwd.0.clone())
            }
            None => (provider.to_owned(), self.shared.known_commands(provider), self.shared.paths.project_root.clone()),
        };
        if provider != "claude" {
            return Ok(offered);
        }
        let home = self.shared.paths.home_dir.clone();
        let found = blocking(move || Ok(skills::discover(&cwd, home.as_deref()))).await?;
        Ok(skills::merge(offered, found))
    }

    fn task(&self, id: &str) -> IdeResult<Arc<Task>> {
        self.tasks.read().get(id).cloned().ok_or_else(|| IdeError::not_found(format!("no agent task {id}")))
    }

    pub fn entries(&self, id: &str) -> IdeResult<Vec<AgentEntry>> {
        Ok(self.task(id)?.state.lock().timeline.entries.clone())
    }

    /// Creates the task (and its worktree) and sends `req.prompt` as its first message.
    pub async fn create(&self, req: NewAgentTask) -> IdeResult<AgentTask> {
        let spec = self
            .shared
            .spec(&req.provider)
            .ok_or_else(|| IdeError::invalid(format!("unknown agent {}", req.provider)))?;
        let prompt = clean(req.prompt).ok_or_else(|| IdeError::invalid("describe the task first"))?;
        let title = title_of(&prompt);
        let root = self.shared.paths.project_root.clone();
        let (cwd, branch, base, base_commit, before) = match req.isolation {
            Isolation::Worktree => {
                let dir = self.shared.paths.worktrees_dir.clone();
                let (t, b) = (title.clone(), req.base.clone());
                let c = blocking(move || worktree::create(&root, &dir, &t, b.as_deref())).await?;
                (c.path, Some(c.branch), Some(c.base), Some(c.base_commit), BTreeMap::new())
            }
            Isolation::Local => {
                let r = root.clone();
                let (head, before) =
                    blocking(move || Ok((worktree::head_of(&r).ok(), worktree::snapshot(&r).unwrap_or_default())))
                        .await?;
                let (base, commit) = head.unzip();
                (root, None, base, commit, before)
            }
        };
        // Until the session reports its own, show what the agent offered last time with the choices applied.
        let mut config = self.shared.known_config(&spec.id);
        for choice in &req.config {
            if let Some(o) =
                config.iter_mut().find(|o| o.id == choice.id || o.category.as_deref() == Some(choice.id.as_str()))
            {
                o.current = Some(choice.value.clone());
            }
        }
        let now = now_ms();
        let task = AgentTask {
            id: uuid::Uuid::new_v4().simple().to_string(),
            title,
            provider: spec.id.clone(),
            model: model_of(&config),
            status: AgentStatus::Starting,
            isolation: req.isolation,
            cwd: IpcPath(cwd),
            branch,
            base,
            base_commit,
            error: None,
            created_ms: now,
            updated_ms: now,
            config,
            commands: self.shared.known_commands(&spec.id),
            usage: None,
            queue: Vec::new(),
        };
        let instructions = req.instructions.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty());
        let file = TaskFile { task: task.clone(), session_id: None, entries: Vec::new(), wanted: req.config, before };
        let handle = Task::restore(file, self.shared.clone());
        handle.state.lock().busy = true;
        self.tasks.write().insert(task.id.clone(), handle.clone());
        handle.emit_task();
        handle.persist();
        self.shared.runtime.spawn(async move { handle.run(prompt, instructions).await });
        Ok(task)
    }

    /// Sends a message. While the agent works it is queued, or with `now` the current turn
    /// is cancelled and the message goes next.
    pub async fn prompt(&self, id: &str, prompt: AgentPrompt, now: bool) -> IdeResult<()> {
        let task = self.task(id)?;
        let prompt = clean(prompt).ok_or_else(|| IdeError::invalid("empty message"))?;
        let start = {
            let mut s = task.state.lock();
            if s.task.status == AgentStatus::Archived {
                return Err(IdeError::invalid("the task is archived"));
            }
            if s.busy {
                let item = AgentQueued { id: uuid::Uuid::new_v4().simple().to_string(), prompt };
                if now {
                    s.task.queue.insert(0, item);
                } else {
                    s.task.queue.push(item);
                }
                None
            } else {
                s.busy = true;
                Some(prompt)
            }
        };
        match start {
            Some(prompt) => {
                self.shared.runtime.spawn(async move { task.run(prompt, None).await });
            }
            None => {
                task.persist();
                task.emit_task();
                if now {
                    task.send_now.store(true, Ordering::Release);
                    task.cancel();
                }
            }
        }
        Ok(())
    }

    /// Drops a queued message.
    pub fn unqueue(&self, id: &str, queued: &str) -> IdeResult<AgentQueued> {
        let task = self.task(id)?;
        let item = {
            let mut s = task.state.lock();
            let i =
                s.task.queue.iter().position(|q| q.id == queued).ok_or_else(|| IdeError::not_found("already sent"))?;
            s.task.queue.remove(i)
        };
        task.persist();
        task.emit_task();
        Ok(item)
    }

    /// Sends queued message `queued` next, cancelling the current turn if there is one.
    pub fn send_queued_now(&self, id: &str, queued: &str) -> IdeResult<()> {
        let task = self.task(id)?;
        let idle = {
            let mut s = task.state.lock();
            let i =
                s.task.queue.iter().position(|q| q.id == queued).ok_or_else(|| IdeError::not_found("already sent"))?;
            let item = s.task.queue.remove(i);
            if s.busy {
                s.task.queue.insert(0, item);
                None
            } else {
                s.busy = true;
                Some(item)
            }
        };
        task.persist();
        task.emit_task();
        match idle {
            Some(item) => {
                self.shared.runtime.spawn(async move { task.run(item.prompt, None).await });
            }
            None => {
                task.send_now.store(true, Ordering::Release);
                task.cancel();
            }
        }
        Ok(())
    }

    /// Changes a session setting (model, mode…): right away when the agent runs, else when it next starts.
    pub async fn set_config(&self, id: &str, option: &str, value: String) -> IdeResult<()> {
        let task = self.task(id)?;
        let target = {
            let s = task.state.lock();
            let o =
                s.task.config.iter().find(|o| o.id == option).ok_or_else(|| IdeError::not_found("no such setting"))?;
            if !o.values.iter().any(|v| v.value == value) {
                return Err(IdeError::invalid(format!("{} has no value {value}", o.name)));
            }
            o.clone()
        };
        let live = task.live.lock().clone().filter(|l| !l.peer.is_closed());
        if let Some(live) = live {
            let (method, mut params) = config::set_request(&target, &value);
            params["sessionId"] = json!(live.session);
            let reply: Value =
                live.peer.request(method, params, None).await.map_err(|e| IdeError::internal(task.describe(e)))?;
            if let Some(options) = reply.get("configOptions") {
                config::merge_update(&mut task.state.lock().task.config, options);
            }
        }
        {
            let mut s = task.state.lock();
            s.wanted.retain(|c| c.id != option);
            s.wanted.push(AgentConfigChoice { id: option.to_owned(), value: value.clone() });
            if let Some(o) = s.task.config.iter_mut().find(|o| o.id == option) {
                o.current = Some(value);
            }
            s.task.model = model_of(&s.task.config).or(s.task.model.take());
        }
        task.persist();
        task.emit_task();
        Ok(())
    }

    /// Stops the current turn (`session/cancel`); pending permission requests are cancelled.
    /// Queued messages stay queued.
    pub fn cancel(&self, id: &str) -> IdeResult<()> {
        self.task(id)?.cancel();
        Ok(())
    }

    /// Answers permission request `permission` with option `option` (`None` cancels it).
    pub fn respond(&self, id: &str, permission: u32, option: Option<String>) -> IdeResult<()> {
        let task = self.task(id)?;
        let pending = task.permissions.lock().remove(&permission);
        match pending {
            Some(reply) => {
                let _ = reply.send(option);
                Ok(())
            }
            None => Err(IdeError::not_found("the request was already answered")),
        }
    }

    /// Stops the agent and moves the task to Archived; its worktree stays.
    pub fn archive(&self, id: &str) -> IdeResult<()> {
        let task = self.task(id)?;
        task.kill();
        task.set_status(AgentStatus::Archived, None);
        Ok(())
    }

    /// Forgets the task; with `remove_worktree` also deletes its worktree (the branch stays).
    pub async fn delete(&self, id: &str, remove_worktree: bool) -> IdeResult<()> {
        let task = self.task(id)?;
        task.kill();
        let (isolation, cwd) = {
            let s = task.state.lock();
            (s.task.isolation, s.task.cwd.0.clone())
        };
        if remove_worktree && isolation == Isolation::Worktree && cwd.exists() {
            let root = self.shared.paths.project_root.clone();
            blocking(move || worktree::remove(&root, &cwd)).await?;
        }
        self.tasks.write().remove(id);
        *task.deleted.lock() = true;
        let _ = std::fs::remove_file(self.shared.paths.store_dir.join(format!("{id}.json")));
        self.shared.emit(AgentEvent::Removed { id: id.to_owned() });
        Ok(())
    }

    /// Files the task changed since it started.
    pub async fn changes(&self, id: &str) -> IdeResult<Vec<AgentChange>> {
        let task = self.task(id)?;
        let (cwd, base) = task.cwd_and_base();
        let before = task.state.lock().before.clone();
        blocking(move || Ok(worktree::without_untouched(worktree::changes(&cwd, &base)?, &before))).await
    }

    /// Content of `path` (in the task's directory) when the task started.
    pub async fn base_text(&self, id: &str, path: PathBuf) -> IdeResult<Option<String>> {
        let (cwd, base) = self.task(id)?.cwd_and_base();
        blocking(move || worktree::file_at(&cwd, &path, &base)).await
    }

    /// Stops every agent (project closed).
    pub fn shutdown(&self) {
        for task in self.tasks.read().values() {
            task.kill();
        }
        *self.shared.sink.write() = None;
    }
}

impl Task {
    fn restore(file: TaskFile, shared: Arc<Shared>) -> Arc<Self> {
        let task = file.task;
        let timeline = Timeline::from_entries(file.entries);
        Arc::new(Self {
            id: task.id.clone(),
            shared,
            state: Mutex::new(TaskState {
                task,
                session_id: file.session_id,
                timeline,
                wanted: file.wanted,
                before: Arc::new(file.before),
                busy: false,
            }),
            live: Mutex::new(None),
            connecting: tokio::sync::Mutex::new(()),
            permissions: Mutex::new(HashMap::new()),
            next_permission: AtomicU32::new(1),
            replaying: AtomicBool::new(false),
            send_now: AtomicBool::new(false),
            dirty: Mutex::new(BTreeSet::new()),
            flush_scheduled: AtomicBool::new(false),
            stderr: Mutex::new(VecDeque::new()),
            deleted: Mutex::new(false),
        })
    }

    fn cwd_and_base(&self) -> (PathBuf, String) {
        let s = self.state.lock();
        // In the project's own checkout the user commits too: compare against the current HEAD,
        // as the Commit tool window does, so commits made since the task started drop out.
        let base = match s.task.isolation {
            Isolation::Local => None,
            Isolation::Worktree => s.task.base_commit.clone(),
        };
        (s.task.cwd.0.clone(), base.unwrap_or_else(|| "HEAD".into()))
    }

    fn emit_task(&self) {
        let task = self.state.lock().task.clone();
        self.shared.emit(AgentEvent::Task { task });
    }

    fn set_status(&self, status: AgentStatus, error: Option<String>) {
        {
            let mut s = self.state.lock();
            s.task.status = status;
            s.task.error = error;
            s.task.updated_ms = now_ms();
        }
        // Saved first: whoever reacts to the status change finds it on disk.
        self.persist();
        self.emit_task();
    }

    fn persist(&self) {
        // Held from snapshot to rename, so saves land in order and none follows a delete.
        let deleted = self.deleted.lock();
        if *deleted {
            return;
        }
        let bytes = {
            let s = self.state.lock();
            serde_json::to_vec(&TaskFile {
                task: s.task.clone(),
                session_id: s.session_id.clone(),
                entries: s.timeline.entries.clone(),
                wanted: s.wanted.clone(),
                before: (*s.before).clone(),
            })
        };
        let path = self.shared.paths.store_dir.join(format!("{}.json", self.id));
        if let Err(e) = bytes.map_err(|e| e.to_string()).and_then(|b| write_file(&path, &b)) {
            tracing::warn!("saving agent task {}: {e}", self.id);
        }
    }

    fn mark_dirty(self: &Arc<Self>, indices: impl IntoIterator<Item = usize>) {
        self.dirty.lock().extend(indices);
        if !self.flush_scheduled.swap(true, Ordering::AcqRel) {
            let task = self.clone();
            self.shared.runtime.spawn(async move {
                tokio::time::sleep(FLUSH_DELAY).await;
                task.flush_scheduled.store(false, Ordering::Release);
                task.flush();
            });
        }
    }

    fn flush(&self) {
        let indices = std::mem::take(&mut *self.dirty.lock());
        let events: Vec<AgentEvent> = {
            let s = self.state.lock();
            indices
                .into_iter()
                .filter_map(|i| {
                    let entry = s.timeline.entries.get(i)?.clone();
                    Some(AgentEvent::Entry { task: self.id.clone(), index: i as u32, entry })
                })
                .collect()
        };
        for e in events {
            self.shared.emit(e);
        }
    }

    fn push_entry(self: &Arc<Self>, entry: AgentEntry) -> usize {
        let i = self.state.lock().timeline.push(entry);
        self.mark_dirty([i]);
        i
    }

    /// Runs `prompt`, then the queued messages, until the queue is empty, a turn fails, or
    /// the user stops one. The caller set `busy`.
    async fn run(self: Arc<Self>, mut prompt: AgentPrompt, mut instructions: Option<String>) {
        loop {
            let result = self.turn(&prompt, instructions.take().as_deref()).await;
            tokio::time::sleep(TURN_GRACE).await;
            let changed = self.state.lock().timeline.end_turn(Some(now_ms()));
            self.mark_dirty(changed);
            let send_now = self.send_now.swap(false, Ordering::AcqRel);
            let next = {
                let mut s = self.state.lock();
                let go_on = s.task.status != AgentStatus::Archived
                    && match &result {
                        Ok(stop) => stop != "cancelled" || send_now,
                        Err(_) => false,
                    };
                let next = (go_on && !s.task.queue.is_empty()).then(|| s.task.queue.remove(0));
                if next.is_none() {
                    s.busy = false;
                }
                next
            };
            if self.state.lock().task.status == AgentStatus::Archived {
                self.persist();
                return;
            }
            if let Ok(stop) = &result
                && stop == "refusal"
            {
                self.push_entry(AgentEntry::Error { message: "The agent declined to continue.".into() });
            }
            match (next, result) {
                (Some(queued), _) => prompt = queued.prompt,
                (None, Ok(_)) => return self.set_status(AgentStatus::Ready, None),
                (None, Err(message)) => {
                    self.push_entry(AgentEntry::Error { message: message.clone() });
                    return self.set_status(AgentStatus::Failed, Some(message));
                }
            }
        }
    }

    /// Sends one prompt, starting the agent first if needed; returns the stop reason.
    async fn turn(self: &Arc<Self>, prompt: &AgentPrompt, instructions: Option<&str>) -> Result<String, String> {
        let attachments = prompt
            .files
            .iter()
            .map(|f| file_name(&f.0))
            .chain(prompt.images.iter().map(|i| i.name.clone().unwrap_or_else(|| "image".into())))
            .collect();
        self.push_entry(AgentEntry::User {
            text: prompt.text.clone(),
            attachments,
            sent_ms: Some(now_ms()),
            done_ms: None,
        });
        // Launching the agent can take a while (`npx` fetches its adapter on first use).
        let starting = self.live.lock().as_ref().is_none_or(|l| l.peer.is_closed());
        self.set_status(if starting { AgentStatus::Starting } else { AgentStatus::Running }, None);
        let live = self.ensure_session().await?;
        self.set_status(AgentStatus::Running, None);
        if !prompt.images.is_empty() && !live.images {
            return Err("This agent can't read images.".into());
        }
        let contents = if live.embedded && !prompt.files.is_empty() {
            let files: Vec<PathBuf> = prompt.files.iter().map(|f| f.0.clone()).collect();
            tokio::task::spawn_blocking(move || files.iter().map(|f| embeddable(f)).collect()).await.unwrap_or_default()
        } else {
            Vec::new()
        };
        let wire_prompt;
        let outgoing = match instructions.map(str::trim).filter(|s| !s.is_empty()) {
            Some(inst) if prompt.text.is_empty() => {
                wire_prompt =
                    AgentPrompt { text: inst.to_owned(), files: prompt.files.clone(), images: prompt.images.clone() };
                &wire_prompt
            }
            Some(inst) => {
                wire_prompt = AgentPrompt {
                    text: format!("{inst}\n\n{}", prompt.text),
                    files: prompt.files.clone(),
                    images: prompt.images.clone(),
                };
                &wire_prompt
            }
            None => prompt,
        };
        let result: Result<Value, RpcError> = live
            .peer
            .request(
                "session/prompt",
                json!({ "sessionId": live.session, "prompt": blocks(outgoing, &contents) }),
                None,
            )
            .await;
        match result {
            Ok(v) => Ok(v.get("stopReason").and_then(Value::as_str).unwrap_or("end_turn").to_owned()),
            // Signed out, or the account was refused (Claude Code: "API Error: 403").
            Err(RpcError::Server { message, .. }) if message.to_lowercase().contains("auth") => {
                let provider = self.state.lock().task.provider.clone();
                Err(match self.shared.spec(&provider) {
                    Some(spec) => format!("{} needs you to sign in. {}", spec.name, spec.login_hint),
                    None => message,
                })
            }
            Err(e) => Err(self.describe(e)),
        }
    }

    async fn ensure_session(self: &Arc<Self>) -> Result<Live, String> {
        let _guard = self.connecting.lock().await;
        if let Some(live) = self.live.lock().clone()
            && !live.peer.is_closed()
        {
            return Ok(live);
        }
        let (provider_id, cwd, saved) = {
            let s = self.state.lock();
            (s.task.provider.clone(), s.task.cwd.0.clone(), s.session_id.clone())
        };
        let spec = self.shared.spec(&provider_id).ok_or_else(|| format!("unknown agent {provider_id}"))?;
        self.stderr.lock().clear();
        let weak = Arc::downgrade(self);
        let on_stderr: Box<dyn Fn(String) + Send + Sync> = Box::new(move |line| {
            if let Some(t) = weak.upgrade() {
                let mut buf = t.stderr.lock();
                if buf.len() == STDERR_LINES {
                    buf.pop_front();
                }
                buf.push_back(line);
            }
        });
        let client = Arc::new(Client { task: Arc::downgrade(self) });
        let peer = (self.shared.connector)(&spec, &cwd, client, on_stderr)
            .map_err(|e| format!("Couldn't start {} (`{}`): {e}", spec.name, spec.command))?;

        let init: Value = peer
            .request(
                "initialize",
                json!({
                    "protocolVersion": 1,
                    "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false },
                    "clientInfo": { "name": "OpenIDEA", "version": env!("CARGO_PKG_VERSION") },
                }),
                None,
            )
            .await
            .map_err(|e| self.describe(e))?;
        let can_load = init.pointer("/agentCapabilities/loadSession").and_then(Value::as_bool) == Some(true);
        let capable = |c: &str| {
            init.pointer(&format!("/agentCapabilities/promptCapabilities/{c}")).and_then(Value::as_bool) == Some(true)
        };
        let (images, embedded) = (capable("image"), capable("embeddedContext"));
        let cwd_s = cwd.to_string_lossy().into_owned();

        let mut session = None;
        if let (Some(id), true) = (saved, can_load) {
            self.replaying.store(true, Ordering::Release);
            let loaded: Result<Value, RpcError> =
                peer.request("session/load", json!({ "sessionId": id, "cwd": cwd_s, "mcpServers": [] }), None).await;
            tokio::time::sleep(REPLAY_GRACE).await;
            self.replaying.store(false, Ordering::Release);
            match loaded {
                Ok(v) => session = Some((id, v)),
                Err(e) => tracing::info!("agent task {}: session/load failed, starting a new session: {e}", self.id),
            }
        }
        let (session_id, result) = match session {
            Some(s) => s,
            None => {
                let v: Value = peer
                    .request("session/new", json!({ "cwd": cwd_s, "mcpServers": [] }), None)
                    .await
                    .map_err(|e| match e {
                        RpcError::Server { ref message, .. } if message.to_lowercase().contains("auth") => {
                            format!("{} needs you to sign in. {}", spec.name, spec.login_hint)
                        }
                        e => self.describe(e),
                    })?;
                let id = v.get("sessionId").and_then(Value::as_str).ok_or("the agent returned no session")?.to_owned();
                (id, v)
            }
        };

        // The session's settings, then the user's choices on top.
        // A session that reports none keeps the last known ones, but what is set is unknown.
        let reported = config::options_of(&result);
        let known = !reported.is_empty();
        let (mut options, wanted) = {
            let s = self.state.lock();
            (if known { reported } else { s.task.config.clone() }, s.wanted.clone())
        };
        self.shared.remember(&provider_id, Some(&options), None);
        for choice in &wanted {
            let Some(o) = options
                .iter()
                .find(|o| o.id == choice.id || o.category.as_deref() == Some(choice.id.as_str()))
                .cloned()
            else {
                continue;
            };
            let already = known && o.current.as_deref() == Some(choice.value.as_str());
            if already || !o.values.iter().any(|v| v.value == choice.value) {
                continue;
            }
            let (method, mut params) = config::set_request(&o, &choice.value);
            params["sessionId"] = json!(session_id);
            match peer.request::<_, Value>(method, params, None).await {
                Ok(reply) => {
                    if let Some(fresh) = reply.get("configOptions") {
                        config::merge_update(&mut options, fresh);
                    }
                    if let Some(target) = options.iter_mut().find(|opt| opt.id == o.id) {
                        target.current = Some(choice.value.clone());
                    }
                }
                Err(e) => tracing::warn!("agent task {}: setting {} to {} failed: {e}", self.id, o.id, choice.value),
            }
        }
        {
            let mut s = self.state.lock();
            s.task.model = model_of(&options).or(s.task.model.take());
            s.task.config = options;
            s.session_id = Some(session_id.clone());
        }
        self.persist();
        self.emit_task();
        let live = Live { peer, session: session_id, images, embedded };
        *self.live.lock() = Some(live.clone());
        Ok(live)
    }

    /// A user-facing message for a failed request, with the agent's last stderr lines when it died.
    fn describe(&self, e: RpcError) -> String {
        describe_error(e, &self.stderr.lock())
    }

    fn on_update(self: &Arc<Self>, update: &Value) {
        let kind = update.get("sessionUpdate").and_then(Value::as_str).unwrap_or_default();
        if kind == "session_info_update" {
            // The agent's own title for the session replaces the first line of the prompt.
            let title = update.get("title").and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty());
            if let Some(title) = title {
                self.state.lock().task.title = title.to_owned();
                self.persist();
                self.emit_task();
            }
            return;
        }
        // Session state (also while `session/load` replays history).
        let provider = self.state.lock().task.provider.clone();
        let task_changed = {
            let mut s = self.state.lock();
            match kind {
                "config_option_update" => {
                    if let Some(options) = update.get("configOptions") {
                        config::merge_update(&mut s.task.config, options);
                        s.task.model = model_of(&s.task.config).or(s.task.model.take());
                    }
                    true
                }
                "current_mode_update" => {
                    if let Some(mode) = update.get("currentModeId").and_then(Value::as_str) {
                        config::set_mode(&mut s.task.config, mode);
                    }
                    true
                }
                "available_commands_update" => {
                    s.task.commands = config::commands_of(update);
                    true
                }
                "usage_update" => {
                    s.task.usage = config::usage_of(update).or(s.task.usage.take());
                    true
                }
                _ => false,
            }
        };
        if task_changed {
            let (config, commands) = {
                let s = self.state.lock();
                (s.task.config.clone(), s.task.commands.clone())
            };
            self.shared.remember(&provider, Some(&config), Some(&commands));
            if kind != "usage_update" {
                self.persist();
            }
            self.emit_task();
            return;
        }
        if self.replaying.load(Ordering::Acquire) {
            return;
        }
        let applied = self.state.lock().timeline.apply(update);
        self.mark_dirty(applied.changed);
    }

    /// Blocks the calling (blocking-pool) thread until the user answers.
    fn ask_permission(self: &Arc<Self>, params: &Value) -> Value {
        let id = self.next_permission.fetch_add(1, Ordering::Relaxed);
        let title = params
            .pointer("/toolCall/title")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty())
            .unwrap_or("The agent asks for permission")
            .to_owned();
        let options: Vec<AgentPermissionOption> = params
            .get("options")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|o| {
                        Some(AgentPermissionOption {
                            id: o.get("optionId")?.as_str()?.to_owned(),
                            name: o.get("name").and_then(Value::as_str).unwrap_or_default().to_owned(),
                            kind: o.get("kind").and_then(Value::as_str).unwrap_or_default().to_owned(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        let (tx, rx) = std::sync::mpsc::channel();
        let entry = self.push_entry(AgentEntry::Permission { id, title, options: options.clone(), chosen: None });
        self.permissions.lock().insert(id, tx);
        self.set_status(AgentStatus::NeedsInput, None);

        let answer = rx.recv().ok().flatten();
        let name = answer
            .as_ref()
            .and_then(|a| options.iter().find(|o| &o.id == a))
            .map_or_else(|| "Cancelled".to_owned(), |o| o.name.clone());
        {
            let mut s = self.state.lock();
            if let Some(AgentEntry::Permission { chosen, .. }) = s.timeline.entries.get_mut(entry) {
                *chosen = Some(name);
            }
        }
        self.mark_dirty([entry]);
        let still_asking = !self.permissions.lock().is_empty();
        if !still_asking && self.state.lock().task.status == AgentStatus::NeedsInput {
            self.set_status(AgentStatus::Running, None);
        }
        match answer {
            Some(option) => json!({ "outcome": { "outcome": "selected", "optionId": option } }),
            None => json!({ "outcome": { "outcome": "cancelled" } }),
        }
    }

    fn cancel_permissions(&self) {
        for (_, reply) in self.permissions.lock().drain() {
            let _ = reply.send(None);
        }
    }

    fn cancel(&self) {
        self.cancel_permissions();
        if let Some(live) = self.live.lock().clone() {
            let _ = live.peer.notify("session/cancel", json!({ "sessionId": live.session }));
        }
    }

    fn kill(&self) {
        self.cancel_permissions();
        if let Some(live) = self.live.lock().take() {
            live.peer.kill();
        }
    }
}

/// Answers the agent's requests on behalf of one task.
struct Client {
    task: Weak<Task>,
}

impl Handler for Client {
    fn on_notification(&self, method: &str, params: Value) {
        if method == "session/update"
            && let (Some(task), Some(update)) = (self.task.upgrade(), params.get("update"))
        {
            task.on_update(update);
        }
    }

    fn on_request(&self, method: &str, params: Value) -> Result<Value, (i64, String)> {
        let task = self.task.upgrade().ok_or((codes::INTERNAL_ERROR, "task closed".to_owned()))?;
        match method {
            "session/request_permission" => Ok(task.ask_permission(&params)),
            _ => Err((codes::METHOD_NOT_FOUND, format!("unsupported method {method}"))),
        }
    }
}

/// Gathers what an agent says in a throwaway session and refuses whatever it asks for.
#[derive(Default)]
struct Collector {
    text: Mutex<String>,
    config_updates: Mutex<Vec<Value>>,
}

impl Handler for Collector {
    fn on_notification(&self, method: &str, params: Value) {
        let Some(update) = params.get("update").filter(|_| method == "session/update") else { return };
        match update.get("sessionUpdate").and_then(Value::as_str) {
            Some("agent_message_chunk") => {
                if let Some(text) = update.pointer("/content/text").and_then(Value::as_str) {
                    self.text.lock().push_str(text);
                }
            }
            Some("config_option_update") => {
                if let Some(opts) = update.get("configOptions") {
                    self.config_updates.lock().push(opts.clone());
                }
            }
            _ => {}
        }
    }

    fn on_request(&self, method: &str, _: Value) -> Result<Value, (i64, String)> {
        match method {
            "session/request_permission" => Ok(json!({ "outcome": { "outcome": "cancelled" } })),
            _ => Err((codes::METHOD_NOT_FOUND, format!("unsupported method {method}"))),
        }
    }
}

enum AskError {
    Rpc(RpcError),
    ReadOnly(String),
}

impl From<RpcError> for AskError {
    fn from(e: RpcError) -> Self {
        Self::Rpc(e)
    }
}

fn is_mode_option(o: &AgentConfigOption) -> bool {
    o.id == "mode" || o.category.as_deref() == Some("mode")
}

/// Picks a restrictive mode (`read-only`, `read_only`, `default`) from the session's reported
/// options, or returns `Err` naming the available values when none is allowlisted.
fn restrictive_mode(options: &[AgentConfigOption]) -> Result<String, String> {
    let Some(opt) = options.iter().find(|o| is_mode_option(o)) else {
        return Err("none".into());
    };
    if opt.values.is_empty() {
        return Err("none".into());
    }
    for candidate in ["read-only", "read_only", "default"] {
        if opt.values.iter().any(|v| v.value == candidate) {
            return Ok(candidate.to_owned());
        }
    }
    Err(opt.values.iter().map(|v| v.value.as_str()).collect::<Vec<_>>().join(", "))
}

/// One question in a new session (`initialize`, `session/new`, mandatory restrictive mode +
/// optional `session/set_*`, `session/prompt`).
async fn ask(
    peer: &Peer,
    spec: &provider::ProviderSpec,
    cwd: &Path,
    prompt: &str,
    config: &[AgentConfigChoice],
    fallback_config: &[AgentConfigOption],
    collector: &Collector,
) -> Result<(String, Vec<AgentConfigOption>), AskError> {
    peer.request::<_, Value>(
        "initialize",
        json!({
            "protocolVersion": 1,
            "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false },
            "clientInfo": { "name": "OpenIDEA", "version": env!("CARGO_PKG_VERSION") },
        }),
        None,
    )
    .await?;
    let cwd_s = cwd.to_string_lossy().into_owned();
    let session: Value = peer.request("session/new", json!({ "cwd": cwd_s, "mcpServers": [] }), None).await?;
    let id = session
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or_else(|| RpcError::Protocol("the agent returned no session".into()))?;
    let mut options = config::options_of(&session);
    for update in collector.config_updates.lock().drain(..) {
        config::merge_update(&mut options, &update);
    }
    let chosen_mode = restrictive_mode(&options).map_err(|modes| {
        AskError::ReadOnly(format!(
            "{} cannot run read-only (modes: {modes}). Choose Claude, Codex or Antigravity for commit suggestions.",
            spec.name
        ))
    })?;
    tracing::info!(
        agent = %spec.id,
        mode = %chosen_mode,
        cwd = %cwd.display(),
        "running read-only completion"
    );
    let has_reported = !options.is_empty();
    let mut effective_choices: Vec<(bool, AgentConfigChoice)> = Vec::new();
    for choice in config {
        let matches = |o: &AgentConfigOption| o.id == choice.id || o.category.as_deref() == Some(choice.id.as_str());
        let is_caller_mode = choice.id == "mode"
            || options.iter().any(|o| matches(o) && is_mode_option(o))
            || fallback_config.iter().any(|o| matches(o) && is_mode_option(o));
        if !is_caller_mode {
            effective_choices.push((false, choice.clone()));
        }
    }
    // The mode goes last, so no other setting the agent applies after it can change it.
    effective_choices.push((true, AgentConfigChoice { id: "mode".into(), value: chosen_mode }));
    for (is_mode, choice) in &effective_choices {
        let value = choice.value.trim();
        if value.is_empty() {
            continue;
        }
        let matches = |o: &AgentConfigOption| o.id == choice.id || o.category.as_deref() == Some(choice.id.as_str());
        let target = if *is_mode {
            options.iter().find(|o| is_mode_option(o)).cloned().expect("restrictive_mode verified mode option")
        } else {
            options
                .iter()
                .find(|o| matches(o))
                .cloned()
                .or_else(|| fallback_config.iter().find(|o| matches(o)).cloned())
                .unwrap_or_else(|| AgentConfigOption {
                    id: choice.id.clone(),
                    name: choice.id.clone(),
                    description: None,
                    category: Some(choice.id.clone()),
                    current: None,
                    values: Vec::new(),
                    via: AgentConfigVia::Option,
                })
        };
        if has_reported && target.current.as_deref() == Some(value) {
            continue;
        }
        let (method, mut params) = config::set_request(&target, value);
        params["sessionId"] = json!(id);
        match peer.request::<_, Value>(method, params, None).await {
            Ok(reply) => {
                if let Some(fresh) = reply.get("configOptions") {
                    config::merge_update(&mut options, fresh);
                }
                if let Some(o) = options.iter_mut().find(|o| o.id == target.id) {
                    o.current = Some(value.to_owned());
                }
            }
            Err(e) if *is_mode => return Err(AskError::Rpc(e)),
            Err(e) => tracing::warn!("complete: setting {} to {} failed: {e}", target.id, value),
        }
    }
    let reply: Value = peer
        .request("session/prompt", json!({ "sessionId": id, "prompt": [{ "type": "text", "text": prompt }] }), None)
        .await?;
    let stop = reply.get("stopReason").and_then(Value::as_str).unwrap_or("end_turn").to_owned();
    Ok((stop, options))
}

fn opt_value(value: &str, name: &str, description: Option<&str>) -> AgentConfigValue {
    AgentConfigValue { value: value.into(), name: name.into(), description: description.map(Into::into) }
}

fn default_known_config(provider: &str) -> Vec<AgentConfigOption> {
    match provider {
        "agy" => vec![
            AgentConfigOption {
                id: "model".into(),
                name: "Model".into(),
                description: None,
                category: Some("model".into()),
                current: Some("gemini-4-argon".into()),
                values: vec![
                    opt_value("gemini-4-argon", "Gemini 4 Argon", None),
                    opt_value("gemini-3.8-flash", "Gemini 3.8 Flash", None),
                ],
                via: AgentConfigVia::Option,
            },
            AgentConfigOption {
                id: "thinking_level".into(),
                name: "Thinking Level".into(),
                description: None,
                category: Some("thought_level".into()),
                current: Some("high".into()),
                values: vec![
                    opt_value("low", "Low", None),
                    opt_value("medium", "Medium", None),
                    opt_value("high", "High", None),
                ],
                via: AgentConfigVia::Option,
            },
            AgentConfigOption {
                id: "mode".into(),
                name: "Session Mode".into(),
                description: None,
                category: Some("mode".into()),
                current: Some("yolo".into()),
                values: vec![
                    opt_value("default", "Default", Some("Default permission prompt flow")),
                    opt_value("auto_edit", "Auto Edit", Some("Auto-approve file edit tools")),
                    opt_value("yolo", "YOLO", Some("Auto-approve all tools")),
                ],
                via: AgentConfigVia::Option,
            },
        ],
        "pi" => vec![
            AgentConfigOption {
                id: "model".into(),
                name: "Model".into(),
                description: None,
                category: Some("model".into()),
                current: Some("anthropic/claude-sonnet-4-6".into()),
                values: vec![
                    opt_value("anthropic/claude-sonnet-4-6", "Claude Sonnet 4.6", None),
                    opt_value("anthropic/claude-opus-4-7", "Claude Opus 4.7", None),
                    opt_value("anthropic/claude-haiku-4-5", "Claude Haiku 4.5", None),
                    opt_value("openai-codex/gpt-5.4", "GPT-5.4 (Codex)", None),
                    opt_value("openai-codex/gpt-5.4-mini", "GPT-5.4 mini (Codex)", None),
                    opt_value("google/gemini-2.5-pro", "Gemini 2.5 Pro", None),
                    opt_value("google/gemini-2.5-flash", "Gemini 2.5 Flash", None),
                ],
                via: AgentConfigVia::Option,
            },
            AgentConfigOption {
                id: "thought_level".into(),
                name: "Thinking Level".into(),
                description: None,
                category: Some("thought_level".into()),
                current: Some("medium".into()),
                values: vec![
                    opt_value("low", "Low", None),
                    opt_value("medium", "Medium", None),
                    opt_value("high", "High", None),
                    opt_value("max", "Max", None),
                ],
                via: AgentConfigVia::Option,
            },
        ],
        "codex" => vec![
            AgentConfigOption {
                id: "mode".into(),
                name: "Approval Preset".into(),
                description: Some("Choose an approval and sandboxing preset for your session".into()),
                category: Some("mode".into()),
                current: Some("auto".into()),
                values: vec![
                    opt_value("read-only", "Read Only", Some("Codex can read files in the current workspace.")),
                    opt_value("auto", "Default", Some("Codex can read and edit files, and run commands.")),
                    opt_value(
                        "full-access",
                        "Full Access",
                        Some("Codex can edit files and run commands without asking."),
                    ),
                ],
                via: AgentConfigVia::Option,
            },
            AgentConfigOption {
                id: "model".into(),
                name: "Model".into(),
                description: Some("Choose which model Codex should use".into()),
                category: Some("model".into()),
                current: Some("gpt-5.4".into()),
                values: vec![
                    opt_value("gpt-5.4", "gpt-5.4", Some("Latest frontier agentic coding model.")),
                    opt_value("gpt-5.4-mini", "gpt-5.4-mini", Some("Smaller frontier agentic coding model.")),
                    opt_value("gpt-5.3-codex", "gpt-5.3-codex", Some("Frontier Codex-optimized agentic coding model.")),
                ],
                via: AgentConfigVia::Option,
            },
            AgentConfigOption {
                id: "reasoning_effort".into(),
                name: "Reasoning Effort".into(),
                description: Some("Choose how much reasoning effort the model should use".into()),
                category: Some("thought_level".into()),
                current: Some("medium".into()),
                values: vec![
                    opt_value("low", "Low", Some("Fast responses with lighter reasoning")),
                    opt_value("medium", "Medium", Some("Balances speed and reasoning depth")),
                    opt_value("high", "High", Some("Greater reasoning depth for complex problems")),
                    opt_value("xhigh", "Extra High", Some("Extra high reasoning depth for complex problems")),
                ],
                via: AgentConfigVia::Option,
            },
        ],
        "claude" => vec![
            AgentConfigOption {
                id: "mode".into(),
                name: "Mode".into(),
                description: Some("The permission mode of the session".into()),
                category: Some("mode".into()),
                current: Some("default".into()),
                values: vec![
                    opt_value("default", "Default", Some("Prompts for permission on first use of each tool")),
                    opt_value("acceptEdits", "Accept Edits", Some("Automatically accepts file edit permissions")),
                    opt_value("plan", "Plan Mode", Some("Claude can analyze and plan but not modify files")),
                    opt_value("dontAsk", "Don't Ask", Some("Skips permission prompts for allowed tools")),
                    opt_value("bypassPermissions", "Bypass Permissions", Some("Bypasses all permission checks")),
                ],
                via: AgentConfigVia::Option,
            },
            AgentConfigOption {
                id: "model".into(),
                name: "Model".into(),
                description: None,
                category: Some("model".into()),
                current: Some("default".into()),
                values: vec![
                    opt_value("default", "Default (recommended)", Some("Opus 4.7 for complex work")),
                    opt_value("sonnet", "Sonnet", Some("Sonnet 4.6 for everyday tasks")),
                    opt_value("haiku", "Haiku", Some("Haiku 4.5 for quick answers")),
                ],
                via: AgentConfigVia::Option,
            },
            AgentConfigOption {
                id: "thought_level".into(),
                name: "Thinking".into(),
                description: Some("Controls how deeply Claude reasons".into()),
                category: Some("thought_level".into()),
                current: Some("high".into()),
                values: vec![
                    opt_value("low", "Low", Some("Fast responses with minimal thinking")),
                    opt_value("medium", "Medium", Some("Moderate thinking for everyday tasks")),
                    opt_value("high", "High", Some("Deep thinking for complex tasks")),
                    opt_value("xhigh", "xHigh", Some("Extra deep thinking for demanding tasks")),
                    opt_value("max", "Max", Some("Maximum thinking depth")),
                ],
                via: AgentConfigVia::Option,
            },
        ],
        "copilot" => vec![
            AgentConfigOption {
                id: "mode".into(),
                name: "Mode".into(),
                description: None,
                category: Some("mode".into()),
                current: Some("https://agentclientprotocol.com/protocol/session-modes#agent".into()),
                values: vec![
                    opt_value("https://agentclientprotocol.com/protocol/session-modes#agent", "Agent", None),
                    opt_value("https://agentclientprotocol.com/protocol/session-modes#plan", "Plan", None),
                    opt_value("https://agentclientprotocol.com/protocol/session-modes#autopilot", "Autopilot", None),
                ],
                via: AgentConfigVia::Option,
            },
            AgentConfigOption {
                id: "model".into(),
                name: "Model".into(),
                description: None,
                category: Some("model".into()),
                current: Some("auto".into()),
                values: vec![
                    opt_value("auto", "Auto", None),
                    opt_value("claude-sonnet-4.6", "Claude Sonnet 4.6", None),
                    opt_value("claude-opus-4.6", "Claude Opus 4.6", None),
                    opt_value("gpt-5.4", "GPT-5.4", None),
                    opt_value("gpt-5.4-mini", "GPT-5.4 mini", None),
                ],
                via: AgentConfigVia::Option,
            },
            AgentConfigOption {
                id: "thought_level".into(),
                name: "Reasoning Effort".into(),
                description: None,
                category: Some("thought_level".into()),
                current: Some("medium".into()),
                values: vec![
                    opt_value("low", "Low", None),
                    opt_value("medium", "Medium", None),
                    opt_value("high", "High", None),
                    opt_value("xhigh", "Extra High", None),
                ],
                via: AgentConfigVia::Option,
            },
        ],
        _ => Vec::new(),
    }
}

/// A user-facing message for a failed request, with the agent's last stderr lines when it died.
fn describe_error(e: RpcError, stderr: &VecDeque<String>) -> String {
    match e {
        RpcError::Closed if stderr.is_empty() => "The agent process exited.".into(),
        RpcError::Closed => {
            format!("The agent process exited:\n{}", stderr.iter().map(String::as_str).collect::<Vec<_>>().join("\n"))
        }
        RpcError::Server { message, .. } => message,
        e => e.to_string(),
    }
}

/// The prompt trimmed, or `None` when there is nothing to send.
fn clean(mut prompt: AgentPrompt) -> Option<AgentPrompt> {
    prompt.text = prompt.text.trim().to_owned();
    (!prompt.text.is_empty() || !prompt.images.is_empty() || !prompt.files.is_empty()).then_some(prompt)
}

/// ACP content blocks: the text, each file (embedded when its text is in `contents`, else
/// a `resource_link`), then the images.
fn blocks(prompt: &AgentPrompt, contents: &[Option<String>]) -> Vec<Value> {
    let mut out = Vec::new();
    if !prompt.text.is_empty() {
        out.push(json!({ "type": "text", "text": prompt.text }));
    }
    for (i, f) in prompt.files.iter().enumerate() {
        let uri = file_uri(&f.0);
        out.push(match contents.get(i).cloned().flatten() {
            Some(text) => json!({ "type": "resource", "resource": { "uri": uri, "text": text } }),
            None => json!({ "type": "resource_link", "uri": uri, "name": file_name(&f.0) }),
        });
    }
    for i in &prompt.images {
        out.push(json!({ "type": "image", "mimeType": i.mime_type, "data": i.data }));
    }
    out
}

/// The text of a referenced file, when it is a small UTF-8 file.
fn embeddable(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_EMBED {
        return None;
    }
    String::from_utf8(std::fs::read(path).ok()?).ok()
}

/// A task file from before a field existed, with that field's empty value.
fn upgrade(mut file: Value) -> Value {
    if let Some(task) = file.get_mut("task").and_then(Value::as_object_mut) {
        for (key, empty) in
            [("config", json!([])), ("commands", json!([])), ("usage", Value::Null), ("queue", json!([]))]
        {
            task.entry(key).or_insert(empty);
        }
    }
    for entry in file.get_mut("entries").and_then(Value::as_array_mut).into_iter().flatten() {
        if entry.get("type").and_then(Value::as_str) == Some("user")
            && let Some(e) = entry.as_object_mut()
        {
            e.entry("attachments").or_insert(json!([]));
        }
    }
    file
}

fn model_of(config: &[AgentConfigOption]) -> Option<String> {
    config.iter().find(|o| o.category.as_deref() == Some("model")).and_then(|o| o.current.clone())
}

fn file_name(path: &Path) -> String {
    path.file_name().map_or_else(|| path.to_string_lossy().into_owned(), |n| n.to_string_lossy().into_owned())
}

/// `file://` URI of an absolute path, percent-encoded.
fn file_uri(path: &Path) -> String {
    let s = path.to_string_lossy().replace('\\', "/");
    let mut out = String::from(if s.starts_with('/') { "file://" } else { "file:///" });
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"/-._~:".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn title_of(prompt: &AgentPrompt) -> String {
    let line = prompt.text.lines().map(str::trim).find(|l| !l.is_empty());
    let line = match line {
        Some(l) => l.to_owned(),
        None => prompt.files.first().map(|f| file_name(&f.0)).unwrap_or_else(|| "Image".into()),
    };
    match line.char_indices().nth(60) {
        Some((cut, _)) => format!("{}…", &line[..cut]),
        None => line,
    }
}

fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64)
}

fn write_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, bytes).and_then(|()| std::fs::rename(&tmp, path)).map_err(|e| e.to_string())
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> IdeResult<T> + Send + 'static) -> IdeResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| IdeError::internal(e.to_string()))?
}

#[cfg(test)]
mod tests;
