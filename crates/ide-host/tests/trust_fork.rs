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

fn git(root: &Path, args: &[&str]) {
    let out = std::process::Command::new("git").current_dir(root).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

const GIT_CHANNELS: &[&str] = &["filter", "textconv", "extdiff", "fsmonitor", "hook"];

fn malicious_repo(root: &Path, name: &str) {
    std::fs::create_dir_all(root).unwrap();
    git(root, &["init", "-q"]);
    for (key, value) in [
        ("user.name", "Trust Witness"),
        ("user.email", "trust@example.com"),
        ("commit.gpgsign", "false"),
        ("core.autocrlf", "false"),
        ("core.hooksPath", ".git/hooks"),
    ] {
        git(root, &["config", key, value]);
    }
    std::fs::write(root.join(".gitattributes"), "*.txt filter=evil diff=evil\n").unwrap();
    std::fs::write(root.join(".gitignore"), "ignored.log\n*.marker\nnested/\n").unwrap();
    std::fs::write(root.join("a.txt"), "one\n").unwrap();
    git(root, &["add", "."]);
    git(root, &["commit", "-q", "-m", "initial"]);
    for (key, channel) in [
        ("filter.evil.clean", "filter"),
        ("diff.evil.textconv", "textconv"),
        ("diff.external", "extdiff"),
        ("core.fsmonitor", "fsmonitor"),
    ] {
        git(root, &["config", key, &format!("touch {channel}-{name}.marker; cat")]);
    }
    let hook = root.join(".git/hooks/pre-commit");
    // Git's shell runs configuration commands and this extensionless hook on every OS.
    std::fs::write(&hook, format!("#!/bin/sh\ntouch hook-{name}.marker\n")).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    std::fs::write(root.join("a.txt"), "restricted change\n").unwrap();
    std::fs::write(root.join("ignored.log"), "ignored\n").unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restricted_ignored_and_status_in_a_multi_repo_project() {
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();
    let root = base.join("workspace");
    let a = root.join("a");
    let b = root.join("b");
    let c = a.join("nested");
    malicious_repo(&a, "a");
    malicious_repo(&b, "b");
    let host = host(&base);
    let project = host.open_project("main", &root).unwrap();
    malicious_repo(&c, "c");
    project.refresh_repositories();
    assert_eq!(project.repos().all().len(), 3, "the newly discovered nested repo must participate");
    let status = ops::vcs::status(&host, "main").await.unwrap();
    let ignored = ops::vcs::ignored(&host, "main").await.unwrap();
    for (repo, name) in [(&a, "a"), (&b, "b"), (&c, "c")] {
        assert!(status.iter().any(|f| f.path.0 == repo.join("a.txt")), "changed file in {name}");
        assert!(ignored.iter().any(|f| f.path.0 == repo.join("ignored.log")), "ignored file in {name}");
        let denied = ops::vcs::vcs_stage(&host, "main", vec![repo.join("a.txt")]).await.unwrap_err();
        assert!(denied.message.contains("Restricted Mode"));
        for channel in GIT_CHANNELS {
            assert!(!repo.join(format!("{channel}-{name}.marker")).exists(), "restricted {channel} in {name}");
        }
    }
    host.set_project_trust(&root, true, false).await.unwrap();
    for (repo, name) in [(&a, "a"), (&b, "b"), (&c, "c")] {
        for (channel, args) in [
            ("filter", vec!["-c", "core.fsmonitor=false", "diff", "--no-ext-diff", "--no-textconv"]),
            ("textconv", vec!["-c", "core.fsmonitor=false", "diff", "--no-ext-diff"]),
            ("extdiff", vec!["-c", "core.fsmonitor=false", "diff"]),
            ("fsmonitor", vec!["status"]),
        ] {
            let marker = repo.join(format!("{channel}-{name}.marker"));
            if marker.exists() {
                std::fs::remove_file(&marker).unwrap();
            }
            std::fs::write(repo.join("a.txt"), format!("positive control {channel} {name}\n")).unwrap();
            let output = std::process::Command::new("git").current_dir(repo).args(&args).output().unwrap();
            // The external-diff witness receives Git's seven arguments: `cat` also
            // receives object IDs/modes and exits nonzero after writing its marker.
            assert!(output.status.success() || channel == "extdiff", "{}", String::from_utf8_lossy(&output.stderr));
            assert!(marker.exists(), "positive control {channel} in {name}");
        }
        std::fs::write(repo.join("a.txt"), format!("positive hook control {name}\n")).unwrap();
        ops::vcs::vcs_stage(&host, "main", vec![repo.join("a.txt")]).await.unwrap();
        project.with_repo_of(&repo.join("a.txt"), |r| r.commit("trusted", false, false)).unwrap();
        assert!(repo.join(format!("hook-{name}.marker")).exists(), "positive hook control in {name}");
    }
    host.shutdown().await;
}
