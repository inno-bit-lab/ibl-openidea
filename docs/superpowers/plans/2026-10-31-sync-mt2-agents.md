# MT-2 Agents and Commit-Suggestion Backend Implementation Plan (upstream sync v0.3.0)

> **For agentic workers:** you are `dev-codex` in Crew team `ibl-openidea`; `rev-claude` reviews. Sub-agents are allowed for the TypeScript part; only one agent runs cargo at a time. Steps use checkbox (`- [ ]`) syntax. Report to `pilot-bridge` with `crew send`, never in your chat.

**Goal:** the fork's agent features run on upstream's agent model from #151 (native Claude and Codex drivers, ACP v2 negotiation, ACP Registry): read-only commit-message completion, agent presets with injected instructions, custom arguments and enable/disable, in a slimmed Agents editor tab. Existing users keep their settings, with agent ids and fork-written files migrated, and native drivers are never shadowed.

**Architecture:** upstream's `crates/ide-agent` stays the base. Fork code is added beside it: `complete()` on the shared `Connector`, an extra-args store applied inside `provider::load()`, and an idempotent `provider::migrate_legacy()`. The frontend keeps upstream's registry page (Settings › Tools › Agents) and adds the fork's presets and a slimmed catalog tab.

**Tech Stack:** Rust (`ide-agent`, `ide-host`, `ide-core`, Tauri commands), TypeScript/React (agents feature, settings).

**Spec:** design `docs/superpowers/specs/2026-10-31-upstream-sync-design.md` (binding), port map `docs/superpowers/specs/2026-10-31-upstream-sync-port-map.md` sections 1.3, 2 and risk 1. Read them with `git show origin/fix/release-hardening:docs/superpowers/specs/<file>`.

## Global Constraints

