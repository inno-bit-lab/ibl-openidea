# Visible feedback during the first-start profile migration: design

- **Date**: 2026-10-31
- **Status**: Proposal for the coordinator (request `6F24B4`), defect D1.
- **Author**: `rev-claude` (architect role, read-only on `next/v0.3.1` = `5e1b50a6`).
- **Release**: v0.3.1.
- **Sources**: rev-codex analysis `837892` (section D1); line numbers below are for `5e1b50a6` and were read with `git show`.

## 1. Problem

On the first start of 0.2.3-2 after the update, the owner's PC showed no window for about 94 s ("first IPC 94382 ms ... setup at 92663 ms"). `seed_profile` was copying 18,895 files, 1.23 GB (EBWebView, tools, acp-agents). The owner thought the app was dead and started it again; the second start reported `Resumed` and the final profile was correct. These figures come from the owner's log; nobody has measured them again.

The cause is the bootstrap order in `src-tauri/src/lib.rs`:
- `seed_profile` runs synchronously at :50-58, before `logging::init` (:59), the managed tool `PATH` (:68-72), the single-instance plugin (:84), `AppState::new` (:107) and `create_main_window` (:123). `main` has `create: false` in `tauri.conf.json`, so nothing is on screen until setup.
- `migrate::seed_profile` passes an empty hook (`migrate.rs:119-121`), and the copy loop updates only the report counters (`:485-486`).
- A second start also reaches the seeding before the single-instance check. It waits on the migration lock (`:265-273`), which protects the profile but shows nothing.
- The exclusions (`:32-33`) do not cover `EBWebView`, tools or `acp-agents`, so the copy is large on Windows.

The ordering itself is correct: nothing may read or create the `<to>` profile before the copy is published (`lib.rs:48`, `migrate.rs:1-12`). The fix keeps that gate and adds feedback.

## 2. Options

| Option | Result | Verdict |
|---|---|---|
| A. Native Windows task dialog on a helper thread, started before `seed_profile` | Visible within a second, no profile access, no Tauri or WebView involved | **Chosen** |
| B. WebView splash window in Tauri, with a separate WebView data directory | The seed must move after the Tauri builder. Logging, window-state, the updater and AppState would then have to be shown not to create `<to>` first, and WebView2 start-up adds its own delay | Rejected for v0.3.1 |
| C. Hand-written Win32 window (`CreateWindowExW`, progress control, message loop) | Same behaviour as A, about three times the code | Fallback if A does not hold up in Task 4 |
| D. Lazy migration of tools and `acp-agents` | Needs a gate per component and consistent manifests; the tool `PATH` is set right after the seed (`lib.rs:68-72`) | Rejected (mandate) |
| E. Copy less: leave out WebView caches (`EBWebView/Default/Cache`, `Code Cache`, `GPUCache`) | Shorter copy, still no feedback | Optional follow-up, separate decision |

## 3. Decision

**a. `migrate.rs`: a progress record, no change to the state machine.**
- `pub struct Progress` holds atomics: `phase` (`Checking`, `WaitingForOtherStart`, `Copying`, `Publishing`, `Done`), `files`, `bytes`. A new `pub fn seed_profile_with_progress(bases, from, to, progress: &Progress)` does what `seed_profile` does; `seed_profile` keeps its signature and passes a throwaway record.
- `Run` gets a `progress` reference. `copy_entry` adds to `files` and `bytes` next to the report counters (`:485-486`), and the phase changes at the existing points: the copy phase journal write (`:354-355`), the rename phase (`:363`, `publish` `:370`), and the end of `start`.
- Where `lock.lock()` is today (`:273`), `start` first calls `lock.try_lock()` on the same handle. On success it keeps that lock and does not call `lock()`: the std documentation leaves a second lock on a handle that already holds one unspecified, and it may deadlock. Only `WouldBlock` means another start is migrating: phase `WaitingForOtherStart`, then the blocking `lock()` as today. Any other error is an I/O fault, as today.
- The journal, the partial copies, the renames, the marker and the hook for tests keep their behaviour. No new file is written.

