# MT-1 Platform, Identity and Local Dev Implementation Plan (upstream sync v0.3.0)

> **For agentic workers:** you are `dev-codex` in Crew team `ibl-openidea`; `rev-claude` reviews. You may split the work across your own sub-agents, but only one of them runs cargo at a time. Steps use checkbox (`- [ ]`) syntax. Report to `pilot-bridge` with `crew send`, never in your chat.

**Goal:** `port/v0.3.0` (upstream `504d859`) builds, starts and passes every `ci.yml` job as IBLOpenIdea: fork brand, identifier `it.innobitlab.iblopenidea` with MT-C's profile migration, fork updater and release pipeline, and the fork's local Windows scripts working on top of upstream's dev launcher.

**Architecture:** start from upstream's files and re-apply only the fork deltas listed in port map 1.1 and 1.2. Upstream already provides per-worktree dev identity and ports (`src-tauri/src/dev.rs`, `scripts/dev-session.ts`, `scripts/tauri.ts`), the single `latest.json` job and a failing `export_bindings`. The fork keeps the VS2022 environment, the build slots, the seed variable and `migrate.rs`.

**Tech Stack:** Rust (Tauri 2 app crate `openidea`), TypeScript (Node 22 launcher scripts), PowerShell 7, GitHub Actions.

**Spec:** design `docs/superpowers/specs/2026-10-31-upstream-sync-design.md` (binding), port map `docs/superpowers/specs/2026-10-31-upstream-sync-port-map.md` sections 1.1, 1.2, 2, 3, 4 and risk 3. They are not on `port/*` branches: read them with `git show origin/fix/release-hardening:docs/superpowers/specs/<file>` (in Git Bash prefix `MSYS_NO_PATHCONV=1`).

## Global Constraints

