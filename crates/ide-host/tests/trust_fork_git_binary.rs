//! The selected Git executable is process-wide: isolate this witness in its own binary.
use ide_core::NullSink;
use ide_host::{Host, HostConfig, ops};
use std::sync::Arc;

struct ResetGit;
impl Drop for ResetGit {
    fn drop(&mut self) {
        ide_vcs::set_git_executable(None);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restricted_ignored_does_not_select_the_project_git_for_other_windows() {
    let _reset = ResetGit;
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();
    let root = base.join("project");
    std::fs::create_dir_all(root.join(".openidea")).unwrap();
    ide_vcs::init(&root).unwrap();
    let marker = base.join("git.marker");
    let real_git = ide_vcs::detected_git_executable().expect("the positive control needs Git");
    #[cfg(windows)]
    let (executable, script) = (
        root.join("git-witness.cmd"),
        format!("@echo off\r\n>\"{}\" echo executed\r\n\"{}\" %*\r\n", marker.display(), real_git.display()),
    );
    #[cfg(unix)]
    let (executable, script) = (
        root.join("git-witness"),
        format!("#!/bin/sh\nprintf executed > '{}'\nexec '{}' \"$@\"\n", marker.display(), real_git.display()),
    );
    std::fs::write(&executable, script).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    std::fs::write(root.join(".openidea/settings.toml"), format!("[vcs.git]\nexecutable = {executable:?}\n")).unwrap();
    let host = Arc::new(Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    }));
    host.open_project("main", &root).unwrap();
    ops::vcs::ignored(&host, "main").await.unwrap();
    ide_vcs::git_version(None).unwrap();
    let restricted_spawned = marker.exists();
    if restricted_spawned {
        std::fs::remove_file(&marker).unwrap();
    }
    host.set_project_trust(&root, true, false).await.unwrap();
    ops::vcs::ignored(&host, "main").await.unwrap();
    ide_vcs::git_version(None).unwrap();
    let control_spawned = marker.exists();
    ide_vcs::set_git_executable(None);
    host.shutdown().await;
    assert!(control_spawned, "trusted use must execute the project's Git witness");
    assert!(!restricted_spawned, "restricted ignored selected a project binary for another window's next Git command");
}
