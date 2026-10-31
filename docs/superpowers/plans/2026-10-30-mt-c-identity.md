# MT-C Identity and Migration Implementation Plan

> **For agentic workers:** you are `dev-claude` in Crew team `ibl-openidea`. You may use subagents (multi-agent orchestration is authorised for this macro task by the spec), but `migrate.rs` is one state machine: keep its design and implementation in one agent. Steps use checkbox (`- [ ]`) syntax for tracking. Reply to the envelope's `da` with `crew send`, never in your chat.

**Goal:** give the fork its own bundle identifier and carry each user's existing data over on first start, without ever touching the old data and without a crash, an error or a second process leaving a broken profile.

**Architecture:** a function `seed_profile` in a new module `src-tauri/src/migrate.rs`, driven by a journaled state machine under a file lock, tested on temporary directories with fault injection at every mutation. `run()` calls it before anything reads or creates the identifier's directories.

**Tech Stack:** Rust (Tauri 2 app crate `openidea`), std only (`std::fs::File::lock`, stable since Rust 1.89; workspace MSRV 1.96), `dirs`, `serde_json`, `tauri-plugin-dialog`.

**Spec:** `docs/superpowers/specs/2026-10-30-release-hardening-design.md`, section 6 and sections 8 to 10. Read it before starting. This plan refines spec 6.2 after the lint by rev-codex and the questions from dev-claude. The coordinator approved the design below under the owner's delegation, and it stands as the design-first sign-off.

## Global Constraints

- Release v0.2.3. It is developed now and consolidated only after v0.2.2 is tagged. Version files stay at `0.2.1`.
- `identifier`: `it.innobitlab.iblopenidea`. `bundle.publisher`: `InnoBitLab S.r.l.`. `mainBinaryName` stays `openidea`. Legacy identifier: `ai.l0ng.openidea`.
- Root-only excluded names, matched only directly under `<base>/<from>`: `cache`, `index`, `lsp`, `server`, `logs`, `webview-dev`, and every name starting with `webview-`. Nested directories with those names (for example `tools/jdk/bin/server`) are copied.
- Source selection:
  - Release builds always seed from `ai.l0ng.openidea`.
  - Debug builds seed only when `IBLOPENIDEA_SEED_FROM` is set and non-empty. Unset or empty means no seeding at all.
  - `from == to`, path separators or `..` in either identifier mean no seeding, with a `warn`.
  - `to` is `context.config().identifier`, never a constant.
- Copy, never move or delete anything under `<from>`.
- No new dependency, not even for tests: temporary test directories use `std::env::temp_dir()` plus a unique name, created and removed by a small helper. No time crate: RFC 3339 timestamps are formatted in UTC by hand.
- Worktree: `<base>/.ibl-crew-worktree/dev-claude`. Branch: `fix/rh-mt-c`. PR into `fix/release-hardening`.
- Until MT-A's build slots are merged (the coordinator tells you), run at most one cargo command at a time with `CARGO_BUILD_JOBS=2`. After that, run cargo through `scripts/local/cargo-slot.ps1`.
- Code, comments and commit messages in English, conventional commits. Every commit ends with `Co-Authored-By` for your model. Never push tags.

## Review Focus

1. The process is killed at any mutation (journal write, copy of a file, phase change, rename, marker, cleanup): the next start converges to a complete profile or to a recorded failure, never to a half profile or a retry loop.
2. Two processes start at once on first run: exactly one copies; the other waits and then finds the seeded profile.
3. Upstream OpenIDEA is running (its WebView profile is locked): the app starts, skips the WebView data and tells the user once, even if it crashes before showing the message.
4. A machine that never had OpenIDEA: nothing copied, no files written, no noise.
5. `tools/` holds nested `server` or `cache` folders and, on macOS or Linux, symlinks: they survive the copy unchanged.

## 1. Context and goal

