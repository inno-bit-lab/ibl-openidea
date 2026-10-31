# Upstream sync v0.3.1: design

- **Date**: 2026-10-31
- **Status**: Approved by the coordinator under the owner's delegation ("prosegui in maniera autonoma").
- **Inputs**: [inventory](2026-10-31-upstream-sync-v0.3.1-inventory.md) by `rev-codex` (A3382B), the [v0.3.0 sync design](2026-10-31-upstream-sync-design.md), the roadmap section "v0.3.x follow-ups".

## 1. Goal

Bring the 32 upstream commits after the v0.3.0 freeze (`504d859`) into the fork and release them as v0.3.1, together with the v0.3.x follow-ups (small fixes, Windows process-tree teardown). The fork's behaviour, brand, identity, Italian UI and v0.3.0 fixes stay as they are.

## 2. Decisions

| Topic | Decision |
|---|---|
| Upstream base | Freeze at `upstream/main` `06109aae` (v0.1.31). It is `b2d11880` (the inventory base) plus a version bump only. |
| Integration branch | `next/v0.3.1`, cut from `port/v0.3.0` `2847c42`. Every tranche is a PR into it. The small fixes and the teardown tranche also land there. |
| Method | Cherry-pick the upstream commits by area with `git cherry-pick -x`, in the order of section 3, so each tranche stays reviewable and keeps its provenance. After the last tranche, `git merge -s ours 06109aae` makes upstream an ancestor without changing the tree (`git diff --exit-code` before and after), so the next sync starts from `06109aae`. |
| Shared files | `src/bindings.ts` is regenerated, never hand-merged. `Cargo.lock` comes from the integration branch plus `cargo update --workspace` only. Catalogs are merged by key. One integrator at a time on these files. |
| Italian | Each tranche translates its own new strings with the glossary, so the catalog gate stays green. MT-7 does a final audit. |
| Version | Stays 0.3.0 until MT-7, which sets 0.3.1. |
| CI | `ci.yml` by `workflow_dispatch` on each tranche branch; every job green before merge. |
| Release | Candidates `v0.3.1-N` built by CI. The final tag waits for the owner's acceptance, as for v0.3.0. |

## 3. Macro tasks and order

Order from the inventory, section 5. Each MT gets a nine-section plan, linted by a member other than its author, before development.

| MT | Content | Upstream commits |
|---|---|---|
| MT-1 | JVM, Go, C/C++ and LSP runtime | 12 (#512, #514 already present, #525, #529, #545, #546, #540, #555, #524, #550, #539, #553) |
| MT-2 | Deployment | 2 (#521, #544) |
| MT-3 | Editor, search, console, shelf | 11 (#518, #527, #528, #534, #537, #564, #554, scratch search, #566, #531, #541) |
| MT-4 | Shell and menu | 3 (#279, #558, #561); includes the brand in the new `src-tauri/tauri.linux.conf.json` |
| MT-5 | Release ARM64 and tool selection | 1 (#516); extends the fork's pre-release rpm guard to Linux ARM and makes the ARM rpm manifest key conditional; 16 pre-release / 18 stable manifest keys |
| MT-6 | Project trust and the fork's commands | 2 (#517, #571); after MT-1 to MT-5, so every new entry point is classified |
| MT-7 | Italian audit, version 0.3.1, final gate | 1 (#5329ddc4 adapted, plus the v0.1.31 bump ignored); then the `-s ours` merge of `06109aae` |

MT-1 and MT-3 may be split into sub-tranches (JVM / Go / C++; editor-find / shelf) if a plan finds them too large.

## 4. Project trust (MT-6): default decisions

These are the defaults for the MT-6 plan. The plan may refine them with evidence, but any change needs the coordinator's approval.

- **Agent catalog without a project.** `agent_providers` and `agent_set_args` read and write the user's profile, not project state, so they stay available from the Welcome screen and in restricted projects. The plan must show that listing providers runs nothing controlled by the project.
- **Commit suggestion.** `agent_complete` starts an agent in the project's context, so it is denied in restricted projects. The host operation checks this before spawning. The Suggest button is disabled with an explanation. Revoking trust while a suggestion is running cancels it, together with the teardown tranche's process tree.
- **Ignored files.** `vcs_ignored` gets the same classification and protection as `vcs_status`. `Repo::status_with_ignored` receives the `ExecutionScope`, so it never takes the Git executable, hooks or fsmonitor from an untrusted project's settings. The tests use malicious fixtures, including multi-repo.
- **Migrated profiles.** Upstream's `TrustStore` imports existing recent projects as trusted when `project-trust.json` is missing. With the fork's profile seeding, migrated recent projects are trusted. Accepted as upstream behaviour, tested, and written in the release notes.
- **Remote protocol 2.** Server and client move together; an older `openidea-server` is incompatible. The app downloads the server that matches its version. Release notes.
- **PATH budget.** It stays as it is; trust changes the environment of terminals and runs, and the plan verifies trusted, restricted and revoked with a long `PATH`.

## 5. Risks

- MT-6 touches 103 files and the security model: a separate, careful review (`rev-claude`, architect of the teardown, which shares the agent spawn code).
- MT-5 needs ARM runners and signing for new targets: runner availability and ARM installers are NOT_VERIFIED until a candidate is built.
- The inventory is textual: compilation and tests of the integrated result are NOT_VERIFIED until each tranche runs CI.
