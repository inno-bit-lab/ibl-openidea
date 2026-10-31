//! Starting `claude` in stream-json mode, one process per session.

use ide_core::{CancellationToken, process_tree::ProcessTree};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncWrite};

/// The flags every session runs with: the Agent SDK's, as its process transport passes them.
pub(super) const BASE_ARGS: &[&str] = &[
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-prompt-tool",
    "stdio",
    "--include-partial-messages",
    "--thinking-display",
    "summarized",
    "--allow-dangerously-skip-permissions",
];

/// How a session's process starts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Start {
    New {
        id: String,
    },
    Resume {
        id: String,
        at: Option<String>,
    },
    /// A copy of `from` (up to `at`) under the id `id`.
    Fork {
        from: String,
        id: String,
        at: Option<String>,
    },
}

impl Start {
    pub fn args(&self) -> Vec<String> {
        let mut out: Vec<String> = BASE_ARGS.iter().map(|a| (*a).to_owned()).collect();
        let mut push = |a: &str, v: &str| {
            out.push(a.to_owned());
            out.push(v.to_owned());
        };
        match self {
            Start::New { id } => push("--session-id", id),
            Start::Resume { id, at } => {
                push("--resume", id);
                if let Some(at) = at {
                    push("--resume-session-at", at);
                }
            }
            Start::Fork { from, id, at } => {
                push("--resume", from);
                if let Some(at) = at {
                    push("--resume-session-at", at);
                }
                out.push("--fork-session".into());
                out.push("--session-id".into());
                out.push(id.clone());
            }
        }
        out
    }
}

pub(super) struct Launch {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
}

/// A running CLI: its stdio, and a token that kills it when cancelled. Its stdout ending
/// means it is gone.
pub(super) struct CliIo {
    pub stdin: Pin<Box<dyn AsyncWrite + Send>>,
    pub stdout: Pin<Box<dyn AsyncRead + Send>>,
    pub kill: CancellationToken,
}

pub(super) type OnStderr = Arc<dyn Fn(String) + Send + Sync>;

pub(super) trait Cli: Send + Sync + 'static {
    fn launch(&self, launch: &Launch, on_stderr: OnStderr) -> std::io::Result<CliIo>;
}

/// The real `claude`.
pub(super) struct Process;

impl Cli for Process {
    fn launch(&self, l: &Launch, on_stderr: OnStderr) -> std::io::Result<CliIo> {
        use std::process::Stdio;
        let mut cmd = tokio::process::Command::new(&l.program);
        ide_core::process::prepare(cmd.as_std_mut());
        ProcessTree::contain(cmd.as_std_mut());
        cmd.args(&l.args)
            .current_dir(&l.cwd)
            .envs(ide_core::process::shell_env())
            .envs(l.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            // Started from inside Claude Code (a terminal in it), the CLI would think it is nested.
            .env_remove("CLAUDECODE")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = cmd.spawn()?;
        #[cfg(windows)]
        let tree = {
            let handle = child.raw_handle().ok_or_else(|| std::io::Error::other("child handle unavailable"))?;
            // SAFETY: child remains owned during this temporary handle borrow.
            let borrowed = unsafe { std::os::windows::io::BorrowedHandle::borrow_raw(handle) };
            ProcessTree::adopt(&borrowed)?
        };
        #[cfg(not(windows))]
        let tree = ProcessTree::adopt(&child)?;
        let stdin = child.stdin.take().ok_or_else(|| std::io::Error::other("no stdin"))?;
        let stdout = child.stdout.take().ok_or_else(|| std::io::Error::other("no stdout"))?;
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(ide_jsonrpc::output::read_lines(stderr, move |line| on_stderr(line)));
        }
        let kill = CancellationToken::new();
        let token = kill.clone();
        tokio::spawn(async move {
            tokio::select! {
                _ = child.wait() => {}
                _ = token.cancelled() => {
                    if let Err(error) = tokio::task::spawn_blocking(move || tree.kill()).await {
                        tracing::warn!(%error, "Claude process-tree teardown task failed");
                    }
                    let _ = child.start_kill();
                    let _ = child.wait().await;
                }
            }
            // On a natural exit the owned job closes here and ends descendants.
        });
        Ok(CliIo { stdin: Box::pin(stdin), stdout: Box::pin(stdout), kill })
    }
}