The fork still uses upstream's identifier, so IBLOpenIdea and an installed OpenIDEA share settings, tools, WebView data and probably the single-instance lock. Changing the identifier later costs more with every new user, so it happens in v0.2.3, with a migration that keeps layouts, presets, agents, local history, scratches and downloaded tools (about 1 GB measured on the owner's machine, spec 6.2).

## 2. Frozen base

`fix/release-hardening` at the commit that adds this revision of the plan. The dispatch message gives its SHA. In your worktree (branch `fix/rh-mt-c`, already pushed): `git fetch origin && git merge --ff-only origin/fix/release-hardening`, then push.

## 3. Solution design

### 3.1 Interface

```rust
pub enum SeedOutcome { NotNeeded, Seeded, Resumed, Failed(String) }
pub struct SeedReport { pub outcome: SeedOutcome, pub copied: Vec<PathBuf>, pub skipped: Vec<(PathBuf, String)>, pub notify_webview_skipped: bool }
pub fn seed_profile(bases: &[PathBuf], from: &str, to: &str) -> SeedReport
pub fn seed_source(debug: bool, env_value: Option<&str>, to: &str) -> Option<String>   // pure source selection
pub fn mark_notified(config_base: &Path, to: &str) -> std::io::Result<()>
```

`seed_profile` deduplicates `bases`. The first base is the config base. An internal `seed_profile_with(.., hooks: &mut dyn FnMut(Step) -> io::Result<()>)` is called before every mutation, so tests can inject a crash or an error at each `Step`.

### 3.2 Files

All files live in the config base, outside every `<to>` directory, so they never make the target look present:

- **Lock:** `<config base>/<to>.migration.lock`. `File::lock()` (exclusive, released by the OS when the process dies) is held for the whole run. A second process blocks on it, then evaluates the state from the beginning.
- **Journal:** `<config base>/<to>.migration.json` with `{"phase": "copying" | "renaming" | "failed", "from", "started", "bases": [participating bases], "copied", "skipped", "error"}`. It is written atomically: write `<name>.tmp`, then rename it over the journal. A journal that cannot be parsed counts as `copying`.
- **Marker:** `<config base>/<to>/.migrated.json` with `{"status": "seeded" | "failed", "from", "app_version", "started", "finished", "files_copied", "bytes_copied", "copied", "skipped", "error", "notified"}`.

### 3.3 State machine

Under the lock, in this order:

| State at start                        | Action                                                                                                                                                                                                                                                                           | Outcome     |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| no journal, `<to>` exists in any base | none                                                                                                                                                                                                                                                                             | `NotNeeded` |
| no journal, no `<from>` in any base   | none, writes nothing                                                                                                                                                                                                                                                             | `NotNeeded` |
| no journal, otherwise                 | write journal `copying` with participating bases (the bases that have `<from>`), then copy each into `<base>/<to>.partial`; write journal `renaming` with `copied` and `skipped`; rename each `.partial` to `<to>`; write marker `seeded`; delete journal                        | `Seeded`    |
| journal `copying` or malformed        | delete every `<to>.partial` of the participating bases, run the copy phase again                                                                                                                                                                                                 | `Resumed`   |
| journal `renaming`                    | for each participating base: `.partial` present and `<to>` absent: rename; `.partial` absent and `<to>` present: already done; both present: delete `.partial` and record it in `skipped` (never merge into a target the app may have written). Then marker, then delete journal | `Resumed`   |
| journal `failed`                      | finish the failure cleanup (delete remaining `.partial`, write marker `failed` if missing, delete journal)                                                                                                                                                                       | `Failed`    |

Error paths:

- **Copy phase I/O error**: write journal `failed` with the error, delete every `.partial`, write marker `failed`, delete journal. No retry on later starts; the source is untouched.
- **Rename error**: retry 5 times, 200 ms apart. If it still fails, delete that base's `.partial`, record it in `skipped` with the error, continue with the other bases, and finish normally.
- **Marker write error after renames**: keep the journal in `renaming`; the next start finishes it.
- **Any error** is recorded in the report and logged. `seed_profile` never panics and never blocks startup, except while it waits on the lock held by another live process.

