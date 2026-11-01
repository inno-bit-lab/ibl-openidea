//! User-owned project execution decisions. Project settings never grant trust.
use ide_core::{IdeError, IdeResult};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};

#[derive(Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TrustDecisions {
    pub projects: Vec<PathBuf>,
    pub locations: Vec<PathBuf>,
    pub restricted: Vec<PathBuf>,
}

pub struct TrustStore {
    file: PathBuf,
    state: Mutex<IdeResult<TrustDecisions>>,
}

impl TrustStore {
    pub fn load(config: &Path, data: &Path) -> Self {
        let file = data.join("project-trust.json");
        let state = match std::fs::read(&file) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| IdeError::invalid(e.to_string())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let projects = ide_workspace::RecentProjects::load(config)
                    .paths()
                    .into_iter()
                    .filter_map(|p| dunce::canonicalize(p).ok())
                    .collect();
                let migrated = TrustDecisions { projects, ..Default::default() };
                persist(&file, &migrated).map(|()| migrated)
            }
            Err(e) => Err(e.into()),
        };
        Self { file, state: Mutex::new(state) }
    }

    pub fn decisions(&self) -> IdeResult<TrustDecisions> {
        self.state.lock().clone()
    }

    pub fn trusted(&self, path: &Path) -> IdeResult<bool> {
        let root = dunce::canonicalize(path)?;
        let decisions = self.decisions()?;
        Ok(!decisions.restricted.contains(&root)
            && (decisions.projects.contains(&root) || decisions.locations.iter().any(|p| root.starts_with(p))))
    }

    pub fn decide(&self, path: &Path, trusted: bool, folder: bool) -> IdeResult<()> {
        let root = match dunce::canonicalize(path) {
            Ok(root) => root,
            Err(_) if !trusted && path.is_absolute() => path.to_path_buf(),
            Err(error) => return Err(error.into()),
        };
        let mut state = self.state.lock();
        let mut next = state.clone()?;
        next.projects.retain(|p| p != &root);
        next.restricted.retain(|p| p != &root);
        if trusted {
            next.projects.push(root.clone());
            if folder && let Some(parent) = root.parent() {
                let parent = parent.to_path_buf();
                if !next.locations.contains(&parent) {
                    next.locations.push(parent);
                }
            }
        } else {
            next.restricted.push(root);
        }
        persist(&self.file, &next)?;
        *state = Ok(next);
        Ok(())
    }

    pub fn remove_location(&self, path: &Path) -> IdeResult<()> {
        let mut state = self.state.lock();
        let mut next = state.clone()?;
        next.locations.retain(|p| p != path);
        persist(&self.file, &next)?;
        *state = Ok(next);
        Ok(())
    }
}

fn persist(file: &Path, state: &TrustDecisions) -> IdeResult<()> {
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let bytes = serde_json::to_vec_pretty(state).map_err(|e| IdeError::internal(e.to_string()))?;
    ide_vfs::write_atomic(file, &bytes)?;
    Ok(())
}

impl crate::Host {
    pub async fn set_project_trust(&self, path: &Path, trusted: bool, folder: bool) -> IdeResult<()> {
        self.trust.decide(path, trusted, folder)?;
        self.refresh_project_trust().await
    }

    pub async fn refresh_project_trust(&self) -> IdeResult<()> {
        for project in self.projects().into_iter().filter(|p| !p.light) {
            crate::pause::point(&project.root, "refresh:apply").await;
            let (changed, revocation, trusted) = {
                let gate = project.trust_gate.lock();
                if gate.closed {
                    continue;
                }
                let trusted = self.trust.trusted(&project.root).unwrap_or(false);
                let previous = project.trusted.swap(trusted, std::sync::atomic::Ordering::SeqCst);
                if previous == trusted {
                    (false, None, trusted)
                } else if trusted {
                    project.repos();
                    if let Some(cmd) = self.environment.project_opened(&project.root, &project.sink) {
                        self.environment.spawn_post_start(cmd, project.root.clone(), project.sink.clone());
                    }
                    project.lsp.set_execution_allowed(true);
                    project.agents.set_execution_allowed(true);
                    (true, None, trusted)
                } else {
                    project.lsp.set_execution_allowed(false);
                    let r = project.agents.revoke();
                    project.repos();
                    self.environment.project_closed();
                    (true, Some(r), trusted)
                }
            };
            if !changed {
                continue;
            }
            if let Some(r) = revocation {
                crate::pause::point(&project.root, "refresh:after-gate").await;
                r.finish();
                self.processes.kill_project(&project.root);
                project.notebooks.restrict().await;
                let windows: Vec<_> = self
                    .projects
                    .read()
                    .iter()
                    .filter(|(_, current)| std::sync::Arc::ptr_eq(current, &project))
                    .map(|(window, _)| window.clone())
                    .collect();
                for window in windows {
                    let requests = self.project_requests.write().remove(&window).unwrap_or_default();
                    for request in requests {
                        self.cancel_request(request);
                    }
                    for session in self.debugger.sessions(Some(&window)) {
                        let _ = self.debugger.stop(session.id).await;
                    }
                }
            }
            project.lsp.reconfigure().await;
            project.sink.emit(ide_core::IdeEvent::ProjectTrustChanged { root: project.root.clone().into(), trusted });
        }
        Ok(())
    }
}

