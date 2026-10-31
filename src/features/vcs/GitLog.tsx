/** Git tool window: Log (graph, filters, commit details) and Console tabs. */
import { IssueText } from "./issueLinks";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import clsx from "clsx";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Branch, ChangedFile, Commit, RevisionChange } from "@/bindings";
import { call, commands } from "@/platform/ipc";
import {
  EmptyState,
  Icon,
  IconButton,
  Popup,
  SearchField,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  Spinner,
  Tabs,
  Tree,
  fileIconName,
  showContextMenu,
  type MenuItem,
  T,
  copyText,
} from "@/ui";
import { hasPrimaryModifier } from "@/platform/keymap";
import { executeAction } from "@/platform/actions";
import { commitFileDiffData, openDiff, revisionChangeDiffData, withChain } from "./diffInput";
import {
  collapseLinear,
  computeGraph,
  computeMultiRepoGraph,
  hideLongEdges,
  laneColor,
  reachableFrom,
  type GraphRow,
} from "./graph";
import {
  closeFileHistory,
  extendCommitSelection,
  goToChild,
  goToParent,
  isMine,
  loadMore,
  ME,
  openFileHistory,
  dateRangeLabel,
  pathsFilterLabel,
  refsSignature,
  reloadLog,
  resolveLogTargets,
  selectCommit,
  selectedCommits,
  setLogFilters,
  toggleCommitSelection,
  toggleRootFilter,
  updateLogOptions,
  useGitLog,
  type LogCommit,
  type LogFilters,
} from "./logStore";
import { refLabels, useLogOptions, type LogOptions } from "./logOptions";
import { KIND_COLOR, baseName, fileCount, formatTime, relTo, type EffectiveKind } from "./model";
import { clearConsole, useVcsConsole } from "./ops";
import { currentRepo, loadBranches, refreshNow, repoName, useVcs } from "./store";
import { repoColorIndex } from "./repoBranches";
import {
  deleteBranch,
  deleteInRepos,
  deleteRemoteBranch,
  deleteRemoteInRepos,
  loadFavoriteBranches,
  newBranch,
  newBranchInRepos,
  updateBranch,
  updateInRepos,
  useFavoriteBranches,
} from "./branchOps";
import { branchMenu, commonBranchMenu, inRepo } from "./branchMenu";
import { showCompareBranches } from "./CompareBranches";
import { FileHistoryView } from "./FileHistory";
import { showManageRemotes } from "./gitMenuDialogs";
import { updateProject } from "./remoteUi";
import {
  branchDetail,
  branchFolderKeys,
  branchGroupKeys,
  buildBranchTree,
  buildMultiRepoBranchTree,
  currentBranchFolderKeys,
  filterBranchTree,
  filterFavoriteBranchTree,
  type BranchTreeNode,
} from "./branches";
import { chooseDateRange, chooseMany, choosePathInTree, confirmDialog, promptText } from "./dialogs";
import { buildFileTree, dirKeys, type FileTreeNode } from "./fileTree";
import styles from "./GitLog.module.css";
import { tx } from "@/platform/i18n";

const ROW = 22;
const LANE = 12;

/** Tool window header: Log / Console / History: <file> content tabs. */
export function GitTabs() {
  const tab = useGitLog((s) => s.tab);
  const historyTabs = useGitLog((s) => s.historyTabs);
  const available = useVcs((s) => s.available);
  if (!available) return null;
  return (
    <Tabs
      variant="compact"
      className={styles.headerTabs}
      activeId={tab}
      onSelect={(id) => useGitLog.setState({ tab: id })}
      onClose={(id) => closeFileHistory(id)}
      aria-label="Git"
      panelIdPrefix="openidea-git"
      items={[
        { id: "log", label: "Log", closable: false },
        { id: "console", label: "Console", closable: false },
        ...historyTabs.map((h) => ({
          id: h.id,
          label: tx`History: ${baseName(h.path)}`,
          closable: true,
          tooltip: h.path,
        })),
      ]}
    />
  );
}

