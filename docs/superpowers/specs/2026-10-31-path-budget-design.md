# PATH budget on Windows: design

- **Date**: 2026-10-31
- **Status**: Approved by the coordinator under the owner's delegation.
- **Author**: `rev-claude` (architect role, read-only on `port/v0.3.0` = `001e560`), report `CEB284`.
- **Part of**: the v0.3.0 sync, section 5a of [`2026-10-31-upstream-sync-design.md`](2026-10-31-upstream-sync-design.md).

## 1. Problem

Measured in MT-2: an app started with a normal user `PATH` of 4,586 characters (103 entries) runs with 8,296 (139 entries). That is over cmd.exe's 8,191-character limit (Microsoft, "Command prompt line string limitation"). Above the limit, a `.cmd` or `.bat` shim no longer finds `node`. This affects the native Codex (`codex.cmd` npm shim), npx agents such as Pi, and npm language servers and installers. With a process-local `PATH` of 5,853 characters the same app starts native Codex. With the user `PATH` it fails.

The cause is `ide_tools::extend_process_path` (src-tauri/src/lib.rs:69, crates/ide-tools/src/lib.rs:158-169). It prepends every managed-tools bin directory, existing or not (36 on Windows), so that tools installed later are found without a restart.

## 2. Where child processes get their PATH

On Windows the only `PATH` writer is the startup `set_var` (src-tauri lib.rs:69 to ide-tools lib.rs:158-164; `server.rs:31` for `openidea-server`). `environment.rs:127` runs only in Reload Environment and only on Unix (`read_login_env_now` returns `Ok(None)` on Windows, shell_env.rs:122).

- **A.** Explicit `PATH` = `ide_core::tool_path::search_path()`: the process `PATH`, the login and user `PATH`, 16 home fallbacks and the shims. Used for:
  - LSP stdio and tcp (ide-lsp launch.rs:78, tcp.rs:96);
  - `ide-sdk` `query_in` (exec.rs:59/141) and apply.rs `path_with`;
  - lookups in ide-run wrap.rs:39, ide-build `program_path` and the Http curl lookup.

  On Windows the fallbacks add 16 entries (574 characters), 13 of them absent.
- **B.** Explicit `PATH` = `Tools.child_path`: the 36 candidates plus `search_path()` (ide-tools lib.rs:421-425, forced in `Tools::command` :461-465). Used for tool installs, `query_version` and detect probes.
- **C.** The child inherits the startup process `PATH`. This covers:
  - ACP agents (ide-agent lib.rs:243 to ide-jsonrpc spawn_framed :384-395) and native Codex (native/codex/mod.rs:40-41);
  - the Claude CLI and terminals (ide-terminal lib.rs:97-108);
  - runs and tasks (ide-run process.rs:664-671, :443-455); `run_system_env` reports this `PATH`;
  - DAP adapters and launches, build, notebook kernels, git, gh, docker;
  - agent registry installs (registry.rs:555/598).
- **D.** Reads `std::env::var_os("PATH")` for lookup only, never for managed tools: provider.rs:190, ide-dap adapter.rs:192, ide-terminal lib.rs:550, ide-sdk java.rs/jdtls.rs, ssh.rs:104. Out of scope.

Every path in A, B and C carries all 36 directories today; A and B add more.

## 3. Fix

There is no `set_var` after startup and no new call site.

- **a.** In `ide-tools`, `extend_process_path` and `path_with_tools` prepend only the candidates that exist (`is_dir`). The startup `set_var` stays where it is, before any thread, and keeps `with_user_path` and the shims. `bin_dirs_in` and `tools_bin_dirs` stay the candidate list, which is still used to keep these directories out of `system_path`.
- **b.** `Tools::with_paths` sets `child_path` to the existing candidates plus the system `PATH`. A `Tools` is built per operation (ide-host ops/tools.rs:26), so it is fresh for each request.
- **c.** Freshness without a restart:
  - `extend_process_path` also stores the candidate list once, in an `ide_core` static. This is data, not an environment variable.
  - On every call, `search_path()` prepends the candidates that exist and are not already present, so managed tools keep precedence.
  - This follows the pattern of ide-dap `managed_dirs` (adapter.rs:174).