/// Commands which only inspect/edit source or operate user-owned application state.
/// New execution commands are denied until deliberately classified here.
pub fn restricted_command_allowed(cmd: &str) -> bool {
    if [
        "fs_",
        "doc_",
        "syntax_",
        "search_",
        "nav_",
        "history_",
        "spell_",
        "analysis_",
        "structural_",
        "refactor_",
        "bytes_",
        "window_",
        "window_group_",
        "term_",
        "settings_",
        "project_trust_",
        "ssh_",
        "git_credential",
    ]
    .iter()
    .any(|p| cmd.starts_with(p))
    {
        return true;
    }
    matches!(
        cmd,
        "app_info"
            | "app_metrics"
            | "app_quit"
            | "app_cancel_quit"
            | "app_restart"
            | "languages"
            | "menu_refresh"
            | "menu_model"
            | "menu_configure"
            | "menu_set_disabled"
            | "lsp_servers"
            | "lsp_resend_diagnostics"
            | "recent_projects"
            | "remove_recent_project"
            | "open_project"
            | "close_project"
            | "project_current"
            | "project_roots"
            | "index_status"
            | "jvm_file_presentations"
            | "deploy_coverage"
            | "find_files"
            | "find_symbols"
            | "mark_recent"
            | "remove_recent"
            | "recent_files"
            | "web_goto"
            | "path_completions"
            | "web_unresolved_references"
            | "project_rename"
            | "light_edit_open"
            | "workspace_create"
            | "workspace_update"
            | "workspace_attach"
            | "cancel_request"
            | "cancel_task"
            | "log_frontend"
            | "env_reload"
            | "remote_invoke"
            | "remote_current"
            | "remote_disconnect"
            | "remote_connect"
            | "remote_list"
            | "remote_open"
            | "remote_of"
            | "web_browsers"
            | "web_url"
            | "web_open"
            | "debug_attachable_processes"
            | "agent_subscribe"
            | "agent_entries"
            | "agent_commands"
            | "agent_unqueue"
            | "agent_cancel"
            | "agent_archive"
            | "agent_unarchive"
            | "agent_registry_list"
            | "agent_registry_install"
            | "agent_registry_remove"
            | "coverage_import"
            | "system_font_families"
            | "plugin_subscribe"
            | "plugin_list"
            | "plugin_set_active_file"
            | "plugin_set_theme"
            | "plugin_set_theme_frame"
            | "plugin_catalog"
            | "notebook_open"
            | "notebook_get"
            | "notebook_edit"
            | "notebook_save"
            | "notebook_undo"
            | "notebook_redo"
            | "notebook_reload"
            | "notebook_close"
            | "notebook_interrupt"
            | "run_stop"
            | "run_list"
            | "debug_stop"
            | "debug_sessions"
            | "vcs_clone"
            | "vcs_init"
            | "vcs_status"
            | "vcs_roots"
            | "vcs_branch_info"
            | "vcs_line_hunks"
            | "vcs_file_at"
            | "vcs_blame"
            | "vcs_log"
            | "vcs_commit_files"
            | "vcs_commits_changes"
            | "vcs_branches"
            | "vcs_stashes"
            | "vcs_conflict_versions"
            | "vcs_diff_text"
            | "vcs_diff_hunks"
            | "vcs_detected_git"
            | "vcs_config_get"
            | "vcs_tags"
            | "vcs_remotes"
            | "vcs_worktrees"
            | "vcs_diff_with_worktree"
            | "vcs_diff_revisions"
            | "vcs_merge_base"
            | "vcs_shelves"
            | "vcs_shelf_patch"
            | "vcs_changelists_load"
    ) || cmd.starts_with("plugin:")
        || fork_restricted_command_allowed(cmd)
}

// Fork command classification: 2026-10-31-sync-v0.3.1-mt6-trust.md, section 3.2.
// agent_providers deliberately overrides upstream: it reads the user's profile only.
fn fork_restricted_command_allowed(cmd: &str) -> bool {
    matches!(cmd, "agent_providers" | "agent_set_args" | "vcs_ignored")
}

impl crate::Host {
    pub fn authorize_command(&self, window: &str, command: &str) -> IdeResult<()> {
        if restricted_command_allowed(command) {
            return Ok(());
        }
        self.project(window)?.require_trust()
    }
}