export function GitToolWindow() {
  const tab = useGitLog((s) => s.tab);
  const historyTabs = useGitLog((s) => s.historyTabs);
  const available = useVcs((s) => s.available);
  if (!available)
    return (
      <EmptyState title="Version control is not configured">
        <T>The project is not a Git repository.</T>
      </EmptyState>
    );
  const activeHistory = historyTabs.find((h) => h.id === tab);
  return (
    <div
      className={styles.root}
      role="tabpanel"
      id={`openidea-git-panel-${tab}`}
      aria-labelledby={`openidea-git-tab-${tab}`}
    >
      {activeHistory ? (
        <FileHistoryView key={activeHistory.id} tab={activeHistory} />
      ) : tab === "console" ? (
        <ConsoleView />
      ) : (
        <LogView />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Log

function LogView() {
  const version = useVcs((s) => s.version);
  const commits = useGitLog((s) => s.commits);
  const selection = useGitLog((s) => s.selection);
  const root = useVcs((s) => s.root);
  const repo = useVcs((s) => s.repo);
  const rootsCount = useVcs((s) => s.roots.length);
  const lastRefs = useRef<{ repo: string | null; sig: string } | null>(null);
  const [branchesCollapsed, setBranchesCollapsed] = useState(false);

  // On mount, when the window switches to another project and when another of its
  // repositories is selected (its branches are needed to notice its refs moving).
  useEffect(() => {
    lastRefs.current = null;
    if (!useGitLog.getState().commits.length) void reloadLog();
    void loadBranches().catch(() => undefined);
  }, [root, repo, rootsCount]);

  // HEAD or a branch tip moved (commit, undo, reset, rebase, fetch…): reload (keeps the selection).
  useEffect(() => {
    const { branch, branches, heads, branchesLoaded, branchesRepo, repo: curRepo, roots } = useVcs.getState();
    if (!branchesLoaded) return;
    const targetRepo = curRepo ?? roots[0] ?? null;
    if (branchesRepo !== null && branchesRepo !== targetRepo) return;
    const refs = refsSignature(branch, branches, heads);
    const previous = lastRefs.current;
    lastRefs.current = { repo: targetRepo, sig: refs };
    if (
      previous !== null &&
      previous.repo === targetRepo &&
      previous.sig !== refs &&
      useGitLog.getState().commits.length
    ) {
      void reloadLog();
    }
  }, [version]);

  if (branchesCollapsed) {
    return (
      <div className={styles.logWrap}>
        <BranchesPanel collapsed onToggleCollapse={() => setBranchesCollapsed(false)} />
        <SplitGroup orientation="horizontal" id="git-log-collapsed" className={styles.split}>
          <SplitPanel id="commits" defaultSize="66%" minSize="25%">
            <div className={styles.log}>
              <FilterBar />
              <CommitList />
            </div>
          </SplitPanel>
          <SplitHandle />
          <SplitPanel id="details" defaultSize="34%" minSize="15%">
            <CommitDetails key={selection.join(" ") || "none"} commits={commits} />
          </SplitPanel>
        </SplitGroup>
      </div>
    );
  }

  return (
    <div className={styles.logWrap}>
      <SplitGroup orientation="horizontal" id="git-log" className={styles.split}>
        <SplitPanel id="branches" defaultSize="18%" minSize="120px">
          <BranchesPanel onToggleCollapse={() => setBranchesCollapsed(true)} />
        </SplitPanel>
        <SplitHandle />
        <SplitPanel id="commits" defaultSize="54%" minSize="25%">
          <div className={styles.log}>
            <FilterBar />
            <CommitList />
          </div>
        </SplitPanel>
        <SplitHandle />
        <SplitPanel id="details" defaultSize="28%" minSize="15%">
          <CommitDetails key={selection.join(" ") || "none"} commits={commits} />
        </SplitPanel>
      </SplitGroup>
    </div>
  );
}

// --- branches ---------------------------------------------------------------

export function BranchesPanel({
  collapsed: collapsedProp,
  onToggleCollapse,
}: {
  collapsed?: boolean;
  onToggleCollapse?: () => void;
} = {}) {
  const branches = useVcs((s) => s.branches);
  const root = useVcs((s) => s.root);
  const vcsRoots = useVcs((s) => s.roots);
  const heads = useVcs((s) => s.heads);
  const repo = useVcs((s) => s.repo);
  const version = useVcs((s) => s.version);
  const branchesLoaded = useVcs((s) => s.branchesLoaded);
  const branchesRepo = useVcs((s) => s.branchesRepo);
  const filters = useGitLog((s) => s.filters);
  const filterBranches = filters.branches;
  const favorites = useFavoriteBranches((s) => s.names);
  const [query, setQuery] = useState("");
  const [onlyFavorites, setOnlyFavorites] = useState(false);
  const [internalCollapsed, setInternalCollapsed] = useState(false);
  const mainRef = useRef<HTMLDivElement>(null);

  const collapsed = collapsedProp ?? internalCollapsed;
  const toggleCollapse = onToggleCollapse ?? (() => setInternalCollapsed((c) => !c));

  const validRoots = useMemo(() => (vcsRoots.length > 1 ? vcsRoots : []), [vcsRoots]);
  const activeRoots = useMemo(() => {
    if (validRoots.length <= 1) return [];
    const targets = resolveLogTargets(validRoots, repo, filters);
    const fromTargets = [...new Set(targets.map((t) => t.repo).filter((r): r is string => !!r))];
    return fromTargets.length ? fromTargets : validRoots;
  }, [validRoots, repo, filters]);
  const multiRepo = activeRoots.length > 1;
  const singleTargetRepo = activeRoots.length === 1 ? activeRoots[0]! : null;

  const knownRepo =
    branchesRepo && (!validRoots.length || validRoots.includes(branchesRepo))
      ? branchesRepo
      : branchesLoaded && (!validRoots.length || (repo && validRoots.includes(repo)))
        ? repo
        : null;
  const [seenRoot, setSeenRoot] = useState(root);
  const [byRepo, setByRepo] = useState<Record<string, readonly Branch[]>>(() =>
    knownRepo && branches.length ? { [knownRepo]: branches } : {},
  );
  const loadSeq = useRef(0);

  const loadAllBranches = useCallback(() => {
    if (validRoots.length <= 1) return;
    const seq = ++loadSeq.current;
    const rootAtStart = useVcs.getState().root;
    void Promise.all(
      validRoots.map((r) =>
        call(commands.vcsBranches(r)).then(
          (list) => [r, list] as const,
          () => [r, null] as const,
        ),
      ),
    ).then((entries) => {
      if (loadSeq.current !== seq || useVcs.getState().root !== rootAtStart) return;
      setByRepo((prev) => {
        const next = { ...prev };
        for (const [r, list] of entries) {
          if (Array.isArray(list)) next[r] = list;
        }
        return next;
      });
    });
  }, [validRoots]);

  useEffect(() => {
    loadAllBranches();
  }, [loadAllBranches, version]);

  useEffect(() => loadFavoriteBranches(), [root]);

  const current = useVcs((s) => {
    const targetRepo = singleTargetRepo ?? (s.branchesRepo ?? s.repo);
    if (targetRepo && s.heads[targetRepo]) return s.heads[targetRepo]!.head;
    if (singleTargetRepo) return byRepo[singleTargetRepo]?.find((b) => !b.remote && b.current)?.name ?? null;
    return s.branch?.head ?? s.branches.find((b) => b.current)?.name ?? null;
  });

  const allRoots = useMemo(() => {
    if (multiRepo) {
      return buildMultiRepoBranchTree(
        activeRoots.map((r) => ({
          root: r,
          name: repoName(r),
          head: heads[r]?.head,
          branches: byRepo[r] ?? [],
        })),
        favorites,
      );
    }
    const list = singleTargetRepo
      ? (byRepo[singleTargetRepo] ?? (knownRepo === singleTargetRepo ? branches : []))
      : branches;
    const headName = singleTargetRepo && heads[singleTargetRepo] ? heads[singleTargetRepo]!.head : undefined;
    const adjusted =
      headName !== undefined ? list.map((b) => (b.remote ? b : { ...b, current: b.name === headName })) : list;
    return buildBranchTree(adjusted, favorites);
  }, [multiRepo, activeRoots, heads, byRepo, favorites, singleTargetRepo, knownRepo, branches]);

  const baseRoots = useMemo(
    () => (onlyFavorites ? filterFavoriteBranchTree(allRoots) : allRoots),
    [allRoots, onlyFavorites],
  );
  const roots = useMemo(() => filterBranchTree(baseRoots, query), [baseRoots, query]);
  const autoExpandKeys = useMemo(
    () => [
      "g:local",
      "g:remote",
      ...allRoots.flatMap((r) => r.children?.filter((c) => c.kind === "remote").map((c) => c.key) ?? []),
      ...currentBranchFolderKeys(allRoots),
      ...(!multiRepo && current ? branchFolderKeys(allRoots, current) : []),
    ],
    [allRoots, multiRepo, current],
  );
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(autoExpandKeys));
  const [seenAuto, setSeenAuto] = useState<ReadonlySet<string>>(() => new Set(autoExpandKeys));
  if (seenRoot !== root) {
    setSeenRoot(root);
    setByRepo(knownRepo && branches.length ? { [knownRepo]: branches } : {});
    setQuery("");
    setSeenAuto(new Set(autoExpandKeys));
    setExpanded(new Set(autoExpandKeys));
  } else {
    if (knownRepo && branches.length && byRepo[knownRepo] !== branches) {
      setByRepo((prev) => ({ ...prev, [knownRepo]: branches }));
    }
    if (autoExpandKeys.some((k) => !seenAuto.has(k))) {
      const nextSeen = new Set(seenAuto);
      const nextExpanded = new Set(expanded);
      for (const k of autoExpandKeys) {
        if (!nextSeen.has(k)) {
          nextSeen.add(k);
          nextExpanded.add(k);
        }
      }
      setSeenAuto(nextSeen);
      setExpanded(nextExpanded);
    }
  }
  // While searching or filtering by favorites, matching groups are shown expanded.
  const searchExpanded = useMemo(
    () => (query.trim() || onlyFavorites ? new Set(branchGroupKeys(roots)) : undefined),
    [roots, query, onlyFavorites],
  );
  // Highlighted rows: a click only selects (IDEA), and only a double click or
  // Enter switches the log, so the selection is the pane's own state. It still
  // follows the filter when something else changes it (Show Log, the filter bar).
  const filterKeys = useMemo(() => filterBranches.map((b) => (b === "HEAD" ? "head" : `b:${b}`)), [filterBranches]);
  const filterKey = filterKeys.join("\n");
  const [shownKey, setShownKey] = useState(filterKey);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(filterKeys));
  if (shownKey !== filterKey) {
    // The filter changed elsewhere (Show Log, the filter bar): highlight it.
    setShownKey(filterKey);
    setSelected(new Set(filterKeys));
  }
  // Branches in tree order, for Copy and toolbar actions.
  const { refs, nodeByKey, currentBranchKeys } = useMemo(() => {
    const outRefs: { key: string; ref: string }[] = [];
    const map = new Map<string, BranchTreeNode>();
    const curKeys: string[] = [];
    const walk = (nodes: readonly BranchTreeNode[]) => {
      for (const n of nodes) {
        map.set(n.key, n);
        if (n.ref) outRefs.push({ key: n.key, ref: n.ref });
        if (n.kind === "branch" && (n.branch?.current || (n.currentRoots?.length ?? 0) > 0)) {
          curKeys.push(n.key);
        }
        walk(n.children ?? []);
      }
    };
    walk(allRoots);
    return { refs: outRefs, nodeByKey: map, currentBranchKeys: curKeys };
  }, [allRoots]);

  const selectedNodes = useMemo(
    () => [...selected].map((k) => nodeByKey.get(k)).filter((n): n is BranchTreeNode => !!n),
    [selected, nodeByKey],
  );
  const selectedLocalBranches = useMemo(
    () => selectedNodes.filter((n) => n.kind === "branch" && n.branch && !n.branch.remote),
    [selectedNodes],
  );
  const headSelected = selected.has("head");
  const canUpdateSelected = selectedLocalBranches.length > 0 || headSelected;

  const deletableBranches = useMemo(
    () =>
      selectedNodes.filter(
        (n) =>
          n.kind === "branch" &&
          n.branch &&
          (multiRepo && n.repoRoots && n.repoRoots.length > 1
            ? (n.currentRoots?.length ?? 0) === 0
            : !n.branch.current),
      ),
    [selectedNodes, multiRepo],
  );
  const canDeleteSelected = deletableBranches.length > 0;

  const compareTarget = useMemo(() => {
    const branchesOnly = selectedNodes.filter((n) => n.kind === "branch" && n.branch);
    if (branchesOnly.length !== 1) return null;
    const target = branchesOnly[0]!;
    if (target.branch!.current) return null;
    return target;
  }, [selectedNodes]);

  const handleNewBranch = () => {
    void (multiRepo
      ? newBranchInRepos(activeRoots)
      : singleTargetRepo
        ? newBranchInRepos([singleTargetRepo])
        : newBranch());
  };

  const handleUpdateSelected = async () => {
    if (selectedLocalBranches.length > 0) {
      for (const n of selectedLocalBranches) {
        const b = n.branch!;
        if (multiRepo && n.repoRoots && n.repoRoots.length > 1) {
          await updateInRepos(b.name, n.repoRoots, n.currentRoots ?? []);
        } else {
          const targetRepo =
            (multiRepo && n.repoRoots?.length === 1 ? n.repoRoots[0]! : singleTargetRepo) ?? undefined;
          await updateBranch(b.name, targetRepo);
        }
      }
      return;
    }
    if (headSelected) {
      await updateProject(multiRepo ? activeRoots : singleTargetRepo ? [singleTargetRepo] : {});
    }
  };

  const handleDeleteSelected = async () => {
    if (!deletableBranches.length) return;
    const batch = deletableBranches.length > 1;
    if (batch) {
      const list = deletableBranches
        .map((n) => (n.branch!.remote ? tx`${n.branch!.name} (remote)` : n.branch!.name))
        .join("\n");
      const ok = await confirmDialog({
        title: "Delete Branches",
        message: tx`Delete the following branches?\n${list}`,
        okLabel: "Delete",
        danger: true,
      });
      if (!ok) return;
    }
    for (const n of deletableBranches) {
      const b = n.branch!;
      if (multiRepo && n.repoRoots && n.repoRoots.length > 1) {
        await (b.remote
          ? deleteRemoteInRepos(b.name, n.repoRoots, { confirm: !batch })
          : deleteInRepos(b.name, n.repoRoots, { confirm: !batch }));
      } else {
        const targetRepo =
          (multiRepo && n.repoRoots?.length === 1 ? n.repoRoots[0]! : singleTargetRepo) ?? undefined;
        await (b.remote
          ? deleteRemoteBranch(b.name, targetRepo, { confirm: !batch })
          : deleteBranch(b.name, targetRepo));
      }
    }
  };

  const handleFind = () => {
    if (collapsed) toggleCollapse();
    requestAnimationFrame(() => {
      const input = mainRef.current?.querySelector<HTMLInputElement>("input");
      input?.focus();
      input?.select();
    });
  };

  const handleSelectCurrent = () => {
    const expandKeys = [
      "g:local",
      ...currentBranchFolderKeys(allRoots),
      ...(!multiRepo && current ? branchFolderKeys(allRoots, current) : []),
    ];
    setExpanded((prev) => new Set([...prev, ...expandKeys]));
    setSelected(new Set(currentBranchKeys.length ? currentBranchKeys : ["head"]));
  };

  const onKeyDownCapture = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.key !== "c" && e.key !== "C") || !hasPrimaryModifier(e) || e.altKey || e.shiftKey) return;
    // The branch search keeps the browser's own copy.
    if ((e.target as HTMLElement).closest("input, textarea")) return;
    const names = refs.filter((r) => selected.has(r.key)).map((r) => r.ref);
    if (!names.length) return;
    e.preventDefault();
    e.stopPropagation();
    void copyText(names.join("\n"));
  };

  return (
    <div className={clsx(styles.branches, collapsed && styles.branchesCollapsed)} onKeyDownCapture={onKeyDownCapture}>
      <div className={styles.branchesSideBar} role="toolbar" aria-label={tx("Branch Actions")}>
        <IconButton
          icon={collapsed ? "chevron-right" : "chevron-left"}
          title={collapsed ? "Show Branches" : "Hide Branches"}
          size="small"
          onClick={toggleCollapse}
        />
        {!collapsed && (
          <>
            <div className={styles.branchesSideSep} role="separator" />
            <IconButton icon="plus" title="New Branch…" size="small" onClick={handleNewBranch} />
            <IconButton
              icon="git-pull"
              title="Update Selected"
              size="small"
              disabled={!canUpdateSelected}
              onClick={() => void handleUpdateSelected()}
            />
            <IconButton
              icon="trash"
              title="Delete"
              size="small"
              disabled={!canDeleteSelected}
              onClick={() => void handleDeleteSelected()}
            />
            <IconButton
              icon="diff"
              title="Compare with Current"
              size="small"
              disabled={!compareTarget}
              onClick={() => {
                if (!compareTarget) return;
                const curRepo = currentRepo();
                const targetRepo =
                  compareTarget.repoRoots?.find((r) => r === curRepo) ??
                  compareTarget.repoRoots?.[0] ??
                  singleTargetRepo ??
                  undefined;
                void showCompareBranches(compareTarget.branch!.name, targetRepo);
              }}
            />
            <IconButton icon="search" title="Find" size="small" onClick={handleFind} />
            <IconButton
              icon="git-fetch"
              title="Fetch"
              size="small"
              onClick={() =>
                void executeAction(
                  "vcs.fetch",
                  multiRepo ? { repos: activeRoots } : singleTargetRepo ? { repo: singleTargetRepo } : undefined,
                )
              }
            />
            <IconButton
              icon="star"
              title="Show Only Favorites"
              size="small"
              pressed={onlyFavorites}
              onClick={() => setOnlyFavorites((v) => !v)}
            />
            <IconButton icon="locate" title="Select Current" size="small" onClick={handleSelectCurrent} />
            <IconButton
              icon="settings"
              title="Branch Settings"
              size="small"
              onClick={(e) =>
                menuBelow(e, [
                  {
                    label: "Manage Remotes…",
                    run: () => showManageRemotes(singleTargetRepo ?? undefined),
                  },
                  { kind: "separator" },
                  {
                    label: "Git Settings…",
                    run: () => void executeAction("file.settings", "vcs.git"),
                  },
                ])
              }
            />
            <div className={styles.branchesSideSep} role="separator" />
            <IconButton
              icon="expand-all"
              title="Expand All"
              size="small"
              onClick={() => setExpanded(new Set(branchGroupKeys(allRoots)))}
            />
            <IconButton
              icon="collapse-all"
              title="Collapse All"
              size="small"
              onClick={() => setExpanded(new Set())}
            />
          </>
        )}
      </div>
      {!collapsed && (
        <div ref={mainRef} className={styles.branchesMain}>
          <div className={styles.branchesBar} role="toolbar" aria-label={tx("Branches")}>
            <SearchField
              className={styles.branchSearch}
              value={query}
              onChange={setQuery}
              placeholder="Branch"
              aria-label="Filter branches"
            />
            <IconButton
              icon="refresh"
              title="Refresh"
              size="small"
              onClick={() => {
                void refreshNow();
                void loadBranches();
                loadAllBranches();
              }}
            />
          </div>
          <Tree<BranchTreeNode>
            key={root ?? ""}
            roots={roots}
            getKey={(n) => n.key}
            getLabel={(n) => (n.kind === "head" || n.kind === "group" ? tx(n.label) : n.label)}
            getChildren={(n) => n.children}
            isExpandable={(n) => !!n.children}
            expanded={searchExpanded ?? expanded}
            onExpandedChange={(next) => {
              if (!searchExpanded) setExpanded(next);
            }}
            getIcon={(n) =>
              n.kind === "head"
                ? "commit"
                : n.branch?.current
                  ? "current-branch"
                  : n.kind === "branch"
                    ? n.favorite
                      ? "star"
                      : "branch"
                    : "folder"
            }
            getDetail={branchDetail}
            selected={selected}
            onSelectionChange={(sel) => setSelected(sel)}
            onActivate={(n) => {
              // IDEA: double click (or Enter) switches the log to that ref, or to every
              // selected one when it is part of a multi-selection; checking out stays in the context menu.
              if (!n.ref) return;
              const sel = selected.has(n.key) ? refs.filter((r) => selected.has(r.key)).map((r) => r.ref) : [n.ref];
              setLogFilters({ branches: sel });
            }}
            onContextMenu={(n, _s, e) => {
              if (!n) return;
              if (n.key === "g:remote" || n.kind === "remote") {
                e.preventDefault();
                showContextMenu(e, [
                  {
                    label: "Manage Remotes…",
                    run: () => showManageRemotes(singleTargetRepo ?? undefined),
                  },
                ]);
                return;
              }
              if (n.key === "g:local") {
                e.preventDefault();
                showContextMenu(e, [{ label: "New Branch…", icon: "plus", run: handleNewBranch }]);
                return;
              }
              if (n.kind === "head") {
                e.preventDefault();
                showContextMenu(e, [
                  {
                    label: "Update",
                    icon: "git-pull",
                    run: () =>
                      void updateProject(multiRepo ? activeRoots : singleTargetRepo ? [singleTargetRepo] : {}),
                  },
                  { label: "New Branch…", icon: "plus", run: handleNewBranch },
                ]);
                return;
              }
              if (!n.branch) return;
              const singleRoot = multiRepo && n.repoRoots?.length === 1 ? n.repoRoots[0]! : null;
              const singleRootHead = singleRoot
                ? heads[singleRoot]
                  ? heads[singleRoot]!.head
                  : (byRepo[singleRoot]?.find((b) => !b.remote && b.current)?.name ?? null)
                : null;
              const items =
                multiRepo && n.repoRoots && n.repoRoots.length > 1
                  ? commonBranchMenu(
                      {
                        name: n.branch.name,
                        remote: n.branch.remote,
                        current: (n.currentRoots?.length ?? 0) === n.repoRoots.length,
                        favorite: !!n.favorite,
                      },
                      n.repoRoots,
                      undefined,
                      n.currentRoots ?? [],
                    )
                  : singleRoot
                    ? inRepo(singleRoot, branchMenu(n.branch, singleRootHead))
                    : singleTargetRepo
                      ? inRepo(singleTargetRepo, branchMenu(n.branch, current))
                      : branchMenu(n.branch, current);
              if (!items.length) return;
              e.preventDefault();
              showContextMenu(e, items);
            }}
            empty={
              query.trim() || onlyFavorites ? (
                <span className={styles.muted}>
                  <T>No matching branches</T>
                </span>
              ) : undefined
            }
            aria-label="Branches"
            className={styles.branchTree}
          />
        </div>
      )}
    </div>
  );
}

