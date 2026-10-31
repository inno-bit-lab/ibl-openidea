/** Git menu dialogs: Pull…, Merge…, Rebase…, Manage Remotes… and Worktrees. */
import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import type { Branch, BranchInfo, MergeOptions, Remote, Worktree } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { call, commands } from "@/platform/ipc";
import { notifications } from "@/workbench/contributions";
import { Checkbox, Dialog, IconButton, Input, Select, T, type SelectOption } from "@/ui";
import { sortLocal, sortRemote } from "./branches";
import { conflictActions, openConflictsInstead, validateBranchName } from "./branchOps";
import { confirmDialog, openDialog } from "./dialogs";
import { errorMessage, runOp, runRemote, saveAll } from "./ops";
import { currentRepo, loadBranches, refreshNow, repoName, selectRepo, useVcs } from "./store";
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

/** The repository a Git dialog acts on: `initial` when it is one of the project's, else the selected one. */
export function useDialogRepo(initial?: string | null) {
  const roots = useVcs((s) => s.roots);
  const [repo, setRepo] = useState<string | null>(() =>
    initial && useVcs.getState().roots.includes(initial) ? initial : currentRepo(),
  );
  return { repo, roots, setRepo };
}

/** A Git dialog's repository picker; nothing in a single-repository project. */
export function RepoSelect({
  roots,
  value,
  onChange,
}: {
  roots: readonly string[];
  value: string | null;
  onChange: (repo: string) => void;
}) {
  if (roots.length < 2) return null;
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

/** `load(repo)` once per repository the dialog shows; `undefined` until it settles. */
function useRepoValue<T>(repo: string | null, load: (repo: string | null) => Promise<T>): T | undefined {
  const [value, setValue] = useState<{ repo: string | null; value: T }>();
  useEffect(() => {
    let live = true;
    void load(repo)
      .then((v) => live && setValue({ repo, value: v }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [repo]);
  return value && value.repo === repo ? value.value : undefined;
}

const NO_BRANCHES: Branch[] = [];

function useBranches(repo: string | null): Branch[] {
  return useRepoValue(repo, (r) => call(commands.vcsBranches(r))) ?? NO_BRANCHES;
}

/** `repo`'s current branch and upstream (the selected repository's at once, the others' once read). */
function useBranchInfo(repo: string | null): BranchInfo | null {
  const [selected] = useState(() => ({ repo: currentRepo(), info: useVcs.getState().branch }));
  const read = useRepoValue(repo, (r) => call(commands.vcsBranchInfo(r)));
  return read ?? (repo === selected.repo ? selected.info : null);
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

export function showPullDialog(repo?: string | null) {
  openDialog((close) => <PullDialog initialRepo={repo} onClose={close} />);
}

function PullDialog({ initialRepo, onClose }: { initialRepo?: string | null; onClose: () => void }) {
  const { repo, roots, setRepo } = useDialogRepo(initialRepo);
  const info = useBranchInfo(repo);
  const branches = useBranches(repo);
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
        const upstreamRemote = info?.upstream?.split("/")[0];
        setRemote(list.find((r) => r.name === upstreamRemote)?.name ?? list[0]?.name ?? null);
      })
      .catch(() => alive && setRemotes([]));
    return () => {
      alive = false;
    };
  }, [repo, info?.upstream]);

  const remoteBranches = useMemo(() => (remote ? remoteBranchesOf(branches, remote) : []), [branches, remote]);
  // Default: the upstream's branch, else the same name as the current branch.
  const upstream = remote && info?.upstream?.startsWith(`${remote}/`) ? info.upstream.slice(remote.length + 1) : null;
  const preferred = upstream ?? info?.head ?? null;
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
      {
        op: "pullFrom",
        remote,
        branches: branch ? [branch] : [],
        rebase,
        options: mergeOptionsOf(rebase ? new Set() : flags),
      },
      `${info?.head ?? "HEAD"} ← ${remote}${branch ? `/${branch}` : ""}`,
      [repo],
    );
  };

  return (
    <Dialog
      open
      title={tx`Pull to ${info?.head ?? "HEAD"}`}
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

export function showMergeDialog(repo?: string | null) {
  openDialog((close) => <MergeDialog initialRepo={repo} onClose={close} />);
}

function MergeDialog({ initialRepo, onClose }: { initialRepo?: string | null; onClose: () => void }) {
  const { repo, roots, setRepo } = useDialogRepo(initialRepo);
  const head = useBranchInfo(repo)?.head ?? null;
  const branches = useBranches(repo);
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
        <RepoSelect
          roots={roots}
          value={repo}
          onChange={(r) => {
            setRepo(r);
            setBranch(null);
          }}
        />
        <div className={styles.fieldLabel}>
          <T>Branch to merge:</T>
        </div>
        <Select
          aria-label="Branch to merge"
          value={branch}
          placeholder="Select branch"
          options={options}
          onChange={setBranch}
        />
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

export function showRebaseDialog(repo?: string | null) {
  openDialog((close) => <RebaseDialog initialRepo={repo} onClose={close} />);
}

function RebaseDialog({ initialRepo, onClose }: { initialRepo?: string | null; onClose: () => void }) {
  const { repo, roots, setRepo } = useDialogRepo(initialRepo);
  const head = useBranchInfo(repo)?.head ?? null;
  const branches = useBranches(repo);
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
        <RepoSelect
          roots={roots}
          value={repo}
          onChange={(r) => {
            setRepo(r);
            setUpstream(null);
            setOnto(null);
          }}
        />
        <div className={styles.fieldLabel}>
          {useOnto ? tx`Rebase commits of ${head ?? "HEAD"} not on:` : `Rebase ${head ?? "HEAD"} onto:`}
        </div>
        <Select
          aria-label="Upstream"
          value={upstream}
          placeholder="Select branch"
          options={options}
          onChange={setUpstream}
        />
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

export function showManageRemotes(repo?: string | null) {
  openDialog((close) => <RemotesDialog initialRepo={repo} onClose={close} />);
}

/** A remote of one of the dialog's repositories. */
interface RemoteRef {
  repo: string | null;
  name: string;
}

function RemotesDialog({ initialRepo, onClose }: { initialRepo?: string | null; onClose: () => void }) {
  const { repo: initial, roots } = useDialogRepo(initialRepo);
  // Several repositories: each one's remotes under its name.
  const [repos] = useState<Array<string | null>>(() => (roots.length > 1 ? [...roots] : [initial]));
  const grouped = repos.length > 1;
  const [byRepo, setByRepo] = useState<ReadonlyMap<string | null, Remote[]>>(() => new Map());
  const [selected, setSelected] = useState<RemoteRef | null>(null);
  // The repository Add Remote… defaults to: the one shown first, then the last clicked.
  const [active, setActive] = useState<string | null>(initial);
  const [error, setError] = useState<string | null>(null);
  const remotesOf = (repo: string | null) => byRepo.get(repo) ?? [];
  // A repository whose remotes cannot be read shows none and reports the error.
  const reload = () =>
    Promise.all(
      repos.map((r) =>
        call(commands.vcsRemotes(r)).then(
          (list) => [r, list] as const,
          (e: unknown) => {
            setError(errorMessage(e));
            return [r, [] as Remote[]] as const;
          },
        ),
      ),
    ).then((entries) => {
      const next = new Map(entries);
      setByRepo(next);
      setSelected((s) => {
        if (s && next.get(s.repo)?.some((r) => r.name === s.name)) return s;
        const repo = s ? s.repo : active;
        const first = next.get(repo)?.[0];
        return first ? { repo, name: first.name } : null;
      });
    });
  useEffect(() => {
    void reload();
  }, []);

  const apply = async (repo: string | null, edit: Parameters<typeof commands.vcsEditRemote>[1]) => {
    try {
      await call(commands.vcsEditRemote(repo, edit));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
    setActive(repo);
    if (edit.op !== "remove") setSelected({ repo, name: edit.op === "add" ? edit.name : edit.new_name });
    await reload();
    void loadBranches().catch(() => undefined);
  };
  const edit = (target?: RemoteRef & { remote: Remote }) =>
    openDialog((close) => (
      <RemoteEditDialog
        remote={target?.remote}
        roots={target || !grouped ? [] : (repos as string[])}
        initialRepo={target?.repo ?? active}
        existing={(repo) =>
          remotesOf(repo)
            .map((r) => r.name)
            .filter((n) => n !== target?.name)
        }
        onDone={(r) => {
          close();
          if (!r) return;
          void apply(
            target ? target.repo : r.repo,
            target
              ? { op: "edit", name: target.name, new_name: r.name, url: r.url }
              : { op: "add", name: r.name, url: r.url },
          );
        }}
      />
    ));
  const remove = async () => {
    if (!selected) return;
    const ok = await confirmDialog({
      title: "Remove Remote",
      message: tx`Remove remote '${selected.name}'? Its remote-tracking branches are deleted.`,
      okLabel: "Remove",
      danger: true,
    });
    if (ok) await apply(selected.repo, { op: "remove", name: selected.name });
  };
  const current = selected && remotesOf(selected.repo).find((r) => r.name === selected.name);
  const remoteRow = (repo: string | null, r: Remote) => {
    const isSelected = selected?.repo === repo && selected.name === r.name;
    return (
      <button
        key={r.name}
        type="button"
        role="option"
        aria-selected={isSelected}
        className={clsx(styles.manageRow, isSelected && styles.manageRowSelected)}
        onClick={() => {
          setActive(repo);
          setSelected({ repo, name: r.name });
        }}
        onDoubleClick={() => edit({ repo, name: r.name, remote: r })}
      >
        <span className={clsx(styles.fileName, grouped && styles.remoteNested)}>{r.name}</span>
        <span className={clsx(styles.fileDir, styles.mono)}>{r.url}</span>
      </button>
    );
  };

  return (
    <Dialog
      open
      title="Git Remotes"
      onClose={onClose}
      width={560}
      buttons={[{ label: "OK", role: "default", autoFocus: true, onClick: onClose }]}
    >
      <div className={styles.form}>
        <div className={styles.manageBar} role="toolbar" aria-label={tx("Remotes")}>
          <IconButton icon="plus" title="Add Remote…" size="small" onClick={() => edit()} />
          <IconButton
            icon="minus"
            title="Remove Remote"
            size="small"
            disabled={!current}
            onClick={() => void remove()}
          />
          <IconButton
            icon="edit"
            title="Edit Remote…"
            size="small"
            disabled={!current}
            onClick={() => selected && current && edit({ ...selected, remote: current })}
          />
        </div>
        <div className={styles.choiceList} role="listbox" aria-label={tx("Remotes")}>
          {grouped
            ? repos.map((repo) => (
                <div key={repo ?? ""} role="group" aria-label={repo ? repoName(repo) : undefined}>
                  <button
                    type="button"
                    className={clsx(
                      styles.remoteRepoHeader,
                      repo === active && !selected && styles.remoteRepoHeaderActive,
                    )}
                    onClick={() => {
                      setActive(repo);
                      setSelected(null);
                    }}
                  >
                    {repo ? repoName(repo) : ""}
                  </button>
                  {remotesOf(repo).map((r) => remoteRow(repo, r))}
                </div>
              ))
            : remotesOf(repos[0] ?? null).map((r) => remoteRow(repos[0] ?? null, r))}
          {!grouped && !remotesOf(repos[0] ?? null).length && (
            <div className={styles.empty}>
              <T>No remotes</T>
            </div>
          )}
        </div>
        {error && <div className={styles.error}>{error}</div>}
      </div>
    </Dialog>
  );
}

function RemoteEditDialog({
  remote,
  roots,
  initialRepo,
  existing: existingIn,
  onDone,
}: {
  remote?: Remote;
  /** Repositories a new remote can go to (a picker for several). */
  roots: readonly string[];
  initialRepo: string | null;
  /** The other remotes' names in a repository. */
  existing: (repo: string | null) => readonly string[];
  onDone: (r: { repo: string | null; name: string; url: string } | null) => void;
}) {
  const [repo, setRepo] = useState(initialRepo);
  const existing = existingIn(repo);
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

/** Worktrees…; `repo` (a project repository) is selected first, the panel's picker switches it. */
export function showWorktrees(repo?: string | null) {
  if (repo && useVcs.getState().roots.includes(repo)) void selectRepo(repo);
  openDialog((close) => <WorktreesDialog onClose={close} />);
}

export function showNewWorktree(onCreated?: () => void, repo?: string | null) {
  openDialog((close) => (
    <NewWorktreeDialog
      initialRepo={repo}
      onClose={(created) => {
        close();
        if (created) onCreated?.();
      }}
    />
  ));
}

function WorktreesDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog
      open
      title="Worktrees"
      onClose={onClose}
      width={620}
      buttons={[{ label: "Close", role: "default", autoFocus: true, onClick: onClose }]}
    >
      <WorktreesPanel className={styles.form} />
    </Dialog>
  );
}

/**
 * The worktrees of the current repository with New / Remove / Open: the Worktrees
 * dialog's content and the Git tool window's Worktrees tab. `listClassName` replaces
 * the dialog's bordered list box.
 */
export function WorktreesPanel({ className, listClassName }: { className?: string; listClassName?: string }) {
  const repo = useVcs((s) => s.repo);
  const repos = useVcs((s) => s.roots);
  const [list, setList] = useState<Worktree[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = () =>
    call(commands.vcsWorktrees(repo))
      .then((l) => {
        setList(l);
        setError(null);
      })
      .catch((e) => setError(errorMessage(e)));
  useEffect(() => {
    void reload();
  }, [repo]);
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
      if (force)
        await call(commands.vcsRemoveWorktree(repo, current.path, true)).catch((x) => setError(errorMessage(x)));
    }
    setSelected(null);
    await reload();
  };

  return (
    <div className={className}>
      <div className={styles.manageBar} role="toolbar" aria-label={tx("Worktrees")}>
        {repos.length > 1 && (
          <Select
            aria-label="Repository"
            value={repo}
            options={repos.map((r) => ({ value: r, label: repoName(r) }))}
            onChange={(r) => void selectRepo(r)}
          />
        )}
        <IconButton icon="refresh" title="Refresh" size="small" onClick={() => void reload()} />
        <IconButton
          icon="plus"
          title="New Worktree…"
          size="small"
          onClick={() => showNewWorktree(() => void reload(), repo)}
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
      <div className={listClassName ?? styles.choiceList} role="listbox" aria-label={tx("Worktrees")}>
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
  );
}

function NewWorktreeDialog({
  initialRepo,
  onClose,
}: {
  initialRepo?: string | null;
  onClose: (created: boolean) => void;
}) {
  const { repo, roots, setRepo } = useDialogRepo(initialRepo);
  const [projectRoot] = useState(() => useVcs.getState().root ?? "");
  const root = repo ?? projectRoot;
  const branches = useBranches(repo);
  const [source, setSource] = useState<string | null>(null);
  const [createBranch, setCreateBranch] = useState(true);
  const [newBranch, setNewBranch] = useState("");
  const [path, setPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const options = useMemo(
    () => [...branchOptions(sortLocal(branches)), ...branchOptions(sortRemote(branches))],
    [branches],
  );
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
        <RepoSelect
          roots={roots}
          value={repo}
          onChange={(r) => {
            setRepo(r);
            setSource(null);
          }}
        />
        <div className={styles.fieldLabel}>
          <T>Check out:</T>
        </div>
        <Select
          aria-label="Check out"
          value={source}
          placeholder="Select branch"
          options={options}
          onChange={setSource}
        />
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
