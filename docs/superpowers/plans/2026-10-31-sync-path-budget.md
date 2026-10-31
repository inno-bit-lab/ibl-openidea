# PATH budget tranche: implementation plan (upstream sync v0.3.0)

> **For agentic workers:** you are `dev-codex` in Crew team `ibl-openidea`; `rev-claude` reviews (it also wrote the design). Steps use checkbox (`- [ ]`) syntax. Only one agent runs cargo at a time. Report to `pilot-bridge` with `crew send`, never in your chat.

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
- **e.** On Windows only, one `tracing::warn` is logged when a composed child `PATH` exceeds 8,191 characters.

`environment.rs` and `src-tauri` need no change. If a signature has to change in `src-tauri/src/lib.rs`, stop and ask.

## 4. Closed allowlist

- `crates/ide-tools/src/lib.rs`, `crates/ide-tools/src/tests.rs`, plus a new `crates/ide-tools/tests/` file for the Windows cmd fixture.
- `crates/ide-core/src/tool_path.rs`, plus the `mod`/`pub use` line in `crates/ide-core/src/lib.rs` if the static needs one, plus a new `crates/ide-core/tests/` file for the process-global freshness test.
- `docs/superpowers/**`.

Anything else (`ide-host`, `ide-lsp`, `ide-dap`, `ide-terminal`, `src-tauri`, `ide-jsonrpc`, `Cargo.lock` beyond what cargo itself writes): ask first.

## 5. Ordered tasks

### Task 0: Bootstrap

- [ ] Clean tree; `git fetch origin`; `git switch -c port/path-budget origin/port/v0.3.0` (SHA from the dispatch). Check `git config --worktree core.autocrlf` prints `false`. After any `pnpm install`, `.git\hooks\pre-commit` must not exist.

### Task 1: Existing-only candidates (a, b), tests first

- [ ] In `ide-tools` tests, with a tempdir root:
  - `extend_path_adds_nothing_when_no_tool_is_installed`: output equals input.
  - `extend_path_adds_only_installed_tool_dirs`: 1 installed gives exactly 1 entry.
  - `extend_path_is_idempotent`: a second pass adds nothing.
  - `tools_child_path_holds_only_existing_candidates`: extend the Env fixture, tests.rs:20-30.
- [ ] Run them and see them fail; implement a and b; they pass. Commit.

### Task 2: Freshness without restart (c)

- [ ] New `ide-core` test binary (process-global static, as `ide-host/tests/remote_env.rs` does), `search_path_finds_a_tool_installed_after_startup`:
  - register the candidates; `search_path()` lacks `<root>/gopls/bin`;
  - create that directory; the next `search_path()` has it exactly once, ahead of the process `PATH`.
- [ ] Red, implement c, green. Commit.

### Task 3: Windows fallbacks and the warning (d, e)

- [ ] `#[cfg(windows)]` tests:
  - absent home fallbacks are dropped by the `search_path()` wrapper;
  - an over-limit composed `PATH` logs one `warn` (capture with the existing tracing test helper, or assert the predicate function).
- [ ] Implement d and e. Commit.

### Task 4: Windows cmd fixture

- [ ] New `#[cfg(windows)]` integration test: `outer.cmd` calls `helper.cmd`, which sits in the last `PATH` entry, with no node involved.
  - Positive case: the `PATH` composed by production code from a base of about 7,000 characters plus the 36 candidates, 1 of them existing. Exit code 0.
  - Negative control: padded past 8,191 characters, `helper` is not found.
- [ ] If the negative control behaves differently on windows-latest in CI, keep only the length assertion and say so in the delivery. Commit.

### Task 5: Gates

- [ ] Run Section 6. Fix only within the allowlist.

### Task 6: Real check (C4 with a real user PATH)

- [ ] Start the already-built dev app directly with the plain user `PATH`: your shell `PATH`, without `env.ps1` and without cargo additions. Record:
  1. the `run_system_env` `PATH` length, which must be shell `PATH` + existing managed directories and below 8,191;
  2. native Codex (`codex.cmd`) starting from the app;
  3. Pi (npx) starting from the app;
  4. if a managed npm language server is installed, that it starts (otherwise NOT_VERIFIED);
  5. a tool installed from Settings after startup, used on the next spawn through path A, without a restart.

  Keep the evidence (JSON, screenshots) under `target/local/evidence/path-budget`.

### Task 7: PR

- [ ] Push `port/path-budget`, open a PR into `port/v0.3.0` titled "PATH budget on Windows (v0.3.0 C4)", dispatch `gh workflow run ci.yml --repo inno-bit-lab/ibl-openidea --ref port/path-budget`, and send the delivery report (`tipo=res`).

## 6. Verification (exact commands)

All cargo commands go through `pwsh -NoProfile -File scripts/local/cargo-slot.ps1 -- cargo ...`, in the foreground, with `$env:CARGO_TARGET_DIR` set to the worktree target and `$env:CARGO_PROFILE_DEV_DEBUG = 'line-tables-only'`.

```powershell
cargo test -p ide-tools
cargo test -p ide-core
cargo test -p ide-host --test remote_env
cargo clippy -p ide-tools -p ide-core -p ide-host --all-targets -- -D warnings
cargo fmt --all --check
cargo test -p openidea --test export_bindings ; git diff --exit-code src/bindings.ts
```

`remote_env.rs`, `bin_dirs_cover_every_managed_layout` and `search_dirs_*` must pass unchanged. Run the git-dependent tests with `GIT_CONFIG_GLOBAL` pointing to a temporary file with `core.autocrlf=false`, as before.

## 7. Definition of Done

- Fixes a to e are implemented as designed; there is no `set_var` after startup.
- Every Task 1-4 test was observed failing before the fix (red output kept) and passes after.
- The Section 6 commands pass and CI is green.
- The Task 6 evidence is recorded.
- The PR is open, and the delivery lists the allowlist files touched.

## 8. Acceptance criteria and their verification

| Criterion | Verification |
|---|---|
| P1. App `PATH` with a plain 4,586-character user `PATH` is below 8,191 and equals user `PATH` + existing managed directories | Task 6 item 1 |
| P2. Native Codex and Pi start from the app with the plain user `PATH` (C4) | Task 6 items 2-3 |
| P3. A tool installed after startup is found on the next path A spawn without a restart | Task 2 test + Task 6 item 5 |
| P4. `openidea-server` and Unix behaviour unchanged | `remote_env.rs` and `search_dirs_*` green |
| P5. cmd shim works below the limit and fails above it on Windows | Task 4 fixture (or the length assertion, as noted) |
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
