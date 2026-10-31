#![cfg(windows)]

use std::ffi::{OsStr, OsString};
use std::path::PathBuf;
use std::process::Output;

const CMD_PATH_LIMIT: usize = 8191;

struct Fixture {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    outer: PathBuf,
    helper_dir: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("app-data");
        let helper_dir = tmp.path().join("last-helper-dir");
        std::fs::create_dir(&helper_dir).unwrap();
        let outer = tmp.path().join("outer.cmd");
        std::fs::write(&outer, "@echo off\r\ncall path_budget_helper.cmd\r\nexit /b %errorlevel%\r\n").unwrap();
        std::fs::write(helper_dir.join("path_budget_helper.cmd"), "@echo PATH_BUDGET_OK\r\n").unwrap();
        Self { _tmp: tmp, root, outer, helper_dir }
    }

    fn path_at_least(&self, chars: usize) -> OsString {
        let mut padding = Vec::new();
        loop {
            let path = std::env::join_paths(padding.iter().chain(std::iter::once(&self.helper_dir))).unwrap();
            if path_chars(&path) >= chars {
                assert_eq!(std::env::split_paths(&path).last().as_deref(), Some(self.helper_dir.as_path()));
                return path;
            }
            // Nonexistent absolute entries under the fixture, each well below MAX_PATH.
            padding.push(self._tmp.path().join(format!("padding-{:04}-{}", padding.len(), "x".repeat(70))));
        }
    }

    fn run(&self, name: &str, path: &OsStr) -> Output {
        let mut command = std::process::Command::new(&self.outer);
        ide_core::process::prepare(&mut command);
        let output = command
            .current_dir(self.outer.parent().unwrap())
            .env("PATH", path)
            .env("PATHEXT", ".COM;.EXE;.BAT;.CMD")
            .output()
            .unwrap();
        eprintln!(
            "CMD_FIXTURE {name} chars={} entries={} status={} stdout={:?} stderr={:?}",
            path_chars(path),
            std::env::split_paths(path).count(),
            output.status,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        output
    }
}

fn path_chars(path: &OsStr) -> usize {
    use std::os::windows::ffi::OsStrExt;
    path.encode_wide().count()
}

fn helper_ran(output: &Output) -> bool {
    output.status.success() && String::from_utf8_lossy(&output.stdout).contains("PATH_BUDGET_OK")
}

#[test]
fn cmd_shim_finds_the_last_path_entry_below_the_limit() {
    let fixture = Fixture::new();
    let path = fixture.path_at_least(7000);
    assert!(path_chars(&path) < CMD_PATH_LIMIT);
    assert!(helper_ran(&fixture.run("positive-control", &path)));
}

#[test]
fn cmd_shim_loses_the_helper_above_the_inherited_path_limit() {
    let fixture = Fixture::new();
    let path = fixture.path_at_least(9000);
    assert!(path_chars(&path) > CMD_PATH_LIMIT);
    assert!(!helper_ran(&fixture.run("negative-control", &path)));
}

#[test]
fn managed_composition_keeps_cmd_shims_within_the_path_budget() {
    let fixture = Fixture::new();
    let candidates = ide_tools::tools_bin_dirs(&fixture.root);
    assert!(candidates.len() > 1);
    std::fs::create_dir_all(&candidates[0]).unwrap();
    let base = fixture.path_at_least(7000);
    let composed = ide_tools::path_with_tools(&fixture.root, &base);
    let output = fixture.run("production-composition", &composed);
    eprintln!("MANAGED_CANDIDATES total={} existing=1", candidates.len());
    assert!(path_chars(&composed) < CMD_PATH_LIMIT, "managed contribution exceeded the cmd budget");
    assert!(helper_ran(&output));
}

#[derive(Clone)]
struct WarningCapture(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

impl std::io::Write for WarningCapture {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[test]
fn overlong_paths_warn_once_per_composer() {
    const CHILD: &str = "IBL_PATH_BUDGET_WARN_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let fixture = Fixture::new();
        let path = fixture.path_at_least(9000);
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "overlong_paths_warn_once_per_composer", "--nocapture"])
            .env(CHILD, "1")
            .env("PATH", path)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "warning child failed: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        eprintln!("{}", String::from_utf8_lossy(&output.stderr));
        return;
    }

    // Each composer has fresh process-global state; no environment mutation in test threads.
    let fixture = Fixture::new();
    let base = std::env::var_os("PATH").unwrap();
    assert!(path_chars(&base) > CMD_PATH_LIMIT);
    let bytes = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let capture = WarningCapture(bytes.clone());
    let subscriber = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::WARN)
        .with_ansi(false)
        .without_time()
        .with_target(false)
        .with_writer(move || capture.clone())
        .finish();
    let lengths = tracing::subscriber::with_default(subscriber, || {
        let short = ide_tools::path_with_tools(&fixture.root, OsStr::new(""));
        assert!(path_chars(&short) < CMD_PATH_LIMIT);
        let _ = ide_tools::Tools::with_paths(
            fixture.root.join("tools"),
            OsString::new(),
            ide_tools::platform::Platform::current(),
        );
        assert!(bytes.lock().unwrap().is_empty(), "short PATH must not warn");
        let mut lengths = None;
        for _ in 0..2 {
            let startup = ide_tools::path_with_tools(&fixture.root, &base);
            let _ = ide_tools::Tools::with_paths(
                fixture.root.join("tools"),
                base.clone(),
                ide_tools::platform::Platform::current(),
            );
            let lookup = ide_core::tool_path::search_path();
            lengths = Some([path_chars(&startup), path_chars(&base), path_chars(&lookup)]);
        }
        lengths.unwrap()
    });
    let log = String::from_utf8(bytes.lock().unwrap().clone()).unwrap();
    eprintln!("COMPOSER_WARNINGS\n{log}");
    let events: Vec<_> = log.lines().collect();
    assert_eq!(events.len(), 3, "expected exactly one warning per composer: {log}");
    for (composer, length) in
        ["ide_tools::extend_process_path", "ide_tools::Tools::with_paths", "ide_core::tool_path::search_path"]
            .into_iter()
            .zip(lengths)
    {
        let matching: Vec<_> = events.iter().filter(|line| line.contains(composer)).collect();
        assert_eq!(matching.len(), 1, "wrong warning count for {composer}: {log}");
        let event = matching[0];
        assert!(
            event.contains("WARN") && event.contains(&format!("length={length}")) && event.contains("limit=8191"),
            "wrong warning level or fields: {event}"
        );
    }
}
