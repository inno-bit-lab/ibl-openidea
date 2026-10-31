# Upstream sync (v0.3.0): design

- **Date**: 2026-10-31
- **Status**: Approved by the coordinator under the owner's delegation ("procedi spedito; when sub-project 1 ends, start the next one automatically").
- **Roadmap**: [`2026-10-30-improvement-roadmap.md`](2026-10-30-improvement-roadmap.md), sub-project 2.
- **Port map** (authoritative per-file detail): [`2026-10-31-upstream-sync-port-map.md`](2026-10-31-upstream-sync-port-map.md).

## 1. Goal

Rebuild the fork on current upstream and release it as v0.3.0. Upstream features replace the fork's own versions wherever upstream now covers them. Only the fork-only features, the brand and the identity migration are carried forward.

## 2. Decisions

| Topic | Decision |
|---|---|
| Upstream base | Freeze at `upstream/main` `504d859` (v0.1.29+) for the whole port. Later upstream commits come in a separate follow-up sync after v0.3.0. |
| Integration branch | `port/v0.3.0`, cut from `504d859`. Each macro task is a PR into it. |
| How `main` gets the port | Merge the old `main` into `port/v0.3.0` with `-s ours` (history kept, tree from the port), then fast-forward `main`. No force-push; the `v0.2.x` tags stay valid. |
| CI | Upstream's `ci.yml` unchanged. It runs on PRs into `main`, and on `workflow_dispatch`, which the port uses for PRs into `port/v0.3.0`. Every upstream gate applies: fmt, clippy `-D warnings` on 3 OSes, nextest, bindings diff, `cargo deny`, `pnpm format:check` (oxfmt), knip, tests, build, e2e. |
| Line endings | Port worktrees use `core.autocrlf=false`, as upstream CI does, so local oxfmt and rustfmt checks are meaningful. |
| Features upstream already provides | Drop the fork versions (port map section 2): `latest.json` job, bindings export change, per-worktree dev identity and port logic, built-in `agy`/`pi` agents and the catalog metadata, the Windows executable resolution, the `LogCommit` multi-repo plumbing, per-repo cherry-pick, the History tab, Compare with Revision, Merge/Rebase in the Project menu, Group by Repository. |
| Fork-only features kept | Commit-message suggestion (read-only, as hardened in v0.2.2), agent presets and custom arguments (slimmed Agents editor tab), History for Selection, Show Ignored Files (on top of upstream's #476 index guard), the two-pane Compare Branches editor, repo pickers in Git dialogs, ancestor-repo exclusion, dialog viewport clamp, Italian locale, rebrand, identity migration (`migrate.rs`). |
| Update Project | Ship `showUpdateOptions = false` by default, keeping the fork's direct update. Delegated decision; the owner can revert it. |
| agy discovery | Drop it only after a Windows install of `antigravity-acp` through upstream's agent registry has been verified in MT-2. Otherwise keep it as a fallback, with the identifier path fixed. |
| Agent id migration | Rewrite `agy`→`antigravity-acp` and `pi`→`pi-acp` in `vcs.commit.suggestAgent` and in stored presets. Fork-written `<config>/agents/codex.toml` and `claude.toml` overrides that only pin the old npx adapters must not block upstream's native drivers. |

## 3. Macro tasks

As in port map section 4. Owners follow the owner's rule of no Antigravity developer:

| MT | Developer | Reviewer | Depends on |
|---|---|---|---|
| MT-1 Platform, identity, local dev | `dev-codex` | `rev-claude` | none; merge first |
| MT-2 Agents and commit-suggestion backend | `dev-codex` | `rev-claude` | MT-1 merged |
| MT-3 VCS and Git UX | `dev-claude` | `rev-codex` | starts at once; rebases after MT-1 and MT-2 |
| MT-4 Italian locale, catalog sync, version 0.3.0, final gate | `dev-claude` | `rev-codex`, then `rev-agy` as final reviewer | MT-1 to MT-3 merged; the translation of upstream's new strings can start earlier on a side branch |

Shared-file rules are in port map section 4: `src/bindings.ts` is always regenerated and never hand-merged, `Cargo.lock` comes from the integration branch, and `it` catalogs exist only from MT-4.

## 4. Working rules (lessons from sub-project 1)

- Members run with `--backend acp`. The bridge stays a pane Claude session.
- At most two heavy Rust builds at a time on the 4-core laptop: `scripts/local/cargo-slot.ps1`, warm `CARGO_TARGET_DIR` per worktree, `CARGO_PROFILE_DEV_DEBUG=line-tables-only`. Defender exclusions are in place.
- Release builds only in CI. Local full-workspace clippy is replaced by CI.
- Every member sends a short progress info at each milestone and at least every 30 minutes.
- The pre-commit hook (`simple-git-hooks` with `lint-staged`: oxlint, oxfmt, rustfmt) rewrites staged files. Agents expect it.

## 5. Acceptance (v0.3.0)

- C1. Every `ci.yml` job is green on the final `port/v0.3.0`.
- C2. `v0.3.0-N` (numeric pre-release, because WiX rejects `rc.N`) built by CI has every release asset (spec 4.5 of sub-project 1).
- C3. A v0.2.x install (CI-built) updates to the candidate through the updater with `OPENIDEA_UPDATE_ENDPOINT`. The profile is migrated or already present, the app starts, and there is one entry in installed apps. This runs on the owner's PC, as the owner accepted.
- C4. Commit suggestion works with native Claude (mode `default`) and native Codex (mode `read-only`), and refuses agents without a restrictive mode.
- C5. The Git tool window in a folder of repositories shows every repository; History for Selection, Show Ignored Files, two-pane Compare and the repo pickers work.
- C6. The Italian UI is complete: `textCatalog.test.ts` passes for `it`.

Tags follow the owner's rule: the coordinator pushes candidates itself, and pushes the final tag only when C1 to C6 pass.

## 6. Risks

Port map section 5: the agents rebuild on #151, the two multi-repo models, identity and dev-session ordering (seeding after `dev::configure`, and the `EXCLUDED` list against upstream's new profile contents such as `git-credentials.json`), Italian catalog volume, and CI gates that are new to fork code.