### 3.4 Copy rules

- Walk each `<base>/<from>`; skip the root-only excluded names.
- Symlinks and junctions are never followed. On macOS and Linux they are recreated with the same target; on Windows they are recorded in `skipped`, which is not fatal.
- Refuse to run when `<from>` and `<to>` resolve to the same path or one is inside the other.
- Count files and bytes for the marker.
- **WebView profile** (`<local base>/<from>/EBWebView`):
  - Probe `EBWebView/Default/LOCK` with a read-only open and `share_mode(0)`, without creating it.
  - Missing `LOCK` means unlocked.
  - A sharing violation means locked: skip `EBWebView`, record it in `skipped` and set `notify_webview_skipped`.
  - If the probe succeeds, keep that handle open while copying `EBWebView`, so no other process can start using the profile mid-copy, and do not copy `LOCK` itself.

### 3.5 `run()` wiring (`src-tauri/src/lib.rs`)

- Right after `tauri::generate_context!()` and before `logging::init`: compute `from` with `seed_source(cfg!(debug_assertions), std::env::var("IBLOPENIDEA_SEED_FROM").ok().as_deref(), &identifier)`. When it is `Some`, call `seed_profile` with bases `dirs::config_dir()`, `dirs::data_dir()` and `dirs::data_local_dir()`.
- Log the report once logging is up.
- In the existing builder setup, read the marker. If `notified` is false and the WebView was skipped, show one non-blocking message with `DialogExt::message(..).show(..)`: "Layouts and other window settings from OpenIDEA were not copied because OpenIDEA was running. Set them up again." Then call `mark_notified`. A crash before the message shows it on the next start.

## 4. Closed allowlist

`src-tauri/tauri.conf.json` (`identifier`, `bundle.publisher` only); `src-tauri/src/migrate.rs` (new); `src-tauri/src/lib.rs` (`run()`, its setup closure and the module declaration only; `export_bindings` belongs to MT-A).

## 5. Ordered tasks

### Task 1: `seed_profile` state machine

**Files:** Create `src-tauri/src/migrate.rs` with its `#[cfg(test)] mod tests`.

- [ ] Tests, all on temporary base directories:
  - `seeds_every_base_and_skips_root_excluded_dirs` (`settings.toml`, `tools/a/b`, `tools/jdk/bin/server/jvm.dll`, `cache/x`, `webview-123/y`: the first three copied, the last two not; marker `seeded` with file and byte counts; journal and lock-free state after; `Seeded`);
  - `does_nothing_when_the_target_exists`; `does_nothing_without_a_source` (no file written in any base);
  - `second_run_is_a_no_op`; `deduplicates_identical_bases`;
  - `refuses_aliased_source_and_target`;
  - `seed_source_rules` (release always legacy; debug unset or empty: `None`; debug set: that value; `from == to`, separators or `..`: `None`);
  - `crash_at_every_step_converges`: for each `Step`, inject an error that simulates a crash, then run again without faults. The final state is either a complete `<to>` with marker `seeded` or marker `failed`, never a `.partial`, a journal or a missing source byte;
  - `malformed_journal_restarts_the_copy`;
  - `finishes_an_interrupted_rename` (journal `renaming`, one base renamed, one `.partial` left);
  - `rename_conflict_keeps_the_target_and_records_the_partial` (journal `renaming`, both `<to>` and `.partial` present);
  - `rename_error_is_retried_then_skipped` (fault on rename 6 times: base in `skipped`, others published, `Seeded`);
  - `copy_error_gives_up_without_touching_the_source` (an unreadable source file: on Windows held open with `share_mode(0)`, elsewhere mode `000`, restored after the assertion; outcome `Failed`, no `.partial`, no journal, marker `failed`, source content identical, a second call returns `NotNeeded`);
  - `second_caller_waits_and_finds_the_seeded_profile` (two threads with separate handles on the lock file; the second blocks until the first finishes, then returns `NotNeeded`);
  - `#[cfg(windows)] skips_a_locked_webview_profile` (`LOCK` held with `share_mode(0)`: `EBWebView` skipped, `notify_webview_skipped`, rest copied);
  - `copies_a_webview_profile_whose_lock_is_free` and `copies_a_webview_profile_without_lock`;
  - `#[cfg(unix)] recreates_symlinks_with_the_same_target`;
  - `notification_is_reported_once` (`mark_notified` flips `notified`; a second read does not ask again).
