/**
 * Compare Branches editor tab (`Compare: <branch> and <current>`) — IntelliJ IDEA style
 * two-pane comparison view showing commits in `<branch>` not in `<current>` (top) and
 * commits in `<current>` not in `<branch>` (bottom), each with its own filter bar,
 * warning banner, commit graph/list, changed-files tree, and commit message viewer.
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
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import {
  Dialog,
  EmptyState,
  Icon,
  IconButton,
  SearchField,
  Spinner,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  T,
  Tree,
  showContextMenu,
  type MenuItem,
} from "@/ui";
import {
  maybeEditorService,
  toolWindowService,
  type EditorInput,
} from "@/workbench/contributions";
import {
  chooseDateRange,
  chooseMany,
  choosePathInTree,
  openDialog,
  promptText,
} from "./dialogs";
import { commitFileDiffData, openDiff, revisionChangeDiffData, withChain } from "./diffInput";
import { buildFileTree, dirKeys, type FileTreeNode } from "./fileTree";
import { computeGraph, computeMultiRepoGraph } from "./graph";
import {
  dateRangeLabel,
  inDateRange,
  logRepoOf,
  ME,
  openFileHistory,
  pathsFilterLabel,
  resolveAuthors,
  toggleRootFilter,
  type LogCommit,
  type LogDateFilter,
  type LogFilters,
} from "./logStore";
import { fileCount, formatTime, relTo } from "./model";
import { cherryPick } from "./operations";
import { errorMessage } from "./ops";
import { repoColorIndex } from "./repoBranches";
import { currentRepo, repoName, useVcs } from "./store";
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
import styles from "./GitLog.module.css";

const COMPARE_LIMIT = 500;

export const COMPARE_BRANCHES_KIND = "vcs.compareBranches";

export interface CompareBranchesData {
  branch: string;
  current: string;
  repo: string | null;
  repos?: readonly string[];
  title?: string;
}

export function compareBranchesTitle(data: CompareBranchesData): string {
  if (data.title) return data.title;
  return tx`Compare: ${data.branch} and ${data.current}`;
}

export function compareBranchesInput(
  branch: string,
  current: string,
  repo: string | null = currentRepo(),
  repos?: readonly string[],
  title?: string,
): EditorInput {
  const repoKey = repos && repos.length > 1 ? repos.join("|") : (repo ?? "");
  const data: CompareBranchesData = { branch, current, repo, repos, title };
  return {
    kind: COMPARE_BRANCHES_KIND,
    key: `compareBranches:${repoKey}:${branch}:${current}`,
    path: "",
    data,
  };
}

/**
 * Opens the `Compare: <branch> and <current>` editor tab.
 * Accepts an optional single repo path or list of repo paths for multi-root projects.
 */