// --- filters ----------------------------------------------------------------

export const DAY = 86_400_000;
export const DATE_OPTIONS: { label: string; days: number }[] = [
  { label: "Last 24 Hours", days: 1 },
  { label: "Last 7 Days", days: 7 },
  { label: "Last 30 Days", days: 30 },
  { label: "Last Year", days: 365 },
];

export function menuBelow(e: ReactMouseEvent<HTMLElement>, items: MenuItem[]) {
  const r = e.currentTarget.getBoundingClientRect();
  showContextMenu({ x: r.left, y: r.bottom + 2 }, items);
}

export function FilterButton({
  label,
  value,
  onOpen,
  onClear,
}: {
  label: string;
  value: string | null;
  onOpen: (e: ReactMouseEvent<HTMLElement>) => void;
  onClear: () => void;
}) {
  return (
    <span className={clsx(styles.filterButton, value && styles.filterActive)}>
      <button type="button" className={styles.filterMain} onClick={onOpen} aria-haspopup="menu">
        {value ? (
          <>
            {tx(label)}: <span className={styles.filterValue}>{value}</span>
          </>
        ) : (
          tx(label)
        )}
        {!value && <Icon name="chevron-down" size={12} className={styles.filterChevron} />}
      </button>
      {value && (
        <button type="button" className={styles.filterClear} aria-label={tx`Clear ${tx(label)} filter`} onClick={onClear}>
          <Icon name="close" size={12} />
        </button>
      )}
    </span>
  );
}

