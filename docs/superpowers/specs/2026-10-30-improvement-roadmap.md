# IBLOpenIdea improvement roadmap

- **Date**: 2026-10-30
- **Status**: Agreed in brainstorming; sub-project 1 has a spec, sub-projects 2 and 3 do not yet
- **Inputs**: [`docs/intents/2026-10-30-browser-web-ide.md`](../../intents/2026-10-30-browser-web-ide.md), [`docs/upstream-sync.md`](../../upstream-sync.md), the state audit of 2026-10-30 (below)

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
| 2 | Upstream sync | The fork rebuilt on current upstream, released as v0.3.0 | to write |
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

- Every release goes through one or more candidates (`vX.Y.Z-rc.N`). GitHub marks them as prereleases, and the updater ignores them because it reads `releases/latest`. The team installs candidates by hand.
- Patch releases (`vX.Y.Z+1`) carry fixes at any time and do not wait for the next feature set.
- `main` stays releasable. Unfinished work stays on its branch, or is merged behind a setting that is off by default.
- Each release has curated release notes, including what changed for existing users (for example the data migration in v0.2.3).

## Sub-project 2: upstream sync (v0.3.0)

**Approach** (from `docs/upstream-sync.md`): create a branch from `upstream/main` and port the fork onto it subsystem by subsystem, rather than merging 201 upstream commits into the fork. The subsystems are identity and release, agents, VCS, and Italian locale. The sub-project 1 commits are separate per area so they can be ported the same way.

**Decision still open: how the result reaches `main`.** A branch built from `upstream/main` cannot be merged into the current `main` with a normal merge without bringing back every conflict. The two options:

- Reset `main` to the sync branch and force-push. History is rewritten; the `v0.2.x` tags keep pointing at their old commits.
- Merge with `-s ours` after the port. History is kept, the merge commit records the switch, and `main` has the sync branch's tree.

**Corrections to `docs/upstream-sync.md`** (checked against the repository on 2026-10-30):

- It does not say how the sync branch lands on `main` (see above).
- It lists `src/features/help/{updater.ts,AboutDialog.tsx}`. That folder does not exist in the fork; `AboutDialog.tsx` is in `src/features/app/`.
- The commit-suggestion settings are `suggest_agent`, `suggest_model`, `suggest_thinking` and `suggest_rules`, not `agent`/`model`/`effort`.
- "Push tag v0.3.0 and let GitHub Actions publish" assumes a working CI on the fork. Sub-project 1 provides it.
- The port should carry the sub-project 1 fixes. Copying the v0.2.1 code as it is would bring back the blocking problems.

**Parallel work**: the four subsystem ports touch disjoint areas and can run as parallel units, following the conventions in sub-project 1 (section "Local development loop").

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
