/** Git menu dialogs: Pull…, Merge…, Rebase…, Manage Remotes… and Worktrees. */
import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import type { Branch, MergeOptions, Remote, Worktree } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { call, commands } from "@/platform/ipc";
import { notifications } from "@/workbench/contributions";
import { Checkbox, Dialog, IconButton, Input, Select, T, type SelectOption } from "@/ui";
import { sortLocal, sortRemote } from "./branches";
import { conflictActions, openConflictsInstead, validateBranchName } from "./branchOps";
import { confirmDialog, openDialog } from "./dialogs";
import { errorMessage, runOp, runRemote, saveAll } from "./ops";
import { currentRepo, loadBranches, refreshNow, repoName, useVcs } from "./store";
import styles from "./common.module.css";
import { tx } from "@/platform/i18n";

// --- shared -----------------------------------------------------------------

export type MergeFlag = "noFf" | "ffOnly" | "squash" | "noCommit";

/** Flags git refuses together with `flag`. */
const EXCLUSIVE: Record<MergeFlag, MergeFlag[]> = {
  noFf: ["ffOnly", "squash"],
  ffOnly: ["noFf", "squash", "noCommit"],
  squash: ["noFf", "ffOnly"],
  noCommit: ["ffOnly"],
};

/** Merge flags that cannot be turned on next to the `on` ones (and with `--rebase`). */
export function disabledMergeFlags(on: ReadonlySet<MergeFlag>, rebase = false): Set<MergeFlag> {
  if (rebase) return new Set<MergeFlag>(["noFf", "ffOnly", "squash", "noCommit"]);
  const out = new Set<MergeFlag>();
  for (const f of on) for (const x of EXCLUSIVE[f]) out.add(x);
  return out;
}

export function mergeOptionsOf(on: ReadonlySet<MergeFlag>, message: string | null = null): MergeOptions {
  return {
    noFf: on.has("noFf"),
    ffOnly: on.has("ffOnly"),
    squash: on.has("squash"),
    noCommit: on.has("noCommit"),
    message: message?.trim() || null,
  };
}

const FLAG_LABELS: Array<[MergeFlag, string]> = [
  ["noFf", "--no-ff"],
  ["ffOnly", "--ff-only"],
  ["squash", "--squash"],
  ["noCommit", "--no-commit"],
];

function MergeFlags({
  on,
  setOn,
  rebase = false,
}: {
  on: Set<MergeFlag>;
  setOn: (next: Set<MergeFlag>) => void;
  rebase?: boolean;
}) {
  const disabled = disabledMergeFlags(on, rebase);
  return (
    <div className={styles.optionGrid} role="group" aria-label={tx("Merge options")}>
      {FLAG_LABELS.map(([flag, label]) => (
        <Checkbox
          key={flag}
          label={label}
          checked={on.has(flag)}
          disabled={disabled.has(flag) && !on.has(flag)}
          onChange={(v) => {
            const next = new Set(on);
            if (v) next.add(flag);
            else next.delete(flag);
            setOn(next);
          }}
        />
      ))}
    </div>
  );
}

export function useDialogRepo(initialRepo?: string | null) {
  const roots = useVcs((s) => s.roots);
  const defaultRepo = initialRepo && roots.includes(initialRepo) ? initialRepo : currentRepo();
  const [selectedRepo, setSelectedRepo] = useState<string | null>(defaultRepo);
  const repo = selectedRepo && (roots.length === 0 || roots.includes(selectedRepo)) ? selectedRepo : defaultRepo;
  return { repo, roots, setRepo: setSelectedRepo };
}

export function RepoSelect({
  roots,
  value,
  onChange,
}: {
  roots: readonly string[];
  value: string | null;
  onChange: (repo: string) => void;
}) {
  if (roots.length <= 1) return null;
  return (
    <>
      <div className={styles.fieldLabel}>
        <T>Repository:</T>
      </div>
      <Select
        aria-label="Repository"
        value={value ?? roots[0] ?? null}
        options={roots.map((r) => ({ value: r, label: repoName(r), detail: r, icon: "folder" }))}
        onChange={onChange}
      />
    </>
  );
}