export function FilterBar() {
  const filters = useGitLog((s) => s.filters);
  const commits = useGitLog((s) => s.commits);
  const branches = useVcs((s) => s.branches);
  const root = useVcs((s) => s.root);
  const roots = useVcs((s) => s.roots);
  const [text, setText] = useState(filters.text);
  const [pathsAnchor, setPathsAnchor] = useState<HTMLElement | null>(null);

  // Keep the field in sync when filters change elsewhere (Show History, reveal).
  const [seen, setSeen] = useState(filters);
  if (seen !== filters) {
    setSeen(filters);
    setText(filters.text);
  }

  useEffect(() => {
    if (text === filters.text) return;
    const t = setTimeout(() => setLogFilters({ text }), 300);
    return () => clearTimeout(t);
  }, [text, filters.text]);

  const only = (list: readonly string[], v: string) => list.length === 1 && list[0] === v;
  const branchNames = () => branches.filter((b) => !b.name.endsWith("/HEAD")).map((b) => b.name);

  const openBranch = (e: ReactMouseEvent<HTMLElement>) =>
    menuBelow(e, [
      {
        label: "HEAD (Current Branch)",
        checked: only(filters.branches, "HEAD"),
        run: () => setLogFilters({ branches: ["HEAD"] }),
      },
      { kind: "separator" },
      ...branchNames().map((name) => ({
        label: name,
        icon: "branch",
        checked: filters.branches.includes(name),
        run: () => setLogFilters({ branches: [name] }),
      })),
      { kind: "separator" },
      {
        label: "Select…",
        run: async () => {
          const r = await chooseMany({
            title: "Filter by Branch",
            options: ["HEAD", ...branchNames()],
            initial: filters.branches,
            customLabel: "Other revisions (comma-separated):",
          });
          if (r) setLogFilters({ branches: r });
        },
      },
    ]);

  const openUser = (e: ReactMouseEvent<HTMLElement>) => {
    const authors = [...new Set(commits.map((c) => c.author))].sort((a, b) => a.localeCompare(b)).slice(0, 30);
    menuBelow(e, [
      { label: ME, checked: filters.authors.includes(ME), run: () => setLogFilters({ authors: [ME] }) },
      ...(authors.length ? [{ kind: "separator" as const }] : []),
      ...authors.map((a) => ({
        label: a,
        checked: filters.authors.includes(a),
        run: () => setLogFilters({ authors: [a] }),
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
          if (r) setLogFilters({ authors: r });
        },
      },
    ]);
  };

  const openDate = (e: ReactMouseEvent<HTMLElement>) =>
    menuBelow(e, [
      ...DATE_OPTIONS.map((o) => ({
        label: o.label,
        checked: filters.date?.label === o.label,
        run: () => setLogFilters({ date: { after: Date.now() - o.days * DAY, before: null, label: o.label } }),
      })),
      { kind: "separator" },
      {
        label: "Select…",
        run: async () => {
          const r = await chooseDateRange();
          if (r) setLogFilters({ date: { ...r, label: dateRangeLabel(r.after, r.before) } });
        },
      },
    ]);

  const openPaths = (e: ReactMouseEvent<HTMLElement>) => {
    const target = e.currentTarget;
    setPathsAnchor((cur) => (cur ? null : target));
  };

  return (
    <div className={styles.filters} role="toolbar" aria-label={tx("Log filters")}>
      <SearchField
        className={styles.textFilter}
        value={text}
        onChange={setText}
        placeholder="Text or hash"
        aria-label="Filter by message"
        toggles={[
          {
            id: "regex",
            icon: "regex",
            title: "Regex",
            pressed: filters.regex,
            onToggle: (regex) => setLogFilters({ regex }),
          },
          {
            id: "case",
            icon: "case",
            title: "Match Case",
            pressed: filters.matchCase,
            onToggle: (matchCase) => setLogFilters({ matchCase }),
          },
        ]}
      />
      <FilterButton
        label="Branch"
        value={filters.branches.join(", ") || null}
        onOpen={openBranch}
        onClear={() => setLogFilters({ branches: [] })}
      />
      <FilterButton
        label="User"
        value={filters.authors.join(", ") || null}
        onOpen={openUser}
        onClear={() => setLogFilters({ authors: [] })}
      />
      <FilterButton
        label="Date"
        value={filters.date?.label ?? null}
        onOpen={openDate}
        onClear={() => setLogFilters({ date: null })}
      />
      <FilterButton
        label="Paths"
        value={pathsFilterLabel(filters, root, roots)}
        onOpen={openPaths}
        onClear={() => setLogFilters({ path: null, roots: [] })}
      />
      {pathsAnchor && (
        <PathsFilterPopup
          open
          anchor={pathsAnchor}
          filters={filters}
          root={root}
          roots={roots}
          onClose={() => setPathsAnchor(null)}
        />
      )}
      <span className={styles.grow} />
      <IconButton icon="refresh" title="Refresh" size="small" onClick={() => void reloadLog()} />
      <IconButton
        icon="sort"
        title="Graph Options"
        size="small"
        aria-haspopup="menu"
        onClick={(e) => menuBelow(e, graphOptionsMenu(useLogOptions.getState()))}
      />
      <IconButton
        icon="eye"
        title="View Options"
        size="small"
        aria-haspopup="menu"
        onClick={(e) => menuBelow(e, viewOptionsMenu(useLogOptions.getState()))}
      />
      <IconButton icon="search" title="Go to Hash/Branch/Tag" size="small" action="vcs.log.goToRef" />
    </div>
  );
}

/**
 * IDEA's Git Log › Paths filter popup:
 * - `Select…` (type/paste a path relative to project root)
 * - `Select in Tree…` (pick folders / roots in a tree dialog)
 * - `Roots` section with colored checkboxes for each repository in a multi-repo project
 * - `Press Delete to clear the filter` footer
 */
function PathsFilterPopup({
  open,
  anchor,
  filters,
  root,
  roots,
  onClose,
}: {
  open: boolean;
  anchor: HTMLElement | null;
  filters: LogFilters;
  root: string | null;
  roots: readonly string[];
  onClose: () => void;
}) {
  const showRoots =
    roots.length > 1 || (roots.length === 1 && roots[0] !== root) || filters.roots.length > 0;
  const totalItems = 2 + (showRoots ? roots.length : 0);
  const [active, setActive] = useState(0);

  const selectByPrompt = async () => {
    onClose();
    const cur =
      filters.path && root
        ? relTo(root, filters.path)
        : filters.path
          ? filters.path
          : filters.roots.length === 1 && root
            ? relTo(root, filters.roots[0]!)
            : (filters.roots[0] ?? "");
    const r = await promptText({ title: "Filter by Path", label: "File or folder", initial: cur, mono: true });
    if (!r) return;
    const v = r.value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
    if (!v) {
      setLogFilters({ path: null, roots: [] });
      return;
    }
    const full = v.startsWith("/") || /^[A-Za-z]:\//.test(v) || !root ? v : `${root}/${v}`;
    if (roots.includes(full)) {
      setLogFilters({ roots: [full], path: null });
    } else {
      setLogFilters({ path: full, roots: [] });
    }
  };

  const selectInTree = async () => {
    onClose();
    const choice = await choosePathInTree({
      projectRoot: root,
      roots,
      initialPath: filters.path,
      initialRoots: filters.roots,
    });
    if (choice) setLogFilters(choice);
  };

  const toggleRoot = (r: string) => {
    const nextRoots = filters.path ? [r] : toggleRootFilter(filters.roots, roots, r);
    setLogFilters({ roots: nextRoots, path: null });
  };

  const selectOnlyRoot = (r: string) => {
    setLogFilters({ roots: [r], path: null });
    onClose();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % totalItems);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + totalItems) % totalItems);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(totalItems - 1);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      setLogFilters({ path: null, roots: [] });
      onClose();
    } else if (e.key === " ") {
      e.preventDefault();
      if (active === 0) void selectByPrompt();
      else if (active === 1) void selectInTree();
      else if (showRoots && roots[active - 2]) toggleRoot(roots[active - 2]!);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (active === 0) void selectByPrompt();
      else if (active === 1) void selectInTree();
      else if (showRoots && roots[active - 2]) selectOnlyRoot(roots[active - 2]!);
    }
  };

  return (
    <Popup
      open={open}
      anchor={anchor}
      placement="bottom-start"
      offset={2}
      role="menu"
      aria-label={tx("Paths")}
      onClose={onClose}
      className={styles.pathsPopup}
    >
      <div className={styles.pathsMenu} tabIndex={-1} data-autofocus onKeyDown={onKeyDown}>
        <button
          type="button"
          role="menuitem"
          className={clsx(styles.pathsItem, active === 0 && styles.pathsItemActive)}
          onMouseEnter={() => setActive(0)}
          onClick={() => void selectByPrompt()}
        >
          <span className={styles.pathsItemText}>
            <T>Select…</T>
          </span>
        </button>
        <button
          type="button"
          role="menuitem"
          className={clsx(styles.pathsItem, active === 1 && styles.pathsItemActive)}
          onMouseEnter={() => setActive(1)}
          onClick={() => void selectInTree()}
        >
          <span className={styles.pathsItemText}>
            <T>Select in Tree…</T>
          </span>
        </button>
        {showRoots && (
          <>
            <div className={styles.pathsSection} role="presentation">
              <span className={styles.pathsSectionLabel}>
                <T>Roots</T>
              </span>
              <span className={styles.pathsSectionLine} />
            </div>
            <div className={styles.pathsRoots} role="group" aria-label={tx("Roots")}>
              {roots.map((r, idx) => {
                const itemIdx = idx + 2;
                const name = repoName(r);
                const checked = !filters.path && (filters.roots.length === 0 || filters.roots.includes(r));
                const color = `var(--project-color-${repoColorIndex(idx)})`;
                return (
                  <div
                    key={r}
                    role="menuitemcheckbox"
                    aria-checked={checked}
                    className={clsx(styles.pathsItem, active === itemIdx && styles.pathsItemActive)}
                    onMouseEnter={() => setActive(itemIdx)}
                    onClick={(e) => {
                      if (e.metaKey || e.ctrlKey) toggleRoot(r);
                      else selectOnlyRoot(r);
                    }}
                  >
                    <span
                      role="checkbox"
                      aria-checked={checked}
                      aria-label={tx`Toggle ${name}`}
                      className={clsx(styles.rootCheckbox, checked && styles.rootCheckboxChecked)}
                      style={{ "--root-color": color } as CSSProperties}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleRoot(r);
                      }}
                    >
                      {checked && <Icon name="check" size={10} className={styles.rootCheckboxMark} />}
                    </span>
                    <span className={styles.pathsItemText} title={r}>
                      {name}
                    </span>
                  </div>
                );
              })}
            </div>
          </>
        )}
        <div className={styles.pathsFooter}>
          <T>Press Delete to clear the filter</T>
        </div>
      </div>
    </Popup>
  );
}