export function showCompareBranches(branch: string, repoOrRepos?: string | readonly string[] | null) {
  const state = useVcs.getState();
  const repos = Array.isArray(repoOrRepos) ? repoOrRepos : undefined;
  const repo = typeof repoOrRepos === "string" ? repoOrRepos : (repos?.[0] ?? currentRepo());

  let cur = state.branch?.head ?? "HEAD";
  if (repo && state.heads[repo]?.head) {
    cur = state.heads[repo]!.head;
  } else if (repos && repos.length > 0) {
    const headNames = [...new Set(repos.map((r) => state.heads[r]?.head).filter((h): h is string => !!h))];
    if (headNames.length === 1) cur = headNames[0]!;
  }

  const input = compareBranchesInput(branch, cur, repo, repos);
  const svc = maybeEditorService();
  if (svc) {
    void svc.openInput(input, { focus: true });
    return;
  }
  const data = input.data as CompareBranchesData;
  openDialog((close) => (
    <Dialog
      open
      title={compareBranchesTitle(data)}
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

/**
 * Shows commits in range `from..to` (used by "View Commits" after branch deletion or update).
 */
export function showCommitRange(
  title: string,
  from: string,
  to: string,
  repo: string | null = currentRepo(),
) {
  openDialog((close) => (
    <Dialog
      open
      title={tx(title)}
      onClose={close}
      width={980}
      buttons={[{ label: "Close", role: "cancel" }]}
    >
      <div style={{ height: 460, display: "flex", flexDirection: "column" }}>
        <BranchComparisonPane paneId="range" fromBranch={from} toBranch={to} repo={repo} />
      </div>
    </Dialog>
  ));
}

export function CompareBranchesEditor({ input }: { input: EditorInput }) {
  const data = (input.data ?? {
    branch: "HEAD",
    current: useVcs.getState().branch?.head ?? "HEAD",
    repo: currentRepo(),
  }) as CompareBranchesData;
  const { branch, current, repo, repos } = data;

  return (
    <div className={styles.compareRoot}>
      <SplitGroup orientation="vertical" id="vcs-compare-branches" className={styles.split}>
        <SplitPanel id="top" defaultSize="50%" minSize="140px">
          <BranchComparisonPane
            paneId="top"
            fromBranch={current}
            toBranch={branch}
            repo={repo}
            repos={repos}
          />
        </SplitPanel>
        <SplitHandle />
        <SplitPanel id="bottom" defaultSize="50%" minSize="140px">
          <BranchComparisonPane
            paneId="bottom"
            fromBranch={branch}
            toBranch={current}
            repo={repo}
            repos={repos}
          />
        </SplitPanel>
      </SplitGroup>
    </div>
  );
}

type DetailFile = (ChangedFile | RevisionChange) & { _repo?: string | null };

interface PaneFilterState {
  text: string;
  regex: boolean;
  matchCase: boolean;
  authors: string[];
  date: LogDateFilter | null;
  path: string | null;
  roots: string[];
}

function emptyPaneFilters(): PaneFilterState {
  return {
    text: "",
    regex: false,
    matchCase: false,
    authors: [],
    date: null,
    path: null,
    roots: [],
  };
}

function matchesCommitQuery(
  c: Commit,
  rawQuery: string,
  regex: boolean,
  matchCase: boolean,
): boolean {
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

function BranchComparisonPane({
  paneId,
  fromBranch,
  toBranch,
  repo,
  repos,
}: {
  paneId: string;
  fromBranch: string;
  toBranch: string;
  repo: string | null;
  repos?: readonly string[];
}) {
  const version = useVcs((s) => s.version);
  const root = useVcs((s) => s.root);
  const vcsRoots = useVcs((s) => s.roots);
  const branches = useVcs((s) => s.branches);
  const remoteNames = useMemo(
    () => new Set(branches.filter((b) => b.remote).map((b) => b.name)),
    [branches],
  );

  const effectiveRoots = useMemo(
    () => (vcsRoots.length > 1 ? vcsRoots : repos && repos.length > 1 ? repos : []),
    [vcsRoots, repos],
  );
  const multiRepo = effectiveRoots.length > 1;

  const initialRoots = useMemo(() => {
    if (effectiveRoots.length <= 1) return [];
    if (repos && repos.length > 0 && repos.length < effectiveRoots.length) {
      return [...repos];
    }
    if (!repos && repo && effectiveRoots.includes(repo)) {
      return [repo];
    }
    return [];
  }, [effectiveRoots, repos, repo]);

  const [filters, setFilters] = useState<PaneFilterState>(() => ({
    ...emptyPaneFilters(),
    roots: initialRoots,
  }));
  const [searchInput, setSearchInput] = useState("");
  const [commits, setCommits] = useState<LogCommit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const anchorRef = useRef<string | null>(null);
  const [meUser, setMeUser] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      setFilters((prev) => (prev.text === searchInput ? prev : { ...prev, text: searchInput }));
    }, 200);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    const targetRepo = repo ?? effectiveRoots[0] ?? currentRepo();
    call(commands.vcsConfigGet(targetRepo, "user.email"))
      .catch(() => null)
      .then(
        async (email) =>
          email || (await call(commands.vcsConfigGet(targetRepo, "user.name")).catch(() => null)),
      )
      .then((u) => setMeUser(u));
  }, [repo, effectiveRoots]);

  const load = useCallback(() => {
    const resolvedAuthors = resolveAuthors(
      filters.authors,
      filters.authors.includes(ME) ? meUser : null,
    );
    const baseOpts = {
      branch: null,
      branches: [] as string[],
      authors: resolvedAuthors,
      author: resolvedAuthors[0] ?? null,
      text: filters.text.trim() || null,
      textRegex: filters.regex,
      textMatchCase: filters.matchCase,
      range: `${fromBranch}..${toBranch}`,
      sinceMs: filters.date?.after ?? null,
      untilMs: filters.date?.before ?? null,
      skip: 0,
      limit: COMPARE_LIMIT,
    };

    const targetRepos = multiRepo
      ? filters.roots.length
        ? effectiveRoots.filter((r) => filters.roots.includes(r))
        : effectiveRoots
      : [repo ?? currentRepo()];

    Promise.all(
      targetRepos.map(async (r) => {
        const pathForRepo =
          filters.path && (!r || !multiRepo || logRepoOf(filters.path, effectiveRoots) === r)
            ? filters.path
            : multiRepo
              ? null
              : filters.path;
        if (multiRepo && filters.path && !pathForRepo) return [] as LogCommit[];
        try {
          const list = await call(
            commands.vcsLog(r, {
              ...baseOpts,
              path: pathForRepo,
            }),
          );
          return r ? list.map((c) => ({ ...c, repo: r })) : list;
        } catch (e) {
          if (!multiRepo || targetRepos.length === 1) throw e;
          return [] as LogCommit[];
        }
      }),
    )
      .then((batches) => {
        const merged = batches.flat();
        if (multiRepo) merged.sort((a, b) => (b.timeMs ?? 0) - (a.timeMs ?? 0));
        setCommits(merged);
        setError(null);
        setSelected((prev) => {
          const keep = prev && merged.some((c) => c.id === prev) ? prev : (merged[0]?.id ?? null);
          setSelection((prevSel) => {
            const valid = prevSel.filter((id) => merged.some((c) => c.id === id));
            return valid.length ? valid : keep ? [keep] : [];
          });
          return keep;
        });
      })
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setLoading(false));
  }, [
    fromBranch,
    toBranch,
    repo,
    multiRepo,
    effectiveRoots,
    filters.authors,
    filters.text,
    filters.regex,
    filters.matchCase,
    filters.date,
    filters.path,
    filters.roots,
    meUser,
  ]);

  useEffect(() => {
    load();
  }, [load, version]);

  // Also apply client-side filtering so search/author/date filters respond immediately
  // and work seamlessly with mocked IPC responses in tests.
  const visibleCommits = useMemo(() => {
    const resolvedAuthors = resolveAuthors(
      filters.authors,
      filters.authors.includes(ME) ? meUser : null,
    );
    const activeText = searchInput.trim() || filters.text.trim();
    return commits.filter((c) => {
      if (activeText && !matchesCommitQuery(c, activeText, filters.regex, filters.matchCase)) {
        return false;
      }
      if (resolvedAuthors.length > 0) {
        const hay = `${c.author} <${c.email}>`.toLowerCase();
        if (!resolvedAuthors.some((a) => hay.includes(a.toLowerCase()))) return false;
      }
      if (filters.date && !inDateRange(c.timeMs ?? 0, filters.date)) return false;
      return true;
    });
  }, [
    commits,
    searchInput,
    filters.text,
    filters.regex,
    filters.matchCase,
    filters.authors,
    filters.date,
    meUser,
  ]);

  const rows = useMemo(
    () =>
      multiRepo
        ? computeMultiRepoGraph(visibleCommits, effectiveRoots)
        : computeGraph(visibleCommits).rows,
    [visibleCommits, multiRepo, effectiveRoots],
  );

  const selectedSet = useMemo(() => new Set(selection), [selection]);
  const chosen = useMemo(
    () => visibleCommits.filter((c) => selectedSet.has(c.id)),
    [visibleCommits, selectedSet],
  );
  const activeCommit = useMemo(
    () => (selected ? visibleCommits.find((c) => c.id === selected) : visibleCommits[0]) ?? null,
    [visibleCommits, selected],
  );
  const many = chosen.length > 1;

  // Changed files for the selected commit(s)
  const commitRepo = activeCommit?.repo ?? repo ?? currentRepo();
  const repoGroups = useMemo(() => {
    const groups = new Map<string | null, LogCommit[]>();
    for (const c of chosen) {
      const r = c.repo ?? repo ?? currentRepo();
      const list = groups.get(r) ?? [];
      list.push(c);
      groups.set(r, list);
    }
    return groups;
  }, [chosen, repo]);
  const multiRepoSelection = repoGroups.size > 1;

  const idsKey = many
    ? chosen.map((c) => (c.repo ? `${c.repo}:${c.id}` : c.id)).join(" ")
    : activeCommit
      ? (activeCommit.repo ? `${activeCommit.repo}:${activeCommit.id}` : activeCommit.id)
      : "";

  const [filesState, setFilesState] = useState<{
    key: string;
    files: DetailFile[] | null;
    error: string | null;
  }>({ key: "", files: null, error: null });
  const [expanded, setExpanded] = useState<Set<string> | null>(null);

  const files = filesState.key === idsKey ? filesState.files : null;
  const filesError = filesState.key === idsKey ? filesState.error : null;

  useEffect(() => {
    if (!idsKey || !activeCommit) return;
    let alive = true;
    const req: Promise<DetailFile[]> = multiRepoSelection
      ? Promise.all(
          [...repoGroups.entries()].map(async ([r, list]) => {
            const ids = list.map((c) => c.id).reverse();
            const changes = await call(commands.vcsCommitsChanges(r, ids));
            return changes.map((f) => ({ ...f, _repo: r }));
          }),
        ).then((batches) => batches.flat())
      : many
        ? call(
            commands.vcsCommitsChanges(
              commitRepo,
              chosen.map((c) => c.id).reverse(),
            ),
          ).then((list) => list.map((f) => ({ ...f, _repo: commitRepo })))
        : call(commands.vcsCommitFiles(commitRepo, activeCommit.id)).then((list) =>
            list.map((f) => ({ ...f, _repo: commitRepo })),
          );
    req
      .then((list) => {
        if (alive) setFilesState({ key: idsKey, files: list, error: null });
      })
      .catch((e) => {
        if (alive) setFilesState({ key: idsKey, files: null, error: errorMessage(e) });
      });
    return () => {
      alive = false;
    };
  }, [idsKey, commitRepo, multiRepoSelection, repoGroups, many, chosen, activeCommit]);

  const detailRoot = activeCommit?.repo ?? repo ?? root ?? "";
  const tree = useMemo(
    () =>
      buildFileTree(files ?? [], (f) => {
        const d = f as DetailFile;
        const fileRepo = d._repo ?? detailRoot;
        const rel = relTo(fileRepo, d.path);
        if ((multiRepo || multiRepoSelection) && fileRepo) {
          return `${repoName(fileRepo)}/${rel}`;
        }
        return rel;
      }),
    [files, detailRoot, multiRepo, multiRepoSelection],
  );
  const allDirs = useMemo(() => dirKeys(tree), [tree]);

  const openFileDiff = useCallback(
    (target?: DetailFile) => {
      if (!activeCommit) return;
      const list = files ?? (target ? [target] : []);
      if (!list.length) return;
      const chosenFile = target ?? list[0]!;
      void openDiff(
        withChain(
          list.map((x) =>
            many
              ? revisionChangeDiffData(x as RevisionChange, x._repo ?? activeCommit.repo ?? repo)
              : commitFileDiffData(activeCommit, x),
          ),
          Math.max(0, list.indexOf(chosenFile)),
        ),
      );
    },
    [activeCommit, files, many, repo],
  );

  const pickCommit = (id: string, e?: ReactMouseEvent) => {
    if (e?.shiftKey && anchorRef.current) {
      const a = visibleCommits.findIndex((c) => c.id === anchorRef.current);
      const b = visibleCommits.findIndex((c) => c.id === id);
      if (a >= 0 && b >= 0) {
        const [from, to] = a <= b ? [a, b] : [b, a];
        const range = visibleCommits.slice(from, to + 1).map((c) => c.id);
        setSelected(id);
        setSelection([anchorRef.current, ...range.filter((x) => x !== anchorRef.current)]);
        return;
      }
    }
    if (e && (e.metaKey || e.ctrlKey)) {
      setSelection((prev) => {
        const has = prev.includes(id);
        const next = has ? prev.filter((x) => x !== id) : [...prev, id];
        const nextLead = has ? (next[next.length - 1] ?? null) : id;
        setSelected(nextLead);
        return next;
      });
      anchorRef.current = id;
      return;
    }
    anchorRef.current = id;
    setSelected(id);
    setSelection([id]);
  };

  const selectedIndex = selected ? visibleCommits.findIndex((c) => c.id === selected) : -1;
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
    if (target) pickCommit(target.id);
  };

  const openUserMenu = (e: ReactMouseEvent<HTMLElement>) => {
    const authors = [...new Set(commits.map((c) => c.author))]
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 30);
    menuBelow(e, [
      {
        label: ME,
        checked: filters.authors.includes(ME),
        run: () => setFilters((f) => ({ ...f, authors: [ME] })),
      },
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

  const openDateMenu = (e: ReactMouseEvent<HTMLElement>) =>
    menuBelow(e, [
      ...DATE_OPTIONS.map((o) => ({
        label: o.label,
        checked: filters.date?.label === o.label,
        run: () =>
          setFilters((f) => ({
            ...f,
            date: { after: Date.now() - o.days * DAY, before: null, label: o.label },
          })),
      })),
      { kind: "separator" },
      {
        label: "Select…",
        run: async () => {
          const r = await chooseDateRange();
          if (r) {
            setFilters((f) => ({
              ...f,
              date: { ...r, label: dateRangeLabel(r.after, r.before) },
            }));
          }
        },
      },
    ]);

  const openPathsMenu = (e: ReactMouseEvent<HTMLElement>) => {
    const baseRoot = repo ?? root;
    const items: MenuItem[] = [
      {
        label: "Select…",
        run: async () => {
          const cur = filters.path && baseRoot ? relTo(baseRoot, filters.path) : (filters.path ?? "");
          const r = await promptText({
            title: "Filter by Path",
            label: "File or folder",
            initial: cur,
            mono: true,
          });
          if (!r) return;
          const v = r.value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
          if (!v) {
            setFilters((f) => ({ ...f, path: null, roots: [] }));
            return;
          }
          const full =
            v.startsWith("/") || /^[A-Za-z]:\//.test(v) || !baseRoot ? v : `${baseRoot}/${v}`;
          setFilters((f) => ({ ...f, path: full, roots: [] }));
        },
      },
      {
        label: "Select in Tree…",
        run: async () => {
          const choice = await choosePathInTree({
            projectRoot: baseRoot,
            roots: multiRepo ? effectiveRoots : repo ? [repo] : vcsRoots,
            initialPath: filters.path,
            initialRoots: filters.roots,
          });
          if (choice) {
            setFilters((f) => ({
              ...f,
              path: choice.path ?? null,
              roots: choice.roots ?? [],
            }));
          }
        },
      },
    ];
    if (multiRepo) {
      items.push({ kind: "separator" }, { kind: "header", label: "Roots" });
      for (const r of effectiveRoots) {
        const checked = !filters.path && (filters.roots.length === 0 || filters.roots.includes(r));
        items.push({
          label: repoName(r),
          checked,
          run: () =>
            setFilters((f) => ({
              ...f,
              path: null,
              roots: f.path ? [r] : toggleRootFilter(f.roots, effectiveRoots, r),
            })),
        });
      }
    }
    menuBelow(e, items);
  };

  const pathFilterObj = useMemo(
    (): LogFilters => ({
      branches: [],
      authors: filters.authors,
      text: filters.text,
      regex: filters.regex,
      matchCase: filters.matchCase,
      date: filters.date,
      path: filters.path,
      roots: filters.roots,
    }),
    [filters],
  );
  const pathValue = pathsFilterLabel(pathFilterObj, repo ?? root, multiRepo ? effectiveRoots : vcsRoots);

  return (
    <div className={styles.comparePane}>
      <SplitGroup orientation="horizontal" id={`vcs-compare-pane-${paneId}`} className={styles.split}>
        <SplitPanel id="commits" defaultSize="58%" minSize="240px">
          <div className={styles.log}>
            <div
              className={styles.filters}
              role="toolbar"
              aria-label={tx`Compare ${toBranch} with ${fromBranch}`}
            >
              <SearchField
                className={styles.textFilter}
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
                value={pathValue}
                onOpen={openPathsMenu}
                onClear={() => setFilters((f) => ({ ...f, path: null, roots: [] }))}
              />
              <span className={styles.grow} />
              <IconButton icon="refresh" title="Refresh" size="small" onClick={load} />
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

            <div className={styles.compareBanner} role="status">
              <Icon name="warning" size={14} className={styles.compareBannerIcon} />
              <span>{tx`Commits that exist in ${toBranch} but don't exist in ${fromBranch}`}</span>
            </div>

            <div className={styles.listWrap}>
              <div
                className={styles.list}
                role="listbox"
                aria-label={tx`Commits in ${toBranch} not in ${fromBranch}`}
                aria-multiselectable
                tabIndex={0}
                onKeyDown={onKeyDown}
              >
                {error && !visibleCommits.length && <div className={styles.message}>{error}</div>}
                {loading && !visibleCommits.length && (
                  <div className={styles.message}>
                    <Spinner size={12} />{" "}
                    <span className={styles.muted}>
                      <T>Loading…</T>
                    </span>
                  </div>
                )}
                {!loading && !error && !visibleCommits.length && (
                  <div className={styles.message}>
                    <T>No commits</T>
                  </div>
                )}
                {visibleCommits.map((c, idx) => {
                  const isSel = selectedSet.has(c.id);
                  const repoIdx = multiRepo && c.repo ? effectiveRoots.indexOf(c.repo) : -1;
                  const repoColor = repoIdx >= 0 ? repoColorIndex(repoIdx) : null;
                  const repoTitle = multiRepo && c.repo ? repoName(c.repo) : undefined;
                  return (
                    <div
                      key={c.repo ? `${c.repo}:${c.id}` : c.id}
                      role="option"
                      aria-selected={isSel}
                      className={clsx(
                        styles.row,
                        repoColor !== null && styles.rowMultiRepo,
                        isSel && styles.selected,
                      )}
                      style={{ position: "relative" }}
                      onMouseDown={(e) => {
                        if (e.button === 2 && !selectedSet.has(c.id)) {
                          pickCommit(c.id);
                        } else if (e.button === 0) {
                          if (e.shiftKey) e.preventDefault();
                          pickCommit(c.id, e);
                        }
                      }}
                      onDoubleClick={() => openFileDiff()}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        showContextMenu(e, commitMenu(c, chosen.length ? chosen : [c]));
                      }}
                    >
                      {repoColor !== null && (
                        <span
                          className={styles.repoStripe}
                          style={{ background: `var(--project-color-${repoColor})` }}
                          title={repoTitle}
                          aria-hidden
                        />
                      )}
                      <span className={styles.colSubject}>
                        {rows[idx] && <GraphCell row={rows[idx]!} head={false} />}
                        <span className={styles.subject} title={c.message}>
                          {c.summary}
                        </span>
                        {c.refs.length > 0 && <RefLabels refs={c.refs} remoteNames={remoteNames} />}
                      </span>
                      <span
                        className={clsx(styles.colAuthor, styles.muted)}
                        title={`${c.author} <${c.email}>`}
                      >
                        {c.author}
                      </span>
                      <span className={clsx(styles.colDate, styles.muted)}>{formatTime(c.timeMs)}</span>
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
            <div className={styles.details}>
              <EmptyState>
                <T>Select commit to view changes</T>
              </EmptyState>
            </div>
          ) : (
            <div className={styles.details}>
              <SplitGroup orientation="vertical" id={`vcs-compare-details-${paneId}`}>
                <SplitPanel id="files" defaultSize="62%" minSize="60px">
                  <div className={styles.filesPane}>
                    <div className={styles.detailsBar} role="toolbar" aria-label={tx("Changed files")}>
                      <span className={styles.detailsCount} title={many ? undefined : activeCommit.summary}>
                        {many
                          ? `${files ? fileCount(files.length) : ""} ${tx`in ${chosen.length} commits`}`
                          : tx`Changes to ${activeCommit.shortId} ${activeCommit.summary}`}
                      </span>
                      <span className={styles.grow} />
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
                    {filesError && <div className={styles.message}>{filesError}</div>}
                    {!files && !filesError && (
                      <div className={styles.message}>
                        <Spinner size={12} />
                      </div>
                    )}
                    {files && (
                      <Tree<FileTreeNode<ChangedFile>>
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
                          const file = n.file as DetailFile;
                          const fileRepo = file._repo ?? activeCommit.repo ?? repo ?? root ?? "";
                          const normPath = file.path.replace(/\\/g, "/");
                          const absPath =
                            normPath.startsWith("/") || /^[A-Za-z]:\//.test(normPath) || !fileRepo
                              ? file.path
                              : `${fileRepo.replace(/\/+$/, "")}/${normPath}`;
                          showContextMenu(e, [
                            {
                              label: "Show Diff",
                              icon: "diff",
                              run: () => openFileDiff(file),
                            },
                            {
                              label: "Show History",
                              icon: "history",
                              run: () => {
                                openFileHistory(absPath);
                                try {
                                  toolWindowService().show("git");
                                } catch {
                                  /* toolWindowService not mounted in standalone tests */
                                }
                              },
                            },
                          ]);
                        }}
                        aria-label="Changed files"
                        className={styles.fileTree}
                      />
                    )}
                  </div>
                </SplitPanel>
                <SplitHandle />
                <SplitPanel id="message" defaultSize="38%" minSize="60px">
                  <div className={styles.messageBox}>
                    {many ? (
                      chosen.map((c: Commit) => (
                        <CommitMessage key={c.id} commit={c} compact />
                      ))
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