**b. `src-tauri/src/migration_feedback.rs` (new, Windows only; a no-op on other systems).**
- `start(progress: Arc<Progress>) -> Feedback` spawns a thread. That thread waits up to 500 ms on a channel (`recv_timeout`), not with a sleep. Release builds call `start` on every launch, because `seed_from` is always the legacy identifier there; when `finish()` signals before the timeout, the thread ends without a dialog and `finish()` returns at once, so a start with nothing to migrate pays no delay. After the timeout, if the phase is not `Done`, the thread opens a `TaskDialogIndirect`:
  - A window title used only by this dialog ("IBLOpenIdea: updating your profile", translated), a fixed main instruction, a marquee progress bar, and a text line updated on every `TDN_TIMER` (about 200 ms): the phase, then "N files, X MB copied".
  - The only button is disabled at `TDN_CREATED`, there is no Cancel, and `TDN_BUTTON_CLICKED` returns `S_FALSE` until the phase is `Done`, so the user cannot dismiss the dialog; a closed dialog would bring back the silent start. The copy is never cancelled from the UI. A user who ends the process anyway gets the existing journal recovery (`Resumed`).
  - When the phase becomes `Done`, the timer callback enables the button and sends `TDM_CLICK_BUTTON`; the click handler then returns `S_OK` and the dialog closes. That close path is NOT_VERIFIED until W3 runs.
  - The thread runs before `logging::init`, so it cannot log. A failure, such as `TaskDialogIndirect` returning an error, is recorded in `Progress`, and `lib.rs` logs it after `logging::init`, together with whether the dialog was shown and for how long.
- The thread calls `SetThreadDpiAwarenessContext(PER_MONITOR_AWARE_V2)` for itself only, because the manifest declares no DPI awareness (`windows-app-manifest.xml`) and tao sets the process awareness only later.
- The module performs no file access, opens no WebView and uses no Tauri API, so it cannot create `<to>`. `Common-Controls` v6, which `TaskDialogIndirect` needs, is already in the embedded manifest (`build.rs`).
- A second start during the copy (`WaitingForOtherStart`) looks for the first start's dialog: a window of class `#32770` with this dialog's exact title, owned by a process whose executable path equals the current one (`EnumWindows`, `GetWindowThreadProcessId`, `QueryFullProcessImageNameW`). The title alone is not enough: the main window and the WebView notice (`lib.rs:132`) also carry the app name, and debug builds use one identifier per worktree, which the executable path tells apart. It brings that dialog to the front and shows nothing of its own. If no dialog is found yet, it shows its own dialog with the text "Another IBLOpenIdea start is updating your profile". After the lock it gets `NotNeeded` and continues as today; the single-instance plugin then hands its arguments to the remaining process.
- `Feedback::finish()` sets `Done` and waits at most 2 s for the thread, so a stuck dialog can never block the start.
- Text in English, Italian and Chinese, compiled in and chosen from `GetUserDefaultUILanguage`. The app's language setting lives in the profile being migrated, and the frontend catalogs are not loaded yet. Italian is checked against the glossary.
- `windows-sys` 0.61 is already in `Cargo.lock` (0.61.2). `openidea` adds it as a Windows-only dependency with the `Win32_UI_Controls`, `Win32_UI_WindowsAndMessaging`, `Win32_UI_HiDpi`, `Win32_Globalization`, `Win32_System_Threading` and `Win32_Foundation` features. `Cargo.lock` gains one line in `openidea`'s dependency list and no new crate.

**c. `lib.rs`, the only change in the bootstrap.**

```rust
let progress = Arc::new(migrate::Progress::default());
let feedback = seed_from.as_ref().map(|_| migration_feedback::start(progress.clone()));
let seeded = seed_from.map(|from| {
    let report = migrate::seed_profile_with_progress(&migrate::profile_bases(), &from, &identifier, &progress);
    (from, report)
});
if let Some(feedback) = feedback { feedback.finish(); }
logging::init(&context.config().identifier); // unchanged from here on
// after the existing report.log(..): log progress.feedback_error() and whether the dialog was shown
```

Everything after the seed keeps its place, so `AppState`, the plugins and the window still open only after `seed_profile_with_progress` returns. A start with nothing to migrate returns `NotNeeded` from the lock-free check (`:261-263`); `finish()` then interrupts the 500 ms wait, and no dialog appears.

## 4. Tests

RED baseline: `next/v0.3.1` at the dispatch SHA. The new API does not compile there; record that as compile-RED, then use a temporary stub whose `Progress` never changes for the behavioural RED. The stub is never committed.