const toggle = (label: string, o: LogOptions, key: keyof LogOptions): MenuItem => ({
  label,
  checked: !!o[key],
  run: () => updateLogOptions({ [key]: !o[key] }),
});

/** IDEA's Git Log › Graph Options (sort, first parent / no merges, linear branches). */
export function graphOptionsMenu(o: LogOptions): MenuItem[] {
  return [
    { kind: "header", label: "Sort" },
    { label: "By Commit Date", checked: o.sort === "date", run: () => updateLogOptions({ sort: "date" }) },
    { label: "Topologically", checked: o.sort === "topo", run: () => updateLogOptions({ sort: "topo" }) },
    { kind: "separator" },
    { kind: "header", label: "Options" },
    toggle("First Parent", o, "firstParent"),
    toggle("No Merges", o, "noMerges"),
    { kind: "separator" },
    { kind: "header", label: "Branch Actions" },
    {
      label: "Collapse Linear Branches",
      disabled: o.collapseLinear,
      run: () => updateLogOptions({ collapseLinear: true }),
    },
    {
      label: "Expand Linear Branches",
      disabled: !o.collapseLinear,
      run: () => updateLogOptions({ collapseLinear: false }),
    },
  ];
}

/** IDEA's Git Log › View Options (what rows show and highlight). */
export function viewOptionsMenu(o: LogOptions): MenuItem[] {
  return [
    { kind: "header", label: "Show" },
    toggle("Compact References View", o, "compactRefs"),
    toggle("Tag Names", o, "tagNames"),
    toggle("Long Edges", o, "longEdges"),
    toggle("Commit Timestamp", o, "commitTimestamp"),
    toggle("References on the Left", o, "refsOnLeft"),
    {
      label: "Columns",
      submenu: [toggle("Author", o, "showAuthor"), toggle("Date", o, "showDate"), toggle("Hash", o, "showHash")],
    },
    { kind: "separator" },
    { kind: "header", label: "Highlight" },
    toggle("My Commits", o, "highlightMine"),
    toggle("Merge Commits", o, "highlightMerges"),
    toggle("Current Branch", o, "highlightCurrentBranch"),
  ];
}

