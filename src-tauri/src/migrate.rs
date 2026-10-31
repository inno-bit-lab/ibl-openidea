//! First-start migration of the user profile to the fork's own identifier.
//!
//! Up to v0.2.2 the fork used upstream's bundle identifier, so its settings,
//! tools and WebView data live under `ai.l0ng.openidea`. On the first start
//! under the new identifier, [`seed_profile`] copies those directories (never
//! moves them: an installed upstream OpenIDEA keeps using its own) before
//! anything reads or creates the new ones.
//!
//! Each base is copied into `<to>.partial` and renamed into place, under a
//! file lock and with a journal next to the target, so a crash, an I/O error
//! or a second process never leaves a half-written profile. The full state
//! table is in `docs/superpowers/plans/2026-10-30-mt-c-identity.md`, section 3.

use std::ffi::{OsStr, OsString};
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write as _};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU8, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// Identifier used by OpenIDEA, and by IBLOpenIdea up to v0.2.2.
pub const LEGACY_IDENTIFIER: &str = "ai.l0ng.openidea";
/// Debug builds seed only from the identifier named by this variable.
pub const SEED_FROM_ENV: &str = "IBLOPENIDEA_SEED_FROM";
/// Shown once when the WebView profile could not be copied.
pub const WEBVIEW_SKIPPED_MESSAGE: &str = "Layouts and other window settings from OpenIDEA were not copied \
     because OpenIDEA was running. Set them up again.";

/// Directories directly under `<from>` that the app rebuilds on demand.
const EXCLUDED: &[&str] = &["cache", "index", "lsp", "server", "logs", "webview-dev", "notebook-runtime"];
const EXCLUDED_PREFIX: &str = "webview-";
/// WebView2 user-data directory, locked by a running WebView.
const WEBVIEW_DIR: &str = "EBWebView";
const MARKER: &str = ".migrated.json";
/// One attempt plus five retries.
const RENAME_ATTEMPTS: usize = 6;
const RENAME_DELAY: Duration = Duration::from_millis(200);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum ProgressPhase {
    Checking,
    WaitingForOtherStart,
    Copying,
    Publishing,
    Done,
}

/// Bootstrap feedback kept entirely in memory, independent of the profile.
#[derive(Default)]
pub struct Progress {
    phase: AtomicU8,
    files: AtomicU64,
    bytes: AtomicU64,
    feedback_error: Mutex<Option<String>>,
    dialog_shown_ms: AtomicU64,
    last_content: Mutex<String>,
}

impl Progress {
    // Native feedback reads phase/counters on Windows; portable migration tests also use them.
    #[cfg_attr(not(windows), allow(dead_code))]
    pub fn phase(&self) -> ProgressPhase {
        match self.phase.load(Ordering::Acquire) {
            0 => ProgressPhase::Checking,
            1 => ProgressPhase::WaitingForOtherStart,
            2 => ProgressPhase::Copying,
            3 => ProgressPhase::Publishing,
            _ => ProgressPhase::Done,
        }
    }

    pub(crate) fn set_phase(&self, phase: ProgressPhase) {
        self.phase.store(phase as u8, Ordering::Release);
    }

    #[cfg_attr(not(windows), allow(dead_code))]
    pub fn files(&self) -> u64 {
        self.files.load(Ordering::Relaxed)
    }

    #[cfg_attr(not(windows), allow(dead_code))]
    pub fn bytes(&self) -> u64 {
        self.bytes.load(Ordering::Relaxed)
    }

    fn set_counters(&self, files: u64, bytes: u64) {
        self.files.store(files, Ordering::Relaxed);
        self.bytes.store(bytes, Ordering::Relaxed);
    }

    pub fn feedback_error(&self) -> Option<String> {
        self.feedback_error.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    #[cfg(windows)]
    pub(crate) fn set_feedback_error(&self, error: String) {
        let mut stored = self.feedback_error.lock().unwrap_or_else(|e| e.into_inner());
        if stored.is_none() {
            *stored = Some(error);
        }
    }

    pub fn dialog_shown_ms(&self) -> u64 {
        self.dialog_shown_ms.load(Ordering::Relaxed)
    }

    #[cfg(windows)]
    pub(crate) fn set_dialog_shown_ms(&self, milliseconds: u64) {
        // Zero means that no dialog was ever shown, including a sub-millisecond dialog.
        self.dialog_shown_ms.store(milliseconds.max(1), Ordering::Relaxed);
    }

    pub fn last_content(&self) -> String {
        self.last_content.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    #[cfg(windows)]
    pub(crate) fn set_last_content(&self, content: String) {
        *self.last_content.lock().unwrap_or_else(|e| e.into_inner()) = content;
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SeedOutcome {
    /// Already seeded, or there is no legacy profile.
    NotNeeded,
    Seeded,
    /// Finished a run that a crash or an error had interrupted.
    Resumed,
    /// Nothing was published. Also returned when seeding is refused.
    Failed(String),
}

#[derive(Debug)]
pub struct SeedReport {
    pub outcome: SeedOutcome,
    /// Copied entries, by source path, at the top level of each `<base>/<from>`.
    pub copied: Vec<PathBuf>,
    pub skipped: Vec<(PathBuf, String)>,
    pub files_copied: u64,
    pub bytes_copied: u64,
    /// The WebView profile was in use; the user is told once (see [`webview_notice_pending`]).
    pub notify_webview_skipped: bool,
    /// Errors that did not change the outcome (cleanup, marker), for the log.
    pub errors: Vec<String>,
}

impl SeedReport {
    fn new() -> Self {
        Self {
            outcome: SeedOutcome::NotNeeded,
            copied: Vec::new(),
            skipped: Vec::new(),
            files_copied: 0,
            bytes_copied: 0,
            notify_webview_skipped: false,
            errors: Vec::new(),
        }
    }

    pub fn log(&self, from: &str, to: &str) {
        match &self.outcome {
            SeedOutcome::NotNeeded => tracing::debug!("profile seeding from {from} to {to}: NotNeeded"),
            SeedOutcome::Seeded | SeedOutcome::Resumed => tracing::info!(
                "profile seeding from {from} to {to}: {:?}, {} files, {} bytes, copied {:?}",
                self.outcome,
                self.files_copied,
                self.bytes_copied,
                self.copied
            ),
            SeedOutcome::Failed(e) => tracing::warn!("profile seeding from {from} to {to} failed: {e}"),
        }
        for (path, reason) in &self.skipped {
            tracing::info!("profile seeding skipped {}: {reason}", path.display());
        }
        if self.notify_webview_skipped {
            tracing::info!("profile seeding: the WebView profile was in use; the user is told once");
        }
        for e in &self.errors {
            tracing::warn!("profile seeding: {e}");
        }
    }
}

/// The directories that hold a profile, config base first. On Windows the
/// first two are the same; [`seed_profile`] deduplicates them.
pub fn profile_bases() -> Vec<PathBuf> {
    [dirs::config_dir(), dirs::data_dir(), dirs::data_local_dir()].into_iter().flatten().collect()
}

/// The identifier to seed `to` from, if any. Release builds always seed from
/// the legacy identifier; debug builds only from a non-empty `env_value`.
pub fn seed_source(debug: bool, env_value: Option<&str>, to: &str) -> Option<String> {
    let from = if debug { env_value.filter(|v| !v.is_empty())? } else { LEGACY_IDENTIFIER };
    check_identifiers(from, to).ok().map(|()| from.to_owned())
}

/// Copies the `from` profile into `to` in every base when `to` exists in
/// none of them. Never panics, never changes `from`, and returns once this or
/// another process has finished the job.
// Retained entry point for callers that do not need bootstrap feedback.
#[allow(dead_code)]
pub fn seed_profile(bases: &[PathBuf], from: &str, to: &str) -> SeedReport {
    seed_profile_with_progress(bases, from, to, &Progress::default())
}

/// The same migration, with an in-memory progress record for bootstrap feedback.
pub fn seed_profile_with_progress(bases: &[PathBuf], from: &str, to: &str, progress: &Progress) -> SeedReport {
    seed_run(bases, from, to, progress, &mut |_| Ok(()), RENAME_DELAY)
}

/// Whether the marker asks to tell the user that the WebView profile was not copied.
pub fn webview_notice_pending(config_base: &Path, to: &str) -> bool {
    read_marker(&marker_path(config_base, to)).is_some_and(|m| m.webview_skipped && !m.notified)
}

/// Records in the marker that the user was told.
pub fn mark_notified(config_base: &Path, to: &str) -> io::Result<()> {
    let path = marker_path(config_base, to);
    let mut marker =
        read_marker(&path).ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "no readable migration marker"))?;
    marker.notified = true;
    write_json_atomic(&path, &marker)
}

/// A mutation, announced to the hook right before it happens.
#[derive(Debug)]
enum Step {
    WriteJournal(Phase),
    RemoveJournal,
    RemovePartial(PathBuf),
    Copy(PathBuf),
    Rename(PathBuf),
    WriteMarker,
}

impl fmt::Display for Step {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Step::WriteJournal(phase) => write!(f, "write the journal ({phase:?})"),
            Step::RemoveJournal => f.write_str("remove the journal"),
            Step::RemovePartial(base) => write!(f, "remove the partial copy in {}", base.display()),
            Step::Copy(path) => write!(f, "copy to {}", path.display()),
            Step::Rename(base) => write!(f, "rename the copy in {}", base.display()),
            Step::WriteMarker => f.write_str("write the marker"),
        }
    }
}

