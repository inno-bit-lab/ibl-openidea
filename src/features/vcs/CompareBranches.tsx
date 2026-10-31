/**
 * "Compare with current": commits on either side of two branches, in IDEA's `Compare: <branch>
 * and <current>` editor tab. Its top pane lists the commits in `<branch>` not in the current
 * branch, the bottom one the reverse; each has its own filters, graph, changed files and message.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import clsx from "clsx";
import type { ChangedFile, Commit, RevisionChange } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { call, commands } from "@/platform/ipc";
import {
  Dialog,
  EmptyState,
  Icon,
  IconButton,
  List,
  SearchField,
  Spinner,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  T,
  Tree,
  showContextMenu,
} from "@/ui";
import { maybeEditorService, type EditorInput } from "@/workbench/contributions";
import { compareBranchesInput, compareBranchesTitle, type CompareBranchesData } from "./compareBranchesKind";
import { chooseDateRange, chooseMany, openDialog, promptText } from "./dialogs";
import { commitFileDiffData, openDiff, revisionChangeDiffData, withChain } from "./diffInput";
import { buildFileTree, dirKeys, type FileTreeNode } from "./fileTree";
import { computeGraph } from "./graph";
import { absolutePath } from "./logChanges";
import { dateRangeLabel, inDateRange, ME, resolveAuthors, type LogDateFilter } from "./logStore";
import { fileCount, formatTime, relTo } from "./model";
import { commitKey, commitRepo, graphCommit, mergeRepoLogs, type RepoCommit } from "./multiRoot";
import { cherryPick, showCompareRevisions } from "./operations";
import { errorMessage } from "./ops";
import { currentRepo, repoName, repoOf, useVcs } from "./store";
import {
  ChangedFileRow,
  CommitMessage,
  commitMenu,
  DATE_OPTIONS,
  DAY,
  FilterButton,
  GraphCell,
  menuBelow,
  RefLabels,
} from "./GitLog";
import styles from "./common.module.css";
import logStyles from "./GitLog.module.css";
import { tx } from "@/platform/i18n";

const LIMIT = 2000;
const COMPARE_LIMIT = 500;

/** Commits reachable from `to` but not from `from` (git's `from..to`), computed by git, unbounded by any window. */
const commitsBetween = (from: string, to: string, repo: string | null = currentRepo()) =>
  call(
    commands.vcsLog(repo, {
      branch: null,
      path: null,
      author: null,
      text: null,
      range: `${from}..${to}`,
      skip: 0,
      limit: LIMIT,
    }),
  ).then((commits) => commits.map((c) => ({ ...c, repo })));

/**
 * Opens the `Compare: <branch> and <current>` editor tab (a dialog when there is no editor
 * area): `branch` against the current branch of `repo`, or of each of several repositories.
 */
export function showCompareBranches(branch: string, repo?: string | readonly string[]) {
  const repos = typeof repo === "string" ? [repo] : repo?.length ? repo : null;
  const { heads, branch: info } = useVcs.getState();
  // Named after the current branch when every repository has the same one checked out.
  const names = new Set(repos ? repos.map((r) => heads[r]?.head ?? "HEAD") : [info?.head ?? "HEAD"]);
  const current = names.size === 1 ? [...names][0]! : "HEAD";
  const input = compareBranchesInput(
    branch,
    current,
    repos?.[0] ?? currentRepo(),
    repos && repos.length > 1 ? repos : undefined,
  );
  const editor = maybeEditorService();
  if (editor) {
    void editor.openInput(input, { focus: true });
    return;
  }
  openDialog((close) => (
    <Dialog
      open
      title={compareBranchesTitle(input.data as CompareBranchesData)}
      onClose={close}
      width={1040}
      buttons={[{ label: "Close", role: "cancel" }]}
    >
      <div style={{ height: 620, display: "flex", flexDirection: "column" }}>
        <CompareBranchesEditor input={input} />
      </div>
    </Dialog>
  ));
}

