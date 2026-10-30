# MT-A Infrastructure Implementation Plan

> **For agentic workers:** you are `dev-codex` in Crew team `ibl-openidea`. Run this macro task with your own parallel agents where useful; you decide the internal split. Steps use checkbox (`- [ ]`) syntax for tracking. Reply to the envelope's `da` with `crew send`, never in your chat.

**Goal:** CI that runs and passes on the fork, a release pipeline that builds every asset once, and a local loop that lets several worktrees and harnesses build, run and test at the same time.

**Architecture:** PowerShell scripts in `scripts/local/`, exposed as `pnpm` commands, override upstream defaults through environment variables and Tauri config overlays; `Cargo.toml` and the upstream defaults stay unchanged. `release.yml` takes upstream's single-manifest job. `export_bindings` fails loudly in tests again.

**Tech Stack:** PowerShell 7, pnpm, Vite, Tauri 2 CLI, cargo, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-30-release-hardening-design.md`, sections 4, 7, 8 and 9. Read it before starting.

## Global Constraints

- Release v0.2.2. Version files stay at `0.2.1`; the integrator bumps them.
- Do not change `Cargo.toml`, `src-tauri/tauri.conf.json` or upstream defaults. The Vite default port stays `1420`.
- Worktree: `<base>/.ibl-crew-worktree/dev-codex`. Branch: `fix/rh-mt-a`. PR into `fix/release-hardening`.
- Until Task 1 is merged, run at most one cargo command at a time with `CARGO_BUILD_JOBS=2`, and no cargo in parallel sub-agents. After that, run every cargo command through `scripts/local/cargo-slot.ps1`.
- Code, comments and commit messages in English, conventional commits, separate commits per task. Every commit ends with `Co-Authored-By` for your model.
- Never push tags. Never force-push `fix/release-hardening` or `main`.

## Review Focus

1. Two `pnpm dev:local` runs in different worktrees at the same time: different ports, different profiles, no `ERROR_BUSY`.
2. A slot holder that crashes or is killed must release its slot. Windows semaphores have no owner and are never released on process death, so slots are named mutexes, which the OS abandons when the owner exits (lint finding, rev-agy); test it.
3. Paths with spaces in the worktree path or user profile (`C:\Users\张 三\...` style paths already appear in repo tests).
4. `updater-manifest` with a missing platform must fail the release, not publish a partial `latest.json`.
5. `export_bindings` failing must turn the CI test red.

## 1. Context and goal

v0.2.0 was published by hand, Windows only. Actions has never run on the fork. Building in several worktrees at once runs out of memory and collides on port 1420, on the shared app profile and on the MSVC linker choice (spec 7.1). This macro task fixes the pipeline and the local loop, which every other macro task depends on.

## 2. Frozen base

`fix/release-hardening` at the commit that adds this plan. The dispatch message gives its SHA. Create your branch from it: `git branch -m fix/rh-mt-a` in your worktree, then `git push -u origin fix/rh-mt-a`.

## 3. Solution design

See spec 4.2, 4.3 and 7.2. Contracts other macro tasks rely on:

- `scripts/local/env.ps1`: dot-sourced.
  - Finds Visual Studio 2022 with `"${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"` (falling back to `vswhere` on `PATH`) `-version "[17.0,18.0)" -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`, and imports the `vcvars64.bat` environment into the current PowerShell session.
  - Prepends `$env:USERPROFILE\.cargo\bin` to `PATH`, and sets `RUSTC_WRAPPER=sccache` when `sccache` is on `PATH` and `RUSTC_WRAPPER` is unset.
  - Bootstraps a fresh worktree: runs `pnpm install --frozen-lockfile` when `node_modules` is missing, and creates `dist/` when it is missing (`tauri::generate_context!()` needs it, as CI does with `mkdir -p dist`).
  - Fails with a clear message when VS 2022 is missing.
- `scripts/local/cargo-slot.ps1 [-Slots <int>] [-Name <string>] -- <command> [args...]`, default 2 slots and name `Local\ibl-openidea-cargo`:
  - No `param()` block: it parses `$args` itself, consuming the optional `-Slots`, `-Name` and `--` and running the remaining tokens as the command. A `param()` block binds `cargo` to `-Slots`, and `pwsh -File` rejects `--` as an ambiguous parameter. It must work both as `scripts/local/cargo-slot.ps1 -- cargo ...` and as `pwsh -NoProfile -File scripts/local/cargo-slot.ps1 -- cargo ...`, which is what the `package.json` scripts use.
  - Dot-sources `env.ps1`.
  - Slots are named mutexes `"$Name-0"` to `"$Name-$($Slots - 1)"` (`[System.Threading.Mutex]::new($false, ...)`), acquired with `[System.Threading.WaitHandle]::WaitAny`. An `AbandonedMutexException` counts as acquired, because its previous owner died.
  - Sets `CARGO_BUILD_JOBS` to `[Environment]::ProcessorCount / $Slots` (at least 1) unless it is already set, runs the command, calls `ReleaseMutex()` in `finally`, and exits with the command's exit code. Prints a line while waiting.
- `scripts/local/dev.ps1 [-FullDebug] [-SeedFrom <identifier>]`, run by `pnpm dev:local`:
  - slug: the worktree folder name, or `main` for the primary checkout, lowercased, non `[a-z0-9-]` replaced by `-`;
  - port: first free TCP port from `1420 + (stable hash of the repo path mod 200) * 2`, stepping by 2; HMR uses port + 1;
  - writes `target/local/tauri.dev.<slug>.json` with `{"identifier":"it.innobitlab.iblopenidea.dev.<slug>","build":{"devUrl":"http://localhost:<port>"},"app":{"withGlobalTauri":true}}`;
  - sets `OPENIDEA_DEV_PORT`, `IBLOPENIDEA_SEED_FROM` (default: `it.innobitlab.iblopenidea` if that profile exists, else `ai.l0ng.openidea`), `CARGO_PROFILE_DEV_DEBUG=line-tables-only` unless `-FullDebug`, `RUSTC_WRAPPER=sccache` when `sccache` is on `PATH`;
  - runs `cargo build -p openidea` inside a build slot, then `pnpm tauri dev --config <overlay>` outside it. `tauri dev` lives until the window closes, so holding a slot would starve every other build on the machine.
- `vite.config.ts`: `port: Number(process.env.OPENIDEA_DEV_PORT ?? 1420)`; HMR port `port + 1`.
- `scripts/local/build.ps1`, run by `pnpm build:local`: `pnpm tauri build --bundles nsis --config src-tauri/tauri.local.conf.json` with `CARGO_PROFILE_RELEASE_LTO=thin`, `CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16`, inside a build slot; prints the installer path and size. `src-tauri/tauri.local.conf.json`: `{"bundle":{"createUpdaterArtifacts":false}}`.
- `pnpm test:rust -- <cargo test args>` and `pnpm test:full` (full vitest) run inside a build slot.

## 4. Closed allowlist

`.github/workflows/release.yml`; `export_bindings` in `src-tauri/src/lib.rs`; `src-tauri/tests/export_bindings.rs`; `scripts/local/**`; `src-tauri/tauri.local.conf.json`; `vite.config.ts`; the `scripts` block of `package.json`; `docs/development/**`; files that CI flags for fmt or clippy, only when they are not in MT-B's allowlist (spec 8.2). For a flagged file in MT-B's allowlist, do not touch it: list it in your delivery.

## 5. Ordered tasks

### Task 1: Environment and build slots (early delivery)

**Files:** Create `scripts/local/env.ps1`, `scripts/local/cargo-slot.ps1`, `scripts/local/tests/cargo-slot.tests.ps1`.

- [ ] Write `cargo-slot.tests.ps1`:
  - with `-Slots 1` and a unique `-Name`, start two background processes that each run `cargo-slot.ps1 -- pwsh -c "Start-Sleep 3"`; assert that their run windows do not overlap;
  - second case: kill the first process while it holds the slot; assert that the second acquires within 5 s;
  - third case: the same invocation through `pwsh -NoProfile -File scripts/local/cargo-slot.ps1 -Slots 1 -- pwsh -c "exit 7"` returns exit code 7.
- [ ] Run it: fails (scripts missing).
- [ ] Implement both scripts per section 3.
- [ ] Run it: passes. Run `pwsh -c ". scripts/local/env.ps1; cargo --version; where.exe link.exe"`: `link.exe` resolves under the VS 2022 (`\2022\`) tree.
- [ ] Commit, push, open the PR (`gh pr create --base fix/release-hardening --title "MT-A: infrastructure"`), and send the coordinator an `info` that Task 1 is ready for early merge, with the SHA.

### Task 2: Per-worktree dev run

**Files:** Create `scripts/local/dev.ps1`; Modify `vite.config.ts`, `package.json` (scripts `dev:local`).

- [ ] First, check that `tauri dev --config` overrides the identifier compiled by `generate_context!` (spec 10, NOT_VERIFIED): run `pnpm dev:local` once and confirm `%LOCALAPPDATA%\it.innobitlab.iblopenidea.dev.<slug>\logs` appears. If it does not, stop and report to the coordinator; do not implement a fallback in `run()`, which belongs to MT-C.
- [ ] Verify the port and profile logic by running `dev.ps1 -WhatIf` (prints slug, port, overlay path and env without starting) in two worktrees: different slugs and ports.
- [ ] Run two `pnpm dev:local` at once (your worktree and the integration worktree, or a second scratch worktree under `.ibl-crew-worktree/`): both windows open, no `ERROR_BUSY` in either log.
- [ ] Commit.

### Task 3: Local installer, test wrappers, sandbox and docs

**Files:** Create `scripts/local/build.ps1`, `scripts/local/acceptance.ps1`, `src-tauri/tauri.local.conf.json`, `docs/development/parallel-local-dev.md`; Modify `package.json` (scripts `build:local`, `test:rust`, `test:full`).

- [ ] `pnpm build:local` produces `target\release\bundle\nsis\IBLOpenIdea_0.2.1_x64-setup.exe` and prints its size; record wall time and peak memory (Task Manager or `Get-Process` sampling) in the delivery.
- [ ] `acceptance.ps1` writes `target\local\acceptance.wsb` with the absolute path of `target\release\bundle\nsis` mapped read-only to `C:\installers` in the sandbox (Windows Sandbox resolves a relative `HostFolder` against the `.wsb` location), sets Explorer to open there, and prints the `.wsb` path, or launches it when called with `-Start`.
- [ ] The doc covers: commands, slots and how to change K, profiles and ports, `IBLOPENIDEA_SEED_FROM`, sccache setup, cleanup of `*.dev.*` profiles and of removed worktrees' `target/`, the Crew worktree rule.
- [ ] Commit.

### Task 4: Release pipeline

**Files:** Modify `.github/workflows/release.yml`.

- [ ] Port upstream `f911196` (`git show f911196 -- .github/workflows/release.yml`): `uploadUpdaterJson: false` on the build step, the `updater-manifest` job, `publish` needing it. Add `if: needs.create-release.outputs.already_published != 'true'` to `updater-manifest`. Keep the fork's release name `IBLOpenIdea ${tag}`.
- [ ] Check: `git diff upstream/main -- .github/workflows/release.yml` shows only the fork's guard and naming lines.
- [ ] Commit.

### Task 5: `export_bindings` fails in tests

**Files:** Modify `src-tauri/src/lib.rs` (`export_bindings` only), `src-tauri/tests/export_bindings.rs`.

- [ ] Change the signature to `pub fn export_bindings(builder: &tauri_specta::Builder<tauri::Wry>) -> Result<(), String>`; keep the temp-file and write-if-changed behaviour. The test calls `.unwrap()`. The debug-start caller logs a warning on `Err`.
- [ ] Run `scripts/local/cargo-slot.ps1 -- cargo test -p openidea --test export_bindings`: passes and `git diff --exit-code src/bindings.ts` is clean.
- [ ] Commit.

### Task 6: CI baseline

- [ ] Push. If no workflow run appears on the PR within 10 minutes, report to the coordinator (the fork may still need workflows enabled) and continue locally.
- [ ] For each failing `ci.yml` job, fix only what it reports and only inside your allowlist. Repeat until green, or until only MT-B-owned files remain.
- [ ] Commit per fix kind (fmt, clippy, tests).

## 6. Verification (exact commands)

```powershell
pwsh -File scripts/local/tests/cargo-slot.tests.ps1
pnpm typecheck
pnpm lint
pnpm exec vitest run src/platform
scripts/local/cargo-slot.ps1 -- cargo test -p openidea --test export_bindings
git diff --exit-code src/bindings.ts
git diff upstream/main -- .github/workflows/release.yml
gh pr checks --watch
```

## 7. Definition of Done

- All six tasks committed on `fix/rh-mt-a`, pushed, PR open into `fix/release-hardening`.
- Every `ci.yml` job green on the PR, or the remaining failures are only in MT-B-owned files and are listed.
- Task 1 delivered early and announced.
- Delivery `res` to the coordinator via the bridge: frozen SHA, PR URL, CI run URL, outputs of section 6, measured build time and memory, and a list of anything NOT_VERIFIED.

## 8. Acceptance criteria

| Criterion | Verified by |
|---|---|
| Slots serialize and survive a killed holder | `cargo-slot.tests.ps1` |
| Two worktrees run the app at once with separate ports and profiles | Task 2 run, spec A5 |
| Local installer builds without a signing key | Task 3 |
| `latest.json` is written once and fails on a missing platform | Task 4 diff; first release candidate (spec A1) |
| Broken bindings export fails CI | Task 5 |
| CI green | PR checks |

## 9. Risks and NOT_VERIFIED

- `tauri dev --config` identifier override: NOT_VERIFIED, checked first in Task 2.
- Workflows on the fork may need enabling in the GitHub UI by the owner: report, do not work around.
- sccache gain and thin-LTO build time and memory: measure, report.
- The CI baseline may touch many files. Stay in the allowlist and list the rest.
