//! Upload, download, delete and synchronise project files with a deployment
//! server through a shared filesystem interface.

use crate::mapping::{Excludes, Mappings, posix};
use ide_core::remote_settings::DeploymentServer;
use ide_core::{CancellationToken, IdeError, IdeResult};
use ide_ssh::RemoteFs;
use ide_ssh::sftp::mtime_of;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Mapping eligibility uses a common synthetic server root: mapping and exclusion
/// paths are both relative to that root, so checking never opens a connection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentCoverage {
    pub server: String,
    pub paths: Vec<String>,
    pub skipped: Vec<TransferError>,
}

pub fn coverage(settings: &ide_core::settings::Settings, root: &Path, paths: &[PathBuf]) -> Vec<DeploymentCoverage> {
    settings
        .deployment
        .servers
        .iter()
        .map(|server| {
            let selection = Selection::new(settings, server, root);
            let mut result = DeploymentCoverage { server: server.id.clone(), paths: Vec::new(), skipped: Vec::new() };
            for path in paths {
                match selection.deployable(path) {
                    Ok(found) => {
                        for p in found {
                            let name = ide_core::ipc_path::to_ipc(&p);
                            if !result.paths.contains(&name) {
                                result.paths.push(name);
                            }
                        }
                    }
                    Err(message) => result
                        .skipped
                        .push(TransferError { path: ide_core::ipc_path::to_ipc(path), message: message.into() }),
                }
            }
            result
        })
        .collect()
}

/// `paths` with every selected folder outside all mappings replaced by the mapped folders inside
/// it, as [`coverage`] reports them. Other paths stay, so the transfer still reports them.
pub(crate) fn expand_selection(
    settings: &ide_core::settings::Settings,
    server: &DeploymentServer,
    root: &Path,
    paths: &[PathBuf],
) -> Vec<PathBuf> {
    let selection = Selection::new(settings, server, root);
    let mut out: Vec<PathBuf> = Vec::new();
    for path in paths {
        for p in selection.deployable(path).unwrap_or_else(|_| vec![path.clone()]) {
            if !out.contains(&p) {
                out.push(p);
            }
        }
    }
    out
}

/// Eligibility of selected paths on one server, checked locally.
struct Selection {
    map: Mappings,
    exclude: Excludes,
    /// Local folders of the server's mappings, resolved as [`Mappings::new`] does. Only
    /// candidates: [`Selection::deployable`] keeps those the mappings accept.
    folders: Vec<PathBuf>,
}

impl Selection {
    fn new(settings: &ide_core::settings::Settings, server: &DeploymentServer, root: &Path) -> Self {
        let folders = server
            .mappings
            .iter()
            .map(|m| {
                let local = m.local.trim().trim_matches('/');
                if local.is_empty() { root.to_path_buf() } else { root.join(local) }
            })
            .collect();
        Self {
            map: Mappings::new(server, root, "/"),
            exclude: Excludes::new(&settings.deployment, server, "/"),
            folders,
        }
    }

    /// What `path` deploys as: itself when a mapping covers it, or for a folder outside every
    /// mapping the mapped folders inside it. Otherwise why nothing under it deploys.
    fn deployable(&self, path: &Path) -> Result<Vec<PathBuf>, &'static str> {
        let reason = match mapped_path(&self.map, &self.exclude, path) {
            Ok(_) => return Ok(vec![path.to_path_buf()]),
            Err(reason) => reason,
        };
        // Covered but excluded: what is under it stays excluded.
        if self.map.remote(path).is_some() {
            return Err(reason);
        }
        let inner: Vec<PathBuf> = self
            .folders
            .iter()
            .filter(|f| f.starts_with(path) && f.as_path() != path)
            .filter(|f| mapped_path(&self.map, &self.exclude, f).is_ok())
            .cloned()
            .collect();
        if inner.is_empty() { Err(reason) } else { Ok(inner) }
    }
}

fn mapped_path(map: &Mappings, exclude: &Excludes, local: &Path) -> Result<String, &'static str> {
    let remote = map.remote(local).ok_or("Not covered by this server's mappings")?;
    if exclude.local(local.strip_prefix(map.project_root()).unwrap_or(local)) || exclude.remote(&remote) {
        return Err("Excluded from deployment");
    }
    Ok(remote)
}