- **d.** On Windows only, in the `search_path()` wrapper (not in `search_dirs`, so the Unix fixture tests hold), absent home fallbacks are dropped.
- **e.** On Windows only, one `tracing::warn` is logged when a composed child `PATH` exceeds 8,191 characters. This helps diagnosis; it is not a fix.

`environment.rs` needs no change: `path_with_tools` becomes existing-only, so Reload behaves as before.

**Accepted trade-off.**
- Paths A and B see a tool installed after startup on the next spawn.
- Path C (terminal, runs, agents) sees only the tools that existed at startup, until the app restarts. Today C sees every candidate, including absent ones.
- Managed tools are LSP and DAP binaries, reached through A and through DAP's own scan, so the cost is small. The release notes say that a tool installed from Settings becomes available in the terminal after a restart.

**Alternatives rejected.**
- Injecting the managed `PATH` in `ide_core::process::child_env_changes` for every child. It costs about 36 `stat` calls per lookup and per git spawn, and it changes precedence over a remote `PATH` on `openidea-server`.
- One shim directory for all tools. It needs a new install layout, uninstall and migration; it is a follow-up only if a-d is not enough.
- Removing managed directories from the inherited `PATH`. That breaks the terminal promise in ide-tools lib.rs:153-157.

## 4. Tests

- **ide-tools unit tests** (tempdir root):
  - With 0 tools installed, 0 entries are added and the output equals the input.
  - With 1 tool installed, exactly 1 entry is added.
  - A second pass over the output adds nothing.
- **ide-core**, in a separate test binary because the state is a process-global static, as remote_env.rs does:
  - Register the candidates; `search_path()` has no `<root>/gopls/bin`.
  - Create that directory; the next `search_path()` has it once, ahead of the process `PATH`.
- **ide-tools**: `Tools::with_paths` `child_path` holds only existing candidates (extend the Env fixture, tests.rs:20-30).
- **Windows fixture without node**: `outer.cmd` calls `helper.cmd`, which sits in the last `PATH` entry.
  - Positive case: production code composes the `PATH` from a base of about 7,000 characters and 36 candidates, 1 of them existing. Exit code 0.
  - Negative control: the same `PATH` padded past 8,191 characters, and `helper` is not found.
  - Check the control on windows-latest first. If cmd behaves differently there, keep only the length assertion.
- **Unchanged and green**: remote_env.rs (the openidea-server equivalence), `bin_dirs_cover_every_managed_layout`, `search_dirs_*`.
- **Manual C4**, by the developer and then on the owner's PC:
  - `run_system_env` `PATH` equals the shell `PATH` plus the existing managed directories.
  - Native Codex (`codex.cmd`) and Pi (npx) start from the app.
  - An npm LSP (`.cmd`) starts.
  - A tool installed from Settings starts on the next file open, without a restart.

## 5. Risks and NOT_VERIFIED

- Adding only existing directories shortens `PATH` but does not bound it. Many installed non-npm tools on a long base `PATH` can still cross 8,191, which is why there is 3e.
- The numbers for an installed release are estimates. `%APPDATA%\it.innobitlab.iblopenidea\tools` is 22 characters shorter per entry than the dev root, so 36 candidates take about 2,920 characters. Today any user whose base `PATH` is longer than about 5,270 characters breaks on runs, agents and the terminal.
- NOT_VERIFIED:
  - the npm LSP and npm installer failures (inferred from the code);
  - Pi via npx inside the app;
  - cmd behaviour on the CI runner;
  - C4 on the owner's PC.
- Pre-existing and low: `PATH` equality is case-sensitive on Windows, so a managed directory spelled differently in the user's `PATH` can appear twice.

## 6. Upstream

This is worth an issue now and a PR once the fork tranche passes C4. `upstream/main` has not changed these files since `504d859` (#499, the adjacent Windows user-`PATH` fix), and no existing issue was found. Opening the issue is an external action, so the owner decides.