/** IDEA's Git Log commit context menu (Git.Log.ContextMenu); `selection` = all selected commits, newest first. */
export function commitMenu(c: Commit, selection: Commit[] = [c]): MenuItem[] {
  const many = selection.length > 1 && selection.some((x) => x.id === c.id);
  const head = useVcs.getState().branch?.head ?? null;
  const { outgoing } = useGitLog.getState();
  const pushed = (x: Commit) => !!outgoing && !outgoing.has(x.id);
  if (many) {
    const anyPushed = selection.some(pushed);
    return [
      { kind: "action", action: "vcs.log.copyRevision", arg: selection, label: "Copy Revision Numbers" },
      { kind: "action", action: "vcs.log.createPatch", arg: selection },
      { kind: "action", action: "vcs.log.cherryPick", arg: selection },
      ...(selection.length === 2
        ? [{ kind: "action", action: "vcs.log.compareVersions", arg: selection } satisfies MenuItem]
        : []),
      { kind: "separator" },
      { kind: "action", action: "vcs.log.revert", arg: selection, label: "Revert Commits" },
      { kind: "separator" },
      { kind: "action", action: "vcs.log.squashCommits", arg: selection, disabled: anyPushed },
      { kind: "action", action: "vcs.log.dropCommit", arg: selection, label: "Drop Commits", disabled: anyPushed },
    ];
  }
  const isPushed = pushed(c);
  // Without an upstream there is no outgoing set: allow pushing up to any commit of HEAD.
  const canPushHere = !!head && (outgoing ? outgoing.has(c.id) : true);
  return [
    { kind: "action", action: "vcs.log.copyRevision", arg: c },
    { label: "Copy Commit Message", run: () => void navigator.clipboard?.writeText(c.message) },
    { kind: "action", action: "vcs.log.createPatch", arg: c },
    { kind: "action", action: "vcs.log.cherryPick", arg: c },
    { kind: "separator" },
    { kind: "action", action: "vcs.log.checkoutRevision", arg: c },
    { kind: "action", action: "vcs.log.compareWithLocal", arg: c },
    { kind: "separator" },
    { kind: "action", action: "vcs.log.resetToHere", arg: c },
    { kind: "action", action: "vcs.log.revert", arg: c },
    { kind: "action", action: "vcs.log.undoCommit", arg: c },
    { kind: "separator" },
    { kind: "action", action: "vcs.log.editMessage", arg: c, disabled: isPushed },
    { kind: "action", action: "vcs.log.fixup", arg: c, disabled: isPushed },
    { kind: "action", action: "vcs.log.squashInto", arg: c, disabled: isPushed },
    { kind: "action", action: "vcs.log.dropCommit", arg: c, disabled: isPushed },
    { kind: "action", action: "vcs.log.interactiveRebase", arg: c, disabled: isPushed },
    { kind: "action", action: "vcs.log.pushUpToHere", arg: c, disabled: !canPushHere },
    { kind: "separator" },
    {
      kind: "action",
      action: "vcs.log.rebaseOntoCommit",
      arg: c,
      label: tx`Rebase '${head ?? "HEAD"}' onto Selected Commit`,
      disabled: !head,
    },
    { kind: "action", action: "vcs.log.newBranch", arg: c },
    { kind: "action", action: "vcs.log.newTag", arg: c },
    { kind: "separator" },
    { kind: "action", action: "vcs.log.goToChild", arg: c },
    { kind: "action", action: "vcs.log.goToParent", arg: c, disabled: !c.parents.length },
    { kind: "separator" },
    { kind: "action", action: "vcs.log.openInBrowser", arg: c },
  ];
}