/// Modification times closer than this count as equal (FAT, rounding by servers).
const MTIME_SLACK: u32 = 2;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TransferReport {
    pub files: u32,
    /// Files left alone: excluded, or outside every mapping.
    pub skipped: u32,
    pub errors: Vec<TransferError>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TransferError {
    pub path: String,
    pub message: String,
}

impl TransferReport {
    fn fail(&mut self, path: impl Into<String>, e: IdeError) {
        self.errors.push(TransferError { path: path.into(), message: e.message });
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileStamp {
    pub size: u64,
    pub mtime: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SyncStatus {
    LocalOnly,
    RemoteOnly,
    LocalNewer,
    RemoteNewer,
    /// Same time, different size.
    Different,
    Same,
}

/// One file of Sync with Deployed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncEntry {
    /// Project-relative, `/`-separated.
    pub path: String,
    pub remote_path: String,
    pub local: Option<FileStamp>,
    pub remote: Option<FileStamp>,
    pub status: SyncStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SyncAction {
    Upload,
    Download,
    DeleteRemote,
    DeleteLocal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncStep {
    /// Project-relative, `/`-separated.
    pub path: String,
    pub action: SyncAction,
}

pub fn status(local: Option<FileStamp>, remote: Option<FileStamp>) -> SyncStatus {
    match (local, remote) {
        (Some(_), None) => SyncStatus::LocalOnly,
        (None, Some(_)) | (None, None) => SyncStatus::RemoteOnly,
        (Some(l), Some(r)) => match (l.mtime, r.mtime) {
            (Some(lt), Some(rt)) if lt > rt + MTIME_SLACK => SyncStatus::LocalNewer,
            (Some(lt), Some(rt)) if rt > lt + MTIME_SLACK => SyncStatus::RemoteNewer,
            _ if l.size != r.size => SyncStatus::Different,
            _ => SyncStatus::Same,
        },
    }
}

/// Operations on one server through its filesystem.
pub struct Deployment<'a> {
    pub fs: &'a RemoteFs,
    pub map: &'a Mappings,
    pub exclude: &'a Excludes,
    pub preserve_time: bool,
    pub cancel: CancellationToken,
}

impl Deployment<'_> {
    fn rel(&self, local: &Path) -> String {
        posix(local.strip_prefix(self.map.project_root()).unwrap_or(local))
    }

    fn excluded_local(&self, local: &Path) -> bool {
        self.exclude.local(local.strip_prefix(self.map.project_root()).unwrap_or(local))
    }

    /// Local files under `paths` (folders recursively), excluded names left out.
    fn local_files(&self, paths: &[PathBuf], report: &mut TransferReport) -> Vec<PathBuf> {
        let mut out = Vec::new();
        for p in paths {
            if self.excluded_local(p) {
                report.skipped += 1;
                continue;
            }
            if p.is_dir() {
                let walk = ignore::WalkBuilder::new(p).standard_filters(false).follow_links(false).build();
                for entry in walk.flatten() {
                    let path = entry.path();
                    if entry.file_type().is_some_and(|t| t.is_file()) {
                        if self.excluded_local(path) {
                            report.skipped += 1;
                        } else {
                            out.push(path.to_path_buf());
                        }
                    }
                }
            } else if p.is_file() {
                out.push(p.clone());
            }
        }
        out
    }

    /// Remote files under `dir` (recursively), excluded ones left out.
    async fn remote_files(&self, dir: &str, out: &mut Vec<ide_ssh::RemoteEntry>) -> IdeResult<()> {
        for e in self.fs.list(dir).await? {
            if self.cancel.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            if self.exclude.remote(&e.path) {
                continue;
            }
            if e.is_dir && !e.is_symlink {
                Box::pin(self.remote_files(&e.path, out)).await?;
            } else if !e.is_dir {
                out.push(e);
            }
        }
        Ok(())
    }

    pub async fn upload(
        &self,
        paths: &[PathBuf],
        progress: &mut (dyn FnMut(&str, usize, usize) + Send),
    ) -> TransferReport {
        let mut report = TransferReport::default();
        let files = self.local_files(paths, &mut report);
        for (i, local) in files.iter().enumerate() {
            if self.cancel.is_cancelled() {
                break;
            }
            let rel = self.rel(local);
            let Some(remote) = mapped_path(self.map, self.exclude, local).ok() else {
                report.skipped += 1;
                continue;
            };
            progress(&rel, i, files.len());
            match self.fs.upload(local, &remote, self.preserve_time).await {
                Ok(()) => report.files += 1,
                Err(e) => report.fail(rel, e),
            }
        }
        report
    }

    /// Downloads the remote counterparts of `paths` (folders recursively).
    pub async fn download(
        &self,
        paths: &[PathBuf],
        progress: &mut (dyn FnMut(&str, usize, usize) + Send),
    ) -> TransferReport {
        let mut report = TransferReport::default();
        let mut jobs: Vec<(String, PathBuf)> = Vec::new();
        for p in paths {
            let Some(remote) = mapped_path(self.map, self.exclude, p).ok() else {
                report.skipped += 1;
                continue;
            };
            match self.fs.stat(&remote).await {
                Ok(Some(e)) if e.is_dir => {
                    let mut files = Vec::new();
                    if let Err(e) = self.remote_files(&remote, &mut files).await {
                        report.fail(self.rel(p), e);
                    }
                    for f in files {
                        if let Some(local) = self.map.local(&f.path) {
                            jobs.push((f.path, local));
                        }
                    }
                }
                Ok(Some(_)) => jobs.push((remote, p.clone())),
                Ok(None) => {
                    report.fail(self.rel(p), IdeError::not_found(format!("{remote} does not exist on the server")))
                }
                Err(e) => report.fail(self.rel(p), e),
            }
        }
        for (i, (remote, local)) in jobs.iter().enumerate() {
            if self.cancel.is_cancelled() {
                break;
            }
            if self.excluded_local(local) {
                report.skipped += 1;
                continue;
            }
            let rel = self.rel(local);
            progress(&rel, i, jobs.len());
            match self.fs.download(remote, local).await {
                Ok(()) => report.files += 1,
                Err(e) => report.fail(rel, e),
            }
        }
        report
    }

    /// Deletes the remote counterparts of `paths`. A folder goes with what is under it, except
    /// excluded entries and mapping roots: those stay, with the folders that lead to them, and
    /// each one kept counts as skipped.
    pub async fn delete_remote(&self, paths: &[PathBuf]) -> TransferReport {
        let mut report = TransferReport::default();
        for p in paths {
            // Never a whole mapping (the project folder went away, or a mapped folder did).
            let Some(remote) = mapped_path(self.map, self.exclude, p).ok().filter(|r| !self.map.is_root(r)) else {
                report.skipped += 1;
                continue;
            };
            // `lstat`: a symlink is removed itself, never the folder it points to.
            let removed = match self.fs.lstat(&remote).await {
                Ok(None) => continue,
                Ok(Some(e)) if e.is_dir && !e.is_symlink => self.remove_tree(&remote, &mut report).await.map(|_| ()),
                Ok(Some(_)) => self.fs.remove(&remote).await,
                Err(e) => Err(e),
            };
            match removed {
                Ok(()) => report.files += 1,
                Err(e) => report.fail(self.rel(p), e),
            }
        }
        report
    }

    /// What a folder deletion keeps: excluded entries and mapping roots.
    fn protected(&self, remote: &str) -> bool {
        self.exclude.remote(remote) || self.map.is_root(remote)
    }

    /// Removes what `dir` holds, then `dir` once nothing protected is left in it. Returns whether
    /// `dir` itself went.
    async fn remove_tree(&self, dir: &str, report: &mut TransferReport) -> IdeResult<bool> {
        let mut kept = false;
        for e in self.fs.list(dir).await? {
            if self.cancel.is_cancelled() {
                return Err(IdeError::cancelled());
            }
            if self.protected(&e.path) {
                report.skipped += 1;
                kept = true;
            } else if e.is_dir && !e.is_symlink {
                kept |= !Box::pin(self.remove_tree(&e.path, report)).await?;
            } else {
                self.fs.remove(&e.path).await?;
            }
        }
        if !kept {
            // Not recursive: anything the listing missed keeps the folder, with an error.
            self.fs.remove_empty_dir(dir).await?;
        }
        Ok(!kept)
    }

    /// Sync with Deployed: local and remote files under `local` side by side.
    pub async fn compare(&self, local: &Path) -> IdeResult<Vec<SyncEntry>> {
        let remote_root = mapped_path(self.map, self.exclude, local)
            .map_err(|reason| IdeError::invalid(format!("{}: {reason}", local.display())))?;
        let mut by_rel: BTreeMap<String, SyncEntry> = BTreeMap::new();
        let mut ignored = TransferReport::default();
        for f in self.local_files(&[local.to_path_buf()], &mut ignored) {
            let Ok(remote_path) = mapped_path(self.map, self.exclude, &f) else { continue };
            let size = std::fs::metadata(&f).map(|m| m.len()).unwrap_or(0);
            let stamp = FileStamp { size, mtime: mtime_of(&f) };
            by_rel.insert(
                self.rel(&f),
                SyncEntry {
                    path: self.rel(&f),
                    remote_path,
                    local: Some(stamp),
                    remote: None,
                    status: SyncStatus::LocalOnly,
                },
            );
        }
        let mut remote = Vec::new();
        match self.fs.stat(&remote_root).await? {
            Some(e) if e.is_dir => self.remote_files(&remote_root, &mut remote).await?,
            Some(e) => remote.push(e),
            None => {}
        }
        for e in remote {
            let Some(l) = self.map.local(&e.path) else { continue };
            if self.excluded_local(&l) {
                continue;
            }
            let rel = self.rel(&l);
            let stamp = FileStamp { size: e.size, mtime: e.mtime };
            by_rel.entry(rel.clone()).and_modify(|x| x.remote = Some(stamp)).or_insert(SyncEntry {
                path: rel,
                remote_path: e.path,
                local: None,
                remote: Some(stamp),
                status: SyncStatus::RemoteOnly,
            });
        }
        Ok(by_rel
            .into_values()
            .map(|mut e| {
                e.status = status(e.local, e.remote);
                e
            })
            .collect())
    }

    /// Applies the chosen Sync with Deployed actions.
    pub async fn apply(
        &self,
        steps: &[SyncStep],
        progress: &mut (dyn FnMut(&str, usize, usize) + Send),
    ) -> TransferReport {
        let mut report = TransferReport::default();
        let root = self.map.project_root().to_path_buf();
        for (i, step) in steps.iter().enumerate() {
            if self.cancel.is_cancelled() {
                break;
            }
            let local = step.path.split('/').filter(|s| !s.is_empty()).fold(root.clone(), |p, s| p.join(s));
            let Some(remote) = mapped_path(self.map, self.exclude, &local).ok() else {
                report.skipped += 1;
                continue;
            };
            progress(&step.path, i, steps.len());
            let r = match step.action {
                SyncAction::Upload => self.fs.upload(&local, &remote, self.preserve_time).await,
                SyncAction::Download => self.fs.download(&remote, &local).await,
                SyncAction::DeleteRemote => self.fs.remove(&remote).await,
                SyncAction::DeleteLocal => std::fs::remove_file(&local).map_err(IdeError::from),
            };
            match r {
                Ok(()) => report.files += 1,
                Err(e) => report.fail(step.path.clone(), e),
            }
        }
        report
    }

    /// Uploads what changed locally under `local` (new, newer or resized files): sync before a run.
    pub async fn push_changes(
        &self,
        local: &Path,
        progress: &mut (dyn FnMut(&str, usize, usize) + Send),
    ) -> IdeResult<TransferReport> {
        let steps: Vec<SyncStep> = self
            .compare(local)
            .await?
            .into_iter()
            .filter(|e| matches!(e.status, SyncStatus::LocalOnly | SyncStatus::LocalNewer | SyncStatus::Different))
            .map(|e| SyncStep { path: e.path, action: SyncAction::Upload })
            .collect();
        Ok(self.apply(&steps, progress).await)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stamp(size: u64, mtime: u32) -> Option<FileStamp> {
        Some(FileStamp { size, mtime: Some(mtime) })
    }

    #[test]
    fn compares_by_time_then_size() {
        assert_eq!(status(stamp(1, 100), None), SyncStatus::LocalOnly);
        assert_eq!(status(None, stamp(1, 100)), SyncStatus::RemoteOnly);
        assert_eq!(status(stamp(1, 200), stamp(1, 100)), SyncStatus::LocalNewer);
        assert_eq!(status(stamp(1, 100), stamp(1, 200)), SyncStatus::RemoteNewer);
        assert_eq!(status(stamp(1, 101), stamp(1, 100)), SyncStatus::Same);
        assert_eq!(status(stamp(2, 100), stamp(1, 100)), SyncStatus::Different);
    }
}
