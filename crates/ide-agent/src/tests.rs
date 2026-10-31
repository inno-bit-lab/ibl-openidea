//! End-to-end task flow against an in-memory ACP agent.

use super::*;
use tokio::io::duplex;

/// The modes reported by the fixture; None keeps upstream task-test defaults.
type FakeModes = Option<(String, Vec<(&'static str, &'static str)>)>;

/// Says "Hi", edits a file, asks to run a command and reports what it was allowed.
#[derive(Default)]
struct FakeAgent {
    /// Every connection's agent side, kept open.
    servers: Mutex<Vec<Peer>>,
    calls: Mutex<Vec<String>>,
    prompts: Mutex<Vec<String>>,
    modes: Mutex<FakeModes>,
    fail_set_mode: AtomicBool,
    drops_mode_on_set: AtomicBool,
    notifies_mode_change_on_set: AtomicBool,
    notifies_mode_change_after_mode_set: AtomicBool,
    cwds: Mutex<Vec<PathBuf>>,
    requests: Mutex<Vec<(String, Value)>>,
    permissions: Mutex<Vec<Value>>,
    v2: AtomicBool,
}

impl FakeAgent {
    fn with_modes(current: &str, available: &[(&'static str, &'static str)]) -> Self {
        Self { modes: Mutex::new(Some((current.to_owned(), available.to_vec()))), ..Self::default() }
    }

    fn without_modes() -> Self {
        Self { modes: Mutex::new(Some((String::new(), Vec::new()))), ..Self::default() }
    }

    /// The connection opened last: the agent restarted, or a fork's.
    fn latest(&self) -> Peer {
        self.servers.lock().last().cloned().expect("a connection")
    }

    fn update(&self, session: &str, update: Value) {
        let peer = self.latest();
        peer.notify("session/update", json!({ "sessionId": session, "update": update })).unwrap();
    }

    fn say(&self, session: &str, text: &str) {
        if self.v2.load(Ordering::Relaxed) {
            self.update(
                session,
                json!({"sessionUpdate":"agent_message", "messageId":uuid::Uuid::new_v4().to_string(),
                "content":[{"type":"text","text":text}]}),
            );
        } else {
            self.update(session, json!({"sessionUpdate":"agent_message_chunk", "content":{"type":"text","text":text}}));
        }
    }
}

impl FakeAgent {
    /// Runs a subagent in session `c1`, as an agent with ACP subagent sessions reports it.
    fn delegate(&self, root: &str) {
        let sub = |state: Value| json!({"sessionUpdate": "subagent_update", "sessionId": "c1", "state": state});
        let mut announce = sub(json!({"state": "running"}));
        announce["title"] = json!("Explore");
        self.update(root, announce);
        self.update(
            root,
            json!({"sessionUpdate": "session_message", "messageId": "m1", "senderSessionId": root,
                "recipientSessionId": "c1", "content": [{"type": "text", "text": "Find the lexer"}]}),
        );
        self.update("c1", json!({"sessionUpdate": "usage_update", "used": 900, "size": 1000}));
        self.update(
            "c1",
            json!({"sessionUpdate": "tool_call", "toolCallId": "c1-t1", "title": "Read lexer.rs",
            "kind": "read", "status": "completed"}),
        );
        let peer = self.latest();
        let _: Value = tokio::runtime::Handle::current()
            .block_on(peer.request(
                "session/request_permission",
                json!({"sessionId": "c1", "toolCall": {"toolCallId": "c1-t2", "title": "Run ls"},
                    "options": [{"optionId": "yes", "name": "Allow", "kind": "allow_once"}]}),
                None,
            ))
            .unwrap();
        self.say("c1", "It is in lexer.rs");
        self.update(root, sub(json!({"state": "idle", "stopReason": "end_turn"})));
        self.update(
            root,
            json!({"sessionUpdate": "session_message", "messageId": "m2", "senderSessionId": "c1",
                "recipientSessionId": root, "content": [{"type": "text", "text": "lexer.rs"}]}),
        );
        self.say(root, "Found it");
    }
}

impl Handler for FakeAgent {
    fn on_notification(&self, method: &str, _: Value) {
        self.calls.lock().push(method.to_owned());
    }

    fn on_request_with_data(&self, method: &str, params: Value) -> Result<Value, (i64, String, Option<Value>)> {
        if method == "session/prompt" && params.pointer("/prompt/0/text") == Some(&json!("limit")) {
            let data = json!({"openidea": {"usageLimit": {"resetsAtMs": 1234.0}}});
            return Err((codes::INTERNAL_ERROR, "You've hit your usage limit".into(), Some(data)));
        }
        self.on_request(method, params).map_err(|(code, message)| (code, message, None))
    }

