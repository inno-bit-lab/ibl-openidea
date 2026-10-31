# Release and hardening (v0.2.2, v0.2.3): design

- **Date**: 2026-10-30
- **Status**: Approved by the coordinator on 2026-10-30, under the owner's delegation ("delego a te le mie scelte fino al mio ritorno"). Decisions taken under that delegation are marked "Delegated decision".
- **Roadmap**: [`2026-10-30-improvement-roadmap.md`](2026-10-30-improvement-roadmap.md), sub-project 1
- **Base**: `main` at `cd6b3a0` (tag `v0.2.1`); work branch `fix/release-hardening`

## 1. Context and goal

v0.2.0 was built and published by hand: Windows only, with no `openidea-server` assets and a Windows-only `latest.json`. GitHub Actions has never run on the fork. The fork also carries security and correctness problems found in the 2026-10-30 audit, and still uses upstream's bundle identifier.

Goal: every release is built by CI with complete assets; the blocking problems are fixed; the fork gets its own identifier without losing user data; and developers, or agents in several harnesses working in parallel, can run and test local builds quickly without releasing.

Delivered as two releases (see the roadmap's release plan):

- **v0.2.2**: CI and pipeline, the fixes, the local development loop.
- **v0.2.3**: new identifier with data migration. It is the riskiest change, so it ships separately and does not hold back the fixes.

## 2. Decisions taken

| Topic | Decision |
|---|---|
| Approach | Harden the current `main` and release from CI; the upstream sync comes afterwards and ports these changes |
| Build matrix | Same as upstream: Windows x64, macOS arm64 and x64, Linux x64, plus 4 `openidea-server` targets. macOS ships unsigned (no Apple certificates) |
| Pipeline validation | Release candidates (`v0.2.2-rc.N`, `v0.2.3-rc.N`): prereleases that the updater ignores |
| Identifier | Change to `it.innobitlab.iblopenidea`, copying existing data on first start, `tools/` included |
| Version history | Tag `v0.2.1` stays without a release; the v0.2.2 notes include the v0.2.1 changes |
| Commits | Separate commits per area, no squash, so the upstream sync can port them per subsystem |
| Local loop | Built for several worktrees and harnesses running at the same time |
| Execution | A few macro tasks, one per harness, each run with that harness's own multi-agent mode; a different harness reviews and consolidates; this Claude Code session coordinates through a bridge session (section 8) |

## 3. Scope

**In scope**: sections 4 to 7.

**Out of scope**:

- The upstream sync and the web IDE (sub-projects 2 and 3).
- Performance items from the audit: full multi-repo graph recomputation, unthrottled selection history, `COMPARE_LIMIT` without paging.
- Apple signing and notarization.
- Refactoring that CI does not require.

## 4. CI and release pipeline (macro task MT-A)

### 4.1 CI baseline

- The owner enables workflows on the fork (Actions tab).
- The first PR from `fix/release-hardening` shows what `ci.yml` rejects: `cargo fmt --check`, `clippy -D warnings`, `nextest` on three OSes, the bindings drift check, the musl server build and the frontend job. Only what CI reports is fixed.

### 4.2 `release.yml`

- Port upstream `f911196` (#176):
  - builds pass `uploadUpdaterJson: false`;
  - a new `updater-manifest` job writes `latest.json` once from the uploaded `.sig` files and fails if a platform is missing;
  - `publish` waits for it.
- The fork's `already_published` guard stays and is added to the new job.
- The rest of the file stays identical to upstream.
- The existing "Notarize DMG" step already skips itself without `APPLE_ID`.

### 4.3 `export_bindings`

The fork changed `export_bindings` (`src-tauri/src/lib.rs`) to log a warning on failure. As a result the test passes, `bindings.ts` stays unchanged, and the drift check is green without checking anything.

Fix:

- `export_bindings` returns a `Result`, and the `export_bindings` test unwraps it, so CI fails when the export fails.
- At app start in debug builds, a failure still only logs a warning.
- The file is still written only when its content changes.

### 4.4 Secrets

- `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` are set (checked 2026-10-30).
- The key must be the pair of the public key in `tauri.conf.json` (key ID `6F488B067990A3BE`); acceptance test A2 checks this.

### 4.5 Release procedure

1. Bump the version in `Cargo.toml` (workspace), `package.json` and `tauri.conf.json`, update `Cargo.lock`, and merge into `main`.
2. Tag `vX.Y.Z-1` and push the tag. The pre-release part is numeric (`0.2.2-1`, not `0.2.2-rc.1`) because the MSI target rejects a non-numeric pre-release; if the tag push does not start `release.yml`, dispatch it with `gh workflow run release.yml -f tag=vX.Y.Z-1`. The chain runs `create-release` (draft), `build` ×4, `server` ×4, `updater-manifest` and `publish`. The existing step already checks that the tag matches `tauri.conf.json`.
3. Run the acceptance tests on the candidate. If they fail, fix and tag `vX.Y.Z-2`.
4. Bump to the final version, tag it, and publish curated release notes.

A failed job leaves the release as a draft: fix it and re-run with `workflow_dispatch` on the same tag. A published release that turns out broken is not deleted; ship the next patch version instead, because the updater only moves forward.

**Release accepted when** `gh release view` lists:

- the NSIS installer and the MSI;
- two DMGs and two `.app.tar.gz` bundles;
- the AppImage, deb and rpm (a release candidate `vX.Y.Z-N` has no rpm: RPM rejects `-` in its version and Tauri 2.12 has no RPM version override, so `release.yml` skips that bundle for pre-release tags);
- a `.sig` for every bundle the updater uses;
- four `openidea-server-*.gz`, each with its `.sha256`;
- a `latest.json` with every platform key.

## 5. Fixes (macro task MT-B)

Each fix starts from a failing test.

### 5.1 Agent discovery

`find_agy_acp_server` (`crates/ide-agent/src/provider.rs:224`) walks every profile under `C:\Users\*` and can start an `agy_acp_server.exe` found in another user's profile.

- Remove the `C:\Users` walk. Search only the current user's managed agents directory, the current user's JetBrains directories, the executable's directory, and `PATH`.
- Replace the hard-coded `ai.l0ng.openidea` (lines 208 and 230) with a new `AgentPaths.managed_agents_dir: Option<PathBuf>`. `HostConfig` carries it; `src-tauri/src/state.rs` sets it to `<local data dir>/<identifier>/acp-agents`; `openidea-server` sets it under its own data directory.
- Test: no candidate path lies outside the current user's home or the executable's directory.

### 5.2 Read-only commit suggestion

`AgentManager::complete` (`crates/ide-agent/src/lib.rs:337`) runs the agent with `cwd = project_root` and never sets a mode. It only refuses permission requests, which does not help when the agent's mode approves everything; the hard-coded default for `agy` is `yolo` (`lib.rs:1334`). The diff in the prompt is untrusted input.

- **Working directory**: a new empty temporary directory, removed when the call ends. The diffs are already in the prompt.
- **Mode, fail closed**:
  - After `session/new`, read the agent's `mode` option.
  - Choose the first value from the allowlist `read-only`, `read_only`, `default`.
  - If the agent reports a mode but none of those values, fail with an error that names the agent and says it cannot run read-only.
  - If the agent reports no mode at all, also fail. Some agents have no permission gate (Pi's ACP adapter, for example), so refusing permission requests protects nothing there.
  - `plan` is left out on purpose: in Claude Code, leaving plan mode is itself a permission request, which would be refused.
- Permission requests are still refused, as today.
- Correct the settings hint in `src/features/settings/pages/vcs.tsx` that says the agent "cannot change files".
- Tests with `FakeAgent`: the mode comes from the allowlist; only permissive modes give an error; no mode gives an error; the cwd is not the project root and is removed afterwards.

> **Delegated decision.** The in-chat design let agents without a mode run, with refused permissions as the only guard. This spec fails closed instead, because some agents have no permission gate. Effect on the built-in agents, based on the hard-coded fallback configuration (`default_known_config`, `crates/ide-agent/src/lib.rs`):
>
> - Still available for commit suggestion: Claude (`default`), Codex (`read-only`), Antigravity (`default`).
> - No longer available: Pi (no mode option, no permission gate) and GitHub Copilot (modes `agent`, `plan`, `autopilot`, none of them allowlisted).
> - Depends on the modes the agent reports at runtime: Gemini CLI, Cursor, OpenCode, Qwen Code, Kimi, Goose, Auggie, Kiro, Mistral Vibe (no fallback configuration).
>
> The error message names the agent and suggests one of the available ones. The owner can revert this on return.

### 5.3 Ignored files in analysis scopes (v0.2.1 regression)

`vcs_status` now calls `status_with_ignored(true)` (`crates/ide-host/src/ops/vcs.rs:18`), and `changedFiles` (`src/features/analysis/scope.ts`) filters out only deleted entries. As a result, the "changed files" scopes of inspections and Code Cleanup include git-ignored files.

- `vcs_status` goes back to `repos.status()`, as upstream.
- A new command `vcs_ignored() -> Vec<FileStatus>` returns only ignored entries. It is registered both as a Tauri command (`src-tauri/src/commands/mod.rs`) and in the RPC dispatcher (`crates/ide-host/src/rpc.rs`, next to `vcs_status`), so remote development serves it too.
- The Commit View calls it only while "Show Ignored" is on and merges the result. The dirwalk of ignored files then runs only when that option needs it.
- `src/bindings.ts` is regenerated (MT-B owns it).
- Tests: `changedFiles` excludes ignored files; the Commit View lists them with the option on.

### 5.4 Batch branch delete

`handleDeleteSelected` (`src/features/vcs/GitLog.tsx:497`) loops over `deleteBranch`. That deletes without confirmation and force-deletes unmerged branches, raising one Restore toast per branch. The multi-repo and remote paths instead ask once per branch.

- With more than one branch selected, show one confirmation listing the branches and marking the remote ones. Then delete without further dialogs. (Delegated decision after the MT-B lint: `Branch` carries no merged flag, so the dialog cannot mark unmerged branches. The post-delete notification keeps reporting discarded unmerged commits, with Restore.) `deleteInRepos` and `deleteRemoteInRepos` get an option to skip their own confirmation for this path.
- Deleting a single branch keeps the IDEA behaviour: no confirmation, with Restore.
- Tests: N selected branches give one dialog; cancelling deletes nothing.

### 5.5 Custom agent arguments

`set_custom_args` (`crates/ide-agent/src/provider.rs:113`) can lose user configuration:

- for a custom agent, `existing.args = cleaned` replaces its base arguments, so a `gemini.toml` with `["--acp"]` breaks;
- on reset, an override that holds only arguments is deleted;
- for built-in agents, the TOML freezes the pinned `npx` package version.

Fix:

- New TOML field `extra_args` (`serde(default)`, omitted when empty), appended after `args` when the agent is spawned.
- `set_custom_args` writes only `extra_args`. Reset clears it and leaves the rest of the file alone.
- The first `set_custom_args` on a file written by v0.2.x moves arguments beyond the built-in's own into `extra_args`.
- Tests: base arguments survive; an override with only arguments survives a reset; a built-in keeps tracking its own pinned version.

### 5.6 Multi-repo cherry-pick

`cherryPick` (`src/features/vcs/operations.tsx:232`) does not pass the repository, and `runGitOperation` (`src/features/vcs/ops.ts:368`) does not accept one. Commits picked from another repository in Compare are therefore applied to the active one.

- Add `GitOperationOptions.repo`, group commits by `c.repo`, and run one operation per repository, sequentially.
- Check during implementation that the backend operation accepts a repository.
- Test: commits from two repositories produce two operations, each on its own repository.

### 5.7 Invariants

- No persisted setting changes format. The only format change is the agent TOML (5.5): a new optional field.
- No existing command changes signature. `vcs_ignored` is a new command.
- The fixes do not touch tenant data, authorization or remote protocols. `vcs_ignored` follows the same routing as the other VCS commands.

## 6. Identifier and data migration (macro task MT-C, v0.2.3)

### 6.1 Identifier

- `identifier`: `it.innobitlab.iblopenidea`.
- `bundle.publisher`: `InnoBitLab S.r.l.`, set explicitly because NSIS otherwise derives the manufacturer from the identifier.
- `mainBinaryName` stays `openidea`.
- `openidea-server` keeps `~/.openidea` and is not affected.

### 6.2 Startup seeding

A new module `src-tauri/src/migrate.rs` exposes a pure function, testable on temporary directories:

```rust
pub struct SeedReport { pub copied: Vec<PathBuf>, pub skipped: Vec<(PathBuf, String)> }
pub fn seed_profile(bases: &[PathBuf], from: &str, to: &str, excludes: &[&str]) -> SeedReport
```

`run()` calls it on its first line, before `logging::init`, `extend_process_path`, the tools root, the JDK root and the WebView, which all use the identifier directory (`src-tauri/src/lib.rs:44-54`).

- **Bases**: `dirs::config_dir()`, `dirs::data_dir()` and `dirs::data_local_dir()`, deduplicated. On Windows the first two are the same.
- **Source identifier**:
  - Release builds always use `ai.l0ng.openidea`.
  - Debug builds use `IBLOPENIDEA_SEED_FROM` when it is set, otherwise nothing is seeded. Section 7 uses this for per-worktree profiles, and it also lets anyone repeat the migration.
- **Runs only** when the target directory is missing in every base and the source directory exists in at least one.
- **Copy, never move**: an installed upstream OpenIDEA keeps using its own directory.
- **Excluded** (rebuilt on demand): `cache`, `index`, `lsp`, `server`, `logs`, `webview-dev`, `webview-*`. Everything else is copied, so unknown user data is not lost.

| Base (Windows) | Copied (measured on 2026-10-30) | Excluded |
|---|---|---|
| `%APPDATA%` | `settings.toml`, `recent.json`, `agents/`, `history/`, `scratches/`, `plugins/`, `tools/` (619 MB) | `cache/` (62 MB), `index/` (71 MB), `lsp/` (1.1 GB), `server/` (156 MB) |
| `%LOCALAPPDATA%` | `acp-agents/` (222 MB), `EBWebView/` (174 MB, holds localStorage) | `logs/`, `webview-dev/` |

- **Locked WebView profile**: `EBWebView` is skipped when `EBWebView/Default/LOCK` is held, which happens when upstream OpenIDEA is running. A one-time notification says that layouts and presets were not carried over, instead of copying a half-written Chromium profile.
- **macOS and Linux**: config and data directories are copied; WebKit storage is not. No IBLOpenIdea release has existed on those platforms.
- **Atomicity and retry**:
  - For each base, copy into `<target>.partial`, then rename it.
  - A `.partial` left by a crash is deleted and the copy starts again.
  - `.migrated.json` in the target config directory records the source, the version, and what was copied or skipped. The report goes to the log once logging starts.
  - A copy error never blocks startup.
- **Expected duration**: about 1 GB on this machine. From a few seconds to a few tens of seconds on an SSD, mostly spent on the many small files under `tools/node_modules`. Not measured.

**Refined design.** After the MT-C plan lint, section 3 of `docs/superpowers/plans/2026-10-30-mt-c-identity.md` is the authoritative design for this section, approved by the coordinator under delegation. Where it differs from the description above, the plan wins. It adds:

- a file lock held across the whole run, so concurrent first starts are safe;
- an atomically replaced journal with the participating bases and the report, plus an exhaustive recovery table;
- a `failed` phase written before cleanup;
- bounded rename retries;
- exclusions that apply only at the top level;
- links that are never followed;
- the WebView lock held during the copy, with `LOCK` itself excluded;
- debug seeding only when `IBLOPENIDEA_SEED_FROM` is set;
- a one-time notification tracked in the marker.

### 6.3 Installer upgrade path (not verified)

The v0.2.3 installer has a different manufacturer and identifier, so it may not find the v0.2.0 registry key. It would then install into the default directory, which is the same because `productName` is unchanged, and leave an orphan key behind. Acceptance test B1 checks this.

## 7. Local development loop for parallel multi-harness work (macro task MT-A)

### 7.1 Shared resources that conflict today

| Resource | Today | With two or more worktrees |
|---|---|---|
| Vite port | `1420` fixed, `strictPort` (`vite.config.ts`), `devUrl` hard-wired | the second `tauri dev` fails |
| App data | one identifier for every dev build | shared settings, index and LSP data; `webview-dev` hits `ERROR_BUSY`, so the second instance falls back to `webview-<pid>` with empty localStorage |
| `target/` | per worktree, about 24 GB, built from scratch | disk usage and 15 to 20 minutes per new worktree |
| RAM and CPU | 8 cores, about 32 GB; release profile with full LTO | parallel builds killed by memory pressure; vitest flaky under load |
| MSVC environment | `cargo` picks the VS 18 Insiders linker | LNK1104 in every agent shell |

Checked and not shared: askpass binds an ephemeral port (`crates/ide-ssh/src/askpass.rs:67`); `ide-web` uses a random port.

### 7.2 Design

Scripts live in `scripts/local/` (PowerShell) and are exposed as `pnpm` commands, so every harness runs the same commands. `Cargo.toml` and upstream defaults do not change; overrides go through environment variables and config overlays.

1. **`env.ps1`**: finds Visual Studio 2022 with `vswhere` (version `[17,18)`, C++ tools), imports its `vcvars64` environment, and adds `~/.cargo/bin` to `PATH`. Every other script includes it.
2. **Per-worktree data profile.** `dev:local` runs `tauri dev` with a generated config overlay that sets `identifier` to `it.innobitlab.iblopenidea.dev.<slug>`. The slug is the worktree folder name, sanitised to `[a-z0-9-]`, or `main` for the primary checkout. Settings, data, tools, logs and the WebView follow the identifier, so each worktree is isolated.
   - The script sets `IBLOPENIDEA_SEED_FROM` (default: the installed profile if it exists, otherwise `ai.l0ng.openidea`). Seeding takes effect once MT-C lands (v0.2.3); until then each profile starts empty.
3. **Per-worktree port.** `vite.config.ts` reads `OPENIDEA_DEV_PORT` (default `1420`, as upstream; the HMR port is that value plus one). The script picks a free port that stays stable for the worktree and passes the matching `build.devUrl` in the overlay.
4. **Shared compile cache.** Each worktree keeps its own `target/`, so there is no contention on cargo's lock.
   - When `sccache` is installed, the scripts set `RUSTC_WRAPPER=sccache` and dependencies are shared.
   - `CARGO_PROFILE_DEV_DEBUG=line-tables-only` is the default for a smaller `target/` and faster links; `-FullDebug` turns it off.
5. **Machine-wide build slots.** `cargo-slot.ps1` holds one of K named mutexes (`Local\ibl-openidea-cargo-0` to `-<K-1>`, default K = 2; mutexes rather than a semaphore, because Windows releases a mutex as abandoned when its owner dies and never releases a semaphore) around cargo builds, tests and clippy and around the full vitest run, and sets `CARGO_BUILD_JOBS` to cores / K. Callers beyond K wait instead of exhausting memory. Targeted vitest runs do not take a slot.
6. **Commands in `package.json`**:
   - `dev:local`: per-worktree dev run.
   - `build:local`: local NSIS installer inside a slot, using `--bundles nsis` and an overlay with `createUpdaterArtifacts: false`, so no signing key is needed. It uses a lighter release profile through `CARGO_PROFILE_RELEASE_LTO=thin` and `CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16`, and prints the installer path and size. Owner decision (2026-10-31): release builds run only in CI. On the development laptop (4 cores) a cold local release build took more than two hours under load, so `build:local` is an occasional tool and is not part of any gate. Acceptance tests use installers from CI releases and candidates.
   - `test:rust`: targeted `cargo test` inside a slot.
   - `test:full`: the full vitest suite inside a slot.
7. **Clean-profile testing.** `scripts/local/acceptance.ps1` generates a Windows Sandbox `.wsb` file that maps the installers folder read-only, using an absolute path. Windows Sandbox runs one instance at a time, so clean-profile acceptance tests are serial and run by the integrator.
8. **Documentation for agents.** `docs/development/parallel-local-dev.md` covers the commands, slots, profiles, ports, and the cleanup of `*.dev.*` profiles and of the `target/` of removed worktrees. The repository has no tracked `AGENTS.md`, and `CLAUDE.md` is gitignored. Agents therefore learn the convention through the exact commands in their work plans.

Worktrees follow the Crew rule: `<base>/.ibl-crew-worktree/<name>`, with `.ibl-crew-worktree/` in the repository's `info/exclude`. `node_modules` per worktree is cheap, because pnpm hard-links from its global store.

## 8. Execution model

### 8.1 Roles

- **Coordinator**: this Claude Code session.
  - It writes the macro-task plans, dispatches them, tracks deliveries and reports to the owner.
  - It does not implement, and it does not talk to Crew members directly.
- **Bridge**: a separate Claude Code session that is part of the Crew team.
  - The coordinator and the bridge exchange self-contained messages with `SendMessage` across sessions.
  - The bridge relays to and from members with `crew send` (COORD/1) and returns each member's result unchanged.
  - Both sessions need cross-session messaging enabled (section 11).
- **Implementers**: one harness per macro task. Each one works in its own worktree and runs its macro task with its own multi-agent mode:
  - Antigravity in teamwork mode;
  - Claude Code with subagents (multi-agent orchestration is authorised by this spec for that member);
  - Codex with its native parallel agents, if the installed version offers them (NOT_VERIFIED).
  The harness splits the work internally.
- **Reviewers and consolidators**: one per macro task, always on a different harness from its implementer. Each one:
  - reviews the macro-task branch against its plan's Definition of Done;
  - closes the necessary findings itself;
  - merges into `fix/release-hardening`;
  - brings CI to green;
  - runs the acceptance tests of its macro task that do not need the owner.

### 8.2 Macro tasks

| Macro task | Release | Content (from sections 4, 5, 7) | Proposed implementer | Allowlist |
|---|---|---|---|---|
| MT-A Infrastructure | v0.2.2 | CI baseline, `release.yml`, `export_bindings` (section 4); local loop (section 7) | Codex (`dev-codex`) | `.github/workflows/release.yml`, `export_bindings` in `src-tauri/src/lib.rs`, `src-tauri/tests/export_bindings.rs`, `scripts/local/**`, `src-tauri/tauri.local.conf.json`, `vite.config.ts`, `package.json` (scripts only), `docs/development/**`, plus whatever the CI baseline requires (fmt or clippy findings) |
| MT-B Fixes | v0.2.2 | the six fixes of section 5 | Antigravity, teamwork mode (`dev-agy`) | `crates/ide-agent/**`, `crates/ide-vcs/**`, `crates/ide-host/src/{project.rs,lib.rs,rpc.rs,ops/agent.rs,ops/vcs.rs,bin/server.rs}`, `crates/ide-host/tests/**`, `src-tauri/src/state.rs`, `src-tauri/src/commands/**`, `src/features/vcs/**`, `src/features/analysis/**`, `src/features/settings/pages/vcs.tsx`, `src/platform/locales/**`, `src/bindings.ts` |
| MT-C Identity | v0.2.3 | identifier and migration (section 6) | Claude Code (`dev-claude`) | `src-tauri/tauri.conf.json`, `src-tauri/src/migrate.rs`, `run()` in `src-tauri/src/lib.rs`, a test-only dev-dependency in `src-tauri/Cargo.toml` if needed |

**Crew team** (owner's choice, 2026-10-30): team `ibl-openidea`, base folder the repository root, six working members plus the bridge.

| Member | Harness and model | Role |
|---|---|---|
| `pilot-bridge` | Claude, `sonnet` | bridge between the coordinator and the team |
| `dev-agy` | Antigravity, `gemini-4-argon-high` | implements MT-B in teamwork mode |
| `dev-codex` | Codex, `gpt-6.1-sol`, effort `xhigh` | implements MT-A |
| `dev-claude` | Claude, `opus`, effort `xhigh` | implements MT-C |
| `rev-claude` | Claude, `opus`, effort `xhigh` | reviews and consolidates MT-B |
| `rev-agy` | Antigravity, `gemini-4-argon-high` | reviews and consolidates MT-A |
| `rev-codex` | Codex, `gpt-6.1-sol`, effort `xhigh` | reviews and consolidates MT-C |

Reviewers rotate so that no harness reviews its own work. Before dispatch, each reviewer also lints the plan of the macro task it will review.

**Overlaps**:

- MT-A's CI baseline can touch any file that CI flags. When that overlaps MT-B's allowlist, MT-A leaves it and the reviewer reconciles it during consolidation.
- MT-A and MT-C both touch `src-tauri/src/lib.rs`, in different functions. They also land in different releases.

### 8.3 Flow per release

1. The coordinator writes one plan per macro task in the nine-section mandate format (context and goal, frozen base, design, closed allowlist, ordered steps, verification with exact commands, Definition of Done, acceptance criteria, risks with NOT_VERIFIED). The writing-plans step produces them from this spec.
2. The macro task's reviewer lints its plan before dispatch.
3. Through the bridge, the coordinator sends each plan to its implementer. The three implementers work in parallel, each on `fix/rh-<macro-task>` from `fix/release-hardening`, in `<base>/.ibl-crew-worktree/<member>`. MT-C is developed now, but it is consolidated and released only after v0.2.2.
4. Each implementer delivers a frozen SHA, a pushed branch with a green CI run on its PR into `fix/release-hardening`, and the receipts of its own verification commands.
5. The reviewer reviews against the plan's Definition of Done and closes the findings itself, committing on the macro-task branch. It sends work back to the implementer only for a finding that needs a redesign.
6. Consolidation happens one macro task at a time, in the order the coordinator gives, through the macro task's GitHub PR into `fix/release-hardening`. In its own worktree the reviewer checks out the PR branch (`gh pr checkout <n>`), merges `fix/release-hardening` into it when needed, pushes, waits for CI to be green, and merges the PR with `gh pr merge --merge`. No local worktree checks out `fix/release-hardening` except the base folder, which only pulls.
7. The coordinator checks the receipts rather than the authors' claims. It prepares the release candidate commit, but the owner approves the tag before anyone pushes it.

### 8.4 Resource limits during parallel work

Three multi-agent swarms building Rust on one machine (8 cores, about 32 GB) will run out of memory. MT-A therefore delivers `env.ps1` and `cargo-slot.ps1` first, as an early commit merged into `fix/release-hardening`, and the other plans use them from then on. Until then, each implementer runs at most one cargo command at a time, with `CARGO_BUILD_JOBS=2`, and swarm sub-agents do not run cargo in parallel.

## 9. Verification and acceptance

**Per macro task (local):**

- `pnpm typecheck`, `pnpm lint`, and targeted vitest runs.
- `pnpm test:rust` on the crates the macro task touches.
- `cargo test -p ide-agent` has 3 tests that already fail on Windows for environmental reasons (`sh` not on `PATH`; `%TEMP%` under a profile with `~/.claude/skills`). They are reported separately, not as regressions.

**Per macro task (binding):** every `ci.yml` job green on the macro task's PR.

**v0.2.2 acceptance, on `v0.2.2-rc.N`:**

- A1. The candidate has every asset listed in 4.5.
- A2. After the final release, v0.2.0 offers and installs v0.2.2 through "Check for Updates". The signatures in `latest.json` carry key ID `6F488B067990A3BE`.
- A3. Commit suggestion: with `agy` and with Claude the log shows an allowlisted mode and a temporary cwd; an agent with only permissive modes, or with none, returns an error.
- A4. Remote development to a Linux host downloads `openidea-server` from the release and verifies its `.sha256`.
- A5. Two worktrees run `pnpm dev:local` at the same time, each with its own port and profile, with no `ERROR_BUSY`.
- A6 (optional, if a Mac is available). The unsigned DMG opens with the workaround from the release notes.

**v0.2.3 acceptance, on `v0.2.3-rc.N`, in Windows Sandbox:**

- B1. Install v0.2.2, create a preset, change the layout and download a JDK. Then update to the candidate through the real updater: set `OPENIDEA_UPDATE_ENDPOINT` to the candidate's `latest.json` (`https://github.com/inno-bit-lab/ibl-openidea/releases/download/v0.2.3-rc.N/latest.json`) and use "Check for Updates". The override already exists (`src-tauri/src/commands/window.rs:276-279`) and the update is still verified against the compiled public key. Expected: one entry in installed apps, `.migrated.json` present, and preset, layout, JDK and agents all present. Repeat once by running the candidate's installer by hand.
- B2. With upstream OpenIDEA installed, both apps run at the same time, each with its own directories.
- B3. Debug build with `IBLOPENIDEA_SEED_FROM=ai.l0ng.openidea` and no target profile: seeding runs; on the next start it does not.

**Definition of done:** the macro tasks of a release are reviewed and consolidated with CI green, its acceptance tests pass with the evidence recorded in the PR, and the release is published by CI.

## 10. Risks and unverified points

| Item | Status | Mitigation |
|---|---|---|
| NSIS upgrade with a new manufacturer and identifier | NOT_VERIFIED | B1 in Windows Sandbox before v0.2.3 |
| `tauri dev --config` overrides the identifier compiled by `generate_context!` | NOT_VERIFIED | first task of MT-A; fallback: an env-driven identifier suffix in `run()` (debug only) |
| sccache hit rate with MSVC and Tauri | NOT_VERIFIED | measure in MT-A; the loop works without it |
| Time and memory of the thin-LTO local build | NOT_VERIFIED | measure in MT-A |
| CI clippy and fmt findings in fork code | unknown size | first PR measures it; fix only what CI reports |
| Agents' real mode values (`default`, `read-only`) | read from code and adapter documentation, not run | A3 |
| The signing secret matches the committed public key | NOT_VERIFIED | A2 |
| macOS unsigned DMG blocked by Gatekeeper | expected | documented workaround |
| Cross-session messaging between the coordinator and the bridge | NOT_VERIFIED | owner enables it (section 11); a test message both ways before the first dispatch |
| Antigravity teamwork mode and Codex parallel agents on these macro tasks | NOT_VERIFIED | the plan names the harness's own verification commands; the reviewer judges the result, not the process |
| Two swarms exhausting RAM before the build slots exist | likely | section 8.4 |

## 11. Owner actions

- Enable workflows on the fork (Actions tab).
- Confirm that the signing secret is the pair of key `6F488B067990A3BE`.
- Install `sccache` on development machines (optional, machine-level).
- Enable the Windows Sandbox feature (needed for B1 to B3).
- Cross-session messaging between the coordinator and the bridge (delegated decision: the coordinator sets it up and records it in the owner report). According to the Claude Code documentation (`cross-session-messaging`):
  - Sending between sessions on the same machine is on by default from Claude Code v2.1.234 on native Windows.
  - A desktop session holds incoming messages without an approval dialog and drops them after `dialogExpiry` (5 minutes by default) unless `crossSessionInbound` is `accept`. Set it in the user settings (`~/.claude/settings.json`); a project or local `refuse` overrides it.
  - That setting lets any local session start turns in every session of this user. Messages still cannot approve permission prompts or change configuration.
  - Both sessions must run natively on Windows. A WSL 2 session cannot reach a native one.
  - No allow rule is needed for `SendMessage` or `ListAgents`, unless a deny rule blocks them.
- Approve each release tag before it is pushed; tags are public and trigger publishing. Not delegated.