/// Claude Code's configuration directory (`CLAUDE_CONFIG_DIR`, else `~/.claude`).
pub(super) fn config_dir(env: &[(String, String)]) -> Option<PathBuf> {
    let set = env
        .iter()
        .find(|(k, _)| k == "CLAUDE_CONFIG_DIR")
        .map(|(_, v)| PathBuf::from(v))
        .or_else(|| std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from));
    set.or_else(|| {
        std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(|h| Path::new(&h).join(".claude"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_flags() {
        let tail = |s: Start| s.args()[BASE_ARGS.len()..].join(" ");
        assert_eq!(tail(Start::New { id: "a".into() }), "--session-id a");
        assert_eq!(tail(Start::Resume { id: "a".into(), at: Some("u".into()) }), "--resume a --resume-session-at u");
        assert_eq!(
            tail(Start::Fork { from: "a".into(), id: "b".into(), at: None }),
            "--resume a --fork-session --session-id b"
        );
    }

    #[cfg(windows)]
    const TREE_ROLE: &str = "IBL_CLAUDE_TREE_ROLE";

    #[cfg(windows)]
    // The descendant is intentionally left for the launcher's kill token.
    #[allow(clippy::zombie_processes)]
    #[test]
    fn process_tree_fixture() {
        use std::io::Write;
        use std::process::{Command, Stdio};
        use std::time::{Duration, Instant};
        let Some(role) = std::env::var_os(TREE_ROLE) else { return };
        if role == "grandchild" {
            std::fs::write("grandchild.ready", b"ready").unwrap();
            std::thread::sleep(Duration::from_secs(120));
            return;
        }
        assert_eq!(role, "parent");
        std::fs::write("leader.pid", std::process::id().to_string()).unwrap();
        let mut command = Command::new(std::env::current_exe().unwrap());
        ide_core::process::prepare(&mut command);
        let child = command
            .args(["--exact", "native::claude::cli::tests::process_tree_fixture", "--nocapture"])
            .env(TREE_ROLE, "grandchild")
            .stdin(Stdio::null())
            .spawn()
            .unwrap();
        std::fs::write("grandchild.pid", child.id().to_string()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !std::path::Path::new("grandchild.ready").exists() {
            assert!(Instant::now() < deadline, "grandchild startup timeout");
            std::thread::sleep(Duration::from_millis(10));
        }
        println!("ready {}", child.id());
        std::io::stdout().flush().unwrap();
        let mut line = String::new();
        std::io::stdin().read_line(&mut line).unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn process_tree_kill_token_ends_descendants_and_releases_cwd() {
        use ide_core::process_tree::{is_process_in_job, terminate_pid, wait_for_pid_exit};
        use std::time::Duration;
        use tokio::io::{AsyncBufReadExt, AsyncReadExt};
        struct Owned(tempfile::TempDir, Vec<u32>);
        impl Drop for Owned {
            fn drop(&mut self) {
                for file in ["grandchild.pid", "leader.pid"] {
                    if let Some(pid) =
                        std::fs::read_to_string(self.0.path().join(file)).ok().and_then(|s| s.parse::<u32>().ok())
                        && !self.1.contains(&pid)
                    {
                        self.1.push(pid);
                    }
                }
                for pid in self.1.iter().rev() {
                    let _ = terminate_pid(*pid);
                    eprintln!(
                        "PROCESS_TREE_T4 teardown pid={pid} gone={:?}",
                        wait_for_pid_exit(*pid, Duration::from_secs(5))
                    );
                }
            }
        }
        let mut owned = Owned(tempfile::tempdir().unwrap(), Vec::new());
        eprintln!("PROCESS_TREE_T4 in_job={}", is_process_in_job(std::process::id()).unwrap());
        let launch = Launch {
            program: std::env::current_exe().unwrap().to_str().unwrap().into(),
            args: vec![
                "--exact".into(),
                "native::claude::cli::tests::process_tree_fixture".into(),
                "--nocapture".into(),
            ],
            cwd: owned.0.path().into(),
            env: vec![(TREE_ROLE.into(), "parent".into())],
        };
        let CliIo { stdin: _stdin, stdout, kill } = Process.launch(&launch, Arc::new(|_| {})).unwrap();
        let mut reader = tokio::io::BufReader::new(stdout);
        let grandchild = tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let mut line = String::new();
                assert!(reader.read_line(&mut line).await.unwrap() > 0, "fixture ended before ready");
                if let Some(pid) = line.trim().strip_prefix("ready ").and_then(|v| v.parse::<u32>().ok()) {
                    break pid;
                }
            }
        })
        .await
        .expect("fixture readiness timeout");
        let leader = std::fs::read_to_string(owned.0.path().join("leader.pid")).unwrap();
        owned.1.extend([leader.parse::<u32>().unwrap(), grandchild]);
        eprintln!("PROCESS_TREE_T4 leader={leader} grandchild={grandchild}");
        assert!(!wait_for_pid_exit(grandchild, Duration::from_millis(100)).unwrap(), "fixture exited before kill");
        kill.cancel();
        let mut tail = Vec::new();
        let eof =
            matches!(tokio::time::timeout(Duration::from_secs(5), reader.read_to_end(&mut tail)).await, Ok(Ok(_)));
        let gone = wait_for_pid_exit(grandchild, Duration::from_secs(5)).unwrap();
        let removed = std::fs::remove_dir_all(owned.0.path());
        eprintln!("PROCESS_TREE_T4 eof={eof} grandchild_gone={gone} cwd_removable={removed:?}");
        assert!(eof && gone && removed.is_ok(), "native Claude left its descendant or locked cwd");
    }
}