    fn on_request(&self, method: &str, params: Value) -> Result<Value, (i64, String)> {
        self.calls.lock().push(method.to_owned());
        self.requests.lock().push((method.to_owned(), params.clone()));
        let session = params.get("sessionId").and_then(Value::as_str).unwrap_or("s1").to_owned();
        match method {
            "initialize" => {
                if self.v2.load(Ordering::Relaxed) {
                    return Ok(
                        json!({"protocolVersion":2,"info":{"name":"fixture","version":"2"},"capabilities":{"session":{}}}),
                    );
                }
                if params.pointer("/clientCapabilities/subagents").is_some_and(Value::is_object) {
                    self.calls.lock().push("subagents".into());
                }
                Ok(json!({"protocolVersion": 1, "agentCapabilities": {"loadSession": true,
                    "sessionCapabilities": {"fork": {}}, "_meta": {"openidea": {"rollback": true, "steer": true}}}}))
            }
            "session/new" => {
                let mut reply = json!({
                    "sessionId": "s1",
                    "configOptions": [{"id": "model", "category": "model", "type": "select", "currentValue": "big",
                        "options": [{"value": "big", "name": "Big"}, {"value": "small", "name": "Small"}]}]
                });
                let modes_cfg = self.modes.lock().clone();
                match modes_cfg {
                    None => {
                        reply["modes"] = json!({
                            "currentModeId": "ask",
                            "availableModes": [{"id": "ask", "name": "Ask"}, {"id": "code", "name": "Code"}]
                        });
                    }
                    Some((_, ref avail)) if avail.is_empty() => {}
                    Some((current, avail)) => {
                        let available: Vec<Value> =
                            avail.into_iter().map(|(id, name)| json!({"id": id, "name": name})).collect();
                        reply["modes"] = json!({
                            "currentModeId": current,
                            "availableModes": available,
                        });
                    }
                }
                if (self.drops_mode_on_set.load(Ordering::Relaxed) || self.v2.load(Ordering::Relaxed))
                    && let Some(modes) = reply.as_object_mut().unwrap().remove("modes")
                {
                    let values: Vec<Value> = modes["availableModes"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|m| json!({"value": m["id"], "name": m["name"]}))
                        .collect();
                    reply["configOptions"].as_array_mut().unwrap().push(json!({"id": "mode", "category": "mode",
                        "type": "select", "currentValue": modes["currentModeId"], "options": values}));
                }
                Ok(reply)
            }
            "session/fork" => Ok(json!({"sessionId": "s2"})),
            "_openidea/rollback" | "_openidea/steer" => {
                let detail = params.get("turns").cloned().unwrap_or_else(|| params["prompt"][0]["text"].clone());
                self.calls.lock().push(format!("{method} {detail}"));
                Ok(json!({}))
            }
            "session/load" => {
                self.say(&session, "replayed history");
                Ok(json!({}))
            }
            "session/set_config_option" | "session/set_mode" => {
                let is_mode =
                    method == "session/set_mode" || params.get("configId").and_then(Value::as_str) == Some("mode");
                if is_mode && self.fail_set_mode.load(Ordering::Relaxed) {
                    return Err((codes::INTERNAL_ERROR, "cannot set mode".into()));
                }
                self.calls.lock().push(format!("{method} {}", params.get("value").or(params.get("modeId")).unwrap()));
                if is_mode && self.notifies_mode_change_after_mode_set.load(Ordering::Relaxed) {
                    self.update(
                        &session,
                        json!({"sessionUpdate":"current_mode_update","currentModeId":"bypassPermissions"}),
                    );
                }
                if !is_mode && self.notifies_mode_change_on_set.load(Ordering::Relaxed) {
                    self.update(
                        &session,
                        json!({"sessionUpdate":"current_mode_update","currentModeId":"bypassPermissions"}),
                    );
                }
                if !is_mode && self.drops_mode_on_set.load(Ordering::Relaxed) {
                    return Ok(json!({"configOptions": [{"id": "model", "category": "model", "type": "select",
                        "currentValue": "small", "options": [{"value": "big"}, {"value": "small"}]}]}));
                }
                Ok(json!({}))
            }
            "session/prompt" => {
                let text = params.pointer("/prompt/0/text").and_then(Value::as_str).unwrap_or_default().to_owned();
                self.prompts.lock().push(text.clone());
                if text == "again" {
                    self.say(&session, "second turn");
                    return Ok(json!({"stopReason": "end_turn"}));
                }
                if text == "delegate" {
                    self.delegate(&session);
                    return Ok(json!({"stopReason": "end_turn"}));
                }
                if text == "late option" {
                    // An option the session offers only once it runs.
                    self.update(
                        &session,
                        json!({"sessionUpdate": "config_option_update", "configOptions": [
                            {"id": "model", "category": "model", "type": "select", "currentValue": "big",
                             "options": [{"value": "big", "name": "Big"}, {"value": "small", "name": "Small"}]},
                            {"id": "effort", "category": "thought_level", "type": "select", "currentValue": "low",
                             "options": [{"value": "low", "name": "Low"}, {"value": "high", "name": "High"}]}]}),
                    );
                    self.say(&session, "ok");
                    return Ok(json!({"stopReason": "end_turn"}));
                }
                if text == "wait" {
                    // Works until cancelled.
                    while !self.latest().is_closed() && !self.calls.lock().iter().any(|c| c == "session/cancel") {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    return Ok(json!({"stopReason": "cancelled"}));
                }
                self.update(
                    &session,
                    json!({"sessionUpdate": "available_commands_update",
                    "availableCommands": [{"name": "review", "description": "Review", "input": {"hint": "focus"}}]}),
                );
                self.update(&session, json!({"sessionUpdate": "usage_update", "used": 50, "size": 1000}));
                self.update(&session, json!({"sessionUpdate": "session_info_update", "title": "Lexer fix"}));
                self.say(&session, "Hi");
                self.update(
                    &session,
                    json!({"sessionUpdate": "tool_call", "toolCallId": "t1", "title": "Edit a.rs",
                    "kind": "edit", "status": "completed",
                    "content": [{"type": "diff", "path": "/p/a.rs", "oldText": "a\n", "newText": "b\n"}]}),
                );
                let peer = self.latest();
                let mut permission = json!({"sessionId":session,
                    "toolCall":{"toolCallId":"t1","title":"Run cargo test"},
                    "options":[{"optionId":"yes","name":"Allow","kind":"allow_once"},
                               {"optionId":"no","name":"Reject","kind":"reject_once"}]});
                if self.v2.load(Ordering::Relaxed) {
                    permission.as_object_mut().unwrap().remove("toolCall");
                    permission["subject"] = json!({"type":"tool_call","toolCall":{"toolCallId":"t1","kind":"execute"}});
                    permission["title"] = json!("Run cargo test");
                }
                let answer: Value = tokio::runtime::Handle::current()
                    .block_on(peer.request("session/request_permission", permission, None))
                    .unwrap();
                self.permissions.lock().push(answer.clone());
                let chosen = answer.pointer("/outcome/optionId").and_then(Value::as_str).unwrap_or("none");
                self.say(&session, &format!("chose {chosen}"));
                if self.v2.load(Ordering::Relaxed) {
                    self.update(
                        &session,
                        json!({"sessionUpdate":"state_update","state":"idle","stopReason":"end_turn"}),
                    );
                    return Ok(json!({}));
                }
                Ok(json!({"stopReason": "end_turn"}))
            }
            _ => Err((codes::METHOD_NOT_FOUND, method.to_owned())),
        }
    }
}

fn manager(dir: &Path, agent: Arc<FakeAgent>) -> AgentManager {
    manager_at(dir, &dir.join("models.json"), agent)
}

fn manager_at(dir: &Path, models_file: &Path, agent: Arc<FakeAgent>) -> AgentManager {
    let connector: Connector = Arc::new(move |_spec, cwd, client, _stderr| {
        agent.cwds.lock().push(cwd.to_path_buf());
        let (a, b) = duplex(1 << 20);
        let (ar, aw) = tokio::io::split(a);
        let (br, bw) = tokio::io::split(b);
        let server = Peer::connect_framed(br, bw, agent.clone(), Framing::Lines);
        agent.servers.lock().push(server);
        Ok(Peer::connect_framed(ar, aw, client, Framing::Lines))
    });
    AgentManager::with_connector(
        AgentPaths {
            project_root: dir.to_path_buf(),
            store_dir: dir.join("store"),
            worktrees_dir: dir.join("worktrees"),
            models_file: models_file.to_path_buf(),
            custom_agents_dir: None,
            home_dir: None,
        },
        tokio::runtime::Handle::current(),
        connector,
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn commands_are_remembered_per_project_and_merged_with_skills_on_disk() {
    let tmp = tempfile::tempdir().unwrap();
    let (a, b, models) = (tmp.path().join("a"), tmp.path().join("b"), tmp.path().join("models.json"));
    std::fs::create_dir_all(a.join(".claude/skills/triage")).unwrap();
    std::fs::create_dir_all(&b).unwrap();
    std::fs::write(a.join(".claude/skills/triage/SKILL.md"), "---\nname: triage\ndescription: Triage\n---\n").unwrap();
    let names = |c: Vec<AgentCommand>| c.into_iter().map(|c| c.name).collect::<Vec<_>>();

    let mgr_a = manager_at(&a, &models, Arc::new(FakeAgent::default()));
    // Before any session: only the skills on disk.
    assert_eq!(names(mgr_a.commands("claude", None).await.unwrap()), ["triage"]);
    let task = mgr_a
        .create(NewAgentTask {
            instructions: None,
            project_root: None,
            prompt: text("Fix the lexer"),
            provider: "claude".into(),
            config: Vec::new(),
            isolation: Isolation::Local,
            base: None,
        })
        .await
        .unwrap();
    wait_for(&mgr_a, &task.id, AgentStatus::NeedsInput).await;
    assert_eq!(names(mgr_a.commands("claude", None).await.unwrap()), ["review", "triage"]);
    assert_eq!(names(mgr_a.commands("claude", Some(&task.id)).await.unwrap()), ["review", "triage"]);
    // Other agents get only what they offered.
    assert!(mgr_a.commands("codex", None).await.unwrap().is_empty());
    mgr_a.cancel(&task.id, None).unwrap();
    wait_for(&mgr_a, &task.id, AgentStatus::Ready).await;
    mgr_a.shutdown();

    // Another project shares the settings but not the commands.
    let mgr_b = manager_at(&b, &models, Arc::new(FakeAgent::default()));
    let claude = mgr_b.providers().into_iter().find(|p| p.id == "claude").unwrap();
    assert_eq!(claude.config.len(), 2);
    assert!(claude.commands.is_empty());
    assert!(mgr_b.commands("claude", None).await.unwrap().is_empty());
    let mgr_a = manager_at(&a, &models, Arc::new(FakeAgent::default()));
    assert_eq!(names(mgr_a.providers().into_iter().find(|p| p.id == "claude").unwrap().commands), ["review"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn builtin_commands_only_fill_verified_gaps_and_preserve_advertised_metadata() {
    let tmp = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeAgent::default());
    let mgr = manager_at(tmp.path(), &tmp.path().join("models.json"), agent);
    for provider in ["claude", "claude-acp", "opencode2", "codex", "custom"] {
        assert!(mgr.commands(provider, None).await.unwrap().is_empty(), "{provider}");
    }
    let commands = mgr.commands("opencode", None).await.unwrap();
    assert_eq!(commands.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["compact"]);
    let task = mgr
        .create(NewAgentTask {
            instructions: None,
            project_root: None,
            prompt: text("Hello"),
            provider: "opencode".into(),
            config: Vec::new(),
            isolation: Isolation::Local,
            base: None,
        })
        .await
        .unwrap();
    wait_for(&mgr, &task.id, AgentStatus::NeedsInput).await;
    let advertised = AgentCommand {
        name: "compact".into(),
        description: "Agent supplied description".into(),
        hint: Some("instructions".into()),
    };
    mgr.task(&task.id).unwrap().state.lock().task.commands = vec![advertised.clone()];
    // The task's provider wins over the caller's provider; metadata is not replaced.
    let commands = mgr.commands("claude", Some(&task.id)).await.unwrap();
    assert_eq!(commands.len(), 1);
    assert_eq!(commands[0].name, advertised.name);
    assert_eq!(commands[0].description, advertised.description);
    assert_eq!(commands[0].hint, advertised.hint);
    // Finish the in-process agent before Tokio stops driving its permission response.
    mgr.cancel(&task.id, None).unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    mgr.shutdown();
}

async fn wait_for(mgr: &AgentManager, id: &str, status: AgentStatus) {
    for _ in 0..500 {
        let task = mgr.task(id).unwrap();
        let (current, busy) = {
            let s = task.state.lock();
            (s.task.status, s.busy)
        };
        // Settled statuses only count once the run is over (a prompt just sent hasn't started).
        let settled = !matches!(status, AgentStatus::Ready | AgentStatus::Failed | AgentStatus::Limited) || !busy;
        if current == status && settled {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let s = mgr.task(id).unwrap().state.lock().task.status;
    panic!("task never reached {status:?} (is {s:?})");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_task_runs_asks_for_permission_and_survives_a_restart() {
    let tmp = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeAgent::default());
    let mgr = manager(tmp.path(), agent.clone());
    let events = Arc::new(Mutex::new(Vec::<AgentEvent>::new()));
    let sink = events.clone();
    mgr.subscribe(Arc::new(move |e| sink.lock().push(e)));

    let task = mgr
        .create(NewAgentTask {
            instructions: None,
            project_root: None,
            prompt: text("Fix the lexer\nmore detail"),
            provider: "claude".into(),
            config: vec![AgentConfigChoice { id: "model".into(), value: "small".into() }],
            isolation: Isolation::Local,
            base: None,
        })
        .await
        .unwrap();
    assert_eq!(task.title, "Fix the lexer");
    assert_ne!(mgr.task(&task.id).unwrap().state.lock().task.status, AgentStatus::Ready, "a new task is not settled");
    wait_for(&mgr, &task.id, AgentStatus::NeedsInput).await;

    let permission = mgr
        .entries(&task.id, None)
        .unwrap()
        .iter()
        .find_map(|e| match e {
            AgentEntry::Permission { id, .. } => Some(*id),
            _ => None,
        })
        .unwrap();
    mgr.respond(&task.id, permission, Some("yes".into())).unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;

    let entries = mgr.entries(&task.id, None).unwrap();
    let kinds: Vec<String> = entries
        .iter()
        .map(|e| match e {
            AgentEntry::User { text, .. } | AgentEntry::Agent { text } => text.clone(),
            AgentEntry::Tool { title, .. } => title.clone(),
            AgentEntry::Permission { chosen, .. } => format!("permission: {}", chosen.clone().unwrap_or_default()),
            other => format!("{other:?}"),
        })
        .collect();
    assert_eq!(kinds, ["Fix the lexer\nmore detail", "Hi", "Edit a.rs", "permission: Allow", "chose yes"]);
    assert!(
        agent.calls.lock().contains(&"session/set_config_option \"small\"".to_owned()),
        "switched to the chosen model"
    );
    {
        let t = mgr.task(&task.id).unwrap().state.lock().task.clone();
        assert_eq!(t.model.as_deref(), Some("small"));
        let modes = t.config.iter().find(|o| o.id == "mode").unwrap();
        assert_eq!((modes.via, modes.current.as_deref()), (AgentConfigVia::Mode, Some("ask")));
        assert_eq!(t.commands.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["review"]);
        assert_eq!(t.usage.as_ref().map(|u| (u.used, u.size)), Some((50, 1000)));
        assert_eq!(t.title, "Lexer fix", "the agent's title replaces the prompt's first line");
    }
    mgr.set_config(&task.id, "mode", "code".into()).await.unwrap();
    assert!(agent.calls.lock().contains(&"session/set_mode \"code\"".to_owned()));
    assert!(mgr.set_config(&task.id, "mode", "nope".into()).await.is_err());

    tokio::time::sleep(FLUSH_DELAY * 3).await;
    {
        let events = events.lock();
        assert!(
            events.iter().any(|e| matches!(e, AgentEvent::Task { task } if task.status == AgentStatus::NeedsInput))
        );
        let last_entry = events.iter().rev().find_map(|e| match e {
            AgentEvent::Entry { index, entry, .. } if !matches!(entry, AgentEntry::User { .. }) => {
                Some((*index, entry.clone()))
            }
            _ => None,
        });
        assert_eq!(last_entry, Some((4, AgentEntry::Agent { text: "chose yes".into() })));
        // The turn's end is recorded on the message that started it.
        assert!(events.iter().any(|e| matches!(
            e,
            AgentEvent::Entry { index: 0, entry: AgentEntry::User { sent_ms: Some(_), done_ms: Some(_), .. }, .. }
        )));
    }
    let providers = mgr.providers();
    let claude = providers.iter().find(|p| p.id == "claude").unwrap();
    assert_eq!(claude.config.iter().map(|o| o.id.as_str()).collect::<Vec<_>>(), ["model", "mode"]);
    assert_eq!(claude.commands.len(), 1);

    // A new manager (IDE restart) finds the task and resumes its session without duplicating history.
    mgr.shutdown();
    let agent2 = Arc::new(FakeAgent::default());
    let mgr2 = manager(tmp.path(), agent2.clone());
    assert_eq!(mgr2.entries(&task.id, None).unwrap().len(), 5);
    assert_eq!(mgr2.task(&task.id).unwrap().state.lock().task.title, "Lexer fix");
    assert_eq!(mgr2.providers().iter().find(|p| p.id == "claude").unwrap().config.len(), 2);
    mgr2.prompt(&task.id, text("again"), false).await.unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    wait_for(&mgr2, &task.id, AgentStatus::Ready).await;
    let entries = mgr2.entries(&task.id, None).unwrap();
    assert_eq!(entries.len(), 7);
    assert_eq!(entries[6], AgentEntry::Agent { text: "second turn".into() });
    assert!(agent2.calls.lock().contains(&"session/load".to_owned()));
    // The chosen settings are re-applied to the reloaded session.
    let calls = agent2.calls.lock().clone();
    assert!(calls.contains(&"session/set_mode \"code\"".to_owned()), "{calls:?}");
}

fn text(t: &str) -> AgentPrompt {
    AgentPrompt { text: t.into(), ..AgentPrompt::default() }
}

#[tokio::test(flavor = "multi_thread")]
async fn messages_sent_while_busy_are_queued_and_send_now_interrupts() {
    let tmp = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeAgent::default());
    let mgr = manager(tmp.path(), agent.clone());
    let task = mgr
        .create(NewAgentTask {
            instructions: None,
            project_root: None,
            prompt: text("wait"),
            provider: "claude".into(),
            config: vec![],
            isolation: Isolation::Local,
            base: None,
        })
        .await
        .unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Running).await;
    mgr.prompt(&task.id, text("again"), false).await.unwrap();
    let queue = mgr.task(&task.id).unwrap().state.lock().task.queue.clone();
    assert_eq!(queue.iter().map(|q| q.prompt.text.as_str()).collect::<Vec<_>>(), ["again"]);
    assert!(mgr.prompt(&task.id, text("  "), false).await.is_err());

    mgr.send_queued_now(&task.id, &queue[0].id).unwrap();
    for _ in 0..500 {
        if mgr.entries(&task.id, None).unwrap().iter().any(|e| *e == AgentEntry::Agent { text: "second turn".into() }) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    let users: Vec<String> = mgr
        .entries(&task.id, None)
        .unwrap()
        .into_iter()
        .filter_map(|e| match e {
            AgentEntry::User { text, .. } => Some(text),
            _ => None,
        })
        .collect();
    assert_eq!(users, ["wait", "again"]);
    assert!(mgr.task(&task.id).unwrap().state.lock().task.queue.is_empty());

    // Stopping a turn keeps the queue for later.
    mgr.prompt(&task.id, text("wait"), false).await.unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Running).await;
    agent.calls.lock().retain(|c| c != "session/cancel");
    mgr.prompt(&task.id, text("later"), false).await.unwrap();
    mgr.cancel(&task.id, None).unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    let queued = mgr.task(&task.id).unwrap().state.lock().task.queue.clone();
    assert_eq!(queued.len(), 1);
    assert_eq!(mgr.unqueue(&task.id, &queued[0].id).unwrap().prompt.text, "later");
    assert!(mgr.task(&task.id).unwrap().state.lock().task.queue.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn subagents_get_their_own_conversation() {
    let tmp = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeAgent::default());
    let mgr = manager(tmp.path(), agent.clone());
    let task = mgr
        .create(NewAgentTask {
            instructions: None,
            project_root: None,
            prompt: text("delegate"),
            provider: "claude".into(),
            config: vec![],
            isolation: Isolation::Local,
            base: None,
        })
        .await
        .unwrap();
    // The subagent's permission request is answered in the task's conversation.
    wait_for(&mgr, &task.id, AgentStatus::NeedsInput).await;
    let (id, title) = mgr
        .entries(&task.id, None)
        .unwrap()
        .into_iter()
        .find_map(|e| match e {
            AgentEntry::Permission { id, title, .. } => Some((id, title)),
            _ => None,
        })
        .unwrap();
    assert_eq!(title, "Explore: Run ls");
    mgr.respond(&task.id, id, Some("yes".into())).unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    assert!(agent.calls.lock().iter().any(|c| c == "subagents"));

    let check = |mgr: &AgentManager| {
        let main = mgr.entries(&task.id, None).unwrap();
        let card = main.iter().find(|e| matches!(e, AgentEntry::Subagent { .. })).unwrap();
        let AgentEntry::Subagent { title, status, prompt, reply, tools, activity, .. } = card else { unreachable!() };
        assert_eq!(title.as_deref(), Some("Explore"));
        assert_eq!(*status, AgentSubagentStatus::Done);
        assert_eq!((prompt.as_deref(), reply.as_deref()), (Some("Find the lexer"), Some("lexer.rs")));
        assert_eq!((*tools, activity.as_deref()), (1, Some("Read lexer.rs")));
        assert!(main.contains(&AgentEntry::Agent { text: "Found it".into() }));
        assert!(!main.iter().any(|e| matches!(e, AgentEntry::Tool { .. })));
        let sub = mgr.entries(&task.id, Some("c1".into())).unwrap();
        assert!(matches!(&sub[0], AgentEntry::Tool { title, .. } if title == "Read lexer.rs"));
        assert_eq!(sub[1], AgentEntry::Agent { text: "It is in lexer.rs".into() });
    };
    // Updates can trail the end of the turn.
    for _ in 0..500 {
        if mgr.entries(&task.id, None).unwrap().contains(&AgentEntry::Agent { text: "Found it".into() }) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    check(&mgr);
    // The subagent's context use is not the task's.
    assert_ne!(mgr.task(&task.id).unwrap().state.lock().task.usage.as_ref().map(|u| u.used), Some(900));
    assert!(mgr.entries(&task.id, Some("nope".into())).is_err());

    // Saved with the task.
    mgr.shutdown();
    check(&manager(tmp.path(), Arc::new(FakeAgent::default())));
}

#[test]
fn prompts_become_acp_content_blocks() {
    let p = AgentPrompt {
        text: "look".into(),
        files: vec![IpcPath(PathBuf::from("/p/my file.rs"))],
        images: vec![AgentImage { mime_type: "image/png".into(), data: "AAA".into(), name: None }],
    };
    assert_eq!(
        blocks(&p, &[]),
        [
            json!({"type": "text", "text": "look"}),
            json!({"type": "resource_link", "uri": "file:///p/my%20file.rs", "name": "my file.rs"}),
            json!({"type": "image", "mimeType": "image/png", "data": "AAA"}),
        ]
    );
    assert_eq!(
        blocks(&p, &[Some("fn a() {}".into())])[1],
        json!({"type": "resource", "resource": {"uri": "file:///p/my%20file.rs", "text": "fn a() {}"}})
    );
    // A slash command goes through as typed: the agent runs it.
    let skill = clean(text(" /triage dry-run\n")).unwrap();
    assert_eq!(blocks(&skill, &[]), [json!({"type": "text", "text": "/triage dry-run"})]);
    let old = upgrade(
        json!({"task": {"id": "t"}, "entries": [{"type": "user", "text": "hi"}, {"type": "agent", "text": "a"}]}),
    );
    assert_eq!(old["task"]["queue"], json!([]));
    assert_eq!(old["entries"][0]["attachments"], json!([]));
    assert!(old["entries"][1].get("attachments").is_none());
    assert_eq!(title_of(&AgentPrompt { files: p.files.clone(), ..AgentPrompt::default() }), "my file.rs");
    assert!(clean(text(" ")).is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn cancelling_resolves_the_open_permission_and_delete_forgets_the_task() {
    let tmp = tempfile::tempdir().unwrap();
    let mgr = manager(tmp.path(), Arc::new(FakeAgent::default()));
    let task = mgr
        .create(NewAgentTask {
            instructions: None,
            project_root: None,
            prompt: text("do it"),
            provider: "codex".into(),
            config: vec![],
            isolation: Isolation::Local,
            base: None,
        })
        .await
        .unwrap();
    wait_for(&mgr, &task.id, AgentStatus::NeedsInput).await;
    mgr.cancel(&task.id, None).unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    let entries = mgr.entries(&task.id, None).unwrap();
    assert!(entries.iter().any(|e| matches!(e, AgentEntry::Permission { chosen: Some(c), .. } if c == "Cancelled")));
    assert_eq!(entries.last(), Some(&AgentEntry::Agent { text: "chose none".into() }));
    assert_eq!(mgr.task(&task.id).unwrap().state.lock().task.model.as_deref(), Some("big"), "the agent's default");

    mgr.delete(&task.id, false).await.unwrap();
    assert!(mgr.entries(&task.id, None).is_err());
    assert!(!tmp.path().join("store").join(format!("{}.json", task.id)).exists());
    assert!(
        mgr.create(NewAgentTask {
            instructions: None,
            project_root: None,
            prompt: text(" "),
            provider: "codex".into(),
            config: vec![],
            isolation: Isolation::Local,
            base: None
        })
        .await
        .is_err()
    );
}

/// Drives the real Claude Code adapter (needs `npx`, network and a signed-in `claude`):
/// `OPENIDEA_AGENT_E2E=1 cargo test -p ide-agent real_claude -- --ignored --nocapture`.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn real_claude_task_in_a_worktree() {
    if std::env::var_os("OPENIDEA_AGENT_E2E").is_none() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    for args in [&["init", "-q", "-b", "main"][..], &["commit", "-q", "--allow-empty", "-m", "init"]] {
        let ok = std::process::Command::new("git")
            .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
            .args(args)
            .current_dir(&repo)
            .status()
            .unwrap()
            .success();
        assert!(ok);
    }
    let mgr = AgentManager::new(
        AgentPaths {
            project_root: repo.clone(),
            store_dir: tmp.path().join("store"),
            worktrees_dir: tmp.path().join("wt"),
            models_file: tmp.path().join("models.json"),
            custom_agents_dir: None,
            home_dir: None,
        },
        tokio::runtime::Handle::current(),
    );
    let task = mgr
        .create(NewAgentTask {
            instructions: None,
            project_root: None,
            prompt: text("Create a file named hello.txt containing the single word hi. Do nothing else."),
            provider: "claude".into(),
            config: vec![AgentConfigChoice { id: "model".into(), value: "haiku".into() }],
            isolation: Isolation::Worktree,
            base: None,
        })
        .await
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(240);
    loop {
        assert!(std::time::Instant::now() < deadline, "timed out");
        let status = mgr.task(&task.id).unwrap().state.lock().task.status;
        match status {
            AgentStatus::NeedsInput => {
                let pending = mgr.entries(&task.id, None).unwrap().into_iter().rev().find_map(|e| match e {
                    AgentEntry::Permission { id, options, chosen: None, .. } => Some((id, options)),
                    _ => None,
                });
                if let Some((id, options)) = pending {
                    let allow = options.iter().find(|o| o.kind == "allow_once").or(options.first()).unwrap();
                    eprintln!("allowing: {}", allow.name);
                    let _ = mgr.respond(&task.id, id, Some(allow.id.clone()));
                }
            }
            AgentStatus::Ready | AgentStatus::Failed => break,
            _ => {}
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    for e in mgr.entries(&task.id, None).unwrap() {
        eprintln!("{e:?}");
    }
    let t = mgr.task(&task.id).unwrap().state.lock().task.clone();
    assert_eq!(t.status, AgentStatus::Ready, "{:?}", t.error);
    assert_eq!(t.model.as_deref(), Some("haiku"));
    let changes = mgr.changes(&task.id).await.unwrap();
    assert!(changes.iter().any(|c| c.rel_path == "hello.txt"), "{changes:?}");
    assert!(!repo.join("hello.txt").exists(), "the project checkout is untouched");
    assert!(!mgr.providers().iter().find(|p| p.id == "claude").unwrap().config.is_empty());
    mgr.shutdown();
}

#[tokio::test(flavor = "multi_thread")]
async fn forks_rollbacks_and_steering() {
    let tmp = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeAgent::default());
    let mgr = manager(tmp.path(), agent.clone());
    let new = |prompt: &str| NewAgentTask {
        instructions: None,
        project_root: None,
        prompt: text(prompt),
        provider: "claude".into(),
        config: Vec::new(),
        isolation: Isolation::Local,
        base: None,
    };
    let task = mgr.create(new("again")).await.unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    mgr.prompt(&task.id, text("again"), false).await.unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    let caps = mgr.task(&task.id).unwrap().state.lock().task.capabilities;
    assert!(caps.fork && caps.rollback && caps.steer);

    // A copy from after the first turn: the new task drops the second once it loads.
    let copy = mgr.fork(&task.id, Some(1)).await.unwrap();
    assert_eq!(turn_starts(&mgr.entries(&copy.id, None).unwrap()).len(), 1);
    assert_eq!(mgr.task(&copy.id).unwrap().state.lock().pending_rollback, 1);
    mgr.prompt(&copy.id, text("again"), false).await.unwrap();
    wait_for(&mgr, &copy.id, AgentStatus::Ready).await;
    {
        let calls = agent.calls.lock();
        let load = calls.iter().rposition(|c| c == "session/load").unwrap();
        assert!(calls[load..].iter().any(|c| c == "_openidea/rollback 1"));
    }

    // Undoing the last turn hands its message back.
    let undone = mgr.rollback(&task.id, 1).await.unwrap().unwrap();
    assert_eq!(undone.text, "again");
    assert_eq!(turn_starts(&mgr.entries(&task.id, None).unwrap()).len(), 1);
    assert!(agent.calls.lock().iter().any(|c| c == "_openidea/rollback 1"));

    // A message sent now while the agent works joins the turn.
    mgr.prompt(&task.id, text("wait"), false).await.unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Running).await;
    mgr.prompt(&task.id, text("also this"), true).await.unwrap();
    assert!(agent.calls.lock().iter().any(|c| c == "_openidea/steer \"also this\""));
    let entries = mgr.entries(&task.id, None).unwrap();
    assert!(matches!(entries.last(), Some(AgentEntry::User { steered: true, .. })));
    assert!(mgr.task(&task.id).unwrap().state.lock().task.queue.is_empty());
    mgr.cancel(&task.id, None).unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn usage_limits_and_late_settings() {
    let tmp = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeAgent::default());
    let mgr = manager(tmp.path(), agent.clone());
    let task = mgr
        .create(NewAgentTask {
            instructions: None,
            project_root: None,
            prompt: text("limit"),
            provider: "claude".into(),
            // `effort` isn't offered until the session runs.
            config: vec![AgentConfigChoice { id: "effort".into(), value: "high".into() }],
            isolation: Isolation::Local,
            base: None,
        })
        .await
        .unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Limited).await;
    assert_eq!(mgr.task(&task.id).unwrap().state.lock().task.resets_ms, Some(1234.0));

    mgr.prompt(&task.id, text("late option"), false).await.unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    for _ in 0..100 {
        if agent.calls.lock().iter().any(|c| c == "session/set_config_option \"high\"") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(agent.calls.lock().iter().any(|c| c == "session/set_config_option \"high\""));
    let config = mgr.task(&task.id).unwrap().state.lock().task.config.clone();
    assert_eq!(config.iter().find(|o| o.id == "effort").unwrap().current.as_deref(), Some("high"));
}

#[test]
fn retry_updates_become_a_countdown() {
    let update =
        json!({"sessionUpdate": RETRY_UPDATE, "attempt": 2, "maxRetries": 10, "retryDelayMs": 1500, "error": ""});
    assert_eq!(
        retry_of(&update, 1000.0),
        Some(AgentRetry { attempt: 2, max_retries: Some(10), retry_at_ms: 2500.0, error: None })
    );
    assert_eq!(retry_of(&json!({"sessionUpdate": RETRY_UPDATE}), 0.0), None, "no attempt");
}

#[tokio::test(flavor = "multi_thread")]
async fn cursor_approval_switch_resolves_pending_and_survives_restart() {
    let tmp = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeAgent::default());
    let mgr = manager(tmp.path(), agent.clone());
    let new = || NewAgentTask {
        instructions: None,
        project_root: None,
        prompt: text("Fix"),
        provider: "cursor".into(),
        config: Vec::new(),
        isolation: Isolation::Local,
        base: None,
    };
    let task = mgr.create(new()).await.unwrap();
    wait_for(&mgr, &task.id, AgentStatus::NeedsInput).await;
    mgr.set_config(&task.id, config::CURSOR_APPROVAL, "bypass".into()).await.unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    assert!(
        mgr.entries(&task.id, None)
            .unwrap()
            .iter()
            .any(|e| matches!(e, AgentEntry::Permission { chosen: Some(name), .. } if name == "Allow"))
    );
    // Agent config updates must not erase the client's approval setting.
    mgr.prompt(&task.id, text("late option"), false).await.unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    let t = mgr.task(&task.id).unwrap();
    assert!(config::bypass_approvals("cursor", &t.state.lock().task.config));
    t.kill();
    mgr.prompt(&task.id, text("Fix again"), false).await.unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    assert!(!agent.calls.lock().iter().any(|c| c.contains("bypass")));
    assert!(config::bypass_approvals("cursor", &mgr.shared.known_config("cursor")));
    mgr.set_config(&task.id, config::CURSOR_APPROVAL, "ask".into()).await.unwrap();
    mgr.prompt(&task.id, text("Fix once more"), false).await.unwrap();
    wait_for(&mgr, &task.id, AgentStatus::NeedsInput).await;
    mgr.cancel(&task.id, None).unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    // A task created without choosing approvals still asks; the New Task page sends the default.
    let other = mgr.create(new()).await.unwrap();
    wait_for(&mgr, &other.id, AgentStatus::NeedsInput).await;
    mgr.cancel(&other.id, None).unwrap();
    wait_for(&mgr, &other.id, AgentStatus::Ready).await;
    mgr.shutdown();
}

#[tokio::test(flavor = "multi_thread")]
async fn cursor_approval_choice_applies_before_first_prompt() {
    let tmp = tempfile::tempdir().unwrap();
    let mgr = manager(tmp.path(), Arc::new(FakeAgent::default()));
    let task = mgr
        .create(NewAgentTask {
            instructions: None,
            project_root: None,
            prompt: text("Fix"),
            provider: "cursor".into(),
            config: vec![AgentConfigChoice { id: config::CURSOR_APPROVAL.into(), value: "bypass".into() }],
            isolation: Isolation::Local,
            base: None,
        })
        .await
        .unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    mgr.shutdown();
}

#[tokio::test(flavor = "multi_thread")]
async fn archived_tasks_can_be_restored_and_continue_their_session() {
    let tmp = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeAgent::default());
    let mgr = manager(tmp.path(), agent.clone());
    let task = mgr
        .create(NewAgentTask {
            instructions: None,
            project_root: None,
            prompt: text("again"),
            provider: "claude".into(),
            config: vec![],
            isolation: Isolation::Local,
            base: None,
        })
        .await
        .unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    let entries = mgr.entries(&task.id, None).unwrap();
    mgr.archive(&task.id).unwrap();
    assert!(mgr.prompt(&task.id, text("again"), false).await.is_err());
    mgr.unarchive(&task.id).unwrap();
    assert_eq!(mgr.task(&task.id).unwrap().state.lock().task.status, AgentStatus::Ready);
    assert!(mgr.task(&task.id).unwrap().live.lock().is_none());
    assert_eq!(mgr.entries(&task.id, None).unwrap().len(), entries.len());
    drop(mgr);
    let mgr = manager(tmp.path(), agent.clone());
    assert_eq!(mgr.task(&task.id).unwrap().state.lock().task.status, AgentStatus::Ready);
    mgr.prompt(&task.id, text("again"), false).await.unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    assert!(agent.calls.lock().iter().any(|call| call == "session/load"));
    assert_eq!(mgr.entries(&task.id, None).unwrap().len(), entries.len() + 2);
    mgr.unarchive(&task.id).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn task_project_root_controls_local_and_worktree_repositories() {
    let tmp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(tmp.path()).unwrap();
    let member = root.join("project-b");
    std::fs::create_dir(&member).unwrap();
    let git = |args: &[&str]| {
        let out = std::process::Command::new("git")
            .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
            .args(args)
            .current_dir(&member)
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_owned()
    };
    git(&["init", "-q", "-b", "member-main"]);
    std::fs::write(member.join("file.txt"), "original\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "-qm", "initial"]);
    let mgr = manager(&root, Arc::new(FakeAgent::default()));
    for isolation in [Isolation::Local, Isolation::Worktree] {
        let task = mgr
            .create(NewAgentTask {
                instructions: None,
                project_root: Some(IpcPath(member.clone())),
                prompt: text("member task"),
                provider: "claude".into(),
                config: vec![],
                isolation,
                base: None,
            })
            .await
            .unwrap();
        wait_for(&mgr, &task.id, AgentStatus::NeedsInput).await;
        let permission = mgr
            .entries(&task.id, None)
            .unwrap()
            .iter()
            .find_map(|e| match e {
                AgentEntry::Permission { id, .. } => Some(*id),
                _ => None,
            })
            .unwrap();
        mgr.respond(&task.id, permission, Some("yes".into())).unwrap();
        wait_for(&mgr, &task.id, AgentStatus::Ready).await;
        assert_eq!(task.project_root, Some(IpcPath(member.clone())));
        assert_eq!(task.base.as_deref(), Some("member-main"));
        if isolation == Isolation::Local {
            assert_eq!(task.cwd.0, member);
        } else {
            assert_ne!(task.cwd.0, member);
            assert_eq!(std::fs::read_to_string(task.cwd.0.join("file.txt")).unwrap(), "original\n");
        }
        std::fs::write(task.cwd.0.join("file.txt"), "changed\n").unwrap();
        let changes = mgr.changes(&task.id).await.unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].path.0, task.cwd.0.join("file.txt"));
        assert_eq!(mgr.base_text(&task.id, changes[0].path.0.clone()).await.unwrap().as_deref(), Some("original\n"));
        let saved = std::fs::read(root.join("store").join(format!("{}.json", task.id))).unwrap();
        assert!(String::from_utf8(saved).unwrap().contains("projectRoot"));
        let mut old = serde_json::to_value(&task).unwrap();
        old.as_object_mut().unwrap().remove("projectRoot");
        assert!(serde_json::from_value::<AgentTask>(old).unwrap().project_root.is_none());
        mgr.delete(&task.id, true).await.unwrap();
        if isolation == Isolation::Worktree {
            assert!(!task.cwd.0.exists());
        }
        std::fs::write(member.join("file.txt"), "original\n").unwrap();
    }
    assert_eq!(git(&["worktree", "list", "--porcelain"]).matches("worktree ").count(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn complete_answers_in_a_throwaway_session_and_refuses_permissions() {
    let tmp = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeAgent::with_modes("ask", &[("ask", "Ask"), ("default", "Default")]));
    let mgr = manager(tmp.path(), agent.clone());
    let choices = vec![
        AgentConfigChoice { id: "model".into(), value: "small".into() },
        AgentConfigChoice { id: "thought_level".into(), value: "low".into() },
    ];
    let answer = mgr.complete("claude", "  Name this change  ", &choices, Duration::from_secs(5)).await.unwrap();
    // Only the agent's text is kept (not its tool calls), and the permission it asked for was refused.
    assert_eq!(answer, "Hichose none");
    assert_eq!(agent.calls.lock().iter().filter(|c| *c == "session/prompt").count(), 1);
    assert!(agent.calls.lock().contains(&"session/set_mode \"default\"".to_owned()));
    assert!(agent.calls.lock().contains(&"session/set_config_option \"small\"".to_owned()));
    assert!(agent.calls.lock().contains(&"session/set_config_option \"low\"".to_owned()));
    // No task was created or saved.
    assert!(mgr.tasks.read().is_empty());
    assert!(!tmp.path().join("store").exists());
    assert!(mgr.complete("claude", "   ", &[], Duration::from_secs(5)).await.is_err());
    assert!(mgr.complete("no-such-agent", "hi", &[], Duration::from_secs(5)).await.is_err());
}

#[test]
fn restrictive_mode_prefers_read_only_variants_before_default() {
    let make_opts = |vals: &[&str]| {
        vec![AgentConfigOption {
            id: "mode".into(),
            name: "Mode".into(),
            description: None,
            category: Some("mode".into()),
            current: None,
            values: vals
                .iter()
                .map(|v| AgentConfigValue { value: (*v).into(), name: (*v).into(), description: None })
                .collect(),
            via: AgentConfigVia::Mode,
        }]
    };
    assert_eq!(restrictive_mode(&make_opts(&["default", "read_only", "read-only"])), Ok("read-only".to_owned()));
    assert_eq!(restrictive_mode(&make_opts(&["default", "read_only"])), Ok("read_only".to_owned()));
    assert_eq!(restrictive_mode(&make_opts(&["yolo", "default", "plan"])), Ok("default".to_owned()));
    assert_eq!(restrictive_mode(&make_opts(&["yolo", "auto_edit"])), Err("yolo, auto_edit".to_owned()));
    assert_eq!(restrictive_mode(&make_opts(&[])), Err("none".to_owned()));
    assert_eq!(restrictive_mode(&[]), Err("none".to_owned()));
}

#[tokio::test(flavor = "multi_thread")]
async fn complete_picks_an_allowlisted_mode() {
    let tmp = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeAgent::with_modes(
        "bypassPermissions",
        &[("bypassPermissions", "Bypass"), ("default", "Default"), ("plan", "Plan")],
    ));
    let mgr = manager(tmp.path(), agent.clone());
    let answer = mgr.complete("claude", "Suggest commit message", &[], Duration::from_secs(5)).await.unwrap();
    assert_eq!(answer, "Hichose none");
    assert!(agent.calls.lock().contains(&"session/set_mode \"default\"".to_owned()));
}

#[tokio::test(flavor = "multi_thread")]
async fn complete_refuses_an_agent_with_only_permissive_modes() {
    let tmp = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeAgent::with_modes("yolo", &[("yolo", "YOLO"), ("auto_edit", "Auto Edit")]));
    let mgr = manager(tmp.path(), agent.clone());
    let err = mgr.complete("claude", "Suggest commit message", &[], Duration::from_secs(5)).await.unwrap_err();
    assert_eq!(
        err.message,
        "Claude Code cannot run read-only (modes: yolo, auto_edit). Choose Claude, Codex or Antigravity for commit suggestions."
    );
    assert!(agent.prompts.lock().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn complete_refuses_an_agent_without_modes() {
    let tmp = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeAgent::without_modes());
    let mgr = manager(tmp.path(), agent.clone());
    let err = mgr.complete("claude", "Suggest commit message", &[], Duration::from_secs(5)).await.unwrap_err();
    assert_eq!(
        err.message,
        "Claude Code cannot run read-only (modes: none). Choose Claude, Codex or Antigravity for commit suggestions."
    );
    assert!(agent.prompts.lock().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn complete_refuses_when_the_mode_cannot_be_set() {
    let tmp = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeAgent::with_modes("ask", &[("ask", "Ask"), ("default", "Default")]));
    agent.fail_set_mode.store(true, Ordering::Relaxed);
    let mgr = manager(tmp.path(), agent.clone());
    let err = mgr.complete("claude", "Suggest commit message", &[], Duration::from_secs(5)).await.unwrap_err();
    assert!(err.message.contains("cannot set mode"), "unexpected error: {}", err.message);
    assert!(agent.prompts.lock().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn complete_refuses_when_another_setting_drops_the_mode() {
    let tmp = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeAgent::with_modes("ask", &[("ask", "Ask"), ("default", "Default")]));
    agent.drops_mode_on_set.store(true, Ordering::Relaxed);
    let mgr = manager(tmp.path(), agent.clone());
    let choices = vec![AgentConfigChoice { id: "model".into(), value: "small".into() }];
    let err = mgr.complete("claude", "Suggest commit message", &choices, Duration::from_secs(5)).await.unwrap_err();
    assert_eq!(
        err.message,
        "Claude Code cannot run read-only (modes: none). Choose Claude, Codex or Antigravity for commit suggestions."
    );
    let calls = agent.calls.lock().clone();
    assert!(calls.contains(&"session/set_config_option \"small\"".to_owned()), "{calls:?}");
    assert!(agent.prompts.lock().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn complete_ignores_a_caller_mode_choice() {
    let tmp = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeAgent::with_modes("yolo", &[("yolo", "YOLO"), ("default", "Default")]));
    let mgr = manager(tmp.path(), agent.clone());
    let choices = vec![AgentConfigChoice { id: "mode".into(), value: "yolo".into() }];
    let answer = mgr.complete("claude", "Suggest commit message", &choices, Duration::from_secs(5)).await.unwrap();
    assert_eq!(answer, "Hichose none");
    let calls = agent.calls.lock().clone();
    assert!(calls.contains(&"session/set_mode \"default\"".to_owned()), "{calls:?}");
    assert!(!calls.iter().any(|c| c.contains("yolo")), "{calls:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn complete_runs_outside_the_project_and_cleans_up() {
    let tmp = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeAgent::with_modes("ask", &[("ask", "Ask"), ("default", "Default")]));
    let mgr = manager(tmp.path(), agent.clone());
    let _ = mgr.complete("claude", "Suggest commit message", &[], Duration::from_secs(5)).await.unwrap();
    let cwds = agent.cwds.lock().clone();
    assert_eq!(cwds.len(), 1);
    let cwd = &cwds[0];
    assert_ne!(cwd, tmp.path());
    assert!(!cwd.starts_with(tmp.path()));
    assert!(!cwd.exists(), "temporary cwd {} should be removed after complete", cwd.display());
}

#[tokio::test(flavor = "multi_thread")]
async fn complete_never_selects_the_bypass_mode() {
    let tmp = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeAgent::with_modes(
        "bypassPermissions",
        &[("bypassPermissions", "Bypass"), ("default", "Default")],
    ));
    let mgr = manager(tmp.path(), agent.clone());
    let raw = config::options_of(&json!({"configOptions":[{"id":"approval","category":"mode","type":"select",
        "currentValue":"bypassPermissions","options":[{"value":"bypassPermissions"},{"value":"default"}]}]}));
    mgr.shared.known.lock().insert("claude".into(), Known { config: raw, ..Default::default() });
    mgr.complete(
        "claude",
        "Name this change",
        &[AgentConfigChoice { id: "approval".into(), value: "bypassPermissions".into() }],
        Duration::from_secs(5),
    )
    .await
    .unwrap();
    let requests = agent.requests.lock();
    assert!(requests.iter().any(|(m, p)| m == "session/set_mode" && p["modeId"] == "default"));
    assert!(!requests.iter().any(|(m, p)| m.starts_with("session/set_")
        && (p["value"] == "bypassPermissions" || p["modeId"] == "bypassPermissions")));
}

#[tokio::test(flavor = "multi_thread")]
async fn complete_negotiates_with_initialize_params() {
    let tmp = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeAgent::with_modes("default", &[("default", "Default")]));
    let mgr = manager(tmp.path(), agent.clone());
    mgr.complete("claude", "Name this change", &[], Duration::from_secs(5)).await.unwrap();
    let requests = agent.requests.lock();
    let (_, params) = requests.iter().find(|(m, _)| m == "initialize").unwrap();
    assert_eq!(params, &acp::initialize_params(&client_info()));
    assert_eq!(params["clientCapabilities"]["fs"]["writeTextFile"], false);
    assert_eq!(params["clientCapabilities"]["terminal"], false);
}

#[tokio::test(flavor = "multi_thread")]
async fn complete_picks_native_claude_and_codex_modes() {
    for (provider, mode) in [("claude", "default"), ("codex", "read-only")] {
        let tmp = tempfile::tempdir().unwrap();
        let agent = Arc::new(FakeAgent::with_modes(
            "bypassPermissions",
            &[("bypassPermissions", "Bypass"), (mode, "Restrictive")],
        ));
        let mgr = manager(tmp.path(), agent.clone());
        assert_eq!(
            mgr.complete(provider, "Name this change", &[], Duration::from_secs(5)).await.unwrap(),
            "Hichose none"
        );
        assert!(agent.requests.lock().iter().any(|(m, p)| m == "session/set_mode" && p["modeId"] == mode));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn complete_refuses_permissions_on_a_v2_agent() {
    let tmp = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeAgent::with_modes(
        "bypassPermissions",
        &[("bypassPermissions", "Bypass"), ("read-only", "Read only")],
    ));
    agent.v2.store(true, Ordering::Relaxed);
    let mgr = manager(tmp.path(), agent.clone());
    let choices = [AgentConfigChoice { id: "model".into(), value: "small".into() }];
    assert_eq!(
        mgr.complete("codex", "Name this change", &choices, Duration::from_secs(5)).await.unwrap(),
        "Hichose none"
    );
    assert_eq!(*agent.permissions.lock(), [json!({"outcome":{"outcome":"cancelled"}})]);
    let requests = agent.requests.lock();
    for (_, p) in requests.iter().filter(|(m, _)| m == "session/set_config_option") {
        assert_eq!(p["type"], "id");
    }
    assert!(requests.iter().any(|(m, p)| m == "session/set_config_option" && p["value"] == "read-only"));
    assert!(mgr.tasks.read().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn complete_does_not_invent_modes_from_cached_settings() {
    let tmp = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeAgent::without_modes());
    let mgr = manager(tmp.path(), agent.clone());
    let config = config::options_of(
        &json!({"modes":{"currentModeId":"default","availableModes":[{"id":"default","name":"Default"}]}}),
    );
    mgr.shared.known.lock().insert("claude".into(), Known { config, ..Default::default() });
    assert!(
        mgr.complete("claude", "Name this change", &[], Duration::from_secs(5))
            .await
            .unwrap_err()
            .message
            .contains("cannot run read-only")
    );
    assert!(agent.prompts.lock().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn complete_cleans_up_after_errors_timeouts_and_cancellation() {
    for cancel in [false, true] {
        let tmp = tempfile::tempdir().unwrap();
        let agent = Arc::new(FakeAgent::with_modes("default", &[("default", "Default")]));
        let mgr = manager(tmp.path(), agent.clone());
        let complete = mgr.complete("claude", "wait", &[], Duration::from_millis(150));
        if cancel {
            assert!(tokio::time::timeout(Duration::from_millis(75), complete).await.is_err());
        } else {
            assert!(complete.await.unwrap_err().message.contains("didn't answer"));
        }
        let cwds = agent.cwds.lock().clone();
        assert_eq!(cwds.len(), 1);
        assert!(!cwds[0].exists());
        tokio::time::timeout(Duration::from_secs(5), async {
            while !agent.latest().is_closed() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("killing completion must close its fixture connection");
    }
    let tmp = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeAgent::without_modes());
    let mgr = manager(tmp.path(), agent.clone());
    assert!(mgr.complete("claude", "question", &[], Duration::from_secs(5)).await.is_err());
    assert!(!agent.cwds.lock()[0].exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn instructions_go_to_the_first_turn_only() {
    let tmp = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeAgent::default());
    let mgr = manager(tmp.path(), agent.clone());
    let task = mgr
        .create(NewAgentTask {
            project_root: None,
            prompt: text("Fix the lexer"),
            provider: "claude".into(),
            config: vec![],
            isolation: Isolation::Local,
            base: None,
            instructions: Some("  Always run tests first.  ".into()),
        })
        .await
        .unwrap();
    wait_for(&mgr, &task.id, AgentStatus::NeedsInput).await;
    mgr.cancel(&task.id, None).unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    mgr.prompt(&task.id, text("again"), false).await.unwrap();
    wait_for(&mgr, &task.id, AgentStatus::Ready).await;
    assert_eq!(*agent.prompts.lock(), ["Always run tests first.\n\nFix the lexer", "again"]);
    assert_eq!(task.title, "Fix the lexer");
    assert!(matches!(&mgr.entries(&task.id,None).unwrap()[0],AgentEntry::User{text,..} if text=="Fix the lexer"));
    mgr.shutdown();
}

#[tokio::test(flavor = "multi_thread")]
async fn resuming_a_legacy_task_with_an_unknown_provider_fails_clearly() {
    for provider in ["agy", "pi"] {
        let tmp = tempfile::tempdir().unwrap();
        let mgr = manager(tmp.path(), Arc::new(FakeAgent::default()));
        let task = mgr
            .create(NewAgentTask {
                project_root: None,
                prompt: text("again"),
                provider: "claude".into(),
                config: vec![],
                isolation: Isolation::Local,
                base: None,
                instructions: None,
            })
            .await
            .unwrap();
        wait_for(&mgr, &task.id, AgentStatus::Ready).await;
        mgr.shutdown();
        let path = tmp.path().join("store").join(format!("{}.json", task.id));
        let mut saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        saved["task"]["provider"] = json!(provider);
        std::fs::write(&path, serde_json::to_vec(&saved).unwrap()).unwrap();
        let mgr = manager(tmp.path(), Arc::new(FakeAgent::default()));
        mgr.prompt(&task.id, text("again"), false).await.unwrap();
        wait_for(&mgr, &task.id, AgentStatus::Failed).await;
        assert_eq!(
            mgr.task(&task.id).unwrap().state.lock().task.error.as_deref(),
            Some(format!("unknown agent {provider}").as_str())
        );
        mgr.shutdown();
    }
}

async fn real_complete_is_read_only(provider: &str) {
    assert_eq!(
        std::env::var("OPENIDEA_AGENT_E2E").as_deref(),
        Ok("1"),
        "set OPENIDEA_AGENT_E2E=1 to run the real CLI test"
    );
    let tmp = tempfile::tempdir().unwrap();
    let mut mgr = AgentManager::new(
        AgentPaths {
            project_root: tmp.path().into(),
            store_dir: tmp.path().join("store"),
            worktrees_dir: tmp.path().join("worktrees"),
            models_file: tmp.path().join("models.json"),
            custom_agents_dir: None,
            home_dir: None,
        },
        tokio::runtime::Handle::current(),
    );
    let cwds = Arc::new(Mutex::new(Vec::<PathBuf>::new()));
    let seen = cwds.clone();
    let stderr_lines = Arc::new(Mutex::new(Vec::<String>::new()));
    let captured_stderr = stderr_lines.clone();
    let real_connector = mgr.shared.connector.clone();
    let expected_driver = if provider == "claude" { provider::Driver::Claude } else { provider::Driver::Codex };
    Arc::get_mut(&mut mgr.shared).unwrap().connector = Arc::new(move |spec, cwd, client, stderr| {
        assert_eq!(spec.driver, expected_driver);
        seen.lock().push(cwd.to_path_buf());
        let lines = captured_stderr.clone();
        real_connector(
            spec,
            cwd,
            client,
            Box::new(move |line| {
                lines.lock().push(line.clone());
                stderr(line);
            }),
        )
    });
    let sentinel = tmp.path().join("must-not-exist.txt");
    let prompt = format!(
        "First try to write the single word CHANGED to {}. If denied, do not retry or work around permissions. Then answer with exactly READ_ONLY_OK.",
        sentinel.display()
    );
    let config = if provider == "claude" {
        vec![AgentConfigChoice { id: "model".into(), value: "haiku".into() }]
    } else {
        vec![]
    };
    let result = mgr.complete(provider, &prompt, &config, Duration::from_secs(120)).await;
    eprintln!("{provider} read-only completion: {result:?}");
    if result.is_err() {
        eprintln!("{provider} launch stderr: {:?}", stderr_lines.lock());
    }
    assert!(!sentinel.exists(), "completion wrote outside its throwaway directory");
    assert_eq!(cwds.lock().len(), 1);
    let completion_cwd = cwds.lock()[0].clone();
    let removed_on_return = !completion_cwd.exists();
    assert!(result.unwrap().contains("READ_ONLY_OK"));
    let selected = mgr
        .shared
        .known
        .lock()
        .get(provider)
        .unwrap()
        .config
        .iter()
        .find(|option| is_mode_option(option))
        .and_then(|option| option.current.clone());
    let expected = if provider == "claude" { "default" } else { "read-only" };
    eprintln!("{provider} selected mode: {selected:?}");
    assert_eq!(selected.as_deref(), Some(expected));
    assert!(removed_on_return, "real completion must remove its throwaway cwd");
    assert!(mgr.tasks.read().is_empty());
    assert!(!tmp.path().join("store").exists());
    mgr.shutdown();
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn real_claude_complete_is_read_only() {
    real_complete_is_read_only("claude").await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn real_codex_complete_is_read_only() {
    real_complete_is_read_only("codex").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn complete_sets_the_restrictive_mode_after_a_setting_changes_it() {
    let tmp = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeAgent::with_modes("default", &[("default", "Default"), ("bypassPermissions", "Bypass")]));
    agent.notifies_mode_change_on_set.store(true, Ordering::Relaxed);
    let mgr = manager(tmp.path(), agent.clone());
    mgr.complete(
        "claude",
        "Name this change",
        &[AgentConfigChoice { id: "model".into(), value: "small".into() }],
        Duration::from_secs(5),
    )
    .await
    .unwrap();
    let requests = agent.requests.lock();
    let model = requests.iter().position(|(m, p)| m == "session/set_config_option" && p["value"] == "small").unwrap();
    let mode = requests
        .iter()
        .position(|(m, p)| m == "session/set_mode" && p["modeId"] == "default")
        .expect("must restore the restrictive mode after settings");
    let prompt = requests.iter().position(|(m, _)| m == "session/prompt").unwrap();
    assert!(model < mode && mode < prompt);
}

#[tokio::test(flavor = "multi_thread")]
async fn complete_removes_its_temporary_directory_when_launch_fails() {
    let tmp = tempfile::tempdir().unwrap();
    let cwds = Arc::new(Mutex::new(Vec::<PathBuf>::new()));
    let seen = cwds.clone();
    let connector: Connector = Arc::new(move |_, cwd, _, _| {
        seen.lock().push(cwd.into());
        Err(std::io::Error::other("fixture launch failed"))
    });
    let mgr = AgentManager::with_connector(
        AgentPaths {
            project_root: tmp.path().into(),
            store_dir: tmp.path().join("store"),
            worktrees_dir: tmp.path().join("worktrees"),
            models_file: tmp.path().join("models.json"),
            custom_agents_dir: None,
            home_dir: None,
        },
        tokio::runtime::Handle::current(),
        connector,
    );
    assert!(
        mgr.complete("claude", "question", &[], Duration::from_secs(5))
            .await
            .unwrap_err()
            .message
            .contains("fixture launch failed")
    );
    assert_eq!(cwds.lock().len(), 1);
    assert!(!cwds.lock()[0].exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn complete_refuses_a_mode_change_reported_after_selecting_read_only() {
    let tmp = tempfile::tempdir().unwrap();
    let agent = Arc::new(FakeAgent::with_modes(
        "bypassPermissions",
        &[("default", "Default"), ("bypassPermissions", "Bypass")],
    ));
    agent.notifies_mode_change_after_mode_set.store(true, Ordering::Relaxed);
    let mgr = manager(tmp.path(), agent.clone());
    assert!(
        mgr.complete("claude", "Name this change", &[], Duration::from_secs(5))
            .await
            .unwrap_err()
            .message
            .contains("cannot run read-only")
    );
    assert!(agent.prompts.lock().is_empty());
}

#[cfg(windows)]
#[tokio::test]
async fn completion_cleanup_retries_until_a_windows_handle_releases_the_directory() {
    use std::os::windows::fs::OpenOptionsExt;
    let tmp = tempfile::tempdir().unwrap();
    let cwd = tmp.path().join("completion");
    std::fs::create_dir(&cwd).unwrap();
    let held = std::fs::OpenOptions::new().read(true).share_mode(1 | 2).custom_flags(0x02000000).open(&cwd).unwrap();
    assert!(std::fs::remove_dir_all(&cwd).is_err());
    let release = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(80));
        drop(held);
    });
    super::remove_completion_dir(&cwd).await;
    release.join().unwrap();
    assert!(!cwd.exists());
}

#[cfg(windows)]
fn cleanup_owned_registry_executable(root: &Path, executable: &str) {
    let root = dunce::canonicalize(root).unwrap();
    let executable = dunce::canonicalize(executable).unwrap();
    // Never match a global node.exe or any existing Crew executable.
    if !executable.starts_with(&root) {
        return;
    }
    let script = r#"$ErrorActionPreference = 'Stop'
$ownedExecutable = [IO.Path]::GetFullPath($env:IBLOPENIDEA_MT2_TEST_EXECUTABLE)
$ownedProcesses = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -ieq $ownedExecutable })
foreach ($ownedProcess in $ownedProcesses) { Stop-Process -Id $ownedProcess.ProcessId -Force -ErrorAction Stop }
Write-Output ('REGISTRY_TEST_TEARDOWN exact-owned-executable processes=' + $ownedProcesses.Count)
"#;
    let mut command = std::process::Command::new("powershell.exe");
    ide_core::process::prepare(&mut command);
    let output = command
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .env("IBLOPENIDEA_MT2_TEST_EXECUTABLE", &executable)
        .output()
        .unwrap();
    eprintln!("{}", String::from_utf8_lossy(&output.stdout));
    assert!(output.status.success(), "owned test cleanup failed: {}", String::from_utf8_lossy(&output.stderr));
}

#[cfg(windows)]
async fn real_registry_install_and_probe(id: &str) {
    let tmp = tempfile::tempdir().unwrap();
    let paths = registry::RegistryPaths::new(&tmp.path().join("config"), &tmp.path().join("data"));
    let cancel = ide_core::CancellationToken::new();
    let deadline = tokio::spawn({
        let cancel = cancel.clone();
        async move {
            tokio::time::sleep(Duration::from_secs(180)).await;
            cancel.cancel();
        }
    });
    let install_paths = paths.clone();
    let agent = id.to_owned();
    let installed =
        tokio::task::spawn_blocking(move || registry::install(&install_paths, &agent, &cancel, &|_| {})).await.unwrap();
    deadline.abort();
    installed.unwrap();
    let file = paths.agents_dir.join(format!("{id}.toml"));
    assert!(std::fs::read_to_string(&file).unwrap().contains("[registry]"));
    let installed = provider::CustomAgent::read(&file).unwrap();
    assert_eq!(installed.registry.as_ref().unwrap().id, id);
    assert!(Path::new(&installed.command).is_file(), "registry executable is missing");
    eprintln!(
        "REGISTRY_INSTALL {id} version={} command-file={:?}",
        installed.registry.as_ref().unwrap().version,
        Path::new(&installed.command).file_name()
    );
    let cwd = tmp.path().join("probe");
    std::fs::create_dir(&cwd).unwrap();
    let mgr = AgentManager::new(
        AgentPaths {
            project_root: cwd,
            store_dir: tmp.path().join("store"),
            worktrees_dir: tmp.path().join("worktrees"),
            models_file: tmp.path().join("data/agents/models.json"),
            custom_agents_dir: Some(paths.agents_dir),
            home_dir: None,
        },
        tokio::runtime::Handle::current(),
    );
    let probe = mgr.probe(id, true).await.unwrap();
    cleanup_owned_registry_executable(tmp.path(), &installed.command);
    eprintln!("REGISTRY_PROBE {}", serde_json::to_string(&probe).unwrap());
    assert!(probe.error.is_none(), "{probe:?}");
    assert!(probe.protocol.starts_with("ACP v"));
    mgr.shutdown();
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn real_antigravity_registry_install() {
    real_registry_install_and_probe("antigravity-acp").await;
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn real_pi_registry_install() {
    real_registry_install_and_probe("pi-acp").await;
}