enum Fault {
    Io(io::Error),
    /// Simulated process death: unwinds without any cleanup. Only tests inject it.
    #[cfg_attr(not(test), allow(dead_code))]
    Crash,
}

impl From<io::Error> for Fault {
    fn from(e: io::Error) -> Self {
        Fault::Io(e)
    }
}

type Hook<'a> = &'a mut dyn FnMut(&Step) -> Result<(), Fault>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Phase {
    Copying,
    Renaming,
    Failed,
}

#[derive(Debug, Serialize, Deserialize)]
struct Journal {
    phase: Phase,
    from: String,
    started: String,
    /// The bases that hold `<from>`.
    bases: Vec<PathBuf>,
    #[serde(default)]
    copied: Vec<PathBuf>,
    #[serde(default)]
    skipped: Vec<(PathBuf, String)>,
    #[serde(default)]
    files_copied: u64,
    #[serde(default)]
    bytes_copied: u64,
    #[serde(default)]
    webview_skipped: bool,
    #[serde(default)]
    error: Option<String>,
}

enum JournalState {
    Absent,
    Malformed,
    Valid(Journal),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Marker {
    status: String,
    from: String,
    app_version: String,
    started: String,
    finished: String,
    files_copied: u64,
    bytes_copied: u64,
    copied: Vec<PathBuf>,
    skipped: Vec<(PathBuf, String)>,
    error: Option<String>,
    #[serde(default)]
    webview_skipped: bool,
    #[serde(default)]
    notified: bool,
}

#[cfg(test)]
fn seed_profile_with(bases: &[PathBuf], from: &str, to: &str, hook: Hook<'_>, rename_delay: Duration) -> SeedReport {
    seed_run(bases, from, to, &Progress::default(), hook, rename_delay)
}

fn seed_run(
    bases: &[PathBuf],
    from: &str,
    to: &str,
    progress: &Progress,
    hook: Hook<'_>,
    rename_delay: Duration,
) -> SeedReport {
    let bases = dedup(bases);
    let Some(config) = bases.first().cloned() else {
        progress.set_phase(ProgressPhase::Done);
        return SeedReport::new();
    };
    let mut run =
        Run { bases, config, from, to, progress, hook, rename_delay, report: SeedReport::new(), keep_journal: false };
    run.report.outcome = match run.start() {
        Ok(outcome) => outcome,
        Err(Fault::Io(e)) => SeedOutcome::Failed(e.to_string()),
        Err(Fault::Crash) => SeedOutcome::Failed("interrupted".to_owned()),
    };
    progress.set_phase(ProgressPhase::Done);
    run.report
}

struct Run<'a> {
    /// Deduplicated; the first one is the config base.
    bases: Vec<PathBuf>,
    config: PathBuf,
    from: &'a str,
    to: &'a str,
    progress: &'a Progress,
    hook: Hook<'a>,
    rename_delay: Duration,
    report: SeedReport,
    /// A partial copy could not be removed: the next start tries again.
    keep_journal: bool,
}