- Worktree `C:\projects\development\IBL\ibl-openidea\.ibl-crew-worktree\dev-codex`, branch `port/mt1-platform` from `origin/port/v0.3.0`, PR into `port/v0.3.0`. Bootstrap per section 3.1 before any edit.
- Fork sources, read-only: `origin/fix/release-hardening` at the tip given in the dispatch (at least `0d68ad7`), `origin/fix/rh-mt-b` `86e8498` or later (it carries the review fix `7870140`; once PR #3 merges, read the same code from `origin/fix/release-hardening`), `origin/fix/rh-mt-c` `2321a8a`. If the coordinator announces a newer SHA, port its delta in a separate commit.
- Cargo only as `pwsh -NoProfile -File scripts/local/cargo-slot.ps1 -- cargo ...`, in the foreground, with `$env:CARGO_TARGET_DIR = 'C:\projects\development\IBL\ibl-openidea\.ibl-crew-worktree\dev-codex\target'` and `$env:CARGO_PROFILE_DEV_DEBUG = 'line-tables-only'`. Until Task 1 exists on your branch, run no cargo at all.
- No `--release`, no `pnpm build:local`, no `cargo clippy --workspace`. Local lint gate: `cargo clippy -p openidea --all-targets -- -D warnings` and `-p ide-tools`. CI runs the full matrix.
- Version files stay at upstream's `0.1.29`; MT-4 sets `0.3.0`. Do not touch `ci.yml`: CI runs by `workflow_dispatch` (design section 2), so the temporary trigger change in port map 4 is cancelled.
- `src/bindings.ts` is regenerated only (`cargo test -p openidea --test export_bindings`), never edited. No `it` catalog files and no `"it"` locale on this branch (MT-4 only).
- Every user-visible string you add or reword needs a `src/platform/locales/text/zh.json` entry; reuse the fork's zh text from `release-hardening`.
- The pre-commit hook (simple-git-hooks + lint-staged: `oxlint --fix`, `oxfmt`, `rustfmt --edition 2024`) rewrites staged files. Check `git show --stat HEAD` after each commit.
- English code, comments and commits, conventional commits, `Co-Authored-By` for your model. Never push tags, never force-push `port/v0.3.0` or `main`.
- Reviewers: a worktree with `core.autocrlf=true` gives false `format:check` failures. Run section 3.1 in the reviewer worktree first, or rely on CI for formatting.
- Report: `crew send pilot-bridge -t info "MT-1 <milestone>: <branch>@<sha> <one line>"` at each task end and at least every 30 minutes; final `crew send pilot-bridge -t res -r <dispatch id> --stdin` with the delivery of section 7.

## Review Focus

1. Debug and release seeding run after `dev::configure`, so `to` is the identifier the app really uses; a debug run without `IBLOPENIDEA_SEED_FROM` copies nothing.
2. `git diff upstream/main -- src-tauri/tauri.conf.json .github/workflows/release.yml` shows only identity, updater, copy, release name and `already_published` lines; upstream's CSP stays.
3. `pnpm dev:local` releases its build slot before the app window opens, and the prebuild leaves `openidea` Fresh for `pnpm dev:app`.
4. The pre-commit hook of a port worktree never runs in the primary checkout or in the `rh-mt-b`/`rh-mt-c` worktrees.
5. `pnpm format:check` and `pnpm knip` pass with the fork docs and scripts present.

## 1. Context and goal

The fork has never run upstream's CI gates and still ships its own versions of features upstream now has. MT-1 is the base every other macro task rebases on, so it lands first, small and green. Task 1 (build slots) is delivered early because MT-3 cannot run cargo on `port/v0.3.0` before it.

## 2. Frozen base

`origin/port/v0.3.0` = `504d859`, created by the coordinator. Check `git rev-parse origin/port/v0.3.0` before starting; if it differs, ask the coordinator.

## 3. Solution design

### 3.1 Worktree bootstrap (shared by all port worktrees)

`core.autocrlf=true` comes from the system gitconfig, and a plain `git config` in a linked worktree writes to the shared repo config, which would flip the primary checkout and the MT-B and MT-C worktrees. In the worktree:

```powershell
git status --porcelain                                   # must print nothing, checked while autocrlf is still true
git fetch origin
git config extensions.worktreeConfig true
git config --worktree core.autocrlf false
git switch --discard-changes -C port/mt1-platform origin/port/v0.3.0   # safe: the tree was clean
git rm -r --cached -q . ; git reset -q --hard          # rewrite every tracked file as LF
git ls-files --eol | Select-String -NotMatch '^i/crlf' | Select-String 'w/crlf' | Measure-Object   # Count must be 0
$wtHooks = Join-Path (git rev-parse --absolute-git-dir) 'hooks'
git config --worktree core.hooksPath $wtHooks
pnpm --version                                           # must be 11.x, as in CI (ci.yml:28); pnpm 9 rejects upstream's pnpm-workspace.yaml
pnpm install --frozen-lockfile --config.confirmModulesPurge=false   # simple-git-hooks postinstall writes pre-commit; the flag replaces node_modules left by pnpm 9
```

Gate: `Test-Path "$wtHooks\pre-commit"` is true and `Test-Path "$(git rev-parse --git-common-dir)\hooks\pre-commit"` is false. If simple-git-hooks wrote into the common `hooks` dir instead, move the file into `$wtHooks`. Repeat this check after every later `pnpm install`: a `pre-commit` in the common dir runs `pnpm lint-staged` in every fork-line worktree, where `lint-staged` does not exist, and breaks their commits (it happened on 2026-10-31 at 05:02). Report where it landed; MT-3 relies on this result.

### 3.2 Identity and startup (`src-tauri/src/lib.rs`)

Take upstream's file. Add `mod migrate;` (file from `rh-mt-c` `2321a8a`). In `run()`, after `#[cfg(debug_assertions)] let context = dev::configure(context);` (lib.rs:46) and before `logging::init` (lib.rs:47), insert MT-C's `seed_source`/`seed_profile` block. Log its report (`report.log()`) and the `IBLOPENIDEA_SEED_FROM` warning right after `logging::init`, as `rh-mt-c` does: anything logged before `logging::init` is lost. Then add the one-time WebView notice in `setup` around `windows::create_main_window` (lib.rs:106), exactly as in `git diff b091329 origin/fix/rh-mt-c -- src-tauri/src/lib.rs` (`b091329` is the merge base with `release-hardening`). Keep upstream's `export_bindings` with `.expect` (lib.rs:38) and upstream's `src-tauri/tests/export_bindings.rs`. Take upstream's `windows.rs` unchanged (port map 1.1: per-worktree debug identifiers and the fork identifier remove the shared EBWebView).

Debug identifiers become `it.innobitlab.iblopenidea.dev.w<hash>`: change the prefix in `dev.rs:12` and `scripts/dev-session.ts:12`; the FNV-1a hash and `preferredVitePort` are unchanged, so the expected values in `dev.rs:21` and `dev-session.test.ts:53` keep the suffix `w158e9c5954b7bf64`.

### 3.3 `migrate.rs` review against upstream's profile

List what upstream `504d859` writes under the config, data and local-data dirs (`git grep -n -E 'data_dir\.join\("|config_dir\.join\("' upstream/main -- crates src-tauri/src`). Expected decisions:

- `EXCLUDED` stays `cache, index, lsp, server, logs, webview-dev` plus the `webview-` prefix: all rebuildable.
- Copied: `agents/` (task stores, `models.json`, `registry.json`, registry installs in `agents/tools`), `git-credentials.json` (#321), the jdtls JDK from #370 under `tools/`, notebooks and kernels. MT-2 rehomes registry agent commands that still point into `ai.l0ng.openidea`.
- Absolute paths to `<base>/ai.l0ng.openidea/...` inside other copied files keep working because the source is never deleted. Record them as a known limitation for the release notes.

### 3.4 `scripts/local/dev.ps1` on upstream's launcher

Parameters `-FullDebug`, `-SeedFrom`, `-WhatIf`. Steps:

1. Read the identifier and Vite port from upstream's code, never recomputed in PowerShell: `node --input-type=module -e "import { worktreeId, worktreeRoot, preferredVitePort } from './scripts/dev-session.ts'; const id = worktreeId(worktreeRoot); console.log(JSON.stringify({ id, port: preferredVitePort(id) }))"`.
2. Seed default as before: `it.innobitlab.iblopenidea` if that profile exists in Roaming or Local, else `ai.l0ng.openidea`. `-WhatIf` prints identifier, port, seed and debug level, then exits.
3. Dot-source `env.ps1`; set `CARGO_PROFILE_DEV_DEBUG`.
4. Prebuild in a slot with the config the launcher will pass: `TAURI_CONFIG` = `src-tauri/tauri.dev.conf.json` merged with `{"build":{"beforeDevCommand":"","devUrl":"http://localhost:<port>/"}}` (scripts/dev-session.ts `withDevConfig`), compressed JSON; `cargo build` with exactly the package and feature flags that `pnpm tauri dev --verbose` prints for this tree (record them in the delivery). Upstream's `src-tauri/Cargo.toml` has no `[features]` block and none is ported, so do not assume `--no-default-features`. Then remove `TAURI_CONFIG`. Before the prebuild and again before step 5, check that `port` and `port+1` are free; if not, warn that Vite (`strictPort: false`) will take another port, the launcher will pass a different `devUrl` through `TAURI_CONFIG` (`resolvedUrls`, scripts/tauri.ts) and `openidea` will rebuild.
5. Set `IBLOPENIDEA_SEED_FROM`, run `pnpm dev:app` outside the slot, exit with its code.

## 4. Closed allowlist

- Release and build: `.github/workflows/release.yml`, `src-tauri/tauri.conf.json` (productName, window title, identifier, `bundle.publisher`, copyright, short and long description, updater pubkey and endpoint), `src-tauri/tauri.windows.conf.json` (title), `src-tauri/icons/**`, `README.md` (download link), `index.html`.
- App crate: `src-tauri/src/lib.rs`, `src-tauri/src/migrate.rs` (new), `src-tauri/src/dev.rs`, `src-tauri/src/menu.rs` (brand strings only), `crates/ide-tools/src/server.rs` (`RELEASES` and its test).
- Launcher and scripts: `scripts/dev-session.ts`, `scripts/dev-session.test.ts`, `scripts/local/**`, `src-tauri/tauri.local.conf.json`, `package.json` (scripts block only).
- Brand test expectations only: `src/features/perf/__tests__/perf.test.ts` and `views.test.tsx` (the seven assertions that follow the `memory.ts` rebrand).
- Brand UI: `src/features/welcome/ProjectsPage.tsx`, `WelcomeView.tsx`, `welcome.test.tsx`, `src/workbench/TitleBar.tsx`, `src/workbench/Welcome.tsx` (moved here from port map MT-3: it is brand only), `src/features/app/AboutDialog.tsx`, `src/features/app/__tests__/shell.test.tsx`, `src/features/app/__tests__/menuBridge.test.ts` (Quit label only), plus the new upstream literals you rebrand in Task 3.
- Catalogs: brand keys in `src/platform/locales/en.json` and `zh.json`, brand entries in `text/zh.json`, `"IBLOpenIdea"` in `UNTRANSLATED` of `textCatalog.test.ts`.
- Docs: `docs/superpowers/**`, `docs/intents/**`, `docs/development/parallel-local-dev.md`.
- Not ported (upstream supersedes): fork `vite.config.ts`, `scripts/local/tests/vite-config.test.ts`, fork `windows.rs`, the fork `export_bindings` and its TEMP-subprocess test, `docs/upstream-sync.md` (stale; replaced by the port map).

## 5. Ordered tasks

### Task 0: Bootstrap

- [ ] Run section 3.1. Record: hook location, `w/crlf` count, `pnpm install` time. Send `info`.

### Task 1: Build slots on the upstream base (early delivery)

**Files:** `scripts/local/env.ps1`, `cargo-slot.ps1`, `test-rust.ps1`, `test-full.ps1`, `tests/cargo-slot.tests.ps1`, `tests/env-bootstrap.tests.ps1` (copied from `release-hardening`); `package.json` (`test:rust`, `test:full`).

- [ ] Copy the files unchanged. Run `pwsh -NoProfile -File scripts/local/tests/cargo-slot.tests.ps1` and `pwsh -NoProfile -File scripts/local/tests/env-bootstrap.tests.ps1`: both pass.
- [ ] First build: `pwsh -NoProfile -File scripts/local/cargo-slot.ps1 -- cargo build -p openidea`. Record wall time (cold for upstream's new crates).
- [ ] Commit, push, open PR "MT-1: platform, identity, local dev" into `port/v0.3.0`, send `info` "Task 1 ready for early merge" with the SHA. After the coordinator merges it, continue on the same branch and open a second PR for Tasks 2 to 7.

### Task 2: Fork docs pass oxfmt

- [ ] `git checkout origin/fix/release-hardening -- docs/superpowers docs/intents docs/development/parallel-local-dev.md`, then `pnpm exec oxfmt docs`. Reformat; do not add an ignore pattern (it would also hide upstream's docs).
- [ ] `pnpm format:check` passes. Commit.

### Task 3: Brand and identity

- [ ] Re-apply the fork rebrand to the brand files of section 4 (`git diff 5b63a2b origin/fix/rh-mt-c -- <file>` is the reference). Run `pnpm exec oxfmt index.html src-tauri/tauri.conf.json`.
- [ ] `server.rs`: `RELEASES` to `https://github.com/inno-bit-lab/ibl-openidea/releases/download`, with the fork's test.
- [ ] `dev.rs` and `dev-session.ts` prefix per 3.2, with their tests updated.
- [ ] Grep new upstream literals: `git grep -n OpenIDEA -- 'src/**/*.ts' 'src/**/*.tsx' ':!**/*.test.*' ':!src/bindings.ts'`. Rebrand only text that names the running app to the user (expected: `projectActions.ts`, `MemoryStatus.tsx`, `memory.ts`, `missingAdapter.ts`; check each). Keep storage keys, CSS classes, `~/.openidea` paths and references to the upstream project. List every hit and decision in the delivery.
- [ ] Brand keys in `en.json`/`zh.json`; zh entries in `text/zh.json` for every new brand text; `"IBLOpenIdea"` in `UNTRANSLATED`.
- [ ] `pnpm exec vitest run src/features/welcome src/features/app src/platform/locales scripts/dev-session.test.ts`: passes. Commit.

### Task 4: Identifier, migration and startup

- [ ] Add `migrate.rs` and wire `lib.rs` per 3.2; set `identifier` and `bundle.publisher` in `tauri.conf.json`.
- [ ] Add `#[cfg(unix)] keeps_owner_only_permissions` to `migrate.rs` tests: a `git-credentials.json` with mode `0o600` keeps `0o600` after `seed_profile`.
- [ ] Do the 3.3 review; change `EXCLUDED` only if it finds a rebuildable root dir that is missing. Add each change to `seeds_every_base_and_skips_root_excluded_dirs`.
- [ ] `cargo test -p openidea migrate` and `cargo test -p openidea dev`: pass (every MT-C test, run through the slot).
- [ ] Commit.

### Task 5: Local dev on upstream's launcher

**Files:** `scripts/local/dev.ps1`, `build.ps1`, `acceptance.ps1`, `tests/dev-profile.tests.ps1`, `src-tauri/tauri.local.conf.json`, `package.json`, `docs/development/parallel-local-dev.md`.

- [ ] `package.json`: keep upstream's scripts (`tauri`, `dev:app`, `dev:status`, `format:check`, `knip`) and add `dev:local`, `build:local`, `test:rust`, `test:full`. Do not port `vite-config.test.ts`.
- [ ] Rewrite `dev-profile.tests.ps1`: `dev.ps1 -WhatIf` prints the same identifier as `worktreeId(worktreeRoot)` and the same port as `preferredVitePort`; the seed default follows 3.4 step 2 with fake profile dirs.
- [ ] Implement `dev.ps1` per 3.4. Run `pnpm dev:local -SeedFrom ai.l0ng.openidea` once: the window opens; `%APPDATA%\it.innobitlab.iblopenidea.dev.w<hash>\.migrated.json` appears (or `NotNeeded` is logged when there is no legacy profile); `pnpm dev:status` shows the session.
- [ ] Fresh check: in that run, the cargo output of `pnpm dev:app` shows no `Compiling openidea`. If it does, fix the `TAURI_CONFIG` or `devUrl` mismatch; if that takes over an hour, keep the prebuild and record NOT_VERIFIED.
- [ ] Update the doc (ports and profiles now come from upstream's launcher; `pnpm dev:status`). Commit.

### Task 6: Release pipeline

- [ ] Take upstream's `release.yml`; re-apply the release name `IBLOpenIdea ${tag}` and the `already_published` output with its `if:` on `build`, `server`, `updater-manifest` and `publish`. Upstream already has `uploadUpdaterJson: false` (release.yml:121) and the manifest job (release.yml:179); repository URLs come from `context.repo`.
- [ ] `git diff upstream/main -- .github/workflows/release.yml` shows only those lines. Commit.

### Task 7: CI green

- [ ] Push, then `gh workflow run ci.yml --repo inno-bit-lab/ibl-openidea --ref port/mt1-platform`. The Rust cache is cold on every dispatch: batch fixes before you re-dispatch.
- [ ] Fix inside the allowlist until every job is green: fmt, clippy on 3 OSes, nextest, bindings diff, server musl, deny, typecheck, lint, format:check, knip, test, build, e2e.

## 6. Verification (exact commands)

```powershell
pwsh -NoProfile -File scripts/local/tests/cargo-slot.tests.ps1
pwsh -NoProfile -File scripts/local/tests/env-bootstrap.tests.ps1
pwsh -NoProfile -File scripts/local/tests/dev-profile.tests.ps1
pwsh -NoProfile -File scripts/local/cargo-slot.ps1 -- cargo test -p openidea
pwsh -NoProfile -File scripts/local/cargo-slot.ps1 -- cargo test -p ide-tools server
pwsh -NoProfile -File scripts/local/cargo-slot.ps1 -- cargo clippy -p openidea --all-targets -- -D warnings
pwsh -NoProfile -File scripts/local/cargo-slot.ps1 -- cargo fmt --all --check
git diff --exit-code src/bindings.ts
pnpm typecheck; pnpm lint; pnpm format:check; pnpm knip; pnpm test
git diff upstream/main -- .github/workflows/release.yml src-tauri/tauri.conf.json
gh run list --repo inno-bit-lab/ibl-openidea --workflow ci.yml --branch port/mt1-platform -L 1
gh run watch <run id> --repo inno-bit-lab/ibl-openidea --exit-status
```

## 7. Definition of Done

- Task 1 merged early; Tasks 2 to 7 committed on `port/mt1-platform`, PR open into `port/v0.3.0`, the dispatched CI run fully green.
- Delivery `res` to `pilot-bridge`: base SHA, PR URLs, CI run URL, outputs of section 6, hook location, first-build time, the `OpenIDEA` literal decisions, the 3.3 review table, the Fresh check result, and NOT_VERIFIED items.

## 8. Acceptance criteria

| Criterion | Verified by |
|---|---|
| App builds and starts as IBLOpenIdea on the upstream base | Task 5 run, CI build and e2e |
| Seeding targets the configured identifier, debug only on request | `cargo test -p openidea migrate`, Task 5 marker check |
| Secrets keep owner-only permissions after the copy | `keeps_owner_only_permissions` (Linux and macOS CI) |
| Build slots and env work on the upstream base | `cargo-slot.tests.ps1`, `env-bootstrap.tests.ps1` |
| Dev launcher identity matches the fork prefix | `dev.rs` test, `dev-session.test.ts`, `dev-profile.tests.ps1` |
| Release pipeline equals upstream plus fork guards | Task 6 diff |
| All upstream CI gates pass | dispatched `ci.yml` run |

## 9. Risks and NOT_VERIFIED

- `TAURI_CONFIG` alignment with the launcher's two `--config` values: checked by the Fresh check; NOT_VERIFIED until it passes.
- `node -e` importing a `.ts` module relies on Node's type stripping, which upstream's `node scripts/tauri.ts` already needs. If it fails, call it with `--experimental-strip-types` and report it.
- The updater crossing from `ai.l0ng.openidea` to `it.innobitlab.iblopenidea` (NSIS install location, one entry in installed apps): NOT_VERIFIED here; acceptance C3 on the owner's PC.
- PowerShell scripts are Windows-only and not covered by CI: their tests run locally only.
- simple-git-hooks may ignore `core.hooksPath`: handled by the 3.1 gate.