/** IDEA's "View Commits" of a notification: the commits of `from..to`. */
export function showCommitRange(title: string, from: string, to: string, repo: string | null = currentRepo()) {
  openDialog((close) => <RangeDialog title={title} from={from} to={to} repo={repo} onClose={close} />);
}

function RangeDialog(props: { title: string; from: string; to: string; repo: string | null; onClose: () => void }) {
  const { title, from, to, repo, onClose } = props;
  const [commits, setCommits] = useState<Commit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    commitsBetween(from, to, repo)
      .then((c) => alive && setCommits(c))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [from, to, repo]);
  return (
    <Dialog open title={title} onClose={onClose} width={640} buttons={[{ label: "Close", role: "cancel" }]}>
      <CommitList commits={commits} error={error} onClose={onClose} />
    </Dialog>
  );
}

function CommitList({
  commits,
  error,
  onClose,
}: {
  commits: Commit[] | null;
  error: string | null;
  onClose: () => void;
}) {
  return (
    <div style={{ height: 320, display: "flex", flexDirection: "column" }}>
      {error ? (
        <div className={styles.error} style={{ padding: 14 }}>
          {error}
        </div>
      ) : !commits ? (
        <div className={styles.empty}>
          <Spinner size={14} />
        </div>
      ) : (
        <List
          items={commits}
          getKey={(c) => c.id}
          rowHeight={22}
          aria-label="Commits"
          className={styles.grow}
          empty={
            <span>
              <T>No commits</T>
            </span>
          }
          onActivate={(c) => {
            onClose();
            void executeAction("vcs.showCommit", c);
          }}
          renderItem={(c) => (
            <span className={styles.commitRow} style={{ flex: 1, padding: 0 }}>
              <span className={styles.commitHash}>{c.shortId}</span>
              <span className={styles.commitSubject}>{c.summary}</span>
              <span className={styles.commitMeta}>{c.author}</span>
              <span className={styles.commitMeta}>{formatTime(c.timeMs)}</span>
            </span>
          )}
        />
      )}
    </div>
  );
}

export function CompareBranchesEditor({ input }: { input: EditorInput }) {
  const { branch, current, repo, repos } = (input.data ?? {
    branch: "HEAD",
    current: "HEAD",
    repo: currentRepo(),
  }) as CompareBranchesData;
  const targets = useMemo(() => (repos?.length ? repos : [repo]), [repos, repo]);
  return (
    <div className={logStyles.compareRoot}>
      <SplitGroup orientation="vertical" id="vcs-compare-branches" className={logStyles.split}>
        <SplitPanel id="top" defaultSize="50%" minSize="140px">
          <BranchComparisonPane
            paneId="top"
            fromBranch={current}
            toBranch={branch}
            range={`HEAD..${branch}`}
            repos={targets}
          />
        </SplitPanel>
        <SplitHandle />
        <SplitPanel id="bottom" defaultSize="50%" minSize="140px">
          <BranchComparisonPane
            paneId="bottom"
            fromBranch={branch}
            toBranch={current}
            range={`${branch}..HEAD`}
            repos={targets}
          />
        </SplitPanel>
      </SplitGroup>
    </div>
  );
}

type ChangedFiles = (ChangedFile | RevisionChange)[];

interface PaneFilters {
  text: string;
  regex: boolean;
  matchCase: boolean;
  authors: string[];
  date: LogDateFilter | null;
  path: string | null;
}

const emptyPaneFilters = (): PaneFilters => ({
  text: "",
  regex: false,
  matchCase: false,
  authors: [],
  date: null,
  path: null,
});

function matchesCommitQuery(c: Commit, rawQuery: string, regex: boolean, matchCase: boolean): boolean {
  const q = rawQuery.trim();
  if (!q) return true;
  const haystacks = [c.summary, c.message, c.id, c.shortId];
  if (regex) {
    try {
      const re = new RegExp(q, matchCase ? "" : "i");
      return haystacks.some((h) => re.test(h));
    } catch {
      return false;
    }
  }
  const needle = matchCase ? q : q.toLowerCase();
  return haystacks.some((h) => (matchCase ? h : h.toLowerCase()).includes(needle));
}