impl Run<'_> {
    fn start(&mut self) -> Result<SeedOutcome, Fault> {
        if let Err(reason) = check_identifiers(self.from, self.to) {
            return Ok(SeedOutcome::Failed(reason));
        }
        // Without the lock: a machine that never had the legacy profile gets
        // no file at all, and a finished migration costs a few stats.
        if !exists(&self.journal_path()) && (exists(&self.marker_path()) || self.participating().is_empty()) {
            return Ok(SeedOutcome::NotNeeded);
        }
        fs::create_dir_all(&self.config)?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.config.join(format!("{}.migration.lock", self.to)))?;
        // Released by the OS if this process dies. A second process waits
        // here, then evaluates the state from the beginning.
        match lock.try_lock() {
            Ok(()) => {}
            Err(std::fs::TryLockError::WouldBlock) => {
                self.progress.set_phase(ProgressPhase::WaitingForOtherStart);
                lock.lock()?;
            }
            Err(std::fs::TryLockError::Error(error)) => return Err(Fault::Io(error)),
        }
        self.locked()
    }

    fn locked(&mut self) -> Result<SeedOutcome, Fault> {
        let journal = match read_journal(&self.journal_path()) {
            JournalState::Absent => {
                if self.bases.iter().any(|b| exists(&b.join(self.to))) {
                    return Ok(SeedOutcome::NotNeeded);
                }
                let participating = self.participating();
                if participating.is_empty() {
                    return Ok(SeedOutcome::NotNeeded);
                }
                let journal = Journal::new(self.from, rfc3339(SystemTime::now()), participating);
                return self.copy_and_publish(journal, SeedOutcome::Seeded);
            }
            JournalState::Malformed => None,
            JournalState::Valid(journal) => Some(journal),
        };
        // A journal is persisted input, not authority to mutate other profiles.
        if let Some(journal) = &journal
            && (journal.from != self.from
                || journal.bases.iter().any(|base| !self.bases.contains(base))
                || dedup(&journal.bases).len() != journal.bases.len())
        {
            return Ok(SeedOutcome::Failed("refused: journal does not belong to this migration".to_owned()));
        }
        // Check every destination before recovery renames, removes or writes anything,
        // including the config target when it is not a participating source base.
        for base in &self.bases {
            if let Err(reason) = self.check_destinations(base) {
                return Ok(SeedOutcome::Failed(reason));
            }
            if base.join(self.from).is_dir()
                && let Err(reason) = self.check_alias(base)
            {
                return Ok(SeedOutcome::Failed(reason));
            }
        }
        match journal {
            Some(journal) if journal.phase == Phase::Renaming => {
                self.restore_report(&journal);
                self.publish(journal, SeedOutcome::Resumed)
            }
            Some(journal) if journal.phase == Phase::Failed => {
                self.restore_report(&journal);
                let error = journal.error.clone().unwrap_or_default();
                self.finish_failure(&journal)?;
                Ok(SeedOutcome::Failed(error))
            }
            journal => {
                // Crashed while copying, or the journal is unreadable: copy again.
                let started = journal.map_or_else(|| rfc3339(SystemTime::now()), |j| j.started);
                let journal = Journal::new(self.from, started, self.participating());
                self.copy_and_publish(journal, SeedOutcome::Resumed)
            }
        }
    }

    fn copy_and_publish(&mut self, mut journal: Journal, outcome: SeedOutcome) -> Result<SeedOutcome, Fault> {
        for base in &journal.bases {
            if let Err(reason) = self.check_alias(base) {
                return Ok(SeedOutcome::Failed(reason));
            }
        }
        match self.copy_phase(&mut journal) {
            Ok(()) => self.publish(journal, outcome),
            Err(Fault::Io(e)) => {
                let error = e.to_string();
                journal.error = Some(error.clone());
                self.fail(journal)?;
                Ok(SeedOutcome::Failed(error))
            }
            Err(Fault::Crash) => Err(Fault::Crash),
        }
    }

    /// Copies every participating base into `<to>.partial` and records the
    /// result in the journal, ready to rename.
    fn copy_phase(&mut self, journal: &mut Journal) -> Result<(), Fault> {
        self.progress.set_phase(ProgressPhase::Copying);
        journal.phase = Phase::Copying;
        self.write_journal(journal)?;
        for base in self.bases.clone() {
            self.remove_partial(&base)?;
        }
        self.report = SeedReport { errors: std::mem::take(&mut self.report.errors), ..SeedReport::new() };
        self.progress.set_counters(0, 0);
        for base in journal.bases.clone() {
            self.copy_root(&base.join(self.from), &partial_path(&base, self.to))?;
        }
        journal.phase = Phase::Renaming;
        self.progress.set_phase(ProgressPhase::Publishing);
        self.save_report(journal);
        self.write_journal(journal)
    }

    /// Renames each copy into place and writes the marker. The journal is
    /// in `renaming` on disk.
    fn publish(&mut self, mut journal: Journal, outcome: SeedOutcome) -> Result<SeedOutcome, Fault> {
        self.progress.set_phase(ProgressPhase::Publishing);
        for base in journal.bases.clone() {
            let partial = partial_path(&base, self.to);
            let target = base.join(self.to);
            match (exists(&partial), exists(&target)) {
                (true, false) => {
                    if let Some(e) = self.rename_with_retries(&base, &partial, &target)? {
                        self.report.skipped.push((partial, format!("could not be renamed: {e}")));
                        self.discard_partial(&base)?;
                    }
                }
                (true, true) => {
                    // The app already started without this copy: never merge into it.
                    self.report.skipped.push((partial, "the target already existed; copy discarded".to_owned()));
                    self.discard_partial(&base)?;
                }
                (false, true) => {}
                (false, false) => self.report.skipped.push((base.join(&journal.from), "copy missing".to_owned())),
            }
        }
        self.save_report(&mut journal);
        let marker = self.marker(&journal, "seeded");
        let (config, to) = (self.config.clone(), self.to);
        if !self.attempt(Step::WriteMarker, || write_marker(&config, to, &marker))? || self.keep_journal {
            // The journal stays in `renaming`: the next start finishes it.
            return Ok(outcome);
        }
        let journal_path = self.journal_path();
        self.attempt(Step::RemoveJournal, || fs::remove_file(&journal_path))?;
        Ok(outcome)
    }

    /// A copy error: nothing is published and later starts do not retry.
    fn fail(&mut self, mut journal: Journal) -> Result<(), Fault> {
        journal.phase = Phase::Failed;
        self.report.copied.clear();
        self.report.files_copied = 0;
        self.report.bytes_copied = 0;
        self.progress.set_counters(0, 0);
        self.report.notify_webview_skipped = false;
        self.save_report(&mut journal);
        let path = self.journal_path();
        self.attempt(Step::WriteJournal(Phase::Failed), || write_json_atomic(&path, &journal))?;
        self.finish_failure(&journal)
    }

    fn finish_failure(&mut self, journal: &Journal) -> Result<(), Fault> {
        let mut clean = true;
        for base in self.bases.clone() {
            let partial = partial_path(&base, self.to);
            if exists(&partial) {
                clean &= self.attempt(Step::RemovePartial(base), || fs::remove_dir_all(&partial))?;
            }
        }
        if !exists(&self.marker_path()) {
            let marker = self.marker(journal, "failed");
            let (config, to) = (self.config.clone(), self.to);
            clean &= self.attempt(Step::WriteMarker, || write_marker(&config, to, &marker))?;
        }
        if clean {
            let path = self.journal_path();
            self.attempt(Step::RemoveJournal, || fs::remove_file(&path))?;
        }
        Ok(())
    }

    fn copy_root(&mut self, src: &Path, dst: &Path) -> Result<(), Fault> {
        self.step(Step::Copy(dst.to_path_buf()))?;
        fs::create_dir(dst).map_err(at(dst))?;
        for (path, name) in sorted_entries(src)? {
            if is_excluded(&name) {
                self.report.skipped.push((path, "rebuilt on demand".to_owned()));
            } else if name == WEBVIEW_DIR && fs::symlink_metadata(&path).is_ok_and(|m| m.is_dir()) {
                self.copy_webview(&path, &dst.join(&name))?;
            } else {
                self.copy_entry(&path, &dst.join(&name), None)?;
                self.report.copied.push(path);
            }
        }
        Ok(())
    }

    /// Copies a WebView2 profile only when no WebView is using it, and keeps
    /// it closed to WebView2 until the copy ends.
    fn copy_webview(&mut self, src: &Path, dst: &Path) -> Result<(), Fault> {
        let lock = src.join("Default").join("LOCK");
        match probe_webview_lock(&lock) {
            Err(reason) => {
                self.report.skipped.push((src.to_path_buf(), format!("in use by a running WebView: {reason}")));
                self.report.notify_webview_skipped = true;
            }
            Ok(_held) => {
                self.copy_entry(src, dst, Some(&lock))?;
                self.report.copied.push(src.to_path_buf());
            }
        }
        Ok(())
    }

    /// Copies a file, a link or a whole directory. Links are never followed.
    fn copy_entry(&mut self, src: &Path, dst: &Path, except: Option<&Path>) -> Result<(), Fault> {
        if except == Some(src) {
            return Ok(());
        }
        let kind = fs::symlink_metadata(src).map_err(at(src))?.file_type();
        if kind.is_symlink() {
            self.copy_link(src, dst)
        } else if kind.is_dir() {
            self.step(Step::Copy(dst.to_path_buf()))?;
            fs::create_dir(dst).map_err(at(dst))?;
            for (path, name) in sorted_entries(src)? {
                self.copy_entry(&path, &dst.join(name), except)?;
            }
            Ok(())
        } else if kind.is_file() {
            self.step(Step::Copy(dst.to_path_buf()))?;
            self.report.bytes_copied += fs::copy(src, dst).map_err(at(src))?;
            self.report.files_copied += 1;
            self.progress.set_counters(self.report.files_copied, self.report.bytes_copied);
            Ok(())
        } else {
            self.report.skipped.push((src.to_path_buf(), "not a file, directory or link".to_owned()));
            Ok(())
        }
    }

    #[cfg(unix)]
    fn copy_link(&mut self, src: &Path, dst: &Path) -> Result<(), Fault> {
        let target = fs::read_link(src).map_err(at(src))?;
        self.step(Step::Copy(dst.to_path_buf()))?;
        std::os::unix::fs::symlink(&target, dst).map_err(at(dst))?;
        self.report.files_copied += 1;
        self.progress.set_counters(self.report.files_copied, self.report.bytes_copied);
        Ok(())
    }

    /// Creating links needs a privilege on Windows: record them instead.
    #[cfg(not(unix))]
    fn copy_link(&mut self, src: &Path, _dst: &Path) -> Result<(), Fault> {
        self.report.skipped.push((src.to_path_buf(), "link or junction not copied".to_owned()));
        Ok(())
    }

    /// `Some(error)` when every attempt failed.
    fn rename_with_retries(&mut self, base: &Path, partial: &Path, target: &Path) -> Result<Option<io::Error>, Fault> {
        let mut last = None;
        for attempt in 0..RENAME_ATTEMPTS {
            if attempt > 0 {
                std::thread::sleep(self.rename_delay);
            }
            match self.step(Step::Rename(base.to_path_buf())).and_then(|()| Ok(fs::rename(partial, target)?)) {
                Ok(()) => return Ok(None),
                Err(Fault::Io(e)) => last = Some(e),
                Err(Fault::Crash) => return Err(Fault::Crash),
            }
        }
        Ok(last)
    }

    fn remove_partial(&mut self, base: &Path) -> Result<(), Fault> {
        let partial = partial_path(base, self.to);
        if exists(&partial) {
            self.step(Step::RemovePartial(base.to_path_buf()))?;
            fs::remove_dir_all(&partial).map_err(at(&partial))?;
        }
        Ok(())
    }

    /// Removes a copy that cannot be published. If that fails, the journal
    /// stays so the next start tries again.
    fn discard_partial(&mut self, base: &Path) -> Result<(), Fault> {
        let partial = partial_path(base, self.to);
        if !self.attempt(Step::RemovePartial(base.to_path_buf()), || fs::remove_dir_all(&partial))? {
            self.keep_journal = true;
        }
        Ok(())
    }

    fn write_journal(&mut self, journal: &Journal) -> Result<(), Fault> {
        self.step(Step::WriteJournal(journal.phase))?;
        write_json_atomic(&self.journal_path(), journal)?;
        Ok(())
    }

    /// Runs a mutation whose failure is recorded rather than fatal; `Ok(false)` if it failed.
    fn attempt(&mut self, step: Step, op: impl FnOnce() -> io::Result<()>) -> Result<bool, Fault> {
        let what = step.to_string();
        match self.step(step).and_then(|()| Ok(op()?)) {
            Ok(()) => Ok(true),
            Err(Fault::Io(e)) => {
                self.report.errors.push(format!("{what}: {e}"));
                Ok(false)
            }
            Err(Fault::Crash) => Err(Fault::Crash),
        }
    }

    fn step(&mut self, step: Step) -> Result<(), Fault> {
        (self.hook)(&step)
    }

    fn participating(&self) -> Vec<PathBuf> {
        self.bases.iter().filter(|b| b.join(self.from).is_dir()).cloned().collect()
    }

    /// Recovery must never publish a link or write a marker through one.
    fn check_destinations(&self, base: &Path) -> Result<(), String> {
        for path in [base.join(self.to), partial_path(base, self.to)] {
            match fs::symlink_metadata(&path) {
                Ok(meta) => {
                    #[cfg(windows)]
                    let is_link = {
                        use std::os::windows::fs::MetadataExt;
                        // Includes junctions, which need not be reported as symlinks.
                        meta.file_attributes() & 0x400 != 0
                    };
                    #[cfg(not(windows))]
                    let is_link = meta.file_type().is_symlink();
                    if is_link || !meta.is_dir() {
                        return Err(format!("refused: {} is not a plain directory", path.display()));
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("{}: {e}", path.display())),
            }
        }
        Ok(())
    }

    /// Refuses a `<from>` that resolves into the target or the other way round.
    fn check_alias(&self, base: &Path) -> Result<(), String> {
        let src = fs::canonicalize(base.join(self.from)).map_err(|e| format!("{}: {e}", base.display()))?;
        let root = fs::canonicalize(base).map_err(|e| format!("{}: {e}", base.display()))?;
        for dst in [root.join(self.to), partial_path(&root, self.to)] {
            if dst.starts_with(&src) || src.starts_with(&dst) {
                return Err(format!("refused: {} and {} overlap", src.display(), dst.display()));
            }
        }
        Ok(())
    }

    fn save_report(&self, journal: &mut Journal) {
        journal.copied.clone_from(&self.report.copied);
        journal.skipped.clone_from(&self.report.skipped);
        journal.files_copied = self.report.files_copied;
        journal.bytes_copied = self.report.bytes_copied;
        journal.webview_skipped = self.report.notify_webview_skipped;
    }

    fn restore_report(&mut self, journal: &Journal) {
        self.report.copied.clone_from(&journal.copied);
        self.report.skipped.clone_from(&journal.skipped);
        self.report.files_copied = journal.files_copied;
        self.report.bytes_copied = journal.bytes_copied;
        self.progress.set_counters(self.report.files_copied, self.report.bytes_copied);
        self.report.notify_webview_skipped = journal.webview_skipped;
    }

    fn marker(&self, journal: &Journal, status: &str) -> Marker {
        Marker {
            status: status.to_owned(),
            from: journal.from.clone(),
            app_version: env!("CARGO_PKG_VERSION").to_owned(),
            started: journal.started.clone(),
            finished: rfc3339(SystemTime::now()),
            files_copied: journal.files_copied,
            bytes_copied: journal.bytes_copied,
            copied: journal.copied.clone(),
            skipped: journal.skipped.clone(),
            error: journal.error.clone(),
            webview_skipped: journal.webview_skipped,
            notified: false,
        }
    }

    fn journal_path(&self) -> PathBuf {
        journal_path(&self.config, self.to)
    }

    fn marker_path(&self) -> PathBuf {
        marker_path(&self.config, self.to)
    }
}