#[derive(Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TrustStatus {
    pub root: ide_core::IpcPath,
    pub trusted: bool,
    pub decided: bool,
}
impl TrustStore {
    pub fn status(&self, path: &Path) -> IdeResult<TrustStatus> {
        let root = dunce::canonicalize(path)?;
        let trusted = self.trusted(&root)?;
        let state = self.decisions()?;
        Ok(TrustStatus { decided: trusted || state.restricted.contains(&root), root: root.into(), trusted })
    }
}

#[cfg(test)]
mod races {
    use super::*;
    use crate::{Host, HostConfig};
    use ide_core::NullSink;
    use std::sync::Arc;

    fn test_host(base: &Path) -> Arc<Host> {
        Arc::new(Host::new(HostConfig {
            config_dir: base.join("config"),
            data_dir: base.join("data"),
            languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
            syntax: Arc::default(),
            sink_for: Box::new(|_| Arc::new(NullSink)),
            owner: |w| w,
            runtime: tokio::runtime::Handle::current(),
            project_environment: false,
        }))
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn grant_racing_close_leaves_the_closed_project_without_admission() {
        let tmp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(tmp.path()).unwrap();
        let root = base.join("project");
        std::fs::create_dir_all(&root).unwrap();
        let host = test_host(&base);
        let project = host.open_project("main", &root).unwrap();
        assert!(!project.is_trusted());
        assert!(project.agents.admit().is_err());

        // Intercept grant at refresh:apply
        let arm = crate::pause::arm(&root, "refresh:apply");
        let host_clone = host.clone();
        let root_clone = root.clone();
        let grant_task = tokio::spawn(async move { host_clone.set_project_trust(&root_clone, true, false).await });
        arm.wait_reached().await;

        // Close project while grant is paused before gate
        host.close_project("main");
        assert!(project.trust_gate.lock().closed);

        // Release grant: must observe closed gate and skip re-opening admission
        arm.release();
        grant_task.await.unwrap().unwrap();

        assert!(project.trust_gate.lock().closed);
        assert!(project.agents.admit().is_err(), "closed project must NOT have admission granted");
        host.shutdown().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn grant_racing_revoke_ends_in_the_last_decision() {
        let tmp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(tmp.path()).unwrap();
        let root = base.join("project");
        std::fs::create_dir_all(&root).unwrap();
        let host = test_host(&base);
        let project = host.open_project("main", &root).unwrap();

        // 1. Grant G starts and pauses at refresh:apply
        let arm = crate::pause::arm(&root, "refresh:apply");
        let host_g = host.clone();
        let root_g = root.clone();
        let grant_task = tokio::spawn(async move { host_g.set_project_trust(&root_g, true, false).await });
        arm.wait_reached().await;

        // 2. While G is paused, Revoke R is submitted and sets decision to false
        let host_r = host.clone();
        let root_r = root.clone();
        let revoke_task = tokio::spawn(async move { host_r.set_project_trust(&root_r, false, false).await });

        // 3. Release G
        arm.release();
        grant_task.await.unwrap().unwrap();
        revoke_task.await.unwrap().unwrap();

        // The final state must match the last decision (false / restricted)
        assert!(!project.is_trusted(), "project must end in revoked state");
        assert!(project.agents.admit().is_err(), "admission must be restricted");
        host.shutdown().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stale_revoke_tail_keeps_a_later_grant() {
        let tmp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(tmp.path()).unwrap();
        let root = base.join("project");
        std::fs::create_dir_all(&root).unwrap();
        let host = test_host(&base);
        let project = host.open_project("main", &root).unwrap();

        // Initially trusted
        host.set_project_trust(&root, true, false).await.unwrap();
        assert!(project.is_trusted());
        assert!(project.agents.admit().is_ok());

        // 1. Revoke R starts, completes critical section under gate, pauses at refresh:after-gate
        let arm = crate::pause::arm(&root, "refresh:after-gate");
        let host_r = host.clone();
        let root_r = root.clone();
        let revoke_task = tokio::spawn(async move { host_r.set_project_trust(&root_r, false, false).await });
        arm.wait_reached().await;

        // 2. While R's tail is held, Grant G runs and completes
        host.set_project_trust(&root, true, false).await.unwrap();
        assert!(project.is_trusted());
        let g_epoch = project.agents.admit().unwrap();
        assert!(!g_epoch.is_cancelled(), "Grant G epoch must be alive");

        // 3. Now release R's after-gate tail
        arm.release();
        revoke_task.await.unwrap().unwrap();

        // 4. Assert: stale R tail finishing must NOT cancel G's admission
        assert!(project.is_trusted(), "project must remain trusted");
        assert!(!g_epoch.is_cancelled(), "Grant G epoch must NOT be cancelled by stale R finish");
        assert!(project.agents.admit().is_ok(), "admission must remain valid");
        host.shutdown().await;
    }
}