- Worktree `C:\projects\development\IBL\ibl-openidea\.ibl-crew-worktree\dev-codex` (bootstrapped by MT-1: `core.autocrlf=false` and `core.hooksPath` per worktree). Branch `port/mt2-agents` from `origin/port/v0.3.0` after MT-1 has merged; PR into `port/v0.3.0`. Re-check the gate: `git config --worktree core.autocrlf` prints `false`, and `git ls-files --eol` shows no `w/crlf` outside `i/crlf` files.
- Fork sources, read-only: `origin/fix/release-hardening` at the tip given in the dispatch (at least `0d68ad7`), `origin/fix/rh-mt-b` `86e8498` or later (it carries the review fix `7870140`; once PR #3 merges, read the same code from `origin/fix/release-hardening`) (commits `086ac35`, `d0c1de4`, `2da7ff0`).
- Cargo only as `pwsh -NoProfile -File scripts/local/cargo-slot.ps1 -- cargo ...`, foreground, `$env:CARGO_TARGET_DIR = 'C:\projects\development\IBL\ibl-openidea\.ibl-crew-worktree\dev-codex\target'`, `$env:CARGO_PROFILE_DEV_DEBUG = 'line-tables-only'`. No `--release`, no workspace clippy; local gate `cargo clippy -p ide-agent -p ide-host -p ide-core -p openidea --all-targets -- -D warnings`.
- Decisions from the design: built-in `agy`/`pi` and `AGENT_CATALOG_META` are dropped; ids are rewritten `agy` to `antigravity-acp` and `pi` to `pi-acp`; fork-written `codex.toml`/`claude.toml` must not shadow the native drivers; the Agents editor tab is slimmed; agy discovery goes only if Task 6 verifies the registry install on Windows.
- Do not port `managed_agents_dir` (`ide-host` `lib.rs`, `bin/server.rs`, `project.rs`, `src-tauri/src/state.rs`, the `HostConfig` literals in `tests/rpc.rs`), the `ide-tools` PATH additions, `resolve_executable`, `resolve_spawn` or `search_dirs`. Upstream supersedes them (port map section 2).
- `src/bindings.ts` regenerated only. No `it` catalogs. Every new or reworded UI string gets a `text/zh.json` entry; strings of dropped features leave `en.json`, `zh.json` and `text/zh.json`.
- The pre-commit hook rewrites staged files. Conventional commits in English with `Co-Authored-By`. Never push tags or force-push shared branches.
- Reviewers: a worktree with `core.autocrlf=true` gives false `format:check` failures. Run MT-1 plan section 3.1 in the reviewer worktree first, or rely on CI for formatting.
- Report: `crew send pilot-bridge -t info "MT-2 <milestone>: <branch>@<sha> <one line>"` at each task end and at least every 30 minutes; final `crew send pilot-bridge -t res -r <dispatch id> --stdin`.

## Review Focus

1. Saving custom args for `claude`, `codex` or a registry agent never writes or changes `<config>/agents/<id>.toml`, so driver, `[registry]`, name and env survive, and so do registry updates.
2. `complete()` never reaches `known_config()` (lib.rs:117-128, which selects the #444 bypass mode) or `config::add_client_options`; every permission request is refused; the temp cwd is removed on every path.
3. A v0.2.1 profile (`codex.toml` = `npx -y @agentclientprotocol/codex-acp@2.3.0 <extra>`) loads `codex` as the native driver, and the extra args move to `codex-acp`.
4. No migration writes `antigravity-acp.toml` or `pi-acp.toml`: `install_entry` refuses an existing non-registry file with that id (registry.rs:408-413).
5. `suggestAgent`, presets, disabled agents, drafts and stored args that name `agy` or `pi` reach the registry ids.

## 1. Context and goal

Upstream rebuilt agents in #151: `Driver::{Acp, Codex, Claude}`, `RegistryRef`, an atomic `CustomAgent::write`, the registry and native shims. The fork's agent code assumes every agent is an npx ACP adapter, so a text merge would turn native Claude and Codex into ACP agents or break registry agents (port map risk 1).

## 2. Frozen base

`origin/port/v0.3.0` after MT-1's second PR merged; the dispatch gives the SHA. `git switch -C port/mt2-agents origin/port/v0.3.0`.

## 3. Solution design

### 3.1 Extra-args store (deliberate deviation from port map 1.3)

Port map 1.3 says to re-implement `set_custom_args` on upstream's `CustomAgent`. That cannot preserve everything: `CustomAgent` has `deny_unknown_fields` and a required `command` (provider.rs:89-104); `load()` replaces a built-in entirely when a file uses its id (provider.rs:175-176), which freezes the built-in command (the bug `d0c1de4` fixed); and `registry::install`, which is also the update path, writes a fresh `CustomAgent` (registry.rs:382-395, 438-446), which would drop the args. So:

- Store: `<custom_agents_dir>/extra-args.json`, `{"<id>": ["arg", ...]}`, written atomically (tmp + rename). `load()` reads only `*.toml`, so the store is never taken for an agent.
- `provider::load()` appends `extra[id]` to `spec.args` for every spec (built-in native, built-in ACP, registry, custom).
- `provider::set_custom_args(custom_dir, id, args)`: trims, drops empties, removes the entry when empty and the file when the map is empty; `NotFound` for an id `load()` does not know. It never touches a `.toml`.
- `AgentProvider` gains `extra_args: Vec<String>` (model.rs:320), so the UI reads args from `agentProviders()`. The fork's localStorage key `openidea.agents.args.v1` is imported once (Task 4), then removed.

### 3.2 `provider::migrate_legacy(custom_dir, tools_dir)`

Idempotent; called by `AgentManager::with_connector` before `provider::load` (lib.rs:254) and by the no-project path in 3.4. `tools_dir` is `models_file.parent()/tools`, the layout `RegistryPaths::new` uses (registry.rs:43-47, `ide-host` project.rs:399), so `AgentPaths` and `project.rs` stay upstream's. Each change is logged at `info`; replaced files are renamed `<id>.toml.v02` (not loaded, not lost).

| File found | Action |
|---|---|
| `codex.toml`/`claude.toml`, driver ACP, no `[registry]`, command `npx`, args starting with upstream's `codex-acp`/`claude-acp` built-in args (provider.rs:41-53, identical to the fork's v0.2 pins) | Rename to `.v02`. Args after the prefix go to `extra-args.json` under `codex-acp`/`claude-acp`. Non-empty env: also write `codex-acp.toml`/`claude-acp.toml` with that command, prefix and env, unless it exists. |
| MT-B format (`extra_args` field, optional `command`), in case v0.2.2 or v0.2.3 ships it | Parse with a local `LegacyAgent`. Without `command`: move `extra_args` to the store under the mapped id (`codex`/`claude` to `*-acp`, `agy` to `antigravity-acp`, `pi` to `pi-acp`, others unchanged) and rename to `.v02`. With `command`: rewrite as an upstream `CustomAgent` with `args + extra_args`. |
| `agy.toml` (command `agy_acp_server`) or `pi.toml` (`npx -y pi-acp@0.0.34`) | Rename to `.v02`; extras to `antigravity-acp`/`pi-acp` in the store. Never create the registry-id `.toml`. |
| Registry file (`[registry]`) whose absolute `command` lies under another identifier's `agents/tools/<id>/<version>/`, while the same relative path exists under the current `tools_dir` | Rewrite `command` with `CustomAgent::write`. This covers profiles copied by `migrate.rs` from `ai.l0ng.openidea`. |
| Anything else | Untouched. |

### 3.3 `complete()` on upstream's connector

Port `complete`, `Collector`, `restrictive_mode` and `ask` from `rh-mt-b` `crates/ide-agent/src/lib.rs`, with these changes:
- Spawn through `shared.connector`, so `Driver::Codex` and `Driver::Claude` go through the native shims (lib.rs:241-247) and tests use `FakeAgent`.
- Replace the hand-built `"protocolVersion": 1` with `acp::initialize_params(&client_info())` and `acp::Negotiated::from_initialize`, as `probe()` does (lib.rs:675, :704, :719).
- Take modes only from the `session/new` reply. Pick `read-only`, then `read_only`, then `default`. Native Claude offers `default` (native/claude/settings.rs:33) and native Codex `read-only` (native/codex/translate.rs:22). Refuse otherwise with the existing message.
- Keep: cwd is a fresh `ibl-suggest-<uuid>` temp dir, removed on every path; every `session/request_permission` is answered as rejected; text only; not saved as a task.
- `NewAgentTask.instructions` (`#[serde(default)]`, model.rs) is prepended to the first prompt only, as on `rh-mt-b`.

### 3.4 Host ops, commands, settings

- `crates/ide-host/src/ops/agent.rs`: add `set_args` and `complete` (180 s timeout). Keep upstream's `providers` with `registry::mark_updates` (agent.rs:19-21). If Task 5 shows that the Settings window opened from Welcome lists no agents, add a fallback for when `host.project(window)` fails: `migrate_legacy` + `load` from `config_dir/agents`.
- `src-tauri/src/commands/agent.rs`: `agent_set_args`, `agent_complete`; `commands/mod.rs`: register both (MT-3 adds `vcs_ignored` later).
- `CommitSettings.suggest_agent/suggest_model/suggest_thinking/suggest_rules` in `crates/ide-core/src/workflow_settings.rs` and `src/platform/workflowSettings.ts`. On read, `suggestAgent` goes through `legacyAgentId()`.

### 3.5 Frontend

- `model.ts`: `legacyAgentId(id)` (`agy` to `antigravity-acp`, `pi` to `pi-acp`, others unchanged); `PROVIDER_ICONS` keyed by `antigravity-acp` and `pi-acp`; `CATALOG_KIND`/`CATALOG_KEY`.
- `store.ts`: presets, disabled providers, drafts and the history provider pass through `legacyAgentId` on load and are saved back once. `applyPreset`, `presetConfigFor`, `parseCliArgs`, `withInjectedInstructions` and `openCatalog` are kept. `setProviderArgs` calls `agentSetArgs` only.
- `AgentsCatalogEditor.tsx` slimmed: one row per provider from `agentProviders()` with enable/disable, the args field and the preset manager, and a link to `agents.addAgent` for install and update (index.ts:113). No catalog descriptions, install hints or `AGENT_CATALOG_META`.
- `index.ts`: keep upstream's "More Agents…" (`agents.addAgent`); add "Manage Agents…" (slimmed tab) and "Manage Agent Presets…". `AgentsView.tsx`: split New Session button with an agent/preset menu. `HomeEditor.tsx`: preset picker that sends the preset's instructions.
- `src/features/settings/pages/MessageSuggestion.tsx` (new), moved out of the fork's `vcs.tsx`. In upstream's `vcs.tsx` add only its import and one render line.

## 4. Closed allowlist

`crates/ide-agent/src/{provider.rs, lib.rs, model.rs, tests.rs}`, `crates/ide-agent/src/agy.rs` (only if Task 6 keeps the fallback), `crates/ide-core/src/workflow_settings.rs` (suggest fields), `crates/ide-host/src/ops/agent.rs`, `src-tauri/src/commands/agent.rs`, `src-tauri/src/commands/mod.rs` (two registrations), `src/bindings.ts` (regenerated), `src/platform/workflowSettings.ts` and `workflowSettings.test.ts` (suggest fields), `src/features/agents/{index.ts, model.ts, store.ts, AgentsView.tsx, HomeEditor.tsx, Agents.module.css, AgentsCatalogEditor.tsx, AgentsCatalog.module.css, agents.test.ts, composerCommands.test.tsx}`, `src/ui/icons.tsx` (agent icons), `src/ui/openidea/agents/{agy.svg, pi.svg, pi_dark.svg}`, `src/features/settings/pages/{MessageSuggestion.tsx, Workflow.module.css}`, `src/features/settings/pages/vcs.tsx` (import and render line only), agent keys in `src/platform/locales/{en.json, zh.json, text/zh.json}`.

## 5. Ordered tasks

### Task 1: Extra-args store and legacy migration (TDD)

**Files:** `provider.rs` (+ its `mod tests`), `model.rs`.

- [ ] Tests first: `extra_args_apply_to_builtin_native_registry_and_custom_agents`, `set_custom_args_never_writes_agent_files`, `set_custom_args_clears_entry_and_removes_empty_store`, `set_custom_args_rejects_unknown_ids`, `extra_args_survive_a_registry_reinstall` (rewrite the file as `install_entry` does, then load), `migrates_v021_codex_and_claude_overrides_to_native` (`codex` loads with `Driver::Codex`; args under `codex-acp`; `.v02` kept), `migrates_v021_override_with_env_to_an_acp_file`, `migrates_mtb_extra_args_files`, `migrates_agy_and_pi_files_without_creating_registry_files`, `rehomes_registry_commands_copied_from_another_identifier`, `leaves_user_custom_agents_alone`, `migration_is_idempotent`.
- [ ] `cargo test -p ide-agent provider`: fails. Implement 3.1 and 3.2. Passes. Commit.

### Task 2: `complete()` and instructions (TDD)

**Files:** `lib.rs`, `model.rs`, `tests.rs`.

- [ ] Port onto upstream's `FakeAgent` (tests.rs:8) the `rh-mt-b` tests `complete_answers_in_a_throwaway_session_and_refuses_permissions`, `restrictive_mode_prefers_read_only_variants_before_default`, `complete_picks_an_allowlisted_mode`, `complete_refuses_an_agent_with_only_permissive_modes`, `complete_refuses_an_agent_without_modes`, `complete_refuses_when_the_mode_cannot_be_set`, `complete_ignores_a_caller_mode_choice`, `complete_runs_outside_the_project_and_cleans_up`, and the instructions test (rh-mt-b tests.rs:353-387) as `instructions_go_to_the_first_turn_only`.
- [ ] Add `complete_never_selects_the_bypass_mode` (`bypassPermissions` current, `default` offered: `default` is set), `complete_negotiates_with_initialize_params`, `complete_picks_native_claude_and_codex_modes`.
- [ ] Add `#[ignore]` tests modeled on `real_claude_task_in_a_worktree` (tests.rs:605-608): `real_claude_complete_is_read_only`, `real_codex_complete_is_read_only` (env `OPENIDEA_AGENT_E2E=1`).
- [ ] Drop the fork tests superseded by Task 1 (`set_custom_args_persists_and_resets_builtin_and_custom_agents`, `custom_agent_keeps_its_base_args_when_extra_args_change`, `reset_keeps_an_override_without_extra_args`, `builtin_extra_args_do_not_freeze_the_builtin_command`, `v02_builtin_override_is_rewritten_as_extra_args`, `v02_override_with_other_args_stays_explicit`, `custom_agent_without_command_is_skipped_with_a_warning`) and every `codex-acp@2.3.0` assertion on `codex`.
- [ ] `cargo test -p ide-agent`: passes. Commit.

### Task 3: Host ops, commands, settings, bindings

- [ ] Implement 3.4. Add a `validateWorkflow` case in `workflowSettings.test.ts` (`suggestAgent: "agy"` reads as `antigravity-acp`) and a Rust test in `workflow_settings.rs` that the suggest fields default to empty and read from camelCase keys.
- [ ] `cargo test -p openidea --test export_bindings`; commit `src/bindings.ts` with `agentSetArgs`, `agentComplete`, `CommitSettings.suggest*`, `NewAgentTask.instructions` and `AgentProvider.extraArgs`.
- [ ] `cargo test -p ide-host agent` and `cargo test -p ide-core workflow`: pass. Commit.

### Task 4: Frontend

- [ ] Implement 3.5. Tests: `agents.test.ts` (icons by registry ids, `legacyAgentId`, `parseCliArgs`, presets including stored `agy`/`pi` presets, one-time import of `openidea.agents.args.v1`), `composerCommands.test.tsx` (instructions sent apart from the prompt; Manage Agents opens the slimmed tab).
- [ ] Remove catalog-metadata strings from `en.json`, `zh.json` and `text/zh.json`; add zh for new strings.
- [ ] `pnpm exec vitest run src/features/agents src/platform src/features/settings`, `pnpm typecheck`, `pnpm knip`: pass. Commit.

### Task 5: Manual run

- [ ] `pnpm dev:local`: open Settings from Welcome without a project and check the agent list in Message Suggestion (decides the 3.4 fallback). Save args for `codex`: no `codex.toml` appears and `extra-args.json` holds them. With a test profile holding a v0.2.1 `codex.toml`, Codex starts with the native driver. Record the outcome.

### Task 6: agy discovery gate

- [ ] Add `#[cfg(windows)] #[ignore] real_antigravity_registry_install`: a temp `RegistryPaths`, `registry::install(.., "antigravity-acp", ..)`, then assert the file has `[registry]`, its command exists, and `probe("antigravity-acp")` gets an `initialize` reply (a sign-in request counts as started). Run `cargo test -p ide-agent real_antigravity -- --ignored --nocapture`.
- [ ] Passes: drop discovery and record it. Fails: add `agy.rs`, which looks for `agy_acp_server.exe` under `data_local_dir()/<identifier>/acp-agents/antigravity-acp` (identifier = file name of `custom_agents_dir.parent()`, never a literal) and under the current user's `JetBrains/*/acp-agents/antigravity-acp`. `load()` adds it as `antigravity-acp` only while no `antigravity-acp.toml` exists. Port `agy_search_roots_stay_in_the_current_user_dirs` and assert that no root contains `ai.l0ng.openidea`. Commit.

### Task 7: CI green

- [ ] Push; open the PR (`gh pr create --repo inno-bit-lab/ibl-openidea --base port/v0.3.0 --head port/mt2-agents --title "MT-2: agents and commit suggestion on upstream"`); `gh workflow run ci.yml --repo inno-bit-lab/ibl-openidea --ref port/mt2-agents`; batch fixes per run (cold cache); fix inside the allowlist until green.

## 6. Verification (exact commands)

```powershell
pwsh -NoProfile -File scripts/local/cargo-slot.ps1 -- cargo test -p ide-agent
pwsh -NoProfile -File scripts/local/cargo-slot.ps1 -- cargo test -p ide-host agent
pwsh -NoProfile -File scripts/local/cargo-slot.ps1 -- cargo test -p ide-core
pwsh -NoProfile -File scripts/local/cargo-slot.ps1 -- cargo test -p openidea --test export_bindings
pwsh -NoProfile -File scripts/local/cargo-slot.ps1 -- cargo clippy -p ide-agent -p ide-host -p ide-core -p openidea --all-targets -- -D warnings
$env:OPENIDEA_AGENT_E2E = '1'; pwsh -NoProfile -File scripts/local/cargo-slot.ps1 -- cargo test -p ide-agent real_ -- --ignored --nocapture
git diff --exit-code src/bindings.ts
pnpm typecheck; pnpm lint; pnpm format:check; pnpm knip; pnpm exec vitest run src/features/agents src/platform src/features/settings
gh run list --repo inno-bit-lab/ibl-openidea --workflow ci.yml --branch port/mt2-agents -L 1
gh run watch <run id> --repo inno-bit-lab/ibl-openidea --exit-status
```

## 7. Definition of Done

- Tasks 1 to 7 committed on `port/mt2-agents`, PR open into `port/v0.3.0`, dispatched CI green.
- Every test named in Tasks 1 and 2 exists and passes, and was seen failing first.
- Delivery `res` to `pilot-bridge`: base SHA, PR URL, CI run URL, outputs of section 6, the Task 5 record, the Task 6 verdict (discovery dropped or kept, with the test output), the real-CLI results (C4), and NOT_VERIFIED items.

## 8. Acceptance criteria

| Criterion | Verified by |
|---|---|
| Custom args never change agent files and survive registry updates | Task 1 provider tests |
| v0.2.x and MT-B files migrate; native drivers win | migration tests, Task 5 |
| Commit suggestion is read-only with native Claude (`default`) and Codex (`read-only`) and refuses agents without a restrictive mode (C4) | Task 2 tests, `real_*_complete_is_read_only` |
| No bypass mode in the throwaway session | `complete_never_selects_the_bypass_mode` |
| Saved `agy`/`pi` ids reach the registry ids | `agents.test.ts`, `workflowSettings.test.ts` |
| agy is installable on Windows or discovered as a fallback | Task 6 |
| CI green | dispatched run |

## 9. Risks and NOT_VERIFIED

- The real-CLI tests need signed-in `claude` and `codex` on the machine; without them C4 stays NOT_VERIFIED and the coordinator runs it on the owner's PC.
- The registry download in Task 6 needs network access and may need a Google sign-in to probe. A sign-in request counts as a successful start.
- npx-based registry agents on Windows (`npx.cmd` with `@scope/pkg@ver`) depend on upstream's resolution (`ide-core` process.rs:222-246, `ide-jsonrpc` lib.rs:351): check `pi-acp` in Task 5 if npm is present; otherwise NOT_VERIFIED.
- Users who ran Codex or Claude only through the npx adapter, without the `codex` or `claude` CLI on PATH, lose the agent named "Codex" or "Claude Code" after the migration, and `suggestAgent: "codex"` stops working for them. This follows from the binding design decision; their args move to "Codex (ACP)" or "Claude Code (ACP)". Report it for the release notes.
- If MT-B ships in v0.2.2 or v0.2.3 with a different on-disk format than `rh-mt-b` `7c87cd3`, extend the migration table with the shipped format.