impl Journal {
    fn new(from: &str, started: String, bases: Vec<PathBuf>) -> Self {
        Self {
            phase: Phase::Copying,
            from: from.to_owned(),
            started,
            bases,
            copied: Vec::new(),
            skipped: Vec::new(),
            files_copied: 0,
            bytes_copied: 0,
            webview_skipped: false,
            error: None,
        }
    }
}

/// Opens the WebView2 profile lock exclusively, without creating it.
/// `Ok(None)`: no lock file; `Ok(Some)`: free, and held until dropped;
/// `Err`: in use (a sharing violation) or unreadable, so not copied.
#[cfg(windows)]
fn probe_webview_lock(lock: &Path) -> Result<Option<File>, String> {
    use std::os::windows::fs::OpenOptionsExt;
    match OpenOptions::new().read(true).share_mode(0).open(lock) {
        Ok(file) => Ok(Some(file)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// WebView2 exists only on Windows; WebKit keeps its storage elsewhere.
#[cfg(not(windows))]
fn probe_webview_lock(_lock: &Path) -> Result<Option<File>, String> {
    Ok(None)
}

/// Both identifiers must be single plain directory names, and different.
fn check_identifiers(from: &str, to: &str) -> Result<(), String> {
    for id in [from, to] {
        let plain = !id.is_empty()
            && !id.contains(['/', '\\'])
            && !id.contains("..")
            && matches!(Path::new(id).components().collect::<Vec<_>>().as_slice(), [Component::Normal(_)]);
        if !plain {
            return Err(format!("refused: {id:?} is not a plain identifier"));
        }
    }
    if from.eq_ignore_ascii_case(to) {
        return Err(format!("refused: source and target are both {to}"));
    }
    Ok(())
}

fn dedup(bases: &[PathBuf]) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for base in bases {
        let same = |known: &PathBuf| {
            known == base || matches!((fs::canonicalize(known), fs::canonicalize(base)), (Ok(a), Ok(b)) if a == b)
        };
        if !out.iter().any(same) {
            out.push(base.clone());
        }
    }
    out
}

fn is_excluded(name: &OsStr) -> bool {
    name.to_str().is_some_and(|n| EXCLUDED.contains(&n) || n.starts_with(EXCLUDED_PREFIX))
}

fn sorted_entries(dir: &Path) -> io::Result<Vec<(PathBuf, OsString)>> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(dir).map_err(at(dir))? {
        let entry = entry.map_err(at(dir))?;
        entries.push((entry.path(), entry.file_name()));
    }
    entries.sort();
    Ok(entries)
}

/// Adds the path to an I/O error, for the report.
fn at(path: &Path) -> impl FnOnce(io::Error) -> io::Error + '_ {
    move |e| io::Error::new(e.kind(), format!("{}: {e}", path.display()))
}

fn exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

fn journal_path(config: &Path, to: &str) -> PathBuf {
    config.join(format!("{to}.migration.json"))
}

fn partial_path(base: &Path, to: &str) -> PathBuf {
    base.join(format!("{to}.partial"))
}

fn marker_path(config: &Path, to: &str) -> PathBuf {
    config.join(to).join(MARKER)
}

fn read_journal(path: &Path) -> JournalState {
    match fs::read(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => JournalState::Absent,
        Err(_) => JournalState::Malformed,
        Ok(bytes) => serde_json::from_slice(&bytes).map_or(JournalState::Malformed, JournalState::Valid),
    }
}

fn read_marker(path: &Path) -> Option<Marker> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

/// Keeps `notified` only when recovering the same migration, never from a copied marker.
fn write_marker(config: &Path, to: &str, marker: &Marker) -> io::Result<()> {
    let path = marker_path(config, to);
    fs::create_dir_all(config.join(to))?;
    let notified = read_marker(&path).is_some_and(|m| {
        m.notified && m.from == marker.from && m.started == marker.started && m.status == marker.status
    });
    write_json_atomic(&path, &Marker { notified: marker.notified || notified, ..marker.clone() })
}

/// Writes `<path>.tmp`, then renames it over `path`.
fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> io::Result<()> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    let json = serde_json::to_vec_pretty(value).map_err(io::Error::other)?;
    // A stale or copied temporary file may be a link. Unlink that entry and
    // exclusively create a new file rather than truncating its referent.
    match fs::remove_file(&tmp) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    let mut file = File::create_new(&tmp)?;
    file.write_all(&json)?;
    file.sync_all()?;
    drop(file);
    fs::rename(&tmp, path)
}

/// RFC 3339 in UTC with milliseconds, without a time crate.
fn rfc3339(time: SystemTime) -> String {
    let since = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = since.as_secs();
    let (year, month, day) = civil_from_days((secs / 86_400) as i64);
    let rem = secs % 86_400;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60,
        since.subsec_millis()
    )
}

