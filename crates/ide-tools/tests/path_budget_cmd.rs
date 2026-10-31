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
