//! Fork commands under the upstream project-trust policy.
use ide_core::NullSink;
use ide_core::error::ErrorKind;
use ide_host::{Host, HostConfig, ops, trust::restricted_command_allowed};
use std::path::{Path, PathBuf};
use std::sync::Arc;

fn host(base: &Path) -> Arc<Host> {
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

/// Programs started by the IDE, not shell commands or hooks started by Git.
fn witness(dir: &Path, name: &str, marker: &Path) -> PathBuf {
    #[cfg(windows)]
    let (path, script) =
        (dir.join(format!("{name}.cmd")), format!("@echo off\r\n>\"{}\" echo executed\r\n", marker.display()));
    #[cfg(unix)]
    let (path, script) = (dir.join(name), format!("#!/bin/sh\nprintf executed > '{}'\n", marker.display()));
    std::fs::write(&path, script).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    path
}

fn agent_profile(host: &Host, dir: &Path, marker: &Path) {
    let command = witness(dir, "agent-witness", marker);
    let agents = host.config_dir.join("agents");
    std::fs::create_dir_all(&agents).unwrap();
    std::fs::write(agents.join("witness.toml"), format!("name = 'Witness'\ncommand = {command:?}\n")).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fork_commands_are_classified() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("project");
    std::fs::create_dir(&root).unwrap();
    let host = host(tmp.path());
    host.open_project("main", &root).unwrap();
    for cmd in ["agent_providers", "agent_set_args", "vcs_ignored"] {
        assert!(restricted_command_allowed(cmd), "missing classification: {cmd}");
        host.authorize_command("main", cmd).unwrap();
        host.authorize_command("missing-window", cmd).unwrap();
    }
    assert!(!restricted_command_allowed("agent_complete"));
    let restricted = host.authorize_command("main", "agent_complete").unwrap_err();
    assert_eq!(restricted.kind, ErrorKind::Unavailable);
    assert!(restricted.message.contains("Restricted Mode"));
    assert_eq!(host.authorize_command("missing-window", "agent_complete").unwrap_err().kind, ErrorKind::NotFound);
    host.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn agent_catalog_lists_and_saves_without_a_project_or_trust() {
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();
    let root = base.join("project");
    std::fs::create_dir(&root).unwrap();
    let host = host(&base);
    let marker = base.join("agent.marker");
    agent_profile(&host, &base, &marker);
    host.open_project("main", &root).unwrap();
    let mut lists = Vec::new();
    for window in ["missing-window", "main"] {
        // Direct set_args is already allowed on the source baseline: a guard.
        let saved = ops::agent::set_args(&host, window, "witness".into(), vec!["--fixture".into()]).unwrap();
        assert_eq!(saved.iter().find(|p| p.id == "witness").unwrap().extra_args, ["--fixture"]);
        lists.push(ops::agent::providers(&host, window));
    }
    let catalog_spawned = marker.exists();
    host.set_project_trust(&root, true, false).await.unwrap();
    ops::agent::probe(&host, "main", "witness".into(), true).await.unwrap();
    let control_spawned = marker.exists();
    host.shutdown().await;
    assert!(control_spawned, "trusted probe must execute the same witness");
    assert!(!catalog_spawned, "profile listing/argument writes must not spawn");
    for list in lists {
        assert!(list.unwrap().iter().any(|p| p.id == "witness"));
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restricted_complete_is_refused_before_spawning() {
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();
    let root = base.join("project");
    std::fs::create_dir(&root).unwrap();
    let host = host(&base);
    let marker = base.join("agent.marker");
    agent_profile(&host, &base, &marker);
    host.open_project("main", &root).unwrap();
    let restricted = ops::agent::complete(&host, "main", "witness".into(), "Suggest".into(), vec![]).await;
    let restricted_spawned = marker.exists();
    if restricted_spawned {
        std::fs::remove_file(&marker).unwrap();
    }
    let missing = ops::agent::complete(&host, "missing-window", "witness".into(), "Suggest".into(), vec![]).await;
    let missing_spawned = marker.exists();
    host.set_project_trust(&root, true, false).await.unwrap();
    let _ = ops::agent::complete(&host, "main", "witness".into(), "Suggest".into(), vec![]).await;
    let control_spawned = marker.exists();
    host.shutdown().await;
    assert!(control_spawned, "trusted completion must execute the same witness (not an ACP acceptance test)");
    let error = restricted.unwrap_err();
    assert_eq!(error.kind, ErrorKind::Unavailable);
    assert!(error.message.contains("Restricted Mode"), "{error}");
    assert!(!restricted_spawned);
    assert_eq!(missing.unwrap_err().kind, ErrorKind::NotFound);
    assert!(!missing_spawned);
}
