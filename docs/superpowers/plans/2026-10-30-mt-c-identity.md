# MT-C Identity and Migration Implementation Plan

> **For agentic workers:** you are `dev-claude` in Crew team `ibl-openidea`. You may use subagents (multi-agent orchestration is authorised for this macro task by the spec), but `migrate.rs` is one state machine: keep its design and implementation in one agent. Steps use checkbox (`- [ ]`) syntax for tracking. Reply to the envelope's `da` with `crew send`, never in your chat.

**Goal:** give the fork its own bundle identifier and carry each user's existing data over on first start, without ever touching the old data and without a crash or error leaving a broken profile.

**Architecture:** a pure function `seed_profile` in a new module `src-tauri/src/migrate.rs`, driven by a small journaled state machine and tested on temporary directories. `run()` calls it before anything reads the identifier's directories.

**Tech Stack:** Rust (Tauri 2 app crate `openidea`), `dirs`, `serde_json`, `tauri-plugin-dialog`.

**Spec:** `docs/superpowers/specs/2026-10-30-release-hardening-design.md`, section 6 and sections 8 to 10. Read it before starting.

## Global Constraints

- Release v0.2.3. It is developed now and consolidated only after v0.2.2 is tagged. Version files stay at `0.2.1`.
- `identifier`: `it.innobitlab.iblopenidea`. `bundle.publisher`: `InnoBitLab S.r.l.`. `mainBinaryName` stays `openidea`. Legacy identifier: `ai.l0ng.openidea`.
- Excluded names: `cache`, `index`, `lsp`, `server`, `logs`, `webview-dev`, and every name starting with `webview-`.
- Debug source variable: `IBLOPENIDEA_SEED_FROM`, read only in debug builds. Release builds always seed from `ai.l0ng.openidea`.
- Copy, never move or delete anything under the source identifier.
- Worktree: `<base>/.ibl-crew-worktree/dev-claude`. Branch: `fix/rh-mt-c`. PR into `fix/release-hardening`.
- Until MT-A's build slots are merged (the coordinator tells you), run at most one cargo command at a time with `CARGO_BUILD_JOBS=2`. After that, run cargo through `scripts/local/cargo-slot.ps1`.
- Code, comments and commit messages in English, conventional commits. Every commit ends with `Co-Authored-By` for your model. Never push tags.

## Review Focus

1. The process is killed in the middle of copying `tools/` (hundreds of MB, many small files): the next start must finish a clean copy, not leave a half profile.
2. Upstream OpenIDEA is running while IBLOpenIdea starts for the first time (its WebView profile is locked): the app must start, skip the WebView data and tell the user once.
3. A file in the source cannot be read (locked or permission denied): no retry loop on every start, no change to the source, and the app still starts.
4. A machine that never had OpenIDEA: no source directory, nothing copied, no marker noise.
5. Windows, where the config and data bases are the same directory: each directory is copied once.

## 1. Context and goal

The fork still uses upstream's identifier, so IBLOpenIdea and an installed OpenIDEA share settings, tools, WebView data and probably the single-instance lock. Changing the identifier later costs more with every new user, so it happens in v0.2.3, with a migration that keeps layouts, presets, agents, local history, scratches and downloaded tools (about 1 GB measured on the owner's machine, spec 6.2).

## 2. Frozen base

`fix/release-hardening` at the commit that adds this plan. The dispatch message gives its SHA. In your worktree: `git branch -m fix/rh-mt-c`, then `git push -u origin fix/rh-mt-c`.

## 3. Solution design

Interface (refines spec 6.2 by adding the outcome):

```rust
pub enum SeedOutcome { NotNeeded, Seeded, Resumed, Failed(String) }
pub struct SeedReport { pub outcome: SeedOutcome, pub copied: Vec<PathBuf>, pub skipped: Vec<(PathBuf, String)> }
pub fn seed_profile(bases: &[PathBuf], from: &str, to: &str, excludes: &[&str]) -> SeedReport
```

`bases` is deduplicated inside the function. The journal is `<first base>/<to>.migration.json` with `{"phase": "copying" | "renaming", "from": "...", "started": "<RFC 3339>"}`. The first base is the config base.

State machine:

| At start | Action |
|---|---|
| no journal, `<to>` exists in any base | `NotNeeded` |
| no journal, no `<from>` in any base | `NotNeeded` |
| no journal, otherwise | write journal `copying`; copy each `<base>/<from>` into `<base>/<to>.partial`, skipping excluded names; write journal `renaming`; rename every `.partial` to `<to>`; write `<config base>/<to>/.migrated.json`; delete the journal; `Seeded` |
| journal `copying` (a crash during copy) | delete every `<to>.partial`, then run the copy phase again; `Resumed` |
| journal `renaming` (a crash during rename) | rename the remaining `.partial` directories, write the marker, delete the journal; `Resumed` |
| an I/O error during the copy phase | delete every `<to>.partial`, delete the journal, write `<config base>/<to>/.migrated.json` with `"status": "failed"` and the error; `Failed`. No retry on later starts; the source is untouched |

`EBWebView` is skipped, and recorded in `skipped`, when `EBWebView/Default/LOCK` cannot be opened exclusively. This is not an error. `.migrated.json` records `from`, the app version, `copied`, `skipped` and `status`.

`run()` (`src-tauri/src/lib.rs`):

