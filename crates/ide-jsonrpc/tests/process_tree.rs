#![cfg(windows)]

use ide_core::process_tree::{is_process_in_job, terminate_pid, wait_for_pid_exit};
use ide_jsonrpc::{Framing, NoopHandler, Peer};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU64, Ordering},
};
use std::time::{Duration, Instant};

const ROLE: &str = "IBL_JSONRPC_TREE_ROLE";

// The natural-exit fixture must leave its descendant alive for the supervisor.
#[allow(clippy::zombie_processes)]
#[test]
fn fixture() {
    let Some(role) = std::env::var_os(ROLE) else { return };
    if role == "grandchild" {
        std::fs::write("grandchild.ready", b"ready").unwrap();
        std::thread::sleep(Duration::from_secs(120));
        return;
    }
    assert!(role == "parent" || role == "parent-exit");
    let mut command = Command::new(std::env::current_exe().unwrap());
    ide_core::process::prepare(&mut command);
    let child = command
        .args(["--exact", "fixture", "--nocapture"])
        .env(ROLE, "grandchild")
        .stdin(Stdio::null())
        .spawn()
        .unwrap();
    std::fs::write("grandchild.pid", child.id().to_string()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !std::path::Path::new("grandchild.ready").exists() {
        assert!(Instant::now() < deadline, "grandchild did not enter its fixture");
        std::thread::sleep(Duration::from_millis(10));
    }
    println!("ready {}", child.id());
    std::io::stdout().flush().unwrap();
    if role == "parent" {
        let mut line = String::new();
        std::io::stdin().read_line(&mut line).unwrap();
    }
}

struct OwnedFixture {
    cwd: PathBuf,
    pids: Vec<u32>,
}

impl OwnedFixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let cwd = std::env::temp_dir().join(format!(
            "ibl-jsonrpc-tree-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&cwd).unwrap();
        eprintln!("PROCESS_TREE_TEST in_job={} cwd={}", is_process_in_job(std::process::id()).unwrap(), cwd.display());
        Self { cwd, pids: Vec::new() }
    }

    async fn spawn(&mut self, role: &str) -> (Peer, u32) {
        let (send, receive) = tokio::sync::oneshot::channel();
        let send = Mutex::new(Some(send));
        let peer = Peer::spawn_contained(
            std::env::current_exe().unwrap().to_str().unwrap(),
            &["--exact".into(), "fixture".into(), "--nocapture".into()],
            &self.cwd,
            &[(ROLE.into(), role.into())],
            Arc::new(NoopHandler),
            Box::new(move |line| {
                if let Some(pid) = line.strip_prefix("ready ").and_then(|v| v.parse::<u32>().ok())
                    && let Some(send) = send.lock().unwrap().take()
                {
                    let _ = send.send(pid);
                }
            }),
            Framing::Lines,
        )
        .unwrap();
        let leader = peer.pid().unwrap();
        self.pids.push(leader);
        let grandchild =
            tokio::time::timeout(Duration::from_secs(15), receive).await.expect("fixture readiness timeout").unwrap();
        self.pids.push(grandchild);
        eprintln!("PROCESS_TREE_TEST leader={leader} grandchild={grandchild}");
        assert!(!wait_for_pid_exit(grandchild, Duration::from_millis(100)).unwrap(), "fixture exited before teardown");
        (peer, grandchild)
    }
}

impl Drop for OwnedFixture {
    fn drop(&mut self) {
        // The owned parent records this immediately after spawn, even if readiness fails.
        if let Some(pid) =
            std::fs::read_to_string(self.cwd.join("grandchild.pid")).ok().and_then(|s| s.parse::<u32>().ok())
            && !self.pids.contains(&pid)
        {
            self.pids.push(pid);
        }
        for pid in self.pids.iter().rev() {
            let _ = terminate_pid(*pid);
            eprintln!(
                "PROCESS_TREE_TEST teardown pid={pid} gone={:?}",
                wait_for_pid_exit(*pid, Duration::from_secs(5))
            );
        }
        let _ = std::fs::remove_dir_all(&self.cwd);
    }
}

#[tokio::test]
async fn killing_peer_ends_grandchild_and_releases_cwd() {
    let mut fixture = OwnedFixture::new();
    let (peer, grandchild) = fixture.spawn("parent").await;
    peer.kill();
    let closed = tokio::time::timeout(Duration::from_secs(5), peer.closed()).await.is_ok();
    let gone = wait_for_pid_exit(grandchild, Duration::from_secs(5)).unwrap();
    let removed = std::fs::remove_dir_all(&fixture.cwd);
    eprintln!("PROCESS_TREE_T1 closed={closed} grandchild_gone={gone} cwd_removable={removed:?}");
    assert!(closed && gone && removed.is_ok(), "grandchild gone={gone}; cwd removable={removed:?}; closed={closed}");
}

#[tokio::test]
async fn natural_exit_ends_grandchild_after_bounded_output_drain() {
    let mut fixture = OwnedFixture::new();
    let (peer, grandchild) = fixture.spawn("parent-exit").await;
    let started = Instant::now();
    let closed = tokio::time::timeout(Duration::from_secs(5), peer.closed()).await.is_ok();
    let elapsed = started.elapsed();
    let gone = wait_for_pid_exit(grandchild, Duration::from_secs(5)).unwrap();
    let removed = std::fs::remove_dir_all(&fixture.cwd);
    eprintln!("PROCESS_TREE_T2 closed={closed} elapsed={elapsed:?} grandchild_gone={gone} cwd_removable={removed:?}");
    assert!(closed && gone && removed.is_ok(), "natural exit left descendants or a locked cwd");
}
