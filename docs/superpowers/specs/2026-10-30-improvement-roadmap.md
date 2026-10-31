# IBLOpenIdea improvement roadmap

- **Date**: 2026-10-30, updated 2026-10-31
- **Status**: Sub-projects 1 and 2 are implemented and merged, and their release candidates are published. The final tags wait for the owner's acceptance tests. Sub-project 3 has not started.
- **Inputs**: [`docs/intents/2026-10-30-browser-web-ide.md`](../../intents/2026-10-30-browser-web-ide.md), [`docs/upstream-sync.md`](../../upstream-sync.md), the state audit of 2026-10-30 (below)

## Progress on 2026-10-31

| Release | Where the code is | Candidate | Left before the final tag |
|---|---|---|---|
| v0.2.2 | MT-A (#2) and MT-B (#3) merged; `main` = `3ef089a` | `v0.2.2-2`, published as a prerelease; A1 passed | Nothing: A3 and A4 passed on the owner's PC and A5 in the team's run, on 2026-10-31 |
| v0.2.3 | MT-C (#4) merged into `fix/release-hardening` | `v0.2.3-2`, published as a prerelease; A1 passed | B1 under way on the owner's PC (update installed, profile copied), then B2; B3 passed |
| v0.3.0 | `port/v0.3.0` = `2847c42` (PRs #5 to #12), integrated CI green; `port/release-v0.3.0` = `904af48` | `v0.3.0-1`, published as a prerelease; C1 and C2 passed | C3, C4 and C5 on the owner's PC |
| v0.3.1 | Under way on `next/v0.3.1`: small fixes (#13) merged, process-tree teardown (#14) in review, upstream tranches MT-1 to MT-7 planned and MT-1 in development (section "v0.3.x follow-ups") | none | All of it |
| v0.4 to v0.6 | Not started | none | A design session with the owner |

`releases/latest` is still `v0.2.1`, so the updater does not offer the candidates to anyone.

**Order of the final tags**: v0.2.2, then v0.2.3, then v0.3.0. `main` stays on the 0.2.x line until v0.2.3 is final. After that, `port/release-v0.3.0` gets a `-s ours` merge of the new `main`, and `main` is fast-forwarded to it.

**What changed from the plan**:

- **Signing key.** The password of the original updater key was not available, so the key was replaced on 2026-10-31 (new key ID `A31A0E471F28FEEC`). Installs of 0.2.0 and 0.2.1 trust the old key: they must install 0.2.2 or later by hand once. Acceptance A2 was changed to match.
- **Candidate names.** Candidates are numeric (`v0.2.2-2`, `v0.3.0-1`) because the MSI target rejects `rc.N`. They ship no rpm, because RPM rejects `-` in a version; the final releases have it.
- **Team.** Codex and Claude Code were the developers. Antigravity reviewed only, by the owner's decision. Every member ran over ACP.
- **Extra tranches in the sync.** MT-2 surfaced two problems that got their own PRs: a fail-closed hardening of the read-only commit suggestion (#10), and a Windows `PATH` budget (#11). Without #11, an app started with a normal user `PATH` went past cmd's 8,191-character limit, and native Codex, npx agents and npm language servers did not start.

## State on 2026-10-30

Checked against the repository, GitHub and a local test run on that date:

- The fork is two squash commits on `5b63a2b` (upstream `v0.1.21`): `cbae657` (v0.2.0) and `cd6b3a0` (v0.2.1).
- v0.2.0 is the published "Latest" release, built locally: Windows NSIS installer, its `.sig` and a Windows-only `latest.json`. Tag `v0.2.1` is on `origin` without a release.
- GitHub Actions has never run on the fork, so the macOS, Linux and `openidea-server-*.gz` assets have never been built. Remote development downloads the server from the fork's releases (`crates/ide-tools/src/server.rs`), so it currently gets a 404.
- The bundle identifier is still `ai.l0ng.openidea`, shared with any upstream OpenIDEA installed on the same machine.
- Upstream is 201 commits ahead (`98c8c55`, v0.1.28+). A dry-run merge (`git merge-tree`) reports 52 conflicting files.
- Frontend: `pnpm typecheck` and `pnpm lint` pass. Vitest: 2584 of 2588 tests pass, and the 4 failures are not fork changes (three are flaky under load, one is a CRLF artifact of `core.autocrlf=true`). Rust was not built or tested locally.
- Security and correctness problems that block the next release are listed in the sub-project 1 spec.

## Sub-projects

Three independent pieces of work, each with its own spec, plan and implementation cycle.

| # | Sub-project | Outcome | Spec |
|---|---|---|---|
| 1 | Release and hardening | CI green on the fork, complete release assets, blocking fixes, new identifier with migration, a fast local loop for parallel development; shipped by CI as v0.2.2 and v0.2.3 | [`2026-10-30-release-hardening-design.md`](2026-10-30-release-hardening-design.md) |
| 2 | Upstream sync | The fork rebuilt on current upstream, released as v0.3.0 | [`2026-10-31-upstream-sync-design.md`](2026-10-31-upstream-sync-design.md), with the [port map](2026-10-31-upstream-sync-port-map.md) and the [`PATH` budget design](2026-10-31-path-budget-design.md) |
| 3 | Remote web IDE | Per-user `openidea-server` instances on a shared host, used from the browser and from the desktop app | to write |

### Order and dependencies

1 → 2 → 3.

- Sub-project 2 needs the working CI from 1: its verification gate runs in CI, and it ports the fixes from 1 instead of the unfixed code.
- Sub-project 3 builds on the synced code. It changes `crates/ide-host` and `src/platform`, which upstream changes often, so building it before the sync would add conflicts.

## Release plan

A release ships as soon as a coherent set of features is consolidated, rather than at the end of each sub-project. "Consolidated" means:

- every unit in the set is merged into `main` with CI green;
- the acceptance tests for that set pass on a release candidate;
- the team has used the candidate and no blocking defect is open. The owner decides when that point is reached.

| Release | Content | Sub-project |
|---|---|---|
| v0.2.2 | CI working on the fork; release pipeline with every platform, the `openidea-server` assets and one `latest.json`; the blocking fixes (agent discovery, read-only commit suggestion, ignored files out of analysis scopes, single confirmation for batch branch delete, custom agent arguments, multi-repo cherry-pick); the local loop for parallel development | 1 |
| v0.2.3 | New bundle identifier with migration of existing data | 1 |
| v0.3.0 | Fork rebuilt on current upstream | 2 |
| v0.3.x | Periodic re-syncs with upstream, when upstream ships fixes or features worth taking | 2 |
| v0.4.0 | Web IDE phase 1 (proposed): `openidea-server --http` with a browser client, one user, token authentication | 3 |
| v0.5.0 | Web IDE phase 2 (proposed): the desktop app over WebSocket, first batch of latency work | 3 |
| v0.6.0 | Web IDE phase 3 (proposed): gateway for many users on a shared host (authentication, per-user instances, isolation, packaging) | 3 |

The sub-project 3 phases are a proposal; its spec confirms or changes them.

**Rules**:

- Every release goes through one or more candidates (`vX.Y.Z-N`, numeric, because the MSI target rejects `rc.N`). GitHub marks them as prereleases, and the updater ignores them because it reads `releases/latest`. The team installs candidates by hand.
- Pushing a tag starts the release workflow. Do not also dispatch it for the same tag: the second run waits for the first and then skips.
- Patch releases (`vX.Y.Z+1`) carry fixes at any time and do not wait for the next feature set.
- `main` stays releasable. Unfinished work stays on its branch, or is merged behind a setting that is off by default.
- Each release has curated release notes, including what changed for existing users (for example the data migration in v0.2.3).

## Sub-project 2: upstream sync (v0.3.0)

**Approach** (from `docs/upstream-sync.md`): create a branch from `upstream/main` and port the fork onto it subsystem by subsystem, rather than merging 201 upstream commits into the fork. The subsystems are identity and release, agents, VCS, and Italian locale. The sub-project 1 commits are separate per area so they can be ported the same way.

**Decided: how the result reaches `main`.** A branch built from `upstream/main` cannot be merged into the current `main` with a normal merge without bringing back every conflict. The port is merged with `-s ours` and `main` is fast-forwarded: history is kept, the merge commit records the switch, and the `v0.2.x` tags stay ancestors. Resetting `main` with a force-push was rejected. The details are in the [sync design](2026-10-31-upstream-sync-design.md).

**Corrections to `docs/upstream-sync.md`** (checked against the repository on 2026-10-30):

- It does not say how the sync branch lands on `main` (see above).
- It lists `src/features/help/{updater.ts,AboutDialog.tsx}`. That folder does not exist in the fork; `AboutDialog.tsx` is in `src/features/app/`.
- The commit-suggestion settings are `suggest_agent`, `suggest_model`, `suggest_thinking` and `suggest_rules`, not `agent`/`model`/`effort`.
- "Push tag v0.3.0 and let GitHub Actions publish" assumes a working CI on the fork. Sub-project 1 provides it.
- The port should carry the sub-project 1 fixes. Copying the v0.2.1 code as it is would bring back the blocking problems.

**Parallel work**: the four subsystem ports touch disjoint areas and can run as parallel units, following the conventions in sub-project 1 (section "Local development loop").

### v0.3.x follow-ups

Collected during the sync, none of them blocking v0.3.0:

- **Windows process-tree teardown.** When an agent probe or a completion ends, the app stops the agent process but not always its children (a PyInstaller child of Antigravity, a `git` and credential-manager chain started by Codex's plugin update check). This needs a design of its own, for example with Job Objects, because it touches how every agent is started.
- **Next upstream sync.** The port is frozen at upstream `504d859`. Upstream has moved on (`c5cb217c` on 2026-10-31).
- **Small fixes.** `src/features/github/diff/reviewDiff.test.tsx:219` fails now and then. The module doc at `crates/ide-tools/src/lib.rs:9-10` still describes the old `PATH` behaviour.
- **Possible upstream contributions**, if the owner wants them: the `PATH` budget fix, the Windows fix to `actionTitles.test.ts`, and the `release.yml` corrections (`includeUpdaterJson`, no rpm for pre-releases). Upstream has the same defects.
- **Crew bugs**, for a session in the Crew repository: composer detection confused by Antigravity's teamwork rows; an ACP member taken for a pane member on retry; panes shrunk when the dashboard is opened from a phone; an ACP member's queue filling up with old messages and blocking new ones. The first four are fixed in gmaldarelli/ibl-crew#101, which waits for the owner's merge.

Status on 2026-10-31: the small fixes (#13) and the process-tree teardown (#14) are merged into `next/v0.3.1`, and MT-1 (#15) is in review. The teardown review left two follow-ups: when no job can be assigned, the natural-exit `taskkill` finds no tree and only logs a warning, so it should be skipped or worded to say that descendants may survive; and `ProcessTree::contain` replaces the creation flags set by `prepare()`, which needs a doc comment or a shared constant.

### Defects found in the owner's tests (2026-10-31)

None of them blocks the final tags. The owner can change that decision. `rev-codex` analysed them on `8727ac7` (v0.2.3-2) and `5e1b50a6` (`next/v0.3.1`).

- **D1, silent first start after the identifier change.** v0.2.3 copies the old profile before it opens any window. On the owner's PC the copy was 18,895 files and 1.23 GB, and the window appeared after about 94 seconds, so the app looked dead and the owner started it a second time. The copy resumed and finished correctly. `next/v0.3.1` has the same code. Fix in v0.3.1, Windows only: a native progress dialog during the copy ([design](2026-10-31-migration-progress-design.md), [plan](../plans/2026-10-31-v0.3.1-migration-progress.md)). Later: the same feedback on macOS and Linux, and a separate decision on skipping WebView caches in the copy, which needs proof that Local Storage (where the agent presets live) is kept.
- **D2, wrong version in Windows "Installed apps".** After the in-app update from 0.2.2-2 to 0.2.3-2 the installed files are 0.2.3-2, but the uninstall entry still shows version 0.2.2-2 and publisher `l0ng`. The installer template writes these values, so the cause is still unknown, and finding it needs an isolated machine. It stays a follow-up.
- **D3, an agent's error text becomes the commit suggestion.** Antigravity could not start an MCP server and replied with the error as plain text, and Suggest put that text in the commit message box. The suggestion code accepts any text the agent returns, on `next/v0.3.1` too. Fix in v0.3.1: Suggest accepts only a structured answer and shows anything else as an error ([plan](../plans/2026-10-31-v0.3.1-suggest-structured-result.md)), after MT-6 because both change `complete()` and `CommitView.tsx`.
- **D4, Pi hides provider errors.** With a provider out of credit, the Pi session ended as "ready" and showed no error. The cause is the `pi-acp` 0.0.34 adapter, which reports a failed prompt as a normal end of turn. It stays a follow-up; an issue to the adapter's authors is the owner's decision.

Other findings from the same tests:

- On v0.2.2 every Suggest left its temporary folder behind, and Antigravity left two processes running. The teardown fix in v0.3.1 covers both.
- On the owner's PC, Antigravity 1.4.5 does not answer the ACP `initialize` within 30 seconds, with or without the teardown fix. It stays a follow-up.
- `cargo test` adds directories to `PATH` until it passes cmd's 8,191-character limit, so the ignored real-agent tests need a runner that restores the normal `PATH`.
- Possible upstream issue: Maven on Windows receives a non-ASCII cache path as `??`, seen in an ignored Tomcat test.

Known limitations for the v0.2.3 and v0.3.0 release notes: the first start after an update from 0.2.2 or earlier copies the settings and can show no window for a minute or two, so the app must not be closed; if the agent answers Suggest with an error, the error text can appear in the commit message box and must be discarded.

## Sub-project 3: remote web IDE

**Goal, as stated by the owner**:

- A remote host runs one `openidea-server` instance per user. One host can serve every user.
- Each user connects from their own machine with a browser or with the desktop app, both over the same WebSocket protocol. For the desktop app this is an alternative to SSH remote development.
- It must feel fast: hiding network latency is a requirement, not a later optimisation.

**What already exists** (checked):

- `ide_host::Host` and `rpc::Dispatcher::standard()` (`crates/ide-host/src/rpc.rs`), with JSON-RPC `initialize`, `commands` and `invoke` and server notifications `event` and `channel`.
- `openidea-server --stdio` for SSH remote development (`crates/ide-host/src/bin/server.rs`).
- Frontend routing below the generated bindings: `setInvokeRoute` (`src/platform/tauriCore.ts`) and `encodeArgs`/`remoteInvoke` (`src/platform/remote.ts`). SSH remote development already sends commands over the network, so part of the frontend already copes with latency.
- About 130 frontend files already branch on `isTauri()`. Upstream added browser fallbacks for remote and browser use (#433).

**What is missing beyond the intent document**:

- A gateway in front of the instances: authentication, routing each user to their instance, starting and stopping instances, isolation between users, TLS termination.
- A desktop transport: the desktop app connects to an instance over WebSocket, next to the existing SSH route.
- Latency work: list the IPC calls on hot paths (typing, cursor moves, hover, completion, git status polling) and reduce round-trips (client-side document state, batching, compression, optimistic updates).
- Packaging for the host (container image or service units).

**Decisions still open**:

- Authentication: company SSO (OIDC) or per-user tokens.
- Isolation: one OS user per instance, or one container per instance.
- Provisioning: instances started on demand by the gateway, or long-running.
- Idle policy: when an instance stops, and what happens to open terminals, runs and agent sessions.

**Corrections to the intent document**: none on the facts checked. The "missing 15%" and the day estimates are not checked, and the gateway, the desktop transport and the latency work are not in its scope yet.

## Cross-cutting rules

- **Keep the fork diff small and separable.** Separate commits per area, no squash; prefer new files and new commands over changing upstream signatures; leave upstream defaults (ports, profiles, `Cargo.toml`) unchanged and override them in local scripts.
- **Execution by macro tasks.** Each harness (Claude Code, Codex, Antigravity, Pi) receives a large, self-contained macro task and runs it with its own multi-agent mode (Antigravity in teamwork mode). A different harness reviews and consolidates. A Claude Code coordinator session talks to the Crew through a bridge session using cross-session messages. Defined in the sub-project 1 spec, section 8.
- **Parallel local development**: worktrees under `<base>/.ibl-crew-worktree/<name>`, one data profile and dev port per worktree, a shared compile cache, and a machine-wide build slot. Defined in the sub-project 1 spec and documented for agents in `docs/development/parallel-local-dev.md`.
- **Releases come only from CI.** Local installers are for testing only.
- **pnpm 11.** Upstream's `pnpm-workspace.yaml` needs pnpm 10 or later, and CI uses pnpm 11. The machine-wide pnpm was moved to 11 on 2026-10-31.