function useRepoBranches(repo: string | null): { branches: Branch[]; head: string | null; upstream: string | null } {
  const storeBranches = useVcs((s) => s.branches);
  const storeBranch = useVcs((s) => s.branch);
  const branchesRepo = useVcs((s) => s.branchesRepo);
  const heads = useVcs((s) => s.heads);
  const [repoBranches, setRepoBranches] = useState<{ repo: string | null; list: Branch[] } | null>(null);

  useEffect(() => {
    let alive = true;
    if (!repo || repo === currentRepo()) {
      void loadBranches().catch(() => undefined);
    }
    call(commands.vcsBranches(repo))
      .then((list) => {
        if (alive && Array.isArray(list)) setRepoBranches({ repo, list });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [repo]);

  const branches =
    repoBranches && repoBranches.repo === repo
      ? repoBranches.list
      : !repo || repo === branchesRepo || !branchesRepo
        ? storeBranches
        : [];
  const headInfo = repo && heads[repo] ? heads[repo]! : !repo || repo === currentRepo() ? storeBranch : null;
  const currentLocal = branches.find((b) => !b.remote && b.current);
  const head = headInfo?.head ?? currentLocal?.name ?? storeBranch?.head ?? null;
  const upstream = currentLocal?.upstream ?? (!repo || repo === currentRepo() ? (storeBranch?.upstream ?? null) : null);
  return { branches, head, upstream };
}

const branchOptions = (list: readonly Branch[]): SelectOption[] =>
  list.filter((b) => !b.name.endsWith("/HEAD")).map((b) => ({ value: b.name, label: b.name, icon: "branch" }));

/** Remote branches of `remote` without the remote prefix (`origin/main` → `main`). */
export function remoteBranchesOf(branches: readonly Branch[], remote: string): string[] {
  const prefix = `${remote}/`;
  return sortRemote(branches)
    .filter((b) => b.name.startsWith(prefix) && b.name !== `${prefix}HEAD`)
    .map((b) => b.name.slice(prefix.length));
}

// --- Pull -------------------------------------------------------------------

export function showPullDialog(initialRepo?: string) {
  openDialog((close) => <PullDialog initialRepo={initialRepo} onClose={close} />);
}

function PullDialog({ initialRepo, onClose }: { initialRepo?: string; onClose: () => void }) {
  const { repo, roots, setRepo } = useDialogRepo(initialRepo);
  const { branches, head, upstream: headUpstream } = useRepoBranches(repo);
  const [remotes, setRemotes] = useState<Remote[] | null>(null);
  const [remote, setRemote] = useState<string | null>(null);
  const [chosenBranch, setBranch] = useState<string | null>(null);
  const [rebase, setRebase] = useState(false);
  const [flags, setFlags] = useState<Set<MergeFlag>>(() => new Set());

  useEffect(() => {
    let alive = true;
    call(commands.vcsRemotes(repo))
      .then((list) => {
        if (!alive) return;
        setRemotes(list);
        const upstreamRemote = headUpstream?.split("/")[0];
        setRemote(list.find((r) => r.name === upstreamRemote)?.name ?? list[0]?.name ?? null);
      })
      .catch(() => alive && setRemotes([]));
    return () => {
      alive = false;
    };
  }, [repo, headUpstream]);

  const remoteBranches = useMemo(() => (remote ? remoteBranchesOf(branches, remote) : []), [branches, remote]);
  // Default: the upstream's branch, else the same name as the current branch.
  const upstream = remote && headUpstream?.startsWith(`${remote}/`) ? headUpstream.slice(remote.length + 1) : null;
  const preferred = upstream ?? head ?? null;
  const branch =
    chosenBranch && remoteBranches.includes(chosenBranch)
      ? chosenBranch
      : preferred && remoteBranches.includes(preferred)
        ? preferred
        : (remoteBranches[0] ?? null);

  const run = async () => {
    if (!remote) return;
    onClose();
    await saveAll();
    await runRemote(
      { op: "pullFrom", remote, branches: branch ? [branch] : [], rebase, options: mergeOptionsOf(rebase ? new Set() : flags) },
      `${head ?? "HEAD"} ← ${remote}${branch ? `/${branch}` : ""}`,
      [repo],
    );
  };

  return (
    <Dialog
      open
      title={tx`Pull to ${head ?? "HEAD"}`}
      onClose={onClose}
      width={460}
      buttons={[
        { label: "Pull", role: "default", disabled: !remote, onClick: () => void run() },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.form}>
        <RepoSelect roots={roots} value={repo} onChange={setRepo} />
        {remotes && !remotes.length ? (
          <div className={styles.hint}>
            <T>No remotes are configured. Add one with Git › Manage Remotes….</T>
          </div>
        ) : (
          <div className={styles.fieldRow}>
            <Select
              aria-label="Remote"
              value={remote}
              options={(remotes ?? []).map((r) => ({ value: r.name, label: r.name, detail: r.url }))}
              onChange={setRemote}
            />
            <Select
              aria-label="Remote branch"
              className={styles.grow}
              value={branch}
              placeholder="Branch"
              options={remoteBranches.map((b) => ({ value: b, label: b, icon: "branch" }))}
              onChange={setBranch}
            />
          </div>
        )}
        <div className={styles.fieldLabel}>
          <T>Options:</T>
        </div>
        <Checkbox label="--rebase" checked={rebase} onChange={setRebase} />
        <MergeFlags on={flags} setOn={setFlags} rebase={rebase} />
        <div className={styles.hint}>
          <T>Uncommitted changes are stashed before the pull and restored afterwards.</T>
        </div>
      </div>
    </Dialog>
  );
}

// --- Merge ------------------------------------------------------------------

export function showMergeDialog(initialRepo?: string) {
  openDialog((close) => <MergeDialog initialRepo={initialRepo} onClose={close} />);
}

function MergeDialog({ initialRepo, onClose }: { initialRepo?: string; onClose: () => void }) {
  const { repo, roots, setRepo } = useDialogRepo(initialRepo);
  const { branches, head } = useRepoBranches(repo);
  const [branch, setBranch] = useState<string | null>(null);
  const [flags, setFlags] = useState<Set<MergeFlag>>(() => new Set());
  const [withMessage, setWithMessage] = useState(false);
  const [message, setMessage] = useState("");
  const options = useMemo(
    () => [...branchOptions(sortLocal(branches).filter((b) => !b.current)), ...branchOptions(sortRemote(branches))],
    [branches],
  );

  const run = async () => {
    if (!branch) return;
    onClose();
    await saveAll();
    const target = head ?? "HEAD";
    await runOp(
      `Merge ${branch} into ${target}`,
      () => call(commands.vcsMergeWith(repo, [branch], mergeOptionsOf(flags, withMessage ? message : null))),
      { success: `Merged ${branch} into ${target}`, errorActions: conflictActions, onError: openConflictsInstead },
    );
    await refreshNow();
  };

  return (
    <Dialog
      open
      title={tx`Merge into ${head ?? "HEAD"}`}
      onClose={onClose}
      width={460}
      buttons={[
        { label: "Merge", role: "default", disabled: !branch, onClick: () => void run() },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.form}>
        <RepoSelect roots={roots} value={repo} onChange={setRepo} />
        <div className={styles.fieldLabel}>
          <T>Branch to merge:</T>
        </div>
        <Select aria-label="Branch to merge" value={branch} placeholder="Select branch" options={options} onChange={setBranch} />
        <div className={styles.fieldLabel}>
          <T>Options:</T>
        </div>
        <MergeFlags on={flags} setOn={setFlags} />
        <Checkbox label="-m (commit message)" checked={withMessage} onChange={setWithMessage} />
        {withMessage && (
          <Input
            aria-label="Commit message"
            value={message}
            placeholder={branch ? tx`Merge branch '${branch}' into ${head ?? "HEAD"}` : ""}
            onChange={(e) => setMessage(e.target.value)}
          />
        )}
      </div>
    </Dialog>
  );
}

// --- Rebase -----------------------------------------------------------------

export function showRebaseDialog(initialRepo?: string) {
  openDialog((close) => <RebaseDialog initialRepo={initialRepo} onClose={close} />);
}

function RebaseDialog({ initialRepo, onClose }: { initialRepo?: string; onClose: () => void }) {
  const { repo, roots, setRepo } = useDialogRepo(initialRepo);
  const { branches, head } = useRepoBranches(repo);
  const [upstream, setUpstream] = useState<string | null>(null);
  const [useOnto, setUseOnto] = useState(false);
  const [onto, setOnto] = useState<string | null>(null);
  const [rebaseMerges, setRebaseMerges] = useState(false);
  const [keepEmpty, setKeepEmpty] = useState(false);
  const options = useMemo(
    () => [...branchOptions(sortLocal(branches).filter((b) => !b.current)), ...branchOptions(sortRemote(branches))],
    [branches],
  );
  const ready = !!upstream && (!useOnto || !!onto);

  const run = async () => {
    if (!upstream) return;
    onClose();
    await saveAll();
    const target = useOnto && onto ? onto : upstream;
    const current = head ?? "HEAD";
    await runOp(
      `Rebase ${current} onto ${target}`,
      () =>
        call(
          commands.vcsRebaseWith(repo, upstream, {
            onto: useOnto ? onto : null,
            rebaseMerges,
            keepEmpty,
          }),
        ),
      { success: `Rebased ${current} onto ${target}`, errorActions: conflictActions, onError: openConflictsInstead },
    );
    await refreshNow();
  };

  return (
    <Dialog
      open
      title="Rebase"
      onClose={onClose}
      width={460}
      buttons={[
        { label: "Rebase", role: "default", disabled: !ready, onClick: () => void run() },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.form}>
        <RepoSelect roots={roots} value={repo} onChange={setRepo} />
        <div className={styles.fieldLabel}>
          {useOnto ? tx`Rebase commits of ${head ?? "HEAD"} not on:` : `Rebase ${head ?? "HEAD"} onto:`}
        </div>
        <Select aria-label="Upstream" value={upstream} placeholder="Select branch" options={options} onChange={setUpstream} />
        <Checkbox label="--onto" checked={useOnto} onChange={setUseOnto} />
        {useOnto && (
          <Select aria-label="New base" value={onto} placeholder="New base" options={options} onChange={setOnto} />
        )}
        <Checkbox label="--rebase-merges" checked={rebaseMerges} onChange={setRebaseMerges} />
        <Checkbox label="--keep-empty" checked={keepEmpty} onChange={setKeepEmpty} />
        <div className={styles.hint}>
          <T>Uncommitted changes are stashed before the rebase and restored afterwards.</T>
        </div>
      </div>
    </Dialog>
  );
}

// --- Manage Remotes ---------------------------------------------------------

/** Error for a remote name, or null (`existing`: the other remotes' names). */
export function validateRemoteName(name: string, existing: readonly string[]): string | null {
  const n = name.trim();
  if (!n) return "Enter a remote name";
  if (/\s/.test(n) || n.startsWith("-") || /[~^:?*[\\]/.test(n) || n.includes("..")) return "Invalid remote name";
  if (existing.includes(n)) return `Remote '${n}' already exists`;
  return null;
}

export function showManageRemotes(initialRepo?: string) {
  openDialog((close) => <RemotesDialog initialRepo={initialRepo} onClose={close} />);
}

type RemoteSelection = { repo: string | null; name: string };

function RemotesDialog({ initialRepo, onClose }: { initialRepo?: string; onClose: () => void }) {
  const vcsRoots = useVcs((s) => s.roots);
  const multiRepo = vcsRoots.length > 1;
  const targetRoots = useMemo<ReadonlyArray<string | null>>(
    () => (multiRepo ? vcsRoots : [initialRepo ?? currentRepo()]),
    [multiRepo, vcsRoots, initialRepo],
  );
  const [byRepo, setByRepo] = useState<Record<string, Remote[]>>({});
  const [selected, setSelected] = useState<RemoteSelection | null>(null);
  const [activeRepo, setActiveRepo] = useState<string | null>(
    () => (initialRepo && vcsRoots.includes(initialRepo) ? initialRepo : (targetRoots[0] ?? null)),
  );
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(
    (prefer?: RemoteSelection | null, focusEmptyRepo?: string | null) =>
      Promise.all(
        targetRoots.map((r) =>
          call(commands.vcsRemotes(r)).then(
            (list) => [r ?? "", list, null] as const,
            (e) => [r ?? "", [] as Remote[], errorMessage(e)] as const,
          ),
        ),
      ).then((entries) => {
        const next: Record<string, Remote[]> = {};
        let firstError: string | null = null;
        let firstSel: RemoteSelection | null = null;
        for (const [key, list, err] of entries) {
          next[key] = list;
          if (err && !firstError) firstError = err;
          if (!firstSel && list.length > 0) {
            firstSel = { repo: key || null, name: list[0]!.name };
          }
        }
        setByRepo(next);
        if (firstError) setError(firstError);
        setSelected((prev) => {
          if (prefer) {
            const list = next[prefer.repo ?? ""] ?? [];
            if (list.some((r) => r.name === prefer.name)) return prefer;
          }
          if (focusEmptyRepo !== undefined) {
            const list = next[focusEmptyRepo ?? ""] ?? [];
            return list.length > 0 ? { repo: focusEmptyRepo, name: list[0]!.name } : null;
          }
          if (prev) {
            const list = next[prev.repo ?? ""] ?? [];
            if (list.some((r) => r.name === prev.name)) return prev;
            if (list.length > 0) return { repo: prev.repo, name: list[0]!.name };
            return null;
          }
          if (initialRepo && initialRepo in next) {
            const list = next[initialRepo] ?? [];
            return list.length > 0 ? { repo: initialRepo, name: list[0]!.name } : null;
          }
          return firstSel;
        });
      }),
    [targetRoots, initialRepo],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  const apply = async (repo: string | null, editOp: Parameters<typeof commands.vcsEditRemote>[1]) => {
    try {
      await call(commands.vcsEditRemote(repo, editOp));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
    setActiveRepo(repo);
    const prefer =
      editOp.op === "add"
        ? { repo, name: editOp.name }
        : editOp.op === "edit"
          ? { repo, name: editOp.new_name }
          : null;
    await reload(prefer, editOp.op === "remove" ? repo : undefined);
    void loadBranches().catch(() => undefined);
  };

  const currentRemote = useMemo(() => {
    if (!selected) return undefined;
    const list = byRepo[selected.repo ?? ""] ?? [];
    return list.find((r) => r.name === selected.name);
  }, [byRepo, selected]);

  const openEdit = (target?: { repo: string | null; remote: Remote }) => {
    const defaultRepo = target?.repo ?? selected?.repo ?? activeRepo ?? targetRoots[0] ?? null;
    openDialog((close) => (
      <RemoteEditDialog
        remote={target?.remote}
        roots={multiRepo && !target ? vcsRoots : []}
        initialRepo={defaultRepo}
        existingByRepo={Object.fromEntries(
          Object.entries(byRepo).map(([k, list]) => [
            k,
            list.map((r) => r.name).filter((n) => n !== target?.remote.name),
          ]),
        )}
        onDone={(r) => {
          close();
          if (!r) return;
          const repoForOp = target ? target.repo : r.repo;
          void apply(
            repoForOp,
            target
              ? { op: "edit", name: target.remote.name, new_name: r.name, url: r.url }
              : { op: "add", name: r.name, url: r.url },
          );
        }}
      />
    ));
  };

  const remove = async () => {
    if (!selected || !currentRemote) return;
    const repoSuffix = multiRepo && selected.repo ? ` from ${repoName(selected.repo)}` : "";
    const ok = await confirmDialog({
      title: "Remove Remote",
      message: tx`Remove remote '${selected.name}'${repoSuffix}? Its remote-tracking branches are deleted.`,
      okLabel: "Remove",
      danger: true,
    });
    if (ok) await apply(selected.repo, { op: "remove", name: selected.name });
  };

  const totalRemotes = Object.values(byRepo).reduce((acc, list) => acc + list.length, 0);

  return (
    <Dialog
      open
      title="Git Remotes"
      onClose={onClose}
      width={multiRepo ? 640 : 560}
      buttons={[{ label: "OK", role: "default", autoFocus: true, onClick: onClose }]}
    >
      <div className={styles.form}>
        <div className={styles.manageBar} role="toolbar" aria-label={tx("Remotes")}>
          <IconButton icon="plus" title="Add Remote…" size="small" onClick={() => openEdit()} />
          <IconButton
            icon="minus"
            title="Remove Remote"
            size="small"
            disabled={!currentRemote}
            onClick={() => void remove()}
          />
          <IconButton
            icon="edit"
            title="Edit Remote…"
            size="small"
            disabled={!currentRemote || !selected}
            onClick={() => selected && currentRemote && openEdit({ repo: selected.repo, remote: currentRemote })}
          />
        </div>
        <div className={styles.choiceList} role="listbox" aria-label={tx("Remotes")}>
          <div className={styles.remotesTableHeader} aria-hidden="true">
            <span className={styles.remoteNameCol}>
              <T>Name</T>
            </span>
            <span className={styles.grow}>
              <T>URL</T>
            </span>
          </div>
          {!multiRepo && !totalRemotes && (
            <div className={styles.empty}>
              <T>No remotes</T>
            </div>
          )}
          {multiRepo
            ? vcsRoots.map((rootPath) => {
                const list = byRepo[rootPath] ?? [];
                return (
                  <div key={rootPath} role="group" aria-label={repoName(rootPath)}>
                    <button
                      type="button"
                      className={clsx(
                        styles.remoteRepoHeader,
                        activeRepo === rootPath && !selected && styles.remoteRepoHeaderActive,
                      )}
                      onClick={() => {
                        setActiveRepo(rootPath);
                        setSelected(null);
                      }}
                    >
                      {repoName(rootPath)}
                    </button>
                    {list.map((r) => {
                      const isSel = selected?.repo === rootPath && selected.name === r.name;
                      return (
                        <button
                          key={`${rootPath}:${r.name}`}
                          type="button"
                          role="option"
                          aria-selected={isSel}
                          className={clsx(styles.manageRow, isSel && styles.manageRowSelected)}
                          onClick={() => {
                            setActiveRepo(rootPath);
                            setSelected({ repo: rootPath, name: r.name });
                          }}
                          onDoubleClick={() => openEdit({ repo: rootPath, remote: r })}
                        >
                          <span className={clsx(styles.remoteNameCol, styles.remoteNameIndented)}>{r.name}</span>
                          <span className={clsx(styles.fileDir, styles.mono, styles.grow)}>{r.url}</span>
                        </button>
                      );
                    })}
                  </div>
                );
              })
            : (byRepo[targetRoots[0] ?? ""] ?? []).map((r) => {
                const singleRepo = targetRoots[0] ?? null;
                const isSel = selected?.name === r.name;
                return (
                  <button
                    key={r.name}
                    type="button"
                    role="option"
                    aria-selected={isSel}
                    className={clsx(styles.manageRow, isSel && styles.manageRowSelected)}
                    onClick={() => setSelected({ repo: singleRepo, name: r.name })}
                    onDoubleClick={() => openEdit({ repo: singleRepo, remote: r })}
                  >
                    <span className={styles.remoteNameCol}>{r.name}</span>
                    <span className={clsx(styles.fileDir, styles.mono, styles.grow)}>{r.url}</span>
                  </button>
                );
              })}
        </div>
        {error && <div className={styles.error}>{error}</div>}
      </div>
    </Dialog>
  );
}

function RemoteEditDialog({
  remote,
  roots = [],
  initialRepo = null,
  existingByRepo,
  onDone,
}: {
  remote?: Remote;
  roots?: readonly string[];
  initialRepo?: string | null;
  existingByRepo: Record<string, readonly string[]>;
  onDone: (r: { repo: string | null; name: string; url: string } | null) => void;
}) {
  const [repo, setRepo] = useState<string | null>(initialRepo ?? roots[0] ?? null);
  const existing = existingByRepo[repo ?? ""] ?? [];
  const [name, setName] = useState(remote?.name ?? (existing.includes("origin") ? "" : "origin"));
  const [url, setUrl] = useState(remote?.url ?? "");
  const error = validateRemoteName(name, existing) ?? (url.trim() ? null : "Enter the remote URL");
  const submit = () => {
    if (!error) onDone({ repo, name: name.trim(), url: url.trim() });
  };
  return (
    <Dialog
      open
      title={remote ? "Edit Remote" : "Define Remote"}
      onClose={() => onDone(null)}
      width={460}
      buttons={[
        { label: "OK", role: "default", disabled: !!error, onClick: submit },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <RepoSelect roots={roots} value={repo} onChange={setRepo} />
        <label className={styles.fieldLabel}>
          <T>Name:</T>
        </label>
        <Input data-autofocus aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <label className={styles.fieldLabel}>
          <T>URL:</T>
        </label>
        <Input aria-label="URL" mono value={url} onChange={(e) => setUrl(e.target.value)} />
        {error && (name || url) && <div className={styles.error}>{error}</div>}
      </form>
    </Dialog>
  );
}

// --- Worktrees --------------------------------------------------------------

/** Default folder of a new worktree: next to the repository, `<repo>-<branch>`. */
export function defaultWorktreePath(repoRoot: string, branch: string): string {
  const sep = repoRoot.includes("\\") && !repoRoot.includes("/") ? "\\" : "/";
  const trimmed = repoRoot.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const parent = cut > 0 ? trimmed.slice(0, cut) : trimmed;
  const name = trimmed.slice(cut + 1);
  const suffix = branch.replace(/[\\/]/g, "-");
  return `${parent}${sep}${name}-${suffix || "worktree"}`;
}

export function showWorktrees(initialRepo?: string) {
  openDialog((close) => <WorktreesDialog initialRepo={initialRepo} onClose={close} />);
}

export function showNewWorktree(onCreated?: () => void, initialRepo?: string) {
  openDialog((close) => (
    <NewWorktreeDialog
      initialRepo={initialRepo}
      onClose={(created) => {
        close();
        if (created) onCreated?.();
      }}
    />
  ));
}

function WorktreesDialog({ initialRepo, onClose }: { initialRepo?: string; onClose: () => void }) {
  const { repo, roots, setRepo } = useDialogRepo(initialRepo);
  const [list, setList] = useState<Worktree[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(
    () =>
      call(commands.vcsWorktrees(repo))
        .then((l) => {
          setList(l);
          setError(null);
        })
        .catch((e) => setError(errorMessage(e))),
    [repo],
  );
  useEffect(() => {
    void reload();
  }, [reload]);
  const current = list.find((w) => w.path === selected);

  const remove = async () => {
    if (!current || current.main) return;
    const ok = await confirmDialog({
      title: "Remove Worktree",
      message: tx`Remove the worktree at ${current.path}? Its folder is deleted.`,
      okLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    try {
      await call(commands.vcsRemoveWorktree(repo, current.path, false));
    } catch (e) {
      const force = await confirmDialog({
        title: "Remove Worktree",
        message: tx`${errorMessage(e)}\n\nRemove it anyway, discarding its changes?`,
        okLabel: "Force Remove",
        danger: true,
      });
      if (force) await call(commands.vcsRemoveWorktree(repo, current.path, true)).catch((x) => setError(errorMessage(x)));
    }
    setSelected(null);
    await reload();
  };

  return (
    <Dialog
      open
      title="Worktrees"
      onClose={onClose}
      width={620}
      buttons={[{ label: "Close", role: "default", autoFocus: true, onClick: onClose }]}
    >
      <div className={styles.form}>
        <RepoSelect
          roots={roots}
          value={repo}
          onChange={(r) => {
            setSelected(null);
            setRepo(r);
          }}
        />
        <div className={styles.manageBar} role="toolbar" aria-label={tx("Worktrees")}>
          <IconButton
            icon="plus"
            title="New Worktree…"
            size="small"
            onClick={() => showNewWorktree(() => void reload(), repo ?? undefined)}
          />
          <IconButton
            icon="minus"
            title="Remove Worktree"
            size="small"
            disabled={!current || current.main}
            onClick={() => void remove()}
          />
          <IconButton
            icon="folder"
            title="Open in New Window"
            size="small"
            disabled={!current}
            onClick={() => current && void executeAction("file.openProjectPath", current.path)}
          />
        </div>
        <div className={styles.choiceList} role="listbox" aria-label={tx("Worktrees")}>
          {list.map((w) => (
            <button
              key={w.path}
              type="button"
              role="option"
              aria-selected={w.path === selected}
              className={clsx(styles.manageRow, w.path === selected && styles.manageRowSelected)}
              onClick={() => setSelected(w.path)}
              onDoubleClick={() => void executeAction("file.openProjectPath", w.path)}
            >
              <span className={styles.fileName}>{w.branch ?? (w.head ? w.head.slice(0, 8) : <T>(bare)</T>)}</span>
              <span className={clsx(styles.fileDir, styles.mono)}>{w.path}</span>
              {(w.main || w.locked || w.prunable) && (
                <span className={styles.fileDir}>{w.main ? "main" : w.locked ? tx("locked") : tx("prunable")}</span>
              )}
            </button>
          ))}
        </div>
        {error && <div className={styles.error}>{error}</div>}
      </div>
    </Dialog>
  );
}

function NewWorktreeDialog({
  initialRepo,
  onClose,
}: {
  initialRepo?: string;
  onClose: (created: boolean) => void;
}) {
  const fallbackRoot = useVcs((s) => s.repo ?? s.root) ?? "";
  const { repo, roots, setRepo } = useDialogRepo(initialRepo);
  const root = repo ?? fallbackRoot;
  const { branches } = useRepoBranches(repo);
  const [source, setSource] = useState<string | null>(null);
  const [createBranch, setCreateBranch] = useState(true);
  const [newBranch, setNewBranch] = useState("");
  const [path, setPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const options = useMemo(() => [...branchOptions(sortLocal(branches)), ...branchOptions(sortRemote(branches))], [branches]);
  const sourceRemote = branches.find((b) => b.name === source)?.remote ?? false;
  // A remote branch `origin/x` suggests the local name `x`.
  const shortSource = source && sourceRemote ? source.slice(source.indexOf("/") + 1) : (source ?? "");
  const suggestedBranch = source ? (sourceRemote ? shortSource : `${shortSource}-wt`) : "";
  const branchName = newBranch.trim() || suggestedBranch;
  const target = path ?? (source ? defaultWorktreePath(root, createBranch ? branchName : shortSource) : "");
  const invalid = !source
    ? "Choose what to check out"
    : createBranch
      ? validateBranchName(branchName)
      : !target.trim()
        ? "Enter a folder"
        : null;

  const create = async () => {
    if (invalid || !source) return;
    try {
      await call(commands.vcsAddWorktree(repo, target.trim(), source, createBranch ? branchName : null));
      notifications().notify({ group: "vcs", level: "info", title: `Created worktree at ${target.trim()}` });
      void loadBranches().catch(() => undefined);
      onClose(true);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Dialog
      open
      title="New Worktree"
      onClose={() => onClose(false)}
      width={520}
      buttons={[
        { label: "Create", role: "default", disabled: !!invalid, onClick: () => void create() },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.form}>
        <RepoSelect roots={roots} value={repo} onChange={setRepo} />
        <div className={styles.fieldLabel}>
          <T>Check out:</T>
        </div>
        <Select aria-label="Check out" value={source} placeholder="Select branch" options={options} onChange={setSource} />
        <Checkbox label="Create a new branch" checked={createBranch} onChange={setCreateBranch} />
        {createBranch && (
          <Input
            aria-label="New branch name"
            mono
            value={newBranch}
            placeholder={suggestedBranch}
            onChange={(e) => setNewBranch(e.target.value)}
          />
        )}
        <div className={styles.fieldLabel}>
          <T>Folder:</T>
        </div>
        <Input aria-label="Folder" mono value={target} onChange={(e) => setPath(e.target.value)} />
        {(error ?? (source && invalid)) && <div className={styles.error}>{error ?? invalid}</div>}
      </div>
    </Dialog>
  );
}
