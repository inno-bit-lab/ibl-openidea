# Windows process-tree teardown for agents: design

- **Date**: 2026-10-31
- **Status**: Approved by the coordinator under the owner's delegation, with decisions in section 6.
- **Author**: `rev-claude` (architect role, read-only on `next/v0.3.1` = `2847c42`), report `260F4C`.
- **Release**: v0.3.1 (roadmap section "v0.3.x follow-ups").

## 1. Problem

When the IDE stops an agent on Windows it kills only the leader process. Its children keep running, keep the agent's stdout/stderr open and keep the working directory locked. Two cases were seen in the v0.3.0 sync:

- (a) The Antigravity registry probe kills the PyInstaller parent and leaves the child alive.
- (b) After a native Codex completion, a `git ls-remote` → `git-remote-https` → `sh` → `git-credential-manager` chain stayed alive for more than 17 minutes and kept the throwaway `ibl-suggest-*` directory locked. It came from Codex's plugin-marketplace update check on a private repository.

Reproduced on the owner's PC, Windows 11 26300:

- RED: `cmd.exe /d /c "ping -n 30 127.0.0.1 >nul"` with a temp cwd. `TerminateProcess` on cmd, which is what tokio's `start_kill` does, leaves `ping` and `conhost` alive, and removing the cwd fails.
- GREEN: the same command started with `CREATE_SUSPENDED` and assigned to a new job (`KILL_ON_JOB_CLOSE | BREAKAWAY_OK`; this works even though the calling shell is itself in a job). The thread is resumed through a Toolhelp snapshot, then the job is terminated or closed: both children are gone within 3 s and the cwd is removed. Killing only the leader is not enough: the job must be terminated.
- On rustc 1.99.1, `CommandExt::raw_attribute` (`PROC_THREAD_ATTRIBUTE_JOB_LIST`) and `ChildExt::main_thread_handle` are unstable (E0658), hence suspend plus snapshot resume.

## 2. Where agent processes are spawned and killed

**Spawn:**

- `crates/ide-jsonrpc/src/lib.rs:372-414` `Peer::spawn_framed`: prepare `:386`, `kill_on_drop` `:394`, spawn `:395`, supervise `:412`.
- `supervise` `:419-441`: the kill branch calls `start_kill` `:425` on the leader only; on natural exit there is a bounded drain (`OUTPUT_DRAIN` = 1 s, `:317`, `:431-437`), then `mark_closed` `:439`.
- `Peer::kill` `:697-700` only cancels; the kill itself happens in `supervise`.
- Callers in `crates/ide-agent/src/lib.rs:303-309`:
  - ACP goes through `spawn_framed` `:305`;
  - Codex goes through `native/codex/mod.rs:33-43`, then `spawn_framed` `:41`;
  - Claude goes through `native::claude::connect` `:308`.
- A second spawn site, not shared: `native/claude/cli.rs:96-130` `Process::launch` (prepare `:100`, `kill_on_drop` `:110`, spawn `:111`, kill task `:119-127`).

**Kill, per scope:**

- Probe: `lib.rs:838-901`, `peer.kill()` `:869` (case a).
- `complete()`: `CompletionScope` finish/Drop `:1938-1970`, cwd removal retried for 5 s with a warning at `:1927` (case b).
- Tasks: `:934`, `:962`, `:1000`, `:1198`, `:1702`; native Codex `codex/mod.rs:72-75`; native Claude `cli.rs:122-125` and `claude/mod.rs:815-829`.

**Out of scope:**

- Short-lived `--version` calls.
- Registry installs, which already use `taskkill /T`.
- LSP and DAP (section 6).
- `ide-terminal` (ConPTY), `ide-run` (its own process group plus `taskkill`) and `ide-notebook`, which already uses its own job and fails closed (`kernel/process.rs:245-446`).

## 3. Fix

**a. `ide-core` `process.rs`: new helper (for example `ProcessTree`).**

- `contain(cmd)`: called after `prepare()`. On Windows it sets `CREATE_NO_WINDOW | CREATE_SUSPENDED`; on Unix it does nothing in v0.3.1.
- `adopt(&child)`: called after spawn. It creates a job with `KILL_ON_JOB_CLOSE | BREAKAWAY_OK`, calls `AssignProcessToJobObject`, then resumes every thread of the child PID from a `TH32CS_SNAPTHREAD` snapshot. A suspended child runs no code, so no descendant can exist before the assignment. PID reuse is impossible while the process handle is held.
- Failure rules (every path ends with the process resumed or dead):
  - If the job cannot be created or assigned, log a `warn`, keep `job = None` and still resume the child (fail open: the agent must still start).
  - If no thread was resumed, call `TerminateProcess` and return a spawn error, so a suspended child is never left behind.