/** One side of the comparison: the commits of `range` in each of `repos`. */
function BranchComparisonPane({
  paneId,
  fromBranch,
  toBranch,
  range,
  repos,
}: {
  paneId: string;
  fromBranch: string;
  toBranch: string;
  range: string;
  repos: readonly (string | null)[];
}) {
  const version = useVcs((s) => s.version);
  const root = useVcs((s) => s.root);
  const branches = useVcs((s) => s.branches);
  const remoteNames = useMemo(() => new Set(branches.filter((b) => b.remote).map((b) => b.name)), [branches]);
  const multiRepo = repos.length > 1;

  const [filters, setFilters] = useState<PaneFilters>(emptyPaneFilters);
  const [searchInput, setSearchInput] = useState("");
  const [commits, setCommits] = useState<RepoCommit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Lead selection and every selected commit (`commitKey`s, all of one repository).
  const [{ selected, selection }, setPicked] = useState<{ selected: string | null; selection: string[] }>({
    selected: null,
    selection: [],
  });
  const anchorRef = useRef<string | null>(null);
  // Bumped by every load: only the latest load's answer updates the pane.
  const generation = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => {
      setFilters((prev) => (prev.text === searchInput ? prev : { ...prev, text: searchInput }));
    }, 200);
    return () => clearTimeout(t);
  }, [searchInput]);

  const load = useCallback(() => {
    // A path filter: the log of the repository holding it.
    const targets = multiRepo && filters.path ? repos.filter((r) => r === repoOf(filters.path!)) : repos;
    const gen = ++generation.current;
    void Promise.allSettled(
      targets.map(async (repo) => {
        const config = (key: string) => call(commands.vcsConfigGet(repo, key)).catch(() => null);
        const user = (await config("user.email")) || (await config("user.name"));
        const authors = resolveAuthors(filters.authors, user);
        if (filters.authors.length && !authors.length) return [];
        const page = await call(
          commands.vcsLog(repo, {
            branch: null,
            authors,
            path: filters.path,
            author: null,
            text: filters.text.trim() || null,
            textRegex: filters.regex,
            textMatchCase: filters.matchCase,
            range,
            skip: 0,
            limit: COMPARE_LIMIT,
            sinceMs: filters.date?.after ?? null,
            untilMs: filters.date?.before ?? null,
          }),
        );
        return page.map((c): RepoCommit => ({ ...c, repo, user }));
      }),
    ).then((results) => {
      // A later load (Refresh, other filters or range) superseded this one.
      if (gen !== generation.current) return;
      const streams = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      const failures = results.flatMap((r, i) =>
        r.status === "rejected" ? [`${targets[i] ? repoName(targets[i]!) : "Git"}: ${errorMessage(r.reason)}`] : [],
      );
      const merged = mergeRepoLogs(streams, COMPARE_LIMIT * targets.length);
      setCommits(merged);
      setError(failures.join("\n") || null);
      setLoading(false);
      // Keep the selected commits still listed, else select the first. A lead that is gone moves to
      // the first surviving selected commit, so lead and selection stay in one repository.
      const keys = new Set(merged.map(commitKey));
      setPicked((p) => {
        const kept = p.selection.filter((k) => keys.has(k));
        const keptSet = new Set(kept);
        const lead =
          p.selected && keys.has(p.selected)
            ? p.selected
            : kept.length
              ? commitKey(merged.find((c) => keptSet.has(commitKey(c)))!)
              : merged[0]
                ? commitKey(merged[0])
                : null;
        return { selected: lead, selection: kept.length ? kept : lead ? [lead] : [] };
      });
    });
  }, [
    range,
    repos,
    multiRepo,
    filters.authors,
    filters.text,
    filters.regex,
    filters.matchCase,
    filters.date,
    filters.path,
  ]);

  useEffect(() => {
    load();
  }, [load, version]);

  // Also filtered here, so the list follows the text field before the backend answers.
  const visibleCommits = useMemo(() => {
    const text = searchInput.trim() || filters.text.trim();
    return commits.filter((c) => {
      if (text && !matchesCommitQuery(c, text, filters.regex, filters.matchCase)) return false;
      const authors = resolveAuthors(filters.authors, c.user ?? null);
      if (authors.length) {
        const hay = `${c.author} <${c.email}>`.toLowerCase();
        if (!authors.some((a) => hay.includes(a.toLowerCase()))) return false;
      }
      return inDateRange(c.commitTimeMs ?? c.timeMs ?? 0, filters.date);
    });
  }, [commits, searchInput, filters.text, filters.regex, filters.matchCase, filters.authors, filters.date]);

  const rows = useMemo(() => computeGraph(visibleCommits.map(graphCommit)).rows, [visibleCommits]);
  const byKey = useMemo(() => new Map(commits.map((c) => [commitKey(c), c])), [commits]);
  const selectedSet = useMemo(() => new Set(selection), [selection]);
  const chosen = useMemo(
    () => visibleCommits.filter((c) => selectedSet.has(commitKey(c))),
    [visibleCommits, selectedSet],
  );
  const activeCommit = (selected ? visibleCommits.find((c) => commitKey(c) === selected) : visibleCommits[0]) ?? null;
  const many = chosen.length > 1;
  const commitRoot = activeCommit ? commitRepo(activeCommit) : null;
  const idsKey = many ? chosen.map(commitKey).join(" ") : activeCommit ? commitKey(activeCommit) : "";

  const [filesState, setFilesState] = useState<{ key: string; files: ChangedFiles | null; error: string | null }>({
    key: "",
    files: null,
    error: null,
  });
  const [expanded, setExpanded] = useState<Set<string> | null>(null);

  const files = filesState.key === idsKey ? filesState.files : null;
  const filesError = filesState.key === idsKey ? filesState.error : null;

  useEffect(() => {
    if (!idsKey || !activeCommit) return;
    let alive = true;
    const repo = commitRoot ?? currentRepo();
    // Several commits: their combined changes, oldest first.
    const req: Promise<ChangedFiles> = many
      ? call(commands.vcsCommitsChanges(repo, chosen.map((c) => c.id).reverse()))
      : call(commands.vcsCommitFiles(repo, activeCommit.id));
    req
      .then((list) => alive && setFilesState({ key: idsKey, files: list, error: null }))
      .catch((e) => alive && setFilesState({ key: idsKey, files: null, error: errorMessage(e) }));
    return () => {
      alive = false;
    };
  }, [idsKey]);

  const tree = useMemo(
    () => buildFileTree(files ?? [], (f) => (multiRepo && commitRoot ? `${repoName(commitRoot)}/${f.path}` : f.path)),
    [files, multiRepo, commitRoot],
  );
  const allDirs = useMemo(() => dirKeys(tree), [tree]);

  const openFileDiff = useCallback(
    (target?: ChangedFile | RevisionChange) => {
      if (!activeCommit) return;
      const list = files ?? (target ? [target] : []);
      if (!list.length) return;
      const chosenFile = target ?? list[0]!;
      void openDiff(
        withChain(
          list.map((f) =>
            many
              ? revisionChangeDiffData(f as RevisionChange, commitRoot ?? undefined)
              : commitFileDiffData(activeCommit, f),
          ),
          Math.max(0, list.indexOf(chosenFile)),
        ),
      );
    },
    [activeCommit, files, many, commitRoot],
  );

  // Several selected commits are of one repository, as in the Git log.
  const pickCommit = (key: string, e?: ReactMouseEvent) => {
    const repo = commitRepo(byKey.get(key));
    const anchor = anchorRef.current;
    if (e?.shiftKey && anchor) {
      const a = visibleCommits.findIndex((c) => commitKey(c) === anchor);
      const b = visibleCommits.findIndex((c) => commitKey(c) === key);
      if (a >= 0 && b >= 0) {
        const [from, to] = a <= b ? [a, b] : [b, a];
        const between = visibleCommits
          .slice(from, to + 1)
          .filter((c) => commitRepo(c) === repo)
          .map(commitKey);
        setPicked({
          selected: key,
          selection: between.includes(anchor) ? [anchor, ...between.filter((x) => x !== anchor)] : between,
        });
        return;
      }
    }
    if (e && (e.metaKey || e.ctrlKey)) {
      setPicked((p) => {
        const same = p.selection.filter((k) => commitRepo(byKey.get(k)) === repo);
        const on = same.includes(key);
        const next = on ? same.filter((x) => x !== key) : [...same, key];
        return { selected: on ? (next[next.length - 1] ?? null) : key, selection: next };
      });
      anchorRef.current = key;
      return;
    }
    anchorRef.current = key;
    setPicked({ selected: key, selection: [key] });
  };

  const selectedIndex = selected ? visibleCommits.findIndex((c) => commitKey(c) === selected) : -1;
  const onKeyDown = (e: KeyboardEvent) => {
    if (!visibleCommits.length) return;
    if (e.key === "Enter" && files?.length) {
      e.preventDefault();
      openFileDiff(files[0]);
      return;
    }
    let next: number;
    if (e.key === "ArrowDown") next = Math.min(visibleCommits.length - 1, selectedIndex + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, selectedIndex - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = visibleCommits.length - 1;
    else return;
    e.preventDefault();
    const target = visibleCommits[next];
    if (target) pickCommit(commitKey(target));
  };

  const openUserMenu = (anchor: HTMLElement) => {
    const authors = [...new Set(commits.map((c) => c.author))].sort((a, b) => a.localeCompare(b)).slice(0, 30);
    menuBelow(anchor, [
      { label: ME, checked: filters.authors.includes(ME), run: () => setFilters((f) => ({ ...f, authors: [ME] })) },
      ...(authors.length ? [{ kind: "separator" as const }] : []),
      ...authors.map((a) => ({
        label: a,
        checked: filters.authors.includes(a),
        run: () => setFilters((f) => ({ ...f, authors: [a] })),
      })),
      { kind: "separator" },
      {
        label: "Select…",
        run: async () => {
          const r = await chooseMany({
            title: "Filter by User",
            options: [ME, ...authors],
            initial: filters.authors,
            customLabel: "Other names or emails (comma-separated):",
          });
          if (r) setFilters((f) => ({ ...f, authors: r }));
        },
      },
    ]);
  };

  const openDateMenu = (anchor: HTMLElement) =>
    menuBelow(anchor, [
      ...DATE_OPTIONS.map((o) => ({
        label: o.label,
        checked: filters.date?.label === o.label,
        run: () =>
          setFilters((f) => ({ ...f, date: { after: Date.now() - o.days * DAY, before: null, label: o.label } })),
      })),
      { kind: "separator" },
      {
        label: "Select…",
        run: async () => {
          const r = await chooseDateRange();
          if (r) setFilters((f) => ({ ...f, date: { ...r, label: dateRangeLabel(r.after, r.before) } }));
        },
      },
    ]);

  // Paths are relative to the compared repository (to the project, for several).
  const pathRoot = multiRepo ? root : (repos[0] ?? root);
  const openPathsMenu = (anchor: HTMLElement) =>
    menuBelow(anchor, [
      {
        label: "Select Folders…",
        run: async () => {
          const cur = filters.path && pathRoot ? relTo(pathRoot, filters.path) : (filters.path ?? "");
          const r = await promptText({ title: "Filter by Path", label: "File or folder", initial: cur, mono: true });
          if (!r) return;
          const v = r.value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
          const absolute = v.startsWith("/") || /^[A-Za-z]:\//.test(v) || !pathRoot;
          setFilters((f) => ({ ...f, path: v ? (absolute ? v : `${pathRoot}/${v}`) : null }));
        },
      },
    ]);

  return (
    <div className={logStyles.comparePane}>
      <SplitGroup orientation="horizontal" id={`vcs-compare-pane-${paneId}`} className={logStyles.split}>
        <SplitPanel id="commits" defaultSize="58%" minSize="240px">
          <div className={logStyles.log}>
            <div className={logStyles.filters} role="toolbar" aria-label={tx`Compare ${toBranch} with ${fromBranch}`}>
              <SearchField
                className={logStyles.textFilter}
                value={searchInput}
                onChange={setSearchInput}
                placeholder="Text or hash"
                aria-label="Filter by message"
                toggles={[
                  {
                    id: "regex",
                    icon: "regex",
                    title: "Regex",
                    pressed: filters.regex,
                    onToggle: (regex) => setFilters((f) => ({ ...f, regex })),
                  },
                  {
                    id: "case",
                    icon: "case",
                    title: "Match Case",
                    pressed: filters.matchCase,
                    onToggle: (matchCase) => setFilters((f) => ({ ...f, matchCase })),
                  },
                ]}
              />
              <FilterButton
                label="User"
                value={filters.authors.join(", ") || null}
                onOpen={openUserMenu}
                onClear={() => setFilters((f) => ({ ...f, authors: [] }))}
              />
              <FilterButton
                label="Date"
                value={filters.date?.label ?? null}
                onOpen={openDateMenu}
                onClear={() => setFilters((f) => ({ ...f, date: null }))}
              />
              <FilterButton
                label="Paths"
                value={filters.path ? (pathRoot ? relTo(pathRoot, filters.path) : filters.path) || "." : null}
                onOpen={openPathsMenu}
                onClear={() => setFilters((f) => ({ ...f, path: null }))}
              />
              <span className={logStyles.grow} />
              <IconButton icon="refresh" title="Refresh" size="small" onClick={load} />
              {paneId === "top" && (
                // Every file that differs between the branches, in each repository (#369's Show Diff).
                <IconButton
                  icon="branch"
                  title="Show Diff Between Branches"
                  size="small"
                  onClick={() => {
                    for (const r of repos) showCompareRevisions(toBranch, "HEAD", toBranch, fromBranch, r ?? undefined);
                  }}
                />
              )}
              <IconButton
                icon="cherry-pick"
                title="Cherry-Pick"
                size="small"
                disabled={!chosen.length}
                onClick={() => void cherryPick(chosen)}
              />
              <IconButton
                icon="diff"
                title="Show Diff"
                size="small"
                disabled={!files?.length}
                onClick={() => openFileDiff()}
              />
            </div>

            <div className={logStyles.compareBanner} role="status">
              <Icon name="warning" size={14} className={logStyles.compareBannerIcon} />
              <span>{tx`Commits that exist in ${toBranch} but don't exist in ${fromBranch}`}</span>
            </div>

            <div className={logStyles.listWrap}>
              <div
                className={logStyles.list}
                role="listbox"
                aria-label={tx`Commits in ${toBranch} not in ${fromBranch}`}
                aria-multiselectable
                tabIndex={0}
                onKeyDown={onKeyDown}
              >
                {error && !visibleCommits.length && <div className={logStyles.message}>{error}</div>}
                {loading && !visibleCommits.length && (
                  <div className={logStyles.message}>
                    <Spinner size={12} />{" "}
                    <span className={logStyles.muted}>
                      <T>Loading…</T>
                    </span>
                  </div>
                )}
                {!loading && !error && !visibleCommits.length && (
                  <div className={logStyles.message}>
                    <T>No commits</T>
                  </div>
                )}
                {visibleCommits.map((c, idx) => {
                  const key = commitKey(c);
                  const repo = commitRepo(c);
                  const isSel = selectedSet.has(key);
                  return (
                    <div
                      key={key}
                      role="option"
                      aria-selected={isSel}
                      className={clsx(logStyles.row, isSel && logStyles.selected)}
                      style={{ position: "relative" }}
                      onMouseDown={(e) => {
                        if (e.button === 2 && !isSel) {
                          pickCommit(key);
                        } else if (e.button === 0) {
                          if (e.shiftKey) e.preventDefault();
                          pickCommit(key, e);
                        }
                      }}
                      onDoubleClick={() => openFileDiff()}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        showContextMenu(e, commitMenu(c, chosen.length ? chosen : [c]));
                      }}
                    >
                      {multiRepo && repo && (
                        <span className={logStyles.colRepository} title={repo}>
                          {repoName(repo)}
                        </span>
                      )}
                      <span className={logStyles.colSubject}>
                        {rows[idx] && <GraphCell row={rows[idx]!} head={false} />}
                        <span className={logStyles.subject} title={c.message}>
                          {c.summary}
                        </span>
                        {c.refs.length > 0 && <RefLabels refs={c.refs} remoteNames={remoteNames} />}
                      </span>
                      <span className={clsx(logStyles.colAuthor, logStyles.muted)} title={`${c.author} <${c.email}>`}>
                        {c.author}
                      </span>
                      <span className={clsx(logStyles.colDate, logStyles.muted)}>{formatTime(c.timeMs)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </SplitPanel>
        <SplitHandle />
        <SplitPanel id="details" defaultSize="42%" minSize="180px">
          {!activeCommit ? (
            <div className={logStyles.details}>
              <EmptyState>
                <T>Select a commit to view changes</T>
              </EmptyState>
            </div>
          ) : (
            <div className={logStyles.details}>
              <SplitGroup orientation="vertical" id={`vcs-compare-details-${paneId}`}>
                <SplitPanel id="files" defaultSize="62%" minSize="60px">
                  <div className={logStyles.filesPane}>
                    <div className={logStyles.detailsBar} role="toolbar" aria-label={tx("Changed files")}>
                      <span className={logStyles.detailsCount} title={many ? undefined : activeCommit.summary}>
                        {many
                          ? `${files ? fileCount(files.length) : ""} ${tx`in ${chosen.length} commits`}`
                          : tx`Changes to ${activeCommit.shortId} ${activeCommit.summary}`}
                      </span>
                      <span className={logStyles.grow} />
                      <IconButton
                        icon="diff"
                        title="Show Diff"
                        size="small"
                        disabled={!files?.length}
                        onClick={() => openFileDiff()}
                      />
                      <IconButton
                        icon="expand-all"
                        title="Expand All"
                        size="small"
                        onClick={() => setExpanded(new Set(allDirs))}
                      />
                      <IconButton
                        icon="collapse-all"
                        title="Collapse All"
                        size="small"
                        onClick={() => setExpanded(new Set())}
                      />
                    </div>
                    {filesError && <div className={logStyles.message}>{filesError}</div>}
                    {!files && !filesError && (
                      <div className={logStyles.message}>
                        <Spinner size={12} />
                      </div>
                    )}
                    {files && (
                      <Tree<FileTreeNode<ChangedFile | RevisionChange>>
                        roots={tree}
                        getKey={(n) => n.key}
                        getLabel={(n) => n.name}
                        getChildren={(n) => (n.file ? undefined : n.children)}
                        isExpandable={(n) => !n.file}
                        expanded={expanded ?? new Set(allDirs)}
                        onExpandedChange={(next) => setExpanded(next)}
                        multiSelect={false}
                        renderNode={(n) => <ChangedFileRow node={n} />}
                        onActivate={(n) => n.file && openFileDiff(n.file)}
                        onContextMenu={(n, _sel, e) => {
                          if (!n?.file) return;
                          e.preventDefault();
                          const file = n.file;
                          showContextMenu(e, [
                            { label: "Show Diff", icon: "diff", run: () => openFileDiff(file) },
                            {
                              kind: "action",
                              action: "vcs.showHistory",
                              arg: absolutePath(file.path, commitRoot ?? undefined),
                              label: "Show History",
                            },
                          ]);
                        }}
                        aria-label="Changed files"
                        className={logStyles.fileTree}
                      />
                    )}
                  </div>
                </SplitPanel>
                <SplitHandle />
                <SplitPanel id="message" defaultSize="38%" minSize="60px">
                  <div className={logStyles.messageBox}>
                    {many ? (
                      chosen.map((c) => <CommitMessage key={commitKey(c)} commit={c} compact />)
                    ) : (
                      <CommitMessage commit={activeCommit} />
                    )}
                  </div>
                </SplitPanel>
              </SplitGroup>
            </div>
          )}
        </SplitPanel>
      </SplitGroup>
    </div>
  );
}