/// Days since 1970-01-01 to a proleptic Gregorian date (Howard Hinnant's algorithm).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;

    const FROM: &str = "old.app";
    const TO: &str = "new.app";

    /// A unique directory under the system temp dir, removed on drop.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let name = format!("openidea-migrate-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed));
            let path = std::env::temp_dir().join(name);
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn write(path: &Path, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    /// Two bases shaped like Windows' roaming and local app data.
    struct Fixture {
        dir: TempDir,
        roaming: PathBuf,
        local: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let dir = TempDir::new();
            let roaming = dir.0.join("roaming");
            let local = dir.0.join("local");
            let old = roaming.join(FROM);
            write(&old.join("settings.toml"), "theme = 'dark'");
            write(&old.join("recent.json"), "[]");
            write(&old.join("tools/a/b"), "b");
            write(&old.join("tools/jdk/bin/server/jvm.dll"), "jvm");
            write(&old.join("tools/node/cache/c"), "nested cache");
            fs::create_dir_all(old.join("scratches")).unwrap();
            write(&old.join("cache/x"), "x");
            write(&old.join("index/i"), "i");
            write(&old.join("notebook-runtime/session/kernel-123/connection.json"), "temporary kernel secret");
            write(&old.join("webview-123/y"), "y");
            let old = local.join(FROM);
            write(&old.join("acp-agents/agent/bin"), "agent");
            write(&old.join("EBWebView/Local State"), "{}");
            write(&old.join("EBWebView/Default/Local Storage/leveldb/000003.log"), "layout");
            write(&old.join("EBWebView/Default/LOCK"), "");
            write(&old.join("logs/openidea.log"), "log");
            write(&old.join("webview-dev/EBWebView/Default/LOCK"), "");
            Self { dir, roaming, local }
        }

        fn bases(&self) -> Vec<PathBuf> {
            vec![self.roaming.clone(), self.local.clone()]
        }

        fn root(&self) -> &Path {
            &self.dir.0
        }

        fn sources(&self) -> BTreeMap<String, Vec<u8>> {
            let mut all = BTreeMap::new();
            for (name, base) in [("roaming", &self.roaming), ("local", &self.local)] {
                for (k, v) in snapshot(&base.join(FROM)) {
                    all.insert(format!("{name}/{k}"), v);
                }
            }
            all
        }

        /// Files the migration may leave behind only while it is unfinished.
        fn leftovers(&self) -> Vec<PathBuf> {
            [
                partial_path(&self.roaming, TO),
                partial_path(&self.local, TO),
                journal_path(&self.roaming, TO),
                self.roaming.join(format!("{TO}.migration.json.tmp")),
                self.roaming.join(TO).join(format!("{MARKER}.tmp")),
            ]
            .into_iter()
            .filter(|p| exists(p))
            .collect()
        }
    }

    fn seed(bases: &[PathBuf]) -> SeedReport {
        seed_profile_with(bases, FROM, TO, &mut |_| Ok(()), Duration::ZERO)
    }

    /// Seeds with a fault at the given hook calls (`true`: crash, `false`: I/O
    /// error); returns the report and the number of hook calls.
    fn seed_with_faults(bases: &[PathBuf], faults: &[(usize, bool)]) -> (SeedReport, usize) {
        let mut calls = 0;
        let report = seed_profile_with(
            bases,
            FROM,
            TO,
            &mut |_| {
                let call = calls;
                calls += 1;
                match faults.iter().find(|(at, _)| *at == call) {
                    Some((_, true)) => Err(Fault::Crash),
                    Some((_, false)) => Err(Fault::Io(io::Error::other("injected"))),
                    None => Ok(()),
                }
            },
            Duration::ZERO,
        );
        (report, calls)
    }

    /// Every entry under `dir` by relative path: file content, `/` for a
    /// directory, `-> target` for a link.
    fn snapshot(dir: &Path) -> BTreeMap<String, Vec<u8>> {
        fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
            for (path, _) in sorted_entries(dir).unwrap() {
                let rel = path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
                let kind = fs::symlink_metadata(&path).unwrap().file_type();
                if kind.is_symlink() {
                    out.insert(rel, format!("-> {}", fs::read_link(&path).unwrap().display()).into_bytes());
                } else if kind.is_dir() {
                    out.insert(format!("{rel}/"), Vec::new());
                    walk(root, &path, out);
                } else {
                    out.insert(rel, fs::read(&path).unwrap());
                }
            }
        }
        let mut out = BTreeMap::new();
        if dir.exists() {
            walk(dir, dir, &mut out);
        }
        out
    }

    /// What a complete seed must leave in `<base>/<TO>`.
    fn expected(base: &Path) -> BTreeMap<String, Vec<u8>> {
        snapshot(&base.join(FROM))
            .into_iter()
            .filter(|(k, _)| !is_excluded(OsStr::new(k.split('/').next().unwrap())))
            .filter(|(k, _)| k != "EBWebView/Default/LOCK")
            .collect()
    }

    fn target(base: &Path) -> BTreeMap<String, Vec<u8>> {
        snapshot(&base.join(TO)).into_iter().filter(|(k, _)| k != MARKER).collect()
    }

    fn marker(config: &Path) -> Marker {
        read_marker(&marker_path(config, TO)).expect("marker")
    }

    fn file_count(map: &BTreeMap<String, Vec<u8>>) -> (u64, u64) {
        let files: Vec<_> = map.iter().filter(|(k, _)| !k.ends_with('/')).collect();
        (files.len() as u64, files.iter().map(|(_, v)| v.len() as u64).sum())
    }

    fn journal_phase(config: &Path) -> Option<Phase> {
        match read_journal(&journal_path(config, TO)) {
            JournalState::Valid(j) => Some(j.phase),
            _ => None,
        }
    }

    /// The end state is a complete profile or a recorded failure, the source
    /// is unchanged, and nothing unfinished remains.
    fn assert_converged(f: &Fixture, sources: &BTreeMap<String, Vec<u8>>, context: &str) {
        assert_eq!(f.leftovers(), Vec::<PathBuf>::new(), "{context}: leftovers");
        assert_eq!(f.sources(), *sources, "{context}: the source changed");
        let m = marker(&f.roaming);
        match m.status.as_str() {
            "seeded" => {
                for base in f.bases() {
                    assert_eq!(target(&base), expected(&base), "{context}: {}", base.display());
                }
            }
            "failed" => {
                assert!(m.error.is_some(), "{context}: failed marker without error");
                assert!(target(&f.roaming).is_empty(), "{context}: failure published data");
                assert!(!f.local.join(TO).exists(), "{context}: failure published data");
            }
            other => panic!("{context}: marker status {other}"),
        }
    }

    #[test]
    fn seeds_every_base_and_skips_root_excluded_dirs() {
        let f = Fixture::new();
        let sources = f.sources();
        let report = seed(&f.bases());
        assert_eq!(report.outcome, SeedOutcome::Seeded);
        for base in f.bases() {
            assert_eq!(target(&base), expected(&base), "{}", base.display());
        }
        let new = f.roaming.join(TO);
        assert_eq!(fs::read_to_string(new.join("tools/jdk/bin/server/jvm.dll")).unwrap(), "jvm");
        assert_eq!(fs::read_to_string(new.join("tools/node/cache/c")).unwrap(), "nested cache");
        assert!(new.join("scratches").is_dir());
        for gone in ["cache", "index", "webview-123", "notebook-runtime"] {
            assert!(!new.join(gone).exists(), "{gone}");
        }
        assert!(!f.local.join(TO).join("logs").exists());
        assert!(!f.local.join(TO).join("webview-dev").exists());
        assert!(!f.local.join(TO).join("EBWebView/Default/LOCK").exists());

        let (roaming_files, roaming_bytes) = file_count(&expected(&f.roaming));
        let (local_files, local_bytes) = file_count(&expected(&f.local));
        let m = marker(&f.roaming);
        assert_eq!(m.status, "seeded");
        assert_eq!(m.from, FROM);
        assert_eq!((m.files_copied, m.bytes_copied), (roaming_files + local_files, roaming_bytes + local_bytes));
        assert_eq!((report.files_copied, report.bytes_copied), (m.files_copied, m.bytes_copied));
        assert!(!m.webview_skipped && !m.notified);
        assert!(m.copied.contains(&f.roaming.join(FROM).join("tools")));
        assert!(m.skipped.iter().any(|(p, _)| *p == f.roaming.join(FROM).join("cache")));
        assert_eq!(f.leftovers(), Vec::<PathBuf>::new());
        assert_eq!(f.sources(), sources);
        // The lock is released.
        let lock = File::open(f.roaming.join(format!("{TO}.migration.lock"))).unwrap();
        lock.try_lock().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn keeps_owner_only_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let f = Fixture::new();
        for base in f.bases() {
            let source = base.join(FROM).join("git-credentials.json");
            write(&source, "{\"credentials\": []}");
            fs::set_permissions(&source, fs::Permissions::from_mode(0o600)).unwrap();
            assert_eq!(fs::metadata(&source).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let sources = f.sources();
        let report = seed_profile(&f.bases(), FROM, TO);
        assert_eq!(report.outcome, SeedOutcome::Seeded);
        for base in f.bases() {
            let copied = base.join(TO).join("git-credentials.json");
            assert_eq!(fs::read_to_string(&copied).unwrap(), "{\"credentials\": []}");
            assert_eq!(fs::metadata(&copied).unwrap().permissions().mode() & 0o777, 0o600);
            let source = base.join(FROM).join("git-credentials.json");
            assert_eq!(fs::metadata(&source).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert_eq!(f.sources(), sources);
    }

    #[test]
    fn does_nothing_when_the_target_exists() {
        let f = Fixture::new();
        write(&f.local.join(TO).join("logs/openidea.log"), "already running");
        assert_eq!(seed(&f.bases()).outcome, SeedOutcome::NotNeeded);
        assert!(!f.roaming.join(TO).exists());
        assert_eq!(f.leftovers(), Vec::<PathBuf>::new());
    }

    #[test]
    fn does_nothing_without_a_source() {
        let dir = TempDir::new();
        let bases = vec![dir.0.join("roaming"), dir.0.join("local")];
        fs::create_dir_all(&bases[0]).unwrap();
        let before = snapshot(&dir.0);
        assert_eq!(seed(&bases).outcome, SeedOutcome::NotNeeded);
        assert_eq!(snapshot(&dir.0), before);
    }

    #[test]
    fn second_run_is_a_no_op() {
        let f = Fixture::new();
        assert_eq!(seed(&f.bases()).outcome, SeedOutcome::Seeded);
        let after_first = snapshot(f.root());
        assert_eq!(seed(&f.bases()).outcome, SeedOutcome::NotNeeded);
        assert_eq!(snapshot(f.root()), after_first);
    }

    #[test]
    fn deduplicates_identical_bases() {
        let f = Fixture::new();
        let bases = vec![f.roaming.clone(), f.roaming.join("."), f.local.clone(), f.local.clone()];
        let report = seed(&bases);
        assert_eq!(report.outcome, SeedOutcome::Seeded);
        let (roaming_files, _) = file_count(&expected(&f.roaming));
        let (local_files, _) = file_count(&expected(&f.local));
        assert_eq!(report.files_copied, roaming_files + local_files);
        for base in f.bases() {
            assert_eq!(target(&base), expected(&base));
        }
    }

    #[test]
    fn refuses_aliased_source_and_target() {
        let f = Fixture::new();
        let before = snapshot(f.root());
        for (from, to) in [(FROM, FROM), (FROM, "OLD.APP"), (FROM, "old.app/sub"), ("old.app/..", TO), (FROM, "..")] {
            let report = seed_profile_with(&f.bases(), from, to, &mut |_| Ok(()), Duration::ZERO);
            assert!(matches!(report.outcome, SeedOutcome::Failed(_)), "{from} -> {to}: {:?}", report.outcome);
            assert_eq!(snapshot(f.root()), before, "{from} -> {to}");
        }
        #[cfg(unix)]
        {
            // `<base>/<from>` is a link to the base itself: the target would be inside the source.
            let base = f.root().join("linked");
            fs::create_dir(&base).unwrap();
            std::os::unix::fs::symlink(&base, base.join(FROM)).unwrap();
            let report = seed(std::slice::from_ref(&base));
            assert!(matches!(report.outcome, SeedOutcome::Failed(_)), "{:?}", report.outcome);
            assert!(!exists(&partial_path(&base, TO)) && !exists(&base.join(TO)));
        }
    }

    #[test]
    fn seed_source_rules() {
        let to = "it.example.app";
        assert_eq!(seed_source(false, None, to).as_deref(), Some(LEGACY_IDENTIFIER));
        assert_eq!(seed_source(false, Some("other.app"), to).as_deref(), Some(LEGACY_IDENTIFIER));
        assert_eq!(seed_source(false, None, LEGACY_IDENTIFIER), None);
        assert_eq!(seed_source(true, None, to), None);
        assert_eq!(seed_source(true, Some(""), to), None);
        assert_eq!(seed_source(true, Some(LEGACY_IDENTIFIER), to).as_deref(), Some(LEGACY_IDENTIFIER));
        assert_eq!(seed_source(true, Some(to), "it.example.app.dev.x").as_deref(), Some(to));
        assert_eq!(seed_source(true, Some(to), to), None);
        assert_eq!(seed_source(true, Some("IT.EXAMPLE.APP"), to), None);
        for bad in ["a/b", "a\\b", "..", "a..b", ".", "/abs"] {
            assert_eq!(seed_source(true, Some(bad), to), None, "{bad}");
            assert_eq!(seed_source(true, Some(LEGACY_IDENTIFIER), bad), None, "{bad}");
        }
    }

    #[test]
    fn crash_at_every_step_converges() {
        let (_, steps) = seed_with_faults(&Fixture::new().bases(), &[]);
        assert!(steps > 20, "{steps} steps");
        for at in 0..steps {
            for crash in [true, false] {
                let f = Fixture::new();
                let sources = f.sources();
                seed_with_faults(&f.bases(), &[(at, crash)]);
                seed(&f.bases());
                assert_converged(&f, &sources, &format!("crash {crash} at step {at}"));
            }
        }
        // A copy error, then a crash at each step of the failure cleanup.
        const COPY_ERROR: usize = 3;
        let (report, steps) = seed_with_faults(&Fixture::new().bases(), &[(COPY_ERROR, false)]);
        assert!(matches!(report.outcome, SeedOutcome::Failed(_)), "{:?}", report.outcome);
        for at in COPY_ERROR + 1..steps {
            let f = Fixture::new();
            let sources = f.sources();
            seed_with_faults(&f.bases(), &[(COPY_ERROR, false), (at, true)]);
            seed(&f.bases());
            assert_converged(&f, &sources, &format!("copy error, then crash at step {at}"));
        }
    }

    #[test]
    fn malformed_journal_restarts_the_copy() {
        let f = Fixture::new();
        let sources = f.sources();
        seed_with_faults(&f.bases(), &[(5, true)]);
        assert!(partial_path(&f.roaming, TO).is_dir());
        write(&partial_path(&f.roaming, TO).join("stale"), "stale");
        fs::write(journal_path(&f.roaming, TO), "{ not json").unwrap();
        assert_eq!(seed(&f.bases()).outcome, SeedOutcome::Resumed);
        assert_eq!(marker(&f.roaming).status, "seeded");
        assert_converged(&f, &sources, "malformed journal");
    }

    /// Crashes on the first attempt to rename the local base, after the
    /// roaming base was renamed.
    fn crash_before_the_local_rename(f: &Fixture) {
        let local = f.local.clone();
        seed_profile_with(
            &f.bases(),
            FROM,
            TO,
            &mut |s| match s {
                Step::Rename(base) if *base == local => Err(Fault::Crash),
                _ => Ok(()),
            },
            Duration::ZERO,
        );
        assert_eq!(journal_phase(&f.roaming), Some(Phase::Renaming));
        assert!(f.roaming.join(TO).is_dir());
        assert!(partial_path(&f.local, TO).is_dir());
    }

    #[test]
    fn finishes_an_interrupted_rename() {
        let f = Fixture::new();
        let sources = f.sources();
        crash_before_the_local_rename(&f);
        assert_eq!(seed(&f.bases()).outcome, SeedOutcome::Resumed);
        assert_eq!(marker(&f.roaming).status, "seeded");
        assert_converged(&f, &sources, "interrupted rename");
    }

    #[test]
    fn rename_conflict_keeps_the_target_and_records_the_partial() {
        let f = Fixture::new();
        crash_before_the_local_rename(&f);
        write(&f.local.join(TO).join("logs/openidea.log"), "written by the app");
        let report = seed(&f.bases());
        assert_eq!(report.outcome, SeedOutcome::Resumed);
        let local = snapshot(&f.local.join(TO));
        assert_eq!(local.keys().collect::<Vec<_>>(), ["logs/", "logs/openidea.log"]);
        assert_eq!(local["logs/openidea.log"], b"written by the app");
        assert_eq!(target(&f.roaming), expected(&f.roaming));
        let partial = partial_path(&f.local, TO);
        assert!(report.skipped.iter().any(|(p, _)| *p == partial));
        assert!(marker(&f.roaming).skipped.iter().any(|(p, _)| *p == partial));
        assert_eq!(f.leftovers(), Vec::<PathBuf>::new());
    }

    #[test]
    fn rename_error_is_retried_then_skipped() {
        let f = Fixture::new();
        let local = f.local.clone();
        let mut attempts = 0;
        let report = seed_profile_with(
            &f.bases(),
            FROM,
            TO,
            &mut |s| match s {
                Step::Rename(base) if *base == local => {
                    attempts += 1;
                    Err(Fault::Io(io::Error::other("busy")))
                }
                _ => Ok(()),
            },
            Duration::ZERO,
        );
        assert_eq!(attempts, RENAME_ATTEMPTS);
        assert_eq!(report.outcome, SeedOutcome::Seeded);
        assert!(!f.local.join(TO).exists());
        let partial = partial_path(&f.local, TO);
        assert!(report.skipped.iter().any(|(p, reason)| *p == partial && reason.contains("busy")));
        assert_eq!(target(&f.roaming), expected(&f.roaming));
        assert_eq!(marker(&f.roaming).status, "seeded");
        assert_eq!(f.leftovers(), Vec::<PathBuf>::new());
    }

    /// Makes `path` unreadable until the guard is dropped; `None` when this
    /// user can read it anyway (root).
    #[cfg(windows)]
    fn make_unreadable(path: &Path) -> Option<Box<dyn std::any::Any>> {
        use std::os::windows::fs::OpenOptionsExt;
        Some(Box::new(OpenOptions::new().read(true).share_mode(0).open(path).unwrap()))
    }

    #[cfg(unix)]
    fn make_unreadable(path: &Path) -> Option<Box<dyn std::any::Any>> {
        use std::os::unix::fs::PermissionsExt;
        struct Restore(PathBuf);
        impl Drop for Restore {
            fn drop(&mut self) {
                let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o644));
            }
        }
        fs::set_permissions(path, fs::Permissions::from_mode(0o000)).unwrap();
        let guard = Restore(path.to_path_buf());
        if File::open(path).is_ok() { None } else { Some(Box::new(guard)) }
    }

    #[test]
    fn copy_error_gives_up_without_touching_the_source() {
        let f = Fixture::new();
        let sources = f.sources();
        let Some(guard) = make_unreadable(&f.roaming.join(FROM).join("settings.toml")) else {
            eprintln!("skipped: this user can read an unreadable file");
            return;
        };
        let report = seed(&f.bases());
        drop(guard);
        assert!(
            matches!(&report.outcome, SeedOutcome::Failed(e) if e.contains("settings.toml")),
            "{:?}",
            report.outcome
        );
        assert_eq!(f.leftovers(), Vec::<PathBuf>::new());
        let m = marker(&f.roaming);
        assert_eq!(m.status, "failed");
        assert!(m.error.as_deref().is_some_and(|e| e.contains("settings.toml")));
        assert!(!f.local.join(TO).exists());
        assert_eq!(f.sources(), sources);
        assert_eq!(seed(&f.bases()).outcome, SeedOutcome::NotNeeded);
    }

    #[test]
    fn second_caller_waits_and_finds_the_seeded_profile() {
        let f = Fixture::new();
        let (started_tx, started_rx) = mpsc::channel();
        let (go_tx, go_rx) = mpsc::channel::<()>();
        let bases = f.bases();
        let first = std::thread::spawn(move || {
            let mut first_step = true;
            let mut hook = |_: &Step| -> Result<(), Fault> {
                if std::mem::take(&mut first_step) {
                    started_tx.send(()).unwrap();
                    go_rx.recv().unwrap();
                }
                Ok(())
            };
            seed_profile_with(&bases, FROM, TO, &mut hook, Duration::ZERO).outcome
        });
        started_rx.recv().unwrap();
        let (done_tx, done_rx) = mpsc::channel();
        let bases = f.bases();
        let second = std::thread::spawn(move || {
            let outcome = seed(&bases).outcome;
            done_tx.send(()).unwrap();
            outcome
        });
        assert!(done_rx.recv_timeout(Duration::from_millis(500)).is_err(), "the second caller did not wait");
        go_tx.send(()).unwrap();
        assert_eq!(first.join().unwrap(), SeedOutcome::Seeded);
        assert_eq!(second.join().unwrap(), SeedOutcome::NotNeeded);
        for base in f.bases() {
            assert_eq!(target(&base), expected(&base));
        }
    }

    struct ProgressCopyGate {
        release: Option<mpsc::Sender<()>>,
        worker: Option<std::thread::JoinHandle<SeedReport>>,
    }

    impl ProgressCopyGate {
        fn start(bases: Vec<PathBuf>, progress: std::sync::Arc<Progress>) -> Self {
            let (entered_tx, entered_rx) = mpsc::channel();
            let (release_tx, release_rx) = mpsc::channel();
            let worker = std::thread::spawn(move || {
                let mut blocked = false;
                let mut hook = |step: &Step| {
                    if matches!(step, Step::Copy(_)) && !blocked {
                        blocked = true;
                        let _ = entered_tx.send(());
                        // Dropping the sender also releases the barrier after a failed assertion.
                        let _ = release_rx.recv();
                    }
                    Ok(())
                };
                seed_run(&bases, FROM, TO, &progress, &mut hook, Duration::ZERO)
            });
            let gate = Self { release: Some(release_tx), worker: Some(worker) };
            entered_rx.recv_timeout(Duration::from_secs(10)).expect("migration did not reach its first copy");
            gate
        }

        fn finish(mut self) -> SeedReport {
            let _ = self.release.take().unwrap().send(());
            self.worker.take().unwrap().join().unwrap()
        }
    }

    impl Drop for ProgressCopyGate {
        fn drop(&mut self) {
            if let Some(release) = self.release.take() {
                let _ = release.send(());
            }
            if let Some(worker) = self.worker.take() {
                let _ = worker.join();
            }
        }
    }

    #[test]
    fn progress_is_published_before_the_copy_and_the_target_stays_closed() {
        let f = Fixture::new();
        let sources = f.sources();
        let progress = std::sync::Arc::new(Progress::default());
        let gate = ProgressCopyGate::start(f.bases(), progress.clone());
        let phase_before_copy = progress.phase();
        let targets_before_copy: Vec<_> = f.bases().iter().map(|base| exists(&base.join(TO))).collect();
        let journal_before_copy = exists(&journal_path(&f.roaming, TO));
        let lock_before_copy = exists(&f.roaming.join(format!("{TO}.migration.lock")));
        let report = gate.finish();

        eprintln!(
            "MIGRATION_W1 phase={phase_before_copy:?} targets={targets_before_copy:?} journal={journal_before_copy} lock={lock_before_copy}"
        );
        assert_eq!(phase_before_copy, ProgressPhase::Copying);
        assert!(targets_before_copy.iter().all(|exists| !exists), "profile was published before the copy");
        assert!(journal_before_copy && lock_before_copy);
        assert_eq!(report.outcome, SeedOutcome::Seeded);
        assert_eq!(progress.phase(), ProgressPhase::Done);
        assert_eq!(progress.files(), report.files_copied);
        assert_eq!(progress.bytes(), report.bytes_copied);
        for base in f.bases() {
            assert_eq!(target(&base), expected(&base));
        }
        assert_eq!(f.sources(), sources);
    }

    #[test]
    fn second_start_during_the_copy_reports_waiting_and_converges() {
        let f = Fixture::new();
        let first_progress = std::sync::Arc::new(Progress::default());
        let gate = ProgressCopyGate::start(f.bases(), first_progress);
        let second_progress = std::sync::Arc::new(Progress::default());
        let observed = second_progress.clone();
        let bases = f.bases();
        let (done_tx, done_rx) = mpsc::channel();
        let second = std::thread::spawn(move || {
            let report = seed_profile_with_progress(&bases, FROM, TO, &observed);
            let _ = done_tx.send(report);
        });
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while second_progress.phase() != ProgressPhase::WaitingForOtherStart && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        let waiting_phase = second_progress.phase();
        let early_result = done_rx.recv_timeout(Duration::from_millis(500));
        let returned_early = early_result.is_ok();
        let first_report = gate.finish();
        let second_report = early_result.unwrap_or_else(|_| {
            done_rx.recv_timeout(Duration::from_secs(10)).expect("second start did not finish after the copy")
        });
        second.join().unwrap();

        eprintln!("MIGRATION_W2 phase={waiting_phase:?} returned_early={returned_early}");
        assert_eq!(waiting_phase, ProgressPhase::WaitingForOtherStart);
        assert!(!returned_early, "second start returned while the first copy was blocked");
        assert_eq!(first_report.outcome, SeedOutcome::Seeded);
        assert_eq!(second_report.outcome, SeedOutcome::NotNeeded);
        assert_eq!(second_progress.phase(), ProgressPhase::Done);
        for base in f.bases() {
            assert_eq!(target(&base), expected(&base));
        }
    }

    #[test]
    fn progress_finishes_with_cleared_counters_after_a_copy_failure() {
        let f = Fixture::new();
        let progress = Progress::default();
        let mut files_before_failure = 0;
        let mut hook = |step: &Step| {
            if matches!(step, Step::Copy(path) if path.file_name() == Some(OsStr::new("settings.toml"))) {
                files_before_failure = progress.files();
                return Err(Fault::Io(io::Error::other("copy failure fixture")));
            }
            Ok(())
        };
        let report = seed_run(&f.bases(), FROM, TO, &progress, &mut hook, Duration::ZERO);
        assert!(files_before_failure > 0, "fixture did not copy a file before its error");
        assert!(matches!(report.outcome, SeedOutcome::Failed(_)));
        assert_eq!(report.files_copied, 0);
        assert_eq!(progress.files(), report.files_copied);
        assert_eq!(progress.bytes(), report.bytes_copied);
        assert_eq!(progress.phase(), ProgressPhase::Done);
    }

    #[test]
    fn resumed_publish_restores_progress_counters() {
        let f = Fixture::new();
        let interrupted = seed_profile_with(
            &f.bases(),
            FROM,
            TO,
            &mut |step| if matches!(step, Step::Rename(_)) { Err(Fault::Crash) } else { Ok(()) },
            Duration::ZERO,
        );
        assert!(matches!(interrupted.outcome, SeedOutcome::Failed(_)));
        assert!(interrupted.files_copied > 0);
        let progress = Progress::default();
        let report = seed_profile_with_progress(&f.bases(), FROM, TO, &progress);
        assert_eq!(report.outcome, SeedOutcome::Resumed);
        assert_eq!(progress.files(), report.files_copied);
        assert_eq!(progress.bytes(), report.bytes_copied);
        assert_eq!(progress.phase(), ProgressPhase::Done);
        for base in f.bases() {
            assert_eq!(target(&base), expected(&base));
        }
    }

    #[cfg(windows)]
    #[test]
    fn dialog_is_visible_while_the_copy_is_blocked_and_the_target_is_closed() {
        use crate::migration_feedback::{self, testing};
        let _serial = testing::dialog_test_guard();
        let f = Fixture::new();
        let progress = std::sync::Arc::new(Progress::default());
        let feedback = migration_feedback::start(progress.clone());
        let first_ended = feedback.worker_ended_flag();
        let gate = ProgressCopyGate::start(f.bases(), progress.clone());
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let (visible, content) = loop {
            let windows = testing::visible_dialogs();
            let content = progress.last_content();
            let counter_line = content.lines().last().unwrap_or_default();
            if !windows.is_empty()
                && counter_line.contains(" MB")
                && counter_line.chars().filter(char::is_ascii_digit).count() >= 2
            {
                break (windows, content);
            }
            if std::time::Instant::now() >= deadline {
                break (windows, content);
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        let targets_at_visibility: Vec<_> = f.bases().iter().map(|base| exists(&base.join(TO))).collect();
        if let Some(window) = visible.first() {
            testing::request_close(*window);
            std::thread::sleep(Duration::from_millis(100));
        }
        let after_close_request = testing::visible_dialogs();
        let waiting = std::sync::Arc::new(Progress::default());
        waiting.set_phase(ProgressPhase::WaitingForOtherStart);
        let second_feedback = migration_feedback::start(waiting.clone());
        let second_ended = second_feedback.worker_ended_flag();
        // Keep the second start alive past its initial delay, so it must search for the first window.
        std::thread::sleep(Duration::from_millis(700));
        let while_second_waits = testing::visible_dialogs();
        let second_shown = waiting.dialog_shown_ms();
        let report = gate.finish();
        feedback.finish();
        second_feedback.finish();
        let after_finish = testing::visible_dialogs();

        eprintln!(
            "MIGRATION_W3 visible={visible:?} content={content:?} targets={targets_at_visibility:?} after_close={after_close_request:?} second={while_second_waits:?} after_finish={after_finish:?} feedback_error={:?} waiting_error={:?}",
            progress.feedback_error(),
            waiting.feedback_error()
        );
        assert_eq!(visible.len(), 1, "migration dialog was not visible with its counter within5s");
        let counter_line = content.lines().last().unwrap_or_default();
        assert!(counter_line.contains(" MB") && counter_line.chars().filter(char::is_ascii_digit).count() >= 2);
        assert!(targets_at_visibility.iter().all(|exists| !exists), "profile opened before the copy finished");
        assert_eq!(after_close_request, visible, "dialog was dismissible while copying");
        assert_eq!(while_second_waits, visible, "waiting start opened a second dialog");
        assert_eq!(second_shown, 0);
        assert_eq!(waiting.dialog_shown_ms(), 0);
        assert!(after_finish.is_empty(), "migration dialog survived finish");
        assert!(first_ended.load(Ordering::Acquire));
        assert!(second_ended.load(Ordering::Acquire));
        assert!(progress.feedback_error().is_none(), "{:?}", progress.feedback_error());
        assert!(waiting.feedback_error().is_none(), "{:?}", waiting.feedback_error());
        assert_eq!(report.outcome, SeedOutcome::Seeded);
        for base in f.bases() {
            assert_eq!(target(&base), expected(&base));
        }
    }

    #[cfg(windows)]
    #[test]
    fn skips_a_locked_webview_profile() {
        use std::os::windows::fs::OpenOptionsExt;
        let f = Fixture::new();
        let webview = f.local.join(FROM).join(WEBVIEW_DIR);
        let _held = OpenOptions::new().read(true).share_mode(0).open(webview.join("Default/LOCK")).unwrap();
        let report = seed(&f.bases());
        assert_eq!(report.outcome, SeedOutcome::Seeded);
        assert!(report.notify_webview_skipped);
        assert!(report.skipped.iter().any(|(p, _)| *p == webview));
        assert!(!f.local.join(TO).join(WEBVIEW_DIR).exists());
        assert_eq!(fs::read_to_string(f.local.join(TO).join("acp-agents/agent/bin")).unwrap(), "agent");
        assert_eq!(target(&f.roaming), expected(&f.roaming));
        assert!(marker(&f.roaming).webview_skipped);
        assert!(webview_notice_pending(&f.roaming, TO));
    }

    #[test]
    fn copies_a_webview_profile_whose_lock_is_free() {
        let f = Fixture::new();
        let report = seed(&f.bases());
        assert_eq!(report.outcome, SeedOutcome::Seeded);
        assert!(!report.notify_webview_skipped);
        let copied = f.local.join(TO).join(WEBVIEW_DIR);
        assert_eq!(fs::read_to_string(copied.join("Default/Local Storage/leveldb/000003.log")).unwrap(), "layout");
        assert!(!copied.join("Default/LOCK").exists());
        assert!(!webview_notice_pending(&f.roaming, TO));
    }

    #[test]
    fn copies_a_webview_profile_without_lock() {
        let f = Fixture::new();
        fs::remove_file(f.local.join(FROM).join("EBWebView/Default/LOCK")).unwrap();
        let report = seed(&f.bases());
        assert_eq!(report.outcome, SeedOutcome::Seeded);
        assert!(!report.notify_webview_skipped);
        assert_eq!(target(&f.local), expected(&f.local));
        assert!(f.local.join(TO).join("EBWebView/Local State").is_file());
    }

    #[cfg(unix)]
    #[test]
    fn recreates_symlinks_with_the_same_target() {
        use std::os::unix::fs::symlink;
        let f = Fixture::new();
        let tools = f.roaming.join(FROM).join("tools");
        write(&tools.join("node_modules/pkg/cli.js"), "js");
        fs::create_dir_all(tools.join("node_modules/.bin")).unwrap();
        symlink("../pkg/cli.js", tools.join("node_modules/.bin/cli")).unwrap();
        symlink("/nonexistent/target", tools.join("dangling")).unwrap();
        symlink(tools.join("a"), tools.join("dir-link")).unwrap();
        assert_eq!(seed(&f.bases()).outcome, SeedOutcome::Seeded);
        let new = f.roaming.join(TO).join("tools");
        assert_eq!(fs::read_link(new.join("node_modules/.bin/cli")).unwrap(), Path::new("../pkg/cli.js"));
        assert_eq!(fs::read_to_string(new.join("node_modules/.bin/cli")).unwrap(), "js");
        assert_eq!(fs::read_link(new.join("dangling")).unwrap(), Path::new("/nonexistent/target"));
        assert!(fs::symlink_metadata(new.join("dir-link")).unwrap().file_type().is_symlink());
        assert_eq!(fs::read_link(new.join("dir-link")).unwrap(), tools.join("a"));
        assert_eq!(target(&f.roaming), expected(&f.roaming));
    }

    #[test]
    fn notification_is_reported_once() {
        let f = Fixture::new();
        assert_eq!(seed(&f.bases()).outcome, SeedOutcome::Seeded);
        assert!(!webview_notice_pending(&f.roaming, TO));
        // A run that could not copy the WebView profile records it in the marker.
        let skipped = Marker { webview_skipped: true, ..marker(&f.roaming) };
        write_json_atomic(&marker_path(&f.roaming, TO), &skipped).unwrap();
        assert!(webview_notice_pending(&f.roaming, TO));
        mark_notified(&f.roaming, TO).unwrap();
        assert!(!webview_notice_pending(&f.roaming, TO));
        let after = marker(&f.roaming);
        assert!(after.notified);
        assert_eq!((after.files_copied, after.status.as_str()), (skipped.files_copied, "seeded"));
        // Finishing a journal later rewrites the marker but keeps `notified`.
        write_marker(&f.roaming, TO, &Marker { notified: false, ..after }).unwrap();
        assert!(marker(&f.roaming).notified);
        assert!(mark_notified(&TempDir::new().0, TO).is_err());
    }

    #[test]
    fn recovery_refuses_foreign_journal_bases() {
        for phase in [Phase::Copying, Phase::Renaming, Phase::Failed] {
            let f = Fixture::new();
            let foreign = f.root().join("foreign");
            write(&partial_path(&foreign, TO).join("valuable"), "keep");
            write(&foreign.join(TO).join("existing"), "keep too");
            let mut journal = Journal::new(FROM, "start".into(), vec![f.roaming.clone(), foreign]);
            journal.phase = phase;
            write_json_atomic(&journal_path(&f.roaming, TO), &journal).unwrap();
            let before = snapshot(f.root());
            assert!(matches!(seed(&f.bases()).outcome, SeedOutcome::Failed(_)));
            let mut after = snapshot(f.root());
            after.remove(&format!("roaming/{TO}.migration.lock"));
            assert_eq!(after, before, "{phase:?}");
        }
    }

    #[test]
    fn recovery_refuses_a_different_source() {
        for phase in [Phase::Copying, Phase::Renaming, Phase::Failed] {
            let f = Fixture::new();
            let mut journal = Journal::new("different.app", "start".into(), f.bases());
            journal.phase = phase;
            write_json_atomic(&journal_path(&f.roaming, TO), &journal).unwrap();
            let before = snapshot(f.root());
            assert!(matches!(seed(&f.bases()).outcome, SeedOutcome::Failed(_)));
            let mut after = snapshot(f.root());
            after.remove(&format!("roaming/{TO}.migration.lock"));
            assert_eq!(after, before, "{phase:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn recovery_refuses_a_target_link_to_the_source() {
        for phase in [Phase::Copying, Phase::Renaming, Phase::Failed] {
            for partial in [false, true] {
                let f = Fixture::new();
                let mut journal = Journal::new(FROM, "start".into(), f.bases());
                journal.phase = phase;
                write_json_atomic(&journal_path(&f.roaming, TO), &journal).unwrap();
                let link = if partial { partial_path(&f.roaming, TO) } else { f.roaming.join(TO) };
                std::os::unix::fs::symlink(f.roaming.join(FROM), &link).unwrap();
                let before = snapshot(f.root());
                assert!(matches!(seed(&f.bases()).outcome, SeedOutcome::Failed(_)));
                let mut after = snapshot(f.root());
                after.remove(&format!("roaming/{TO}.migration.lock"));
                assert_eq!(after, before, "{phase:?}, partial={partial}");
            }
        }
    }

    #[test]
    fn copied_marker_does_not_suppress_a_new_notice() {
        let f = Fixture::new();
        let mut journal = Journal::new(FROM, "new migration".into(), f.bases());
        journal.webview_skipped = true;
        journal.phase = Phase::Renaming;
        write_json_atomic(&journal_path(&f.roaming, TO), &journal).unwrap();
        let old = Marker {
            status: "seeded".into(),
            from: FROM.into(),
            app_version: "0.2.1".into(),
            started: "old migration".into(),
            finished: "old migration".into(),
            files_copied: 0,
            bytes_copied: 0,
            copied: vec![],
            skipped: vec![],
            error: None,
            webview_skipped: true,
            notified: true,
        };
        fs::create_dir_all(partial_path(&f.roaming, TO)).unwrap();
        write_json_atomic(&partial_path(&f.roaming, TO).join(MARKER), &old).unwrap();
        seed(&f.bases());
        assert!(webview_notice_pending(&f.roaming, TO));
    }

    #[test]
    fn atomic_write_does_not_overwrite_a_linked_temporary_file() {
        let dir = TempDir::new();
        let source = dir.0.join("source");
        write(&source, "keep source bytes");
        let target = dir.0.join("marker.json");
        fs::hard_link(&source, dir.0.join("marker.json.tmp")).unwrap();
        write_json_atomic(&target, &"new marker").unwrap();
        assert_eq!(fs::read_to_string(&source).unwrap(), "keep source bytes");
        assert_eq!(fs::read_to_string(&target).unwrap(), "\"new marker\"");
    }

    #[cfg(unix)]
    #[test]
    fn copied_marker_temporary_link_does_not_modify_the_source() {
        let f = Fixture::new();
        std::os::unix::fs::symlink(
            f.roaming.join(FROM).join("settings.toml"),
            f.roaming.join(FROM).join(format!("{MARKER}.tmp")),
        )
        .unwrap();
        let before = f.sources();
        assert_eq!(seed(&f.bases()).outcome, SeedOutcome::Seeded);
        assert_eq!(f.sources(), before);
        assert_eq!(marker(&f.roaming).status, "seeded");
    }

    #[test]
    fn formats_utc_timestamps() {
        assert_eq!(rfc3339(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        assert_eq!(rfc3339(UNIX_EPOCH + Duration::from_secs(951_782_400)), "2000-02-29T00:00:00.000Z");
        assert_eq!(rfc3339(UNIX_EPOCH + Duration::from_millis(1_700_000_000_123)), "2023-11-14T22:13:20.123Z");
    }
}