- `kill()`: `TerminateJobObject` when there is a job. Otherwise run `taskkill /T /F /PID` off the async thread as a best effort, BEFORE killing the leader.
- Drop: `CloseHandle`. `KILL_ON_JOB_CLOSE` then also covers IDE exit and crash, which today orphan the agents.
- `windows-sys` 0.61 is already a dependency of `ide-core`. Add the features `Win32_System_JobObjects`, `Win32_System_Threading`, `Win32_System_Diagnostics_ToolHelp` (and `Win32_Security` if needed). The expected `Cargo.lock` delta is none.

**b. `ide-jsonrpc`.**

- `spawn_framed` delegates to a private `spawn_inner(.., contain: bool)`. A new `pub Peer::spawn_contained` takes the same parameters. `Peer::spawn` and the LSP path are unchanged.
- `supervise` receives `Option<ProcessTree>`:
  - the kill branch calls `tree.kill()` and then `start_kill`/wait as today;
  - on natural exit it calls `tree.kill()` after the bounded drain and before `mark_closed`.

**c. `ide-agent`.**

- `lib.rs:305` and `codex/mod.rs:41` use `spawn_contained`.
- In `cli.rs` `Process::launch`: contain after prepare, adopt after spawn (an error becomes a spawn error), `tree.kill()` before `start_kill`, drop after wait.

## 4. Tests (Windows, `cfg(windows)`; other platforms compile the no-op)

- **Fixture:** re-exec the test binary with a role env var, as `ide-tools` `path_budget_cmd.rs` does. `role=parent` spawns `role=grandchild` (inherited stdio, temp cwd), prints `ready <gpid>` and blocks on stdin. `role=grandchild` sleeps 120 s. No cmd, ping or python.
- **T1** (`ide-jsonrpc/tests/process_tree.rs`): `spawn_contained(current_exe, ..)`, wait for `ready`, `peer.kill()`. Within 5 s:
  - `closed()` resolves;
  - the grandchild is signaled (`OpenProcess` `SYNCHRONIZE` plus `WaitForSingleObject`);
  - `remove_dir_all(cwd)` succeeds.

  RED first: the same body against today's `spawn_framed` on `2847c42` must fail on the last two.
- **T2:** natural exit. The parent exits right after `ready`; `closed()` resolves within `OUTPUT_DRAIN` plus a margin, and the grandchild is gone.
- **T3:** fault injection through a test seam in the helper.
  - A failed assignment: spawn still succeeds, a `warn` is logged, and kill (the `taskkill` fallback) still ends the grandchild.
  - Zero threads resumed: the child is terminated and spawn returns `Err`.
- **T4:** the same fixture through `cli.rs` `Process::launch` plus its kill token.
- Log `IsProcessInJob` at test start. Teardown only by recorded PID, never by name.
- **Real agents (developer, then owner PC):**
  - the ignored `complete_is_read_only` (native Codex): the `ibl-suggest` cwd is gone within 5 s without the `:1927` warning, and no recorded descendant survives;
  - the Antigravity registry install returns and the PyInstaller child is gone.

## 5. Risks and NOT_VERIFIED

- **Intended behaviour change:** anything an agent starts that does not ask to break away now ends with its connection (task close or kill, IDE exit or crash). Dev servers, watchers and build daemons started by an agent are included. MSBuild node reuse, VBCSCompiler and Gradle daemons started by an agent's build would die with the task. Whether they break away is NOT_VERIFIED; `BREAKAWAY_OK` lets them escape if they do.
- A browser cold-started from inside an agent lives in the job (NOT_VERIFIED; a warm browser hands off).
- **AV/EDR:** `CREATE_SUSPENDED` plus `ResumeThread` is also a hollowing pattern (NOT_VERIFIED on the owner's AV). When `raw_attribute` stabilises, switch to `JOB_LIST` and drop the suspension.
- **Nested jobs:** they work on the owner's PC; on windows-latest they are NOT_VERIFIED (the tests log it). If assignment fails, the behaviour is today's plus a best-effort `taskkill /T`.
- **ConPTY sessions created by agents:** they should inherit the job (NOT_VERIFIED).

## 6. Coordinator decisions

- **(2e) Scope: agents only.** LSP keeps today's behaviour. Containing it would fix orphaned node LSPs behind `.cmd` shims, but would kill a Gradle daemon started by jdtls at every LSP restart. That can be a later step with its own evaluation.
- **(2f) Yes.** `complete()` sets `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never` in its child environment only, so a one-shot completion cannot wait on a credential prompt nobody can answer. Covered by a test that checks the environment of the completion spawn.
- **Unix:** no-op in v0.3.1 (no evidence of the defect there). A process-group variant is a later option.

## 7. Upstream

`ide-jsonrpc/src/lib.rs`, `native/claude/cli.rs`, `ide-core/src/process.rs` and the notebook `kernel/process.rs` are byte-identical to `upstream/main` `06109aae` (v0.1.31), so upstream has the same defect. No existing upstream issue was found. Candidate for an issue with the RED repro, and a PR after the fork fix is green. Separately, an `openai/codex` issue about the plugin-marketplace `git ls-remote` with an interactive credential helper. Opening issues is the owner's decision.