- **W1, copy barrier** (`migrate.rs` tests, every OS), `progress_is_published_before_the_copy_and_the_target_stays_closed`. The existing `Fixture`, with a hook that blocks on the first `Step::Copy`, as `second_caller_waits_and_finds_the_seeded_profile` does (`:1326-1357`). While it blocks:
  - the phase is `Copying`, which the dialog reads;
  - no `<to>` directory exists in any base, only `<to>.partial`, the journal and the lock. This is the "AppState not yet open" condition: nothing has published the profile.
  After the barrier is released: `Seeded`, `files` and `bytes` equal the report counters, and the target equals `expected(base)`.
- **W2, second start** (same module), `second_start_during_the_copy_reports_waiting_and_converges`. A second thread calls `seed_profile_with_progress` while W1's barrier holds. Its phase becomes `WaitingForOtherStart` and it does not return within 500 ms. After the release: the first gets `Seeded`, the second `NotNeeded`, and both targets are intact.
- **W3, the combined witness** (`migration_feedback.rs`, `cfg(windows)`), `dialog_is_visible_while_the_copy_is_blocked_and_the_target_is_closed`. `migrate` and `migration_feedback` are in the same crate, so the test drives both: it calls `start()`, then runs `seed_profile_with_progress` on a thread through a `#[cfg(test)]` variant that takes W1's barrier hook. While the barrier holds, at the same moment:
  - the dialog is found (class `#32770`, its title, this executable) and its text shows the counters;
  - no `<to>` directory exists in any base.
  It then releases the barrier and calls `finish()`, and asserts that the window is gone, the thread has ended and the outcome is `Seeded`. A second `start()` in `WaitingForOtherStart` must find the first dialog and open none of its own.
- **W4, no delay without a migration** (`migration_feedback.rs`, every OS): `finish()` on a feedback whose dialog was never shown returns within 50 ms, and no window is created.
- **W5, bootstrap order**: the review checks that in `run()` only the lines of 3c changed and that `AppState::new` and `create_main_window` are still after the seed. No test can start Tauri's setup without a display; the manual run below covers it.
- The existing `migrate.rs` tests stay unchanged and green, including `crash_at_every_step_converges` and the journal, partial and rename tests.
- **Manual run on Windows**: a debug build, which has its own identifier per worktree, with `IBLOPENIDEA_SEED_FROM` set to a synthetic identifier (for example `ibl-d1-synthetic`). `SEED_FROM` names an identifier, not a path, so the synthetic profile of about 20,000 files and 1 GB is generated under the profile bases with that name and removed afterwards, together with the debug target. The owner's real profiles are never used. Check:
  - the dialog appears within a second and its counters move;
  - the main window appears after the dialog closes and takes focus;
  - a second start during the copy brings the dialog to the front, shows no second app window, and its path argument reaches the first window;
  - ending the process during the copy, then starting again: dialog, `Resumed`, intact profile.

## 5. Risks and NOT_VERIFIED

- The close path (enable, then `TDM_CLICK_BUTTON`, with `S_FALSE` refusals before `Done`) is NOT_VERIFIED until W3 runs. If it does not close the dialog, option C replaces A.
- Whether hosted `windows-latest` runners can create the W3 dialog is NOT_VERIFIED. If they cannot, W3 must fail rather than be skipped, and the delivery reports it.
- Focus hand-over from the dialog to the main window is NOT_VERIFIED; the manual run records it.
- macOS and Linux: no feedback in this tranche. The legacy profile exists there too (v0.2.2-2 ships `.dmg`, `.AppImage` and `.deb`), but the measured case is Windows, where `EBWebView` dominates the size. NOT_VERIFIED how long the copy takes on those systems; a follow-up decision.
- Two starts racing after the lock is released: the single-instance mutex (`lib.rs:84`) decides which process stays, as today. This design does not change it.
- The dialog strings live in Rust, outside the `text/*.json` catalogs, so the catalog CI gate does not cover them. The delivery lists them with their Italian text.
- Option E (leaving out WebView caches) would shorten the copy, but it changes what is migrated. It needs its own decision.

## 6. Decisions requested from the coordinator

1. Option A, with C as fallback.
2. Windows only in v0.3.1, with macOS and Linux as a follow-up.
3. Whether option E goes into the same tranche or a later one.
