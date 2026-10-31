# PATH budget tranche: implementation plan (upstream sync v0.3.0)

> **For agentic workers:** you are `dev-codex` in Crew team `ibl-openidea`; `rev-claude` reviews (it also wrote the design). Steps use checkbox (`- [ ]`) syntax. Within your session only one agent (you or a sub-agent) runs cargo at a time; machine-wide, `scripts/local/cargo-slot.ps1` keeps its default shared pool of two slots (the team rule of at most two heavy builds). Report to `pilot-bridge` with `crew send`, never in your chat.

## 1. Context and goal

On Windows the app makes `PATH` too long: a normal user `PATH` of 4,586 characters becomes 8,296 inside the app, over cmd.exe's 8,191-character limit. The cause is that `ide_tools::extend_process_path` prepends all 36 managed-tools bin directories, existing or not. Above the limit, `.cmd` shims cannot find `node`: native Codex, npx agents and npm language servers break, and acceptance C4 of v0.3.0 fails on real machines.

Goal: implement the approved design [`docs/superpowers/specs/2026-10-31-path-budget-design.md`](../specs/2026-10-31-path-budget-design.md), fixes a to e, so the app adds only the managed directories that exist, and tools installed later are still found through `search_path()` without a restart.

## 2. Frozen base

- Worktree `C:\projects\development\IBL\ibl-openidea\.ibl-crew-worktree\dev-codex` (bootstrapped by MT-1: worktree `core.autocrlf=false`, per-worktree hooks).
- Branch `port/path-budget` from `origin/port/v0.3.0` at the SHA given in the dispatch; PR into `port/v0.3.0`. MT-2 (PR #8) touches none of this tranche's files; if it merges first, rebase.
- Upstream frozen at `504d859`; these files are unchanged upstream since then (#499 is the adjacent fix).

## 3. Solution design

As in the design spec, section 3:

- **a.** `extend_process_path` and `path_with_tools` (crates/ide-tools/src/lib.rs:158-169) prepend only the candidates for which `is_dir()` is true. `bin_dirs_in` and `tools_bin_dirs` stay the full candidate list. `set_var` stays at startup only.
- **b.** `Tools::with_paths` (lib.rs:421-425) builds `child_path` from the existing candidates plus the system `PATH`.
- **c.** `extend_process_path` registers the candidate list once in an `ide_core` static (data, not an environment variable). `ide_core::tool_path::search_path()` prepends, on every call, the registered candidates that exist and are not yet present, managed first.
- **d.** On Windows only, the `search_path()` wrapper drops absent home fallbacks. `search_dirs` stays unchanged so the Unix fixture tests hold.
- **e.** On Windows only, a `tracing::warn` is logged when a composed child `PATH` exceeds 8,191 characters. It covers three composers:
  - `extend_process_path` (startup);
  - `Tools::with_paths` (B);
  - `ide_core::tool_path::search_path()` (A).

  "Once" means once per process per composer: a static flag, so a long `PATH` does not flood the log. The message names the composer, the length and the limit.

The fix keeps the managed contribution in a pure helper with injected inputs, for example `prepend_existing(candidates, path) -> OsString`. Tests exercise the managed part without the enrichments the design keeps (`path_with_shims`, ide-tools lib.rs:170; `with_user_path`, :160).

`environment.rs` and `src-tauri` need no change. If a signature has to change in `src-tauri/src/lib.rs`, stop and ask.

## 4. Closed allowlist

- `crates/ide-tools/src/lib.rs`, `crates/ide-tools/src/tests.rs`, plus a new `crates/ide-tools/tests/` file for the Windows cmd fixture.
- `crates/ide-core/src/tool_path.rs` (the candidate static is a `std::sync::OnceLock` there; `tool_path` is already exported, so no new module), plus a new `crates/ide-core/tests/` file for the process-global freshness test.
- `crates/ide-core/Cargo.toml`: only `tracing.workspace = true` in `[dependencies]`, and, for the warning test, the workspace `tracing-subscriber` as a dev-dependency of `ide-core` and/or `ide-tools`, if the workspace already uses it. The `Cargo.lock` delta must be only the new dependency edges of `ide-core`/`ide-tools`, with no new crate downloaded. If a new crate would be needed, stop and ask.
- `Tools::with_paths` keeps its signature, so its test callers in `crates/ide-tools/src/jdk.rs:508` and `:527` need no change.
- `docs/superpowers/**`.

Anything else (`ide-host`, `ide-lsp`, `ide-dap`, `ide-terminal`, `src-tauri`, `ide-jsonrpc`, `Cargo.lock` beyond what cargo itself writes): ask first.

## 5. Ordered tasks

### Task 0: Bootstrap

- [ ] Clean tree; `git fetch origin`; `git switch -c port/path-budget origin/port/v0.3.0` (SHA from the dispatch). Check `git config --worktree core.autocrlf` prints `false`. After any `pnpm install`, `.git\hooks\pre-commit` must not exist.

RED rule for every task: the tests that reproduce the defect must be observed failing on the frozen base, or before the fix, with the log kept. Tests that are already green on the base are baseline controls; label them as such in the delivery (for example idempotency, which lib.rs:173-178 already guarantees).

Hermetic tests: unit tests exercise the managed contribution through the pure helper with injected inputs (candidate list, base `PATH`). They do not go through `path_with_shims` or `with_user_path`, whose output depends on mise/asdf and the user's registry, and they never call `set_var`. The only process-global test is the `ide-core` freshness binary (Task 2), which sets its state before any thread.

### Task 1: Windows cmd fixture on the frozen base (RED control)

- [ ] New `#[cfg(windows)]` integration test in `crates/ide-tools/tests/`: `outer.cmd` calls `helper.cmd`, which sits in the last `PATH` entry, with no node involved.
  - Positive case: a `PATH` under 8,191 characters works.
  - Negative control: the same `PATH` padded past 8,191 characters, and `helper` is not found.
  - Defect case: the `PATH` that the frozen base's composition gives (a base of about 7,000 characters plus the 36 candidates, 1 of them existing) is over the limit and fails. This is RED on the base.
- [ ] Keep `task1-cmd-fixture-base.log`. If the negative control behaves differently on windows-latest in CI, keep only the length assertion and say so. Commit the test, marked `#[ignore]` only if it would break the build before the fix, with the reason in the delivery.

### Task 2: Existing-only candidates (a, b), tests first

- [ ] In `ide-tools` tests, with a tempdir root and the pure helper:
  - `managed_prefix_adds_nothing_when_no_tool_is_installed` (RED on the base, which adds 36 directories);
  - `managed_prefix_adds_only_installed_tool_dirs` (RED);
  - `managed_prefix_is_idempotent` (baseline control);
  - `tools_child_path_holds_only_existing_candidates` (RED; extend the Env fixture, tests.rs:20-30).
- [ ] Red, implement a and b, green. The Task 1 defect case must now pass (log `task2-cmd-fixture-after.log`). Commit.

### Task 3: Freshness without restart (c)

- [ ] New `ide-core` test binary (process-global static, set before any thread, as `ide-host/tests/remote_env.rs` does), `search_path_finds_a_tool_installed_after_startup`:
  - register the candidates; `search_path()` lacks `<root>/gopls/bin`;
  - create that directory; the next `search_path()` has it exactly once, ahead of the process `PATH`.

  It is RED (compile or assert) on the base, which has no registration.
- [ ] Red, implement c, green. Commit.

### Task 4: Windows fallbacks and the warning (d, e)

- [ ] `#[cfg(windows)]` tests:
  - absent home fallbacks are dropped by the `search_path()` wrapper (RED on the base);
  - an over-limit composition emits exactly one `warn` per composer per process, at WARN level, naming composer and length. Capture it with a real subscriber (the workspace `tracing-subscriber` test writer), not only the predicate. The test is RED on the base.
- [ ] Red, implement d and e, green. Commit.

### Task 5: Gates

- [ ] Run Section 6. Fix only within the allowlist.

### Task 6: Real check (developer C4 with a real user PATH)

- [ ] Build the desktop binary from the candidate commit first, so C4 does not run an exe built before the fix. Run `pwsh -NoProfile -File scripts/local/cargo-slot.ps1 -- cargo build -p openidea --no-default-features`, with the same `TAURI_CONFIG` that `scripts/local/dev.ps1` sets for the prebuild (or one `pnpm dev:local` run, then quit). Record:
  - the commit SHA;
  - the exe path and its SHA-256;
  - the build log.
- [ ] Start that exe directly, with the Vite listener as in MT-2 Task 5, with the plain user `PATH`: your shell `PATH`, without `env.ps1` and without cargo additions. Record the starting `PATH` length. Then record, separately, the user `PATH` entries and shims added legitimately (`with_user_path`, mise/asdf) and the managed directories added. Then record:
  1. the `run_system_env` `PATH` length, which must be shell `PATH` + existing managed directories and below 8,191;
  2. native Codex (`codex.cmd`) starting from the app;
  3. Pi (npx) starting from the app;
  4. if a managed npm language server is installed, that it starts (otherwise NOT_VERIFIED);
  5. a tool installed from Settings after startup, used on the next spawn through path A, without a restart.

  Keep the evidence (JSON, screenshots) under `target/local/evidence/path-budget`. This is the developer's C4; the owner's C4 on the owner's PC with an installed build stays NOT_VERIFIED in this tranche.

### Task 7: PR

- [ ] Push `port/path-budget`, open a PR into `port/v0.3.0` titled "PATH budget on Windows (v0.3.0 C4)", dispatch `gh workflow run ci.yml --repo inno-bit-lab/ibl-openidea --ref port/path-budget`, and send the delivery report (`tipo=res`).

## 6. Verification (exact commands)

All cargo commands go through `pwsh -NoProfile -File scripts/local/cargo-slot.ps1 -- cargo ...`, in the foreground, with `$env:CARGO_TARGET_DIR` set to the worktree target and `$env:CARGO_PROFILE_DEV_DEBUG = 'line-tables-only'`.

Run each command on its own and check its exit code (`$LASTEXITCODE`, including the wrapper's) before the next. Never chain with `;`, which would hide a failure behind the last command's exit code.

```powershell
cargo test -p ide-tools
cargo test -p ide-core
cargo test -p ide-host --test remote_env
cargo clippy -p ide-tools -p ide-core -p ide-host --all-targets -- -D warnings
cargo fmt --all --check
cargo test -p openidea --test export_bindings
git diff --exit-code src/bindings.ts
```

`remote_env.rs` (`#![cfg(unix)]`) and `search_dirs_put_the_process_path_first_and_shims_after_real_tools` (`cfg(unix)`) run zero tests on Windows. A local exit 0 does not qualify P4. P4 is qualified only by those named tests passing in the CI Ubuntu and macOS jobs; report them from the job logs. `bin_dirs_cover_every_managed_layout` must pass unchanged on every OS. Run the git-dependent tests with `GIT_CONFIG_GLOBAL` pointing to a temporary file with `core.autocrlf=false`, as before.

## 7. Definition of Done

- Fixes a to e are implemented as designed; there is no `set_var` after startup.
- Every defect-reproducing test of Tasks 1-4 was observed RED on the base or before its fix (logs kept) and passes after; baseline controls are labelled as such.
- The Section 6 commands pass and CI is green.
- The Task 6 evidence is recorded.
- The PR is open, and the delivery lists the allowlist files touched.

## 8. Acceptance criteria and their verification

| Criterion | Verification |
|---|---|
| P1. App `PATH` with a plain 4,586-character user `PATH` is below 8,191 and equals user `PATH` + existing managed directories | Task 6 item 1 |
| P2. Native Codex and Pi start from the app with the plain user `PATH` (C4) | Task 6 items 2-3 |
| P3. A tool installed after startup is found on the next path A spawn without a restart | Task 3 test + Task 6 item 5 |
| P4. `openidea-server` and Unix behaviour unchanged | `remote_env.rs` and `search_dirs_*` green in the CI Ubuntu and macOS jobs (named in the delivery) |
| P5. cmd shim works below the limit and fails above it on Windows | Task 1 fixture, RED on the base and green after Task 2 (or the length assertion, as noted) |
| P6. CI green on every job | the dispatched run |

## 9. Risks and NOT_VERIFIED

- Adding only existing directories does not bound the `PATH`; a long base `PATH` plus many installed non-npm tools can still cross 8,191. The warning in e makes this visible.
- Path C (terminal, runs, agents) sees tools installed after startup only after a restart. This is accepted and goes in the release notes.
- NOT_VERIFIED until shown:
  - cmd behaviour on the CI runner;
  - npm language-server startup, if none is installed;
  - C4 on the owner's PC, which the coordinator runs with the owner.
- Pre-existing: on Windows, `PATH` entry comparison is case-sensitive, so a managed directory spelled differently in the user's `PATH` can appear twice. Out of scope.
- Upstream issue/PR: an external action the owner decides; not part of this tranche.