function CommitList() {
  const all = useGitLog((s) => s.commits);
  const allRows = useGitLog((s) => s.rows);
  const opts = useLogOptions();
  const user = useGitLog((s) => s.user);
  const headCommit = useVcs((s) => s.branch?.headCommit ?? null);
  const roots = useVcs((s) => s.roots);
  const heads = useVcs((s) => s.heads);
  const branches = useVcs((s) => s.branches);
  const multiRepo = roots.length > 1;
  const remoteNames = useMemo(() => new Set(branches.filter((b) => b.remote).map((b) => b.name)), [branches]);
  const headSet = useMemo(() => {
    const set = new Set<string>();
    if (headCommit) set.add(headCommit);
    for (const h of Object.values(heads)) {
      if (h.headCommit) set.add(h.headCommit);
    }
    return set;
  }, [headCommit, heads]);
  // Date, No Merges and First Parent are applied by the backend with parent rewriting,
  // so the graph stays connected under them.
  const collapsed = useMemo(
    () => (opts.collapseLinear ? collapseLinear(all, headSet) : null),
    [all, opts.collapseLinear, headSet],
  );
  const commits = collapsed ? collapsed.commits : all;
  const rows = useMemo(() => {
    const hasMultiRepo = collapsed && new Set(collapsed.graph.map((g) => g.repo ?? "")).size > 1;
    const laid = collapsed
      ? hasMultiRepo
        ? computeMultiRepoGraph(collapsed.graph, roots)
        : computeGraph(collapsed.graph).rows
      : allRows;
    return opts.longEdges ? laid : hideLongEdges(laid);
  }, [collapsed, allRows, opts.longEdges, roots]);
  const onBranch = useMemo(() => {
    if (!opts.highlightCurrentBranch) return null;
    const reach = reachableFrom(all, headCommit);
    // Nothing to tell apart when only the current branch is shown.
    return all.every((c) => reach.has(c.id)) ? null : reach;
  }, [all, headCommit, opts.highlightCurrentBranch]);
  const loading = useGitLog((s) => s.loading);
  const done = useGitLog((s) => s.done);
  const error = useGitLog((s) => s.error);
  const selected = useGitLog((s) => s.selected);
  const selectedRepo = useGitLog((s) => s.selectedRepo);
  const selection = useGitLog((s) => s.selection);
  const selectedSet = useMemo(() => new Set(selection), [selection]);
  const revealTick = useGitLog((s) => s.revealTick);
  const scrollRef = useRef<HTMLDivElement>(null);
  const finished = done;
  const virtualizer = useVirtualizer({
    count: commits.length + (finished ? 0 : 1),
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW,
    overscan: 20,
  });
  const items = virtualizer.getVirtualItems();
  const last = items[items.length - 1];

  useEffect(() => {
    if (!finished && !loading && last && last.index >= commits.length - 40) void loadMore();
  }, [last, commits.length, finished, loading]);

  const selectedIndex = selected
    ? commits.findIndex((c) => c.id === selected && (!selectedRepo || !c.repo || c.repo === selectedRepo))
    : -1;
  useLayoutEffect(() => {
    if (selectedIndex >= 0) virtualizer.scrollToIndex(selectedIndex, { align: "center" });
    // Only on explicit reveal requests.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealTick]);

  const visible = useRef(commits);
  visible.current = commits;
  const pick = useCallback((id: string, repo: string | undefined, e: ReactMouseEvent) => {
    if (e.button === 2) {
      if (!useGitLog.getState().selection.includes(id)) selectCommit(id, false, repo);
    } else if (e.button !== 0) return;
    else if (e.shiftKey) extendCommitSelection(id, visible.current, repo);
    else if (e.metaKey || e.ctrlKey) toggleCommitSelection(id, repo);
    else selectCommit(id, false, repo);
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    const lead = selectedIndex >= 0 ? commits[selectedIndex] : undefined;
    if (lead && (e.key === "ArrowLeft" || e.key === "ArrowRight") && !e.altKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      if (e.key === "ArrowLeft") goToChild(lead);
      else void goToParent(lead);
      return;
    }
    let next: number;
    if (e.key === "ArrowDown") next = Math.min(commits.length - 1, selectedIndex + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, selectedIndex - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = commits.length - 1;
    else if (e.key === "PageDown") next = Math.min(commits.length - 1, selectedIndex + 20);
    else if (e.key === "PageUp") next = Math.max(0, selectedIndex - 20);
    else return;
    e.preventDefault();
    const c = commits[next];
    if (c) {
      if (e.shiftKey) extendCommitSelection(c.id, commits, c.repo);
      else selectCommit(c.id, false, c.repo);
      virtualizer.scrollToIndex(next, { align: "auto" });
    }
  };

  if (error && !commits.length) return <div className={styles.message}>{error}</div>;

  return (
    <div className={styles.listWrap}>
      <div
        ref={scrollRef}
        className={styles.list}
        role="listbox"
        aria-label={tx("Commits")}
        aria-multiselectable
        aria-activedescendant={selectedIndex >= 0 ? `commit-${selectedIndex}` : undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        {!commits.length && !loading && finished && (
          <div className={styles.message}>
            {headSet.size > 0 ? tx("No commits match the filters") : tx("No commits yet")}
          </div>
        )}
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {items.map((v) => {
            const c = commits[v.index];
            if (!c)
              return (
                <div key="loading" className={styles.row} style={{ transform: `translateY(${v.start}px)` }}>
                  <Spinner size={12} />{" "}
                  <span className={styles.muted}>
                    <T>Loading…</T>
                  </span>
                </div>
              );
            const repoIdx = multiRepo && c.repo ? roots.indexOf(c.repo) : -1;
            const repoColor = repoIdx >= 0 ? repoColorIndex(repoIdx) : null;
            const repoTitle = multiRepo && c.repo ? repoName(c.repo) : undefined;
            const isHead = c.repo && heads[c.repo] ? c.id === heads[c.repo]!.headCommit : c.id === headCommit;
            const isSelected =
              selectedSet.has(c.id) &&
              (selection.length > 1 || !selectedRepo || !c.repo || c.repo === selectedRepo);
            return (
              <CommitRow
                key={c.repo ? `${c.repo}:${c.id}` : c.id}
                id={`commit-${v.index}`}
                commit={c}
                graph={rows[v.index]}
                top={v.start}
                selected={isSelected}
                head={isHead}
                mine={opts.highlightMine && isMine(c, user)}
                onBranch={!!onBranch?.has(c.id)}
                opts={opts}
                remoteNames={remoteNames}
                repoColor={repoColor}
                repoTitle={repoTitle}
                onPick={pick}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

const CommitRow = memo(function CommitRow({
  id,
  commit: c,
  graph,
  top,
  selected,
  head,
  mine,
  onBranch,
  opts,
  remoteNames,
  repoColor,
  repoTitle,
  onPick,
}: {
  id: string;
  commit: LogCommit;
  graph: GraphRow | undefined;
  top: number;
  selected: boolean;
  head: boolean;
  mine: boolean;
  onBranch: boolean;
  opts: LogOptions;
  remoteNames: ReadonlySet<string>;
  repoColor: number | null;
  repoTitle?: string;
  onPick: (id: string, repo: string | undefined, e: ReactMouseEvent) => void;
}) {
  const merge = opts.highlightMerges && c.parents.length > 1;
  const refs = c.refs.length > 0 && (
    <RefLabels
      refs={c.refs}
      compact={opts.compactRefs}
      tagNames={opts.tagNames}
      remoteNames={remoteNames}
      left={opts.refsOnLeft}
    />
  );
  const time = opts.commitTimestamp ? (c.commitTimeMs ?? c.timeMs) : c.timeMs;
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      className={clsx(
        styles.row,
        repoColor !== null && styles.rowMultiRepo,
        onBranch && styles.currentBranch,
        selected && styles.selected,
      )}
      style={{ transform: `translateY(${top}px)` }}
      onMouseDown={(e) => {
        if (e.shiftKey) e.preventDefault(); // no text selection on range clicks
        onPick(c.id, c.repo, e);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        showContextMenu(e, commitMenu(c, selectedCommits()));
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
        {graph && <GraphCell row={graph} head={head} />}
        {opts.refsOnLeft && refs}
        <span
          className={clsx(styles.subject, head && styles.headSubject, merge && styles.mergeSubject)}
          title={c.message}
        >
          {c.summary}
        </span>
        {!opts.refsOnLeft && refs}
      </span>
      {opts.showAuthor && (
        <span className={clsx(styles.colAuthor, styles.muted, mine && styles.mine)} title={`${c.author} <${c.email}>`}>
          {c.author}
        </span>
      )}
      {opts.showDate && <span className={clsx(styles.colDate, styles.muted)}>{formatTime(time)}</span>}
      {opts.showHash && <span className={clsx(styles.colHash, styles.muted, styles.hash)}>{c.shortId}</span>}
    </div>
  );
});

function x(lane: number) {
  return LANE / 2 + lane * LANE;
}

function seg(fromX: number, fromY: number, toX: number, toY: number) {
  if (fromX === toX) return `M${fromX} ${fromY}L${toX} ${toY}`;
  const mid = (fromY + toY) / 2;
  return `M${fromX} ${fromY}C${fromX} ${mid} ${toX} ${mid} ${toX} ${toY}`;
}

export function GraphCell({ row, head }: { row: GraphRow; head?: boolean }) {
  const width = Math.min(row.width, 24) * LANE;
  const cy = ROW / 2;
  return (
    <svg className={styles.graph} width={width} height={ROW} aria-hidden>
      {row.up.map((s, i) => (
        <path
          key={`u${i}`}
          d={seg(x(s.from), 0, x(s.to), cy) + (s.arrow ? arrowHead(x(s.from), 0, -1) : "")}
          stroke={laneColor(s.color)}
          strokeDasharray={s.dashed ? "2 2" : undefined}
        />
      ))}
      {row.down.map((s, i) => (
        <path
          key={`d${i}`}
          d={seg(x(s.from), cy, x(s.to), ROW) + (s.arrow ? arrowHead(x(s.to), ROW, 1) : "")}
          stroke={laneColor(s.color)}
          strokeDasharray={s.dashed ? "2 2" : undefined}
        />
      ))}
      <circle
        cx={x(row.lane)}
        cy={cy}
        r={head ? 4 : 3.2}
        fill={head ? "var(--bg-app)" : laneColor(row.color)}
        stroke={laneColor(row.color)}
        strokeWidth={head ? 2 : 0}
      />
    </svg>
  );
}

/** Arrow head at (`px`, `py`) pointing up (`dir` -1) or down (1): a long edge continues. */
function arrowHead(px: number, py: number, dir: 1 | -1) {
  const back = py - dir * 4;
  return `M${px - 3} ${back}L${px} ${py}L${px + 3} ${back}`;
}

const REF_KIND_CLASS = {
  head: styles.refHead,
  local: styles.refLocal,
  remote: styles.refRemote,
  tag: styles.refTag,
};

const NO_REMOTES: ReadonlySet<string> = new Set();

export function RefLabels({
  refs,
  compact = false,
  tagNames = true,
  remoteNames = NO_REMOTES,
  left = false,
}: {
  refs: string[];
  compact?: boolean;
  tagNames?: boolean;
  remoteNames?: ReadonlySet<string>;
  left?: boolean;
}) {
  const labels = refLabels(refs, { compact, tagNames }, remoteNames);
  return (
    <span className={clsx(styles.refs, left && styles.refsLeft)}>
      {labels.map((l) => (
        <span key={`${l.kind}:${l.title}`} className={clsx(styles.ref, REF_KIND_CLASS[l.kind])} title={l.title}>
          {l.text}
        </span>
      ))}
    </span>
  );
}

type DetailFile = (ChangedFile | RevisionChange) & { _repo?: string | null };

/**
 * The selected commits' changes: one commit's files against its first parent, or, for several
 * (IDEA), their combined changes with every selected commit listed below.
 */
export function CommitDetails({ commits }: { commits: LogCommit[] }) {
  const selected = useGitLog((s) => s.selected);
  const selectedRepo = useGitLog((s) => s.selectedRepo);
  const selection = useGitLog((s) => s.selection);
  // Newest first (log order).
  const chosen = useMemo(() => {
    const ids = new Set(selection);
    return commits.filter(
      (c) => ids.has(c.id) && (selection.length > 1 || !selectedRepo || !c.repo || c.repo === selectedRepo),
    );
  }, [commits, selection, selectedRepo]);
  const commit = selected
    ? (commits.find((c) => c.id === selected && (!selectedRepo || !c.repo || c.repo === selectedRepo)) ??
      commits.find((c) => c.id === selected))
    : undefined;
  const many = chosen.length > 1;
  const root = useVcs((s) => s.root) ?? "";
  const commitRepo = commit?.repo ?? currentRepo();
  const repoGroups = useMemo(() => {
    const groups = new Map<string | null, LogCommit[]>();
    for (const c of chosen) {
      const r = c.repo ?? currentRepo();
      const list = groups.get(r) ?? [];
      list.push(c);
      groups.set(r, list);
    }
    return groups;
  }, [chosen]);
  const multiRepoSelection = repoGroups.size > 1;
  const detailRoot = multiRepoSelection ? root : (commit?.repo ?? root);
  const idsKey = many
    ? chosen.map((c) => (c.repo ? `${c.repo}:${c.id}` : c.id)).join(" ")
    : commit
      ? (commit.repo ? `${commit.repo}:${commit.id}` : commit.id)
      : "";
  const [files, setFiles] = useState<DetailFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string> | null>(null);

  useEffect(() => {
    if (!idsKey) return;
    let alive = true;
    const load: Promise<DetailFile[]> = multiRepoSelection
      ? Promise.all(
          [...repoGroups.entries()].map(async ([repo, list]) => {
            const ids = list.map((c) => c.id).reverse();
            const changes = await call(commands.vcsCommitsChanges(repo, ids));
            return changes.map((f) => ({ ...f, _repo: repo }));
          }),
        ).then((batches) => batches.flat())
      : many
        ? call(commands.vcsCommitsChanges(commitRepo, chosen.map((c) => c.id).reverse()))
        : call(commands.vcsCommitFiles(commitRepo, commit!.id));
    load.then((f) => alive && setFiles(f)).catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [idsKey, commitRepo, multiRepoSelection, many, repoGroups, chosen, commit]);

  const tree = useMemo(
    () =>
      buildFileTree(files ?? [], (f) => {
        const d = f as DetailFile;
        if (multiRepoSelection && d._repo) return relTo(detailRoot, `${d._repo}/${d.path}`);
        return relTo(detailRoot, d.path);
      }),
    [files, detailRoot, multiRepoSelection],
  );
  const allDirs = useMemo(() => dirKeys(tree), [tree]);

  if (!commit)
    return (
      <div className={styles.details}>
        <EmptyState>
          <T>Select a commit to view changes</T>
        </EmptyState>
      </div>
    );

  const open = (f: DetailFile) => {
    const all = files ?? [f];
    void openDiff(
      withChain(
        all.map((x) =>
          many
            ? revisionChangeDiffData(x as RevisionChange, x._repo ?? commit?.repo)
            : commitFileDiffData(commit, x),
        ),
        Math.max(0, all.indexOf(f)),
      ),
    );
  };

  return (
    <div className={styles.details}>
      <SplitGroup orientation="vertical" id="git-log-details">
        <SplitPanel id="files" defaultSize="60%" minSize="60px">
          <div className={styles.filesPane}>
            <div className={styles.detailsBar} role="toolbar" aria-label={tx("Changed files")}>
              <span className={styles.detailsCount}>
                {files ? fileCount(files.length) : ""}
                {many ? " " + tx`in ${chosen.length} commits` : ""}
              </span>
              <span className={styles.grow} />
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
            {error && <div className={styles.message}>{error}</div>}
            {!files && !error && (
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
                onActivate={(n) => n.file && open(n.file)}
                onContextMenu={(n, _sel, e) => {
                  if (!n?.file) return;
                  e.preventDefault();
                  const file = n.file as DetailFile;
                  const fileRepo = file._repo ?? commit.repo ?? root;
                  const normPath = file.path.replace(/\\/g, "/");
                  const absPath =
                    normPath.startsWith("/") || /^[A-Za-z]:\//.test(normPath) || !fileRepo
                      ? file.path
                      : `${fileRepo.replace(/\/+$/, "")}/${normPath}`;
                  showContextMenu(e, [
                    {
                      label: "Show Diff",
                      icon: "diff",
                      run: () => open(file),
                    },
                    {
                      label: "Show History",
                      icon: "history",
                      run: () => {
                        openFileHistory(absPath);
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
        <SplitPanel id="message" minSize="60px">
          <div className={styles.messageBox}>
            {many ? (
              chosen.map((c) => <CommitMessage key={c.repo ? `${c.repo}:${c.id}` : c.id} commit={c} compact />)
            ) : (
              <CommitMessage commit={commit} />
            )}
          </div>
        </SplitPanel>
      </SplitGroup>
    </div>
  );
}

/** A commit's message and metadata; `compact` (one of several selected): without the body. */
export function CommitMessage({ commit, compact = false }: { commit: Commit; compact?: boolean }) {
  const [subject, ...bodyLines] = commit.message.replace(/\s+$/, "").split("\n");
  const body = compact ? "" : bodyLines.join("\n").replace(/^\n+/, "");
  return (
    <div className={clsx(compact && styles.commitEntry)}>
      <div className={styles.subjectLine}>
        <IssueText text={subject ?? ""} />
      </div>
      {body && (
        <div className={styles.fullMessage}>
          <IssueText text={body} />
        </div>
      )}
      <div className={clsx(styles.meta, compact && styles.metaCompact)}>
        <button
          type="button"
          className={clsx(styles.linkButton, styles.hash)}
          title={tx("Copy revision number")}
          onClick={() => void navigator.clipboard?.writeText(commit.id)}
        >
          {commit.shortId}
        </button>{" "}
        {commit.author} &lt;{commit.email}&gt;
        {commit.timeMs ? " " + tx`on ${new Date(commit.timeMs).toLocaleString()}` : ""}
      </div>
      {commit.parents.length > 1 && (
        <div className={styles.meta}>{tx`Merge of ${commit.parents.map((p) => p.slice(0, 8)).join(", ")}`}</div>
      )}
      {commit.refs.length > 0 && (
        <div className={styles.meta}>
          <RefLabels refs={commit.refs} />
        </div>
      )}
    </div>
  );
}

export function ChangedFileRow({ node }: { node: FileTreeNode<ChangedFile> }) {
  if (!node.file)
    return (
      <span className={styles.fileRow}>
        <Icon name="folder" size={16} className={styles.fileIcon} />
        <span className={styles.fileName}>{node.name}</span>
        <span className={styles.fileDir}>{fileCount(node.count)}</span>
      </span>
    );
  const f = node.file;
  const kind: EffectiveKind = f.kind === "untracked" ? "added" : f.kind;
  return (
    <span className={styles.fileRow} title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
      <Icon name={fileIconName(node.name)} size={16} className={styles.fileIcon} />
      <span className={styles.fileName} style={{ color: KIND_COLOR[kind] }}>
        {node.name}
      </span>
      {f.oldPath && <span className={styles.fileDir}>{tx`renamed from ${baseName(f.oldPath)}`}</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Console

function ConsoleView() {
  const lines = useVcsConsole((s) => s.lines);
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);
  return (
    <div className={styles.consoleWrap}>
      <div className={styles.consoleBar}>
        <IconButton icon="trash" title="Clear All" size="small" onClick={clearConsole} />
      </div>
      <div
        ref={ref}
        className={styles.console}
        role="log"
        aria-label={tx("Git console")}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
        }}
      >
        {!lines.length && (
          <div className={styles.muted}>
            <T>Git commands run by the IDE appear here.</T>
          </div>
        )}
        {lines.map((l) => (
          <div key={l.id} className={clsx(styles.line, styles[`line-${l.kind}`])}>
            {l.kind === "cmd" && (
              <span className={styles.time}>{new Date(l.time).toLocaleTimeString(undefined, { hour12: false })} </span>
            )}
            {l.text}
          </div>
        ))}
      </div>
    </div>
  );
}