- [ ] Run `cargo test -p openidea migrate`: fails.
- [ ] Implement per section 3. Run: passes.
- [ ] Commit.

### Task 2: New identifier and startup wiring

**Files:** Modify `src-tauri/tauri.conf.json`, `src-tauri/src/lib.rs`.

- [ ] Set `identifier` and `bundle.publisher`. Wire `seed_source`, `seed_profile`, logging and the one-time message into `run()` as in section 3.5.
- [ ] `cargo build -p openidea`, `cargo test -p openidea` and `cargo clippy --workspace --all-targets -- -D warnings` pass, apart from failures already present at the frozen base. Record your baseline run.
- [ ] Manual check (spec B3): with MT-A's `pnpm dev:local -SeedFrom ai.l0ng.openidea` if it is merged, otherwise a debug run with `IBLOPENIDEA_SEED_FROM=ai.l0ng.openidea` and `--config` overriding `identifier` to `it.innobitlab.iblopenidea.dev.mtc`. The first start copies and writes the marker; the second start logs `NotNeeded`. Record the marker's times and sizes. Do not run a debug build against the real `it.innobitlab.iblopenidea` profile. Debug builds use `webview-dev`, so B3 does not prove the localStorage carry-over; only spec B1 does.
- [ ] Commit, push, open the PR (`gh pr create --base fix/release-hardening --title "MT-C: identifier and migration"`).

### Task 3: CI green

- [ ] Fix what `ci.yml` reports inside the allowlist.

## 6. Verification (exact commands)

```powershell
cargo test -p openidea migrate
cargo test -p openidea
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
gh pr checks --watch
```

Run each cargo line through `scripts/local/cargo-slot.ps1 --` once it is available. CI runs `cargo nextest run --workspace` on three systems; the PR is the binding gate.

## 7. Definition of Done

- Tasks 1 to 3 committed on `fix/rh-mt-c`, pushed, PR open into `fix/release-hardening`, every `ci.yml` job green.
- Every test in Task 1 exists and passes, and was seen failing first.
- The manual B3 check is recorded with times and sizes.
- Delivery `res` to the coordinator via the bridge: frozen SHA, PR URL, CI run URL, outputs of section 6, the baseline, the B3 record, and anything NOT_VERIFIED.

## 8. Acceptance criteria

| Criterion                                                                         | Verified by                                                     |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Existing data is copied once, caches are not, nested folders and links survive    | Task 1 copy tests                                               |
| No crash, error or concurrent start leaves a broken profile or changes the source | `crash_at_every_step_converges`, failure, rename and lock tests |
| A locked WebView profile does not block startup and the user is told once         | WebView and notification tests; message in `run()`              |
| The new identifier and publisher are in the bundle                                | Task 2 diff; spec B1 on the release candidate                   |
| Upgrade from v0.2.2 through the real updater keeps the data                       | spec B1 in Windows Sandbox (reviewer or integrator)             |

## 9. Risks and NOT_VERIFIED

- NSIS upgrade across a manufacturer and identifier change: NOT_VERIFIED; spec B1.
- `tauri dev --config` overriding the compiled identifier: NOT_VERIFIED (MT-A checks it first). If it does not work, report it; do not change `run()` to work around it.
- Holding the WebView `LOCK` during the copy could make an upstream OpenIDEA started in that window fail to open its WebView: accepted, because the window is seconds long and only on first start.
- Copy time for about 1 GB of small files: not measured; record it in Task 2.
- A second instance started during a long first-run copy waits without a window: accepted for v0.2.3; the marker records the duration.