- Calls the function right after `tauri::generate_context!()` and before `logging::init`, with bases `dirs::config_dir()`, `dirs::data_dir()` and `dirs::data_local_dir()`, and with `from` taken from the debug variable or the legacy constant.
- Logs the report once logging is up.
- When `EBWebView` was skipped, shows one non-blocking message in the existing builder setup through `tauri-plugin-dialog`: "Layouts and other window settings from OpenIDEA were not copied because OpenIDEA was running. Close it and reinstall IBLOpenIdea to copy them, or set them up again."

## 4. Closed allowlist

`src-tauri/tauri.conf.json` (`identifier`, `bundle.publisher` only); `src-tauri/src/migrate.rs` (new); `src-tauri/src/lib.rs` (`run()` and the module declaration only; `export_bindings` belongs to MT-A); `src-tauri/Cargo.toml` only if a dev-dependency already used elsewhere in the workspace is needed for tests (`tempfile`).

## 5. Ordered tasks

### Task 1: `seed_profile` state machine

**Files:** Create `src-tauri/src/migrate.rs` with its `#[cfg(test)] mod tests`.

- [ ] Tests, all on temporary base directories:
  - `seeds_every_base_and_skips_excluded_dirs` (`settings.toml`, `tools/a/b`, `cache/x`, `webview-123/y`: the first two copied, the last two not; marker written; journal gone; `Seeded`);
  - `does_nothing_when_the_target_exists`;
  - `does_nothing_without_a_source`;
  - `second_run_is_a_no_op`;
  - `deduplicates_identical_bases` (the same path passed twice is copied once);
  - `recovers_from_a_crash_while_copying` (journal `copying` and a half `<to>.partial`: complete copy, `Resumed`);
  - `finishes_an_interrupted_rename` (journal `renaming`, one base renamed, one `.partial` left: both present, `Resumed`);
  - `copy_error_gives_up_without_touching_the_source` (an unreadable source file: `Failed`, no `.partial`, no journal, marker with `"status": "failed"`, the source byte-identical, a second call returns `NotNeeded`);
  - `#[cfg(windows)] skips_a_locked_webview_profile` (hold `EBWebView/Default/LOCK` open with `share_mode(0)`: `EBWebView` in `skipped`, everything else copied, `Seeded`).
- [ ] Run `cargo test -p openidea migrate`: fails.
- [ ] Implement per section 3. Run: passes.
- [ ] Commit.

### Task 2: New identifier and startup wiring

**Files:** Modify `src-tauri/tauri.conf.json`, `src-tauri/src/lib.rs` (`run()`).

- [ ] Set `identifier` and `bundle.publisher`. Wire `seed_profile` into `run()` as in section 3, with the debug-only `IBLOPENIDEA_SEED_FROM`.
- [ ] `cargo build -p openidea` and `cargo test -p openidea` pass, apart from the known Windows environment failures listed in spec 9.
- [ ] Manual check (spec B3): with MT-A's `pnpm dev:local -SeedFrom ai.l0ng.openidea` if it is merged, otherwise a debug run with `IBLOPENIDEA_SEED_FROM=ai.l0ng.openidea` and `--config` overriding `identifier` to `it.innobitlab.iblopenidea.dev.mtc`. The first start copies and writes the marker; the second start logs `NotNeeded`. Record times and sizes from the marker. Do not run a debug build against the real `it.innobitlab.iblopenidea` profile.
- [ ] Commit, push, open the PR (`gh pr create --base fix/release-hardening --title "MT-C: identifier and migration"`).

### Task 3: CI green

- [ ] Fix what `ci.yml` reports inside the allowlist.

## 6. Verification (exact commands)

```powershell
cargo test -p openidea migrate
cargo test -p openidea
cargo clippy -p openidea --all-targets -- -D warnings
cargo fmt --all --check
gh pr checks --watch
```

Run each cargo line through `scripts/local/cargo-slot.ps1 --` once it is available.

## 7. Definition of Done

- Tasks 1 to 3 committed on `fix/rh-mt-c`, pushed, PR open into `fix/release-hardening`, every `ci.yml` job green.
- Every test in Task 1 exists and passes, and was seen failing first.
- The manual B3 check is recorded with times and sizes.
- Delivery `res` to the coordinator via the bridge: frozen SHA, PR URL, CI run URL, outputs of section 6, the B3 record, and anything NOT_VERIFIED.

## 8. Acceptance criteria

| Criterion | Verified by |
|---|---|
| Existing data is copied once, caches are not | Task 1 tests |
| A crash or an error never leaves a broken profile or changes the source | Task 1 recovery and failure tests |
| A locked WebView profile does not block startup and the user is told once | Task 1 Windows test; message in `run()` |
| The new identifier and publisher are in the bundle | Task 2 diff; spec B1 on the release candidate |
| Upgrade from v0.2.2 through the real updater keeps the data | spec B1 in Windows Sandbox (reviewer or integrator) |

## 9. Risks and NOT_VERIFIED

- NSIS upgrade across a manufacturer and identifier change: NOT_VERIFIED; spec B1.
- `tauri dev --config` overriding the compiled identifier: NOT_VERIFIED (MT-A checks it first). If it does not work, report it; do not change `run()` to work around it.
- Exclusive-open detection of the WebView lock is Windows-specific. On macOS and Linux WebKit storage is not copied anyway (spec 6.2).
- Copy time for about 1 GB of small files: not measured; record it in Task 2.
