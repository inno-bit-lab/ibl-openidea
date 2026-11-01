//! Restricted ignored-file reads do not execute repository configuration, on every OS.
use ide_vcs::Repo;
use std::path::Path;

fn git(root: &Path, args: &[&str]) {
    let output = std::process::Command::new("git").current_dir(root).args(args).output().unwrap();
    assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
}

#[test]
fn restricted_ignored_status_ignores_executable_repository_configuration() {
    let tmp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(tmp.path()).unwrap();
    git(&root, &["init", "-q"]);
    for (key, value) in [
        ("user.name", "Test"),
        ("user.email", "test@example.com"),
        ("commit.gpgsign", "false"),
        ("core.autocrlf", "false"),
    ] {
        git(&root, &["config", key, value]);
    }
    std::fs::write(root.join("a.txt"), "before\n").unwrap();
    std::fs::write(root.join(".gitignore"), "ignored.log\n*.marker\n").unwrap();
    git(&root, &["add", "."]);
    git(&root, &["commit", "-q", "-m", "initial"]);
    std::fs::write(root.join(".gitattributes"), "*.txt filter=evil diff=evil\n").unwrap();
    std::fs::write(root.join("a.txt"), "restricted change\n").unwrap();
    std::fs::write(root.join("ignored.log"), "ignored\n").unwrap();
    let channels = [
        ("filter.evil.clean", "filter"),
        ("diff.evil.textconv", "textconv"),
        ("diff.external", "extdiff"),
        ("core.fsmonitor", "fsmonitor"),
    ];
    for (key, channel) in channels {
        git(&root, &["config", key, &format!("touch {channel}.marker; cat")]);
    }
    let repo = Repo::discover(&root).unwrap().unwrap();
    repo.set_execution_allowed(false);
    let status = repo.status_with_ignored(true).unwrap();
    assert!(status.iter().any(|f| f.path.0 == root.join("a.txt")));
    assert!(status.iter().any(|f| f.path.0 == root.join("ignored.log")));
    for (_, channel) in channels {
        assert!(!root.join(format!("{channel}.marker")).exists(), "restricted {channel}");
    }
    // Same-program positive controls, each with its own marker and a fresh content change.
    for (channel, args) in [
        ("filter", vec!["-c", "core.fsmonitor=false", "diff", "--no-ext-diff", "--no-textconv"]),
        ("textconv", vec!["-c", "core.fsmonitor=false", "diff", "--no-ext-diff"]),
        ("extdiff", vec!["-c", "core.fsmonitor=false", "diff"]),
        ("fsmonitor", vec!["status"]),
    ] {
        let marker = root.join(format!("{channel}.marker"));
        if marker.exists() {
            std::fs::remove_file(&marker).unwrap();
        }
        std::fs::write(root.join("a.txt"), format!("positive {channel}\n")).unwrap();
        let output = std::process::Command::new("git").current_dir(&root).args(&args).output().unwrap();
        // `cat` in the external-diff witness receives object IDs/modes as well as
        // paths. Its marker proves execution even though those extra args fail.
        assert!(output.status.success() || channel == "extdiff", "{}", String::from_utf8_lossy(&output.stderr));
        assert!(marker.exists(), "positive control {channel}");
    }
}
