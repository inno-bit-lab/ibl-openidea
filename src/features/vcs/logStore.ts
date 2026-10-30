/** Git log tool window state: filters, paged commits, graph, selection. */
import { create } from "zustand";
import type { Branch, BranchInfo, Commit } from "@/bindings";
import { call, commands } from "@/platform/ipc";
import { workflowSettings } from "@/platform/workflowSettings";
import {
  collapseLinear,
  computeGraph,
  computeMultiRepoGraph,
  emptyGraphState,
  type GraphRow,
  type GraphState,
} from "./graph";
import { logOptions, setLogOptions, type LogOptions } from "./logOptions";
import { relTo, repoLabel, stripSlash } from "./model";
import { clearConsole, errorMessage } from "./ops";
import { currentRepo, selectRepo, useVcs } from "./store";

export type LogCommit = Commit & { repo?: string };

/** Date filter: commits made (committer time) after / before the given times (epoch ms). */
export interface LogDateFilter {
  after: number | null;
  before: number | null;
  label: string;
}

/** User filter entry standing for the current Git user (`user.name` / `user.email`). */
export const ME = "me";

export interface LogFilters {
  /** Branches / revisions to show; empty = all. */
  branches: string[];
  /** Author names or emails (any matches); `ME` = the current user. */
  authors: string[];
  text: string;
  /** `text` is a regular expression / matches case-sensitively. */
  regex: boolean;
  matchCase: boolean;
  /** Absolute path (file or directory). */
  path: string | null;
  /** Repository roots to show (Paths › Roots); empty = all repositories. */
  roots: string[];
  date: LogDateFilter | null;
}

export interface FileHistoryTab {
  /** Tab id (`history:<path>`). */
  id: string;
  /** Absolute path of the file. */
  path: string;
  /** Enclosing repository root for this file. */
  repo: string | null;
  /** Branch filter (`"HEAD"` by default, `null` for all branches). */
  branch: string | null;
}

interface LogState {
  filters: LogFilters;
  commits: LogCommit[];
  rows: GraphRow[];
  graph: GraphState;
  loading: boolean;
  done: boolean;
  error: string | null;
  /** Lead selection. */
  selected: string | null;
  /** Repository of the lead selection when disambiguating identical SHAs across clones. */
  selectedRepo?: string | null;
  /** Every selected commit id (includes `selected`), in selection order. */
  selection: string[];
  /** Commits of HEAD not on its upstream (`@{u}..HEAD`); null without an upstream. */
  outgoing: Set<string> | null;
  tab: "log" | "console" | string;
  /** Open `History: <filename>` tabs in the Git tool window. */
  historyTabs: FileHistoryTab[];
  /** Bumped to ask the list to scroll the selection into view. */
  revealTick: number;
  /** The current user (`user.email`, else `user.name`), for View Options › Highlight › My Commits. */
  user: string | null;
  generation: number;
}

export const PAGE = 300;

export const emptyFilters = (): LogFilters => ({
  branches: [],
  authors: [],
  text: "",
  regex: false,
  matchCase: false,
  path: null,
  roots: [],
  date: null,
});

/** Any filter other than the text field's toggles is set. */
export function hasFilters(f: LogFilters): boolean {
  return !!(f.branches.length || f.authors.length || f.text || f.path || f.roots?.length || f.date);
}

/** The innermost repository root containing `path` (including when `path` is itself a nested repository root). */
export function logRepoOf(path: string, roots: readonly string[] = useVcs.getState().roots): string | null {
  const p = stripSlash(path);
  let best: string | null = null;
  for (const r of roots) {
    if ((p === r || p.startsWith(`${r}/`)) && (!best || r.length > best.length)) best = r;
  }
  return best;
}

export interface LogTarget {
  repo: string | null;
  path: string | null;
}

/** Repositories and per-repository path filters the log should query. */
export function resolveLogTargets(
  roots: readonly string[] = useVcs.getState().roots,
  selectedRepo: string | null = currentRepo(),
  filters: Pick<LogFilters, "path" | "roots"> = useGitLog.getState().filters,
): LogTarget[] {
  if (!roots.length) return [{ repo: selectedRepo, path: filters.path }];
  const filterRoots = filters.roots ?? [];
  const chosen = filterRoots.length ? roots.filter((r) => filterRoots.includes(r)) : roots;
  const allowed = chosen.length ? chosen : roots;
  if (!filters.path) return allowed.map((repo) => ({ repo, path: null }));
  const p = stripSlash(filters.path);
  const inside = allowed.filter((r) => r === p || r.startsWith(`${p}/`));
  const enclosing = logRepoOf(p, roots);
  const out: LogTarget[] = inside.map((repo) => ({ repo, path: null }));
  if (enclosing && enclosing !== p && allowed.includes(enclosing) && !inside.includes(enclosing)) {
    out.push({ repo: enclosing, path: filters.path });
  }
  return out;
}

/** Display value of the Paths filter button (`Paths: chb, ecs`, `Paths: src/app`), or null when unfiltered. */
export function pathsFilterLabel(
  filters: Pick<LogFilters, "path" | "roots">,
  projectRoot: string | null,
  allRoots: readonly string[] = [],
): string | null {
  const parts: string[] = [];
  const filterRoots = filters.roots ?? [];
  if (filterRoots.length && (!allRoots.length || filterRoots.length < allRoots.length)) {
    for (const r of filterRoots) parts.push(repoLabel(r, projectRoot));
  }
  if (filters.path) {
    parts.push((projectRoot ? relTo(projectRoot, filters.path) : filters.path) || ".");
  }
  return parts.length ? parts.join(", ") : null;
}

/** Toggles `target` in the Roots filter; returns `[]` when all (or no) roots are selected. */
export function toggleRootFilter(
  currentRoots: readonly string[],
  allRoots: readonly string[],
  target: string,
): string[] {
  const set = new Set(currentRoots.length ? currentRoots : allRoots);
  if (!set.delete(target)) set.add(target);
  if (set.size === 0 || set.size >= allRoots.length) return [];
  return allRoots.filter((r) => set.has(r));
}

/** `ME` replaced by the current user's email (or name); duplicates and blanks dropped. */
export function resolveAuthors(authors: readonly string[], me: string | null): string[] {
  const out = authors.map((a) => (a === ME ? (me ?? "") : a).trim()).filter(Boolean);
  return [...new Set(out)];
}

/** The commit's time falls inside the date filter. */
export function inDateRange(timeMs: number, d: LogDateFilter | null): boolean {
  if (!d) return true;
  return (d.after == null || timeMs >= d.after) && (d.before == null || timeMs < d.before);
}

/** Label of a custom date range: `after 2024-01-01`, `until …`, or `a – b` (`before` is exclusive). */
export function dateRangeLabel(after: number | null, before: number | null): string {
  const day = (ms: number) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const lastDay = (ms: number) => day(new Date(ms).setDate(new Date(ms).getDate() - 1));
  if (after != null && before != null) return `${day(after)} – ${lastDay(before)}`;
  if (after != null) return `after ${day(after)}`;
  if (before != null) return `until ${lastDay(before)}`;
  return "";
}

let me: { repo: string | null; value: Promise<string | null> } | null = null;

/** The current Git user for the "me" filter: `user.email`, else `user.name`. */
function currentUser(): Promise<string | null> {
  const repo = currentRepo();
  if (me?.repo !== repo) {
    const get = (key: string) => call(commands.vcsConfigGet(repo, key)).catch(() => null);
    me = { repo, value: get("user.email").then(async (email) => email || (await get("user.name"))) };
  }
  return me.value;
}

const initialLog = (): Omit<LogState, "generation"> => ({
  filters: emptyFilters(),
  commits: [],
  rows: [],
  graph: emptyGraphState(),
  loading: false,
  done: false,
  error: null,
  selected: null,
  selectedRepo: null,
  selection: [],
  outgoing: null,
  tab: "log",
  historyTabs: [],
  revealTick: 0,
  user: null,
});

export const useGitLog = create<LogState>(() => ({ ...initialLog(), generation: 0 }));

/** Opens or activates a `History: <filename>` tab in the Git tool window. */
export function openFileHistory(path: string, branch: string | null = "HEAD"): FileHistoryTab {
  const clean = stripSlash(path);
  const id = `history:${clean}`;
  const repo = logRepoOf(clean) ?? currentRepo();
  const entry: FileHistoryTab = { id, path: clean, repo, branch };
  useGitLog.setState((s) => {
    const exists = s.historyTabs.some((t) => t.id === id);
    const historyTabs = exists
      ? s.historyTabs.map((t) => (t.id === id ? { ...t, repo, ...(branch !== undefined ? { branch } : {}) } : t))
      : [...s.historyTabs, entry];
    return { historyTabs, tab: id };
  });
  return entry;
}

/** Closes a `History: <filename>` tab in the Git tool window. */
export function closeFileHistory(id: string) {
  useGitLog.setState((s) => {
    const idx = s.historyTabs.findIndex((t) => t.id === id);
    if (idx < 0) return s;
    const historyTabs = s.historyTabs.filter((t) => t.id !== id);
    if (s.tab !== id) return { historyTabs };
    const fallback = historyTabs[Math.min(idx, historyTabs.length - 1)]?.id ?? "log";
    return { historyTabs, tab: fallback };
  });
}

/** Updates the branch filter of an open `History: <filename>` tab. */
export function setFileHistoryBranch(id: string, branch: string | null) {
  useGitLog.setState((s) => ({
    historyTabs: s.historyTabs.map((t) => (t.id === id ? { ...t, branch } : t)),
  }));
}

interface RepoCursor {
  repo: string;
  path: string | null;
  skipped: number;
  buffer: LogCommit[];
  done: boolean;
}

let loadPromise: Promise<void> | null = null;
let repoCursors = new Map<string, RepoCursor>();

/**
 * Another project (the window switched projects): forget its commits, filters, selection
 * and console. Another repository of the project selected: show its log.
 */
export function installGitLog(): () => void {
  return useVcs.subscribe((s, prev) => {
    if (s.root !== prev.root) {
      loadPromise = null;
      repoCursors = new Map();
      useGitLog.setState((l) => ({
        ...initialLog(),
        tab: l.tab === "console" ? "console" : "log",
        generation: l.generation + 1,
      }));
      clearConsole();
    } else if (s.roots.join("\n") !== prev.roots.join("\n")) {
      const l = useGitLog.getState();
      const validRoots = (l.filters.roots ?? []).filter((r) => s.roots.includes(r));
      if (validRoots.length !== (l.filters.roots ?? []).length) {
        useGitLog.setState((st) => ({ filters: { ...st.filters, roots: validRoots } }));
      }
      if (l.generation > 0) void reloadLog();
    } else if (s.roots.length <= 1 && s.repo !== prev.repo && prev.repo !== null) {
      const l = useGitLog.getState();
      if (l.generation === 0 && !l.filters.path) return;
      const { path } = useGitLog.getState().filters;
      // A path filter belongs to the repository it is in.
      if (path && logRepoOf(path, s.roots) !== s.repo)
        useGitLog.setState((st) => ({ filters: { ...st.filters, path: null } }));
      void reloadLog();
    }
  });
}

export function setLogFilters(patch: Partial<LogFilters>) {
  useGitLog.setState((s) => ({ filters: { ...s.filters, ...patch } }));
  const { roots, repo: selectedRepo } = useVcs.getState();
  const targets = resolveLogTargets(roots, selectedRepo, useGitLog.getState().filters);
  const targetRepo =
    targets.length === 1
      ? targets[0]!.repo
      : targets.length > 1 && !targets.some((t) => t.repo === selectedRepo)
        ? targets[0]!.repo
        : null;
  if (targetRepo && targetRepo !== selectedRepo) {
    void selectRepo(targetRepo);
    if (roots.length > 1 || selectedRepo === null) void reloadLog();
  } else {
    void reloadLog();
  }
}

/** Drops loaded commits and loads the first page. */
export function reloadLog(): Promise<void> {
  useGitLog.setState((s) => ({
    commits: [],
    rows: [],
    graph: emptyGraphState(),
    done: false,
    error: null,
    generation: s.generation + 1,
  }));
  loadPromise = null;
  repoCursors = new Map();
  void loadOutgoing();
  void currentUser().then((user) => useGitLog.setState({ user }));
  return loadMore();
}

async function loadOutgoing() {
  const upstream = useVcs.getState().branch?.upstream;
  if (!upstream) return useGitLog.setState({ outgoing: null });
  try {
    const commits = await call(
      commands.vcsLog(currentRepo(), {
        branch: "HEAD",
        path: null,
        author: null,
        text: null,
        range: "@{u}..HEAD",
        skip: 0,
        limit: 0,
      }),
    );
    useGitLog.setState({ outgoing: new Set(commits.map((c) => c.id)) });
  } catch {
    useGitLog.setState({ outgoing: null });
  }
}

/** The commit is on the upstream of the current branch (rewriting it needs a force push). */
export function isPushed(id: string): boolean {
  const { outgoing } = useGitLog.getState();
  return !!outgoing && !outgoing.has(id);
}

export function loadMore(): Promise<void> {
  const s = useGitLog.getState();
  if (s.done) return Promise.resolve();
  if (loadPromise) return loadPromise;
  const gen = s.generation;
  const f = s.filters;
  // Settings › Version Control › Limit history to N rows (file / folder history).
  const vcs = workflowSettings().vcs;
  const cap = f.path && vcs.limitHistory ? vcs.historyLimit : Infinity;
  if (s.commits.length >= cap) {
    useGitLog.setState({ done: true });
    return Promise.resolve();
  }
  useGitLog.setState({ loading: true });
  const p = (async () => {
    try {
      const authors = resolveAuthors(f.authors, f.authors.includes(ME) ? await currentUser() : null);
      if (f.authors.length && !authors.length) {
        if (useGitLog.getState().generation === gen) useGitLog.setState({ done: true });
        return;
      }
      const o = logOptions();
      const { roots, repo: selectedRepo } = useVcs.getState();
      const targets = resolveLogTargets(roots, selectedRepo, f);
      if (!targets.length) {
        if (useGitLog.getState().generation === gen) useGitLog.setState({ done: true, error: null });
        return;
      }

      const baseQuery = {
        branch: null,
        branches: f.branches,
        authors,
        author: null,
        text: f.text.trim() || null,
        textRegex: f.regex,
        textMatchCase: f.matchCase,
        range: null,
        order: o.sort,
        firstParent: o.firstParent,
        noMerges: o.noMerges,
        // The date filter runs in the backend so the graph stays connected.
        sinceMs: f.date?.after ?? null,
        untilMs: f.date?.before ?? null,
      };

      if (targets.length === 1) {
        const target = targets[0]!;
        const page = await call(
          commands.vcsLog(target.repo, {
            ...baseQuery,
            path: target.path,
            skip: s.commits.length,
            limit: Math.min(PAGE, cap - s.commits.length),
          }),
        );
        const cur = useGitLog.getState();
        if (cur.generation !== gen) return;
        const tagged: LogCommit[] =
          roots.length > 1 && target.repo ? page.map((c) => ({ ...c, repo: target.repo! })) : page;
        const { rows, state } = computeGraph(tagged, cur.graph);
        useGitLog.setState({
          commits: cur.commits.concat(tagged),
          rows: cur.rows.concat(rows),
          graph: state,
          done: page.length < PAGE || cur.commits.length + page.length >= cap,
          error: null,
        });
        return;
      }

      // Multi-repository log: fetch pages per repository in parallel and merge newest-first.
      const cursors = targets.map((t) => {
        const key = `${t.repo ?? ""}\n${t.path ?? ""}`;
        let c = repoCursors.get(key);
        if (!c) {
          c = { repo: t.repo!, path: t.path, skipped: 0, buffer: [], done: false };
          repoCursors.set(key, c);
        }
        return c;
      });

      const toFetch = cursors.filter((c) => !c.done && c.buffer.length < PAGE);
      let firstError: unknown = null;
      let succeeded = 0;
      await Promise.all(
        toFetch.map(async (c) => {
          try {
            const batch = await call(
              commands.vcsLog(c.repo, {
                ...baseQuery,
                path: c.path,
                skip: c.skipped,
                limit: PAGE,
              }),
            );
            succeeded++;
            c.skipped += batch.length;
            if (batch.length < PAGE) c.done = true;
            for (const item of batch) c.buffer.push({ ...item, repo: c.repo });
          } catch (e) {
            firstError ??= e;
            c.done = true;
          }
        }),
      );

      const cur = useGitLog.getState();
      if (cur.generation !== gen) return;
      if (firstError && succeeded === 0 && !cur.commits.length && cursors.every((c) => !c.buffer.length)) {
        throw firstError;
      }

      const limit = Math.min(PAGE, cap - cur.commits.length);
      const page: LogCommit[] = [];
      let lastRepo: string | null = cur.commits[cur.commits.length - 1]?.repo ?? null;
      while (page.length < limit) {
        let best: RepoCursor | null = null;
        let bestTime = -Infinity;
        for (const c of cursors) {
          const head = c.buffer[0];
          if (!head) continue;
          const t = head.commitTimeMs ?? head.timeMs ?? 0;
          if (t > bestTime || (t === bestTime && c.repo === lastRepo)) {
            bestTime = t;
            best = c;
          }
        }
        if (!best) break;
        const next = best.buffer.shift()!;
        lastRepo = best.repo;
        page.push(next);
      }

      const allCommits = cur.commits.concat(page);
      const rows = computeMultiRepoGraph(allCommits, roots);
      const allDone = cursors.every((c) => c.done && c.buffer.length === 0) || allCommits.length >= cap;
      useGitLog.setState({
        commits: allCommits,
        rows,
        done: allDone,
        error: null,
      });
    } catch (e) {
      if (useGitLog.getState().generation === gen) useGitLog.setState({ error: errorMessage(e), done: true });
    } finally {
      if (useGitLog.getState().generation === gen) {
        useGitLog.setState({ loading: false });
        loadPromise = null;
      }
    }
  })();
  loadPromise = p;
  return p;
}

/**
 * What the log shows depends on: HEAD and every branch tip. When this changes
 * (commit, undo, reset, rebase, fetch, branch created / deleted) the log is stale.
 */
export function refsSignature(
  head: BranchInfo | null,
  branches: readonly Branch[],
  heads: Readonly<Record<string, { head: string | null; headCommit: string | null }>> = {},
): string {
  const tips = branches.map((b) => `${b.remote ? "r" : "l"}:${b.name}@${b.commit}`).sort();
  const rootHeads = Object.entries(heads)
    .map(([r, h]) => `R:${r}:${h.head ?? ""}@${h.headCommit ?? ""}`)
    .sort();
  return [`HEAD:${head?.head ?? ""}@${head?.headCommit ?? ""}`, ...tips, ...rootHeads].join("\n");
}

export function selectCommit(id: string | null, reveal = false, repo?: string | null) {
  const resolvedRepo =
    repo !== undefined ? repo : id ? (useGitLog.getState().commits.find((c) => c.id === id)?.repo ?? null) : null;
  useGitLog.setState((s) => ({
    selected: id,
    selectedRepo: resolvedRepo ?? null,
    selection: id ? [id] : [],
    revealTick: reveal ? s.revealTick + 1 : s.revealTick,
  }));
  if (resolvedRepo && useVcs.getState().roots.includes(resolvedRepo) && resolvedRepo !== currentRepo()) {
    void selectRepo(resolvedRepo);
  }
}

/** Cmd/Ctrl-click: toggles `id` in the selection. */
export function toggleCommitSelection(id: string, repo?: string | null) {
  let nextRepo: string | null = null;
  useGitLog.setState((s) => {
    const on = s.selection.includes(id);
    const selection = on ? s.selection.filter((x) => x !== id) : [...s.selection, id];
    const selected = on ? (selection[selection.length - 1] ?? null) : id;
    if (!on) {
      nextRepo = (repo !== undefined ? repo : s.commits.find((c) => c.id === id)?.repo) ?? s.selectedRepo ?? null;
    } else if (selected) {
      nextRepo = s.commits.find((c) => c.id === selected)?.repo ?? s.selectedRepo ?? null;
    } else {
      nextRepo = null;
    }
    return {
      selection,
      selected,
      selectedRepo: nextRepo,
    };
  });
  if (nextRepo && useVcs.getState().roots.includes(nextRepo) && nextRepo !== currentRepo()) {
    void selectRepo(nextRepo);
  }
}

/** Shift-click / Shift+arrows: selects the rows between the anchor (lead) and `id` within `visible`. */
export function extendCommitSelection(id: string, visible: readonly LogCommit[], repo?: string | null) {
  let nextRepo: string | null = null;
  useGitLog.setState((s) => {
    const anchor = s.selection[0] ?? s.selected;
    const a = anchor ? visible.findIndex((c) => c.id === anchor) : -1;
    const b = visible.findIndex((c) => c.id === id && (!repo || !c.repo || c.repo === repo));
    const targetIdx = b >= 0 ? b : visible.findIndex((c) => c.id === id);
    const targetRepo =
      (repo !== undefined ? repo : visible[targetIdx]?.repo ?? s.commits.find((c) => c.id === id)?.repo) ??
      s.selectedRepo ??
      null;
    nextRepo = targetRepo;
    if (a < 0 || targetIdx < 0) return { selected: id, selectedRepo: targetRepo, selection: [id] };
    const [from, to] = a <= targetIdx ? [a, targetIdx] : [targetIdx, a];
    const range = visible.slice(from, to + 1).map((c) => c.id);
    // Keep the anchor first so further extensions pivot on it.
    return {
      selected: id,
      selectedRepo: targetRepo,
      selection: [anchor!, ...range.filter((x) => x !== anchor)],
    };
  });
  if (nextRepo && useVcs.getState().roots.includes(nextRepo) && nextRepo !== currentRepo()) {
    void selectRepo(nextRepo);
  }
}

/** Selected commits, newest first (log order). */
export function selectedCommits(): LogCommit[] {
  const { commits, selection, selectedRepo } = useGitLog.getState();
  const ids = new Set(selection);
  return commits.filter(
    (c) => ids.has(c.id) && (selection.length > 1 || !selectedRepo || !c.repo || c.repo === selectedRepo),
  );
}

const MAX_SEARCH_PAGES = 30;

/** Selects `id` in the log, clearing filters and paging until it is loaded. */
export async function revealCommit(id: string, repo?: string | null) {
  useGitLog.setState({ tab: "log" });
  const f = useGitLog.getState().filters;
  const filtered = hasFilters(f);
  const find = () =>
    useGitLog
      .getState()
      .commits.find((c) => (c.id === id || c.id.startsWith(id)) && (!repo || !c.repo || c.repo === repo));
  if (filtered) {
    useGitLog.setState({ filters: emptyFilters() });
    await reloadLog();
  } else if (!useGitLog.getState().commits.length) {
    await reloadLog();
  }
  for (let i = 0; i < MAX_SEARCH_PAGES && !find() && !useGitLog.getState().done; i++) await loadMore();
  const hit = find();
  if (hit) selectCommit(hit.id, true, hit.repo ?? repo);
}

/** Go to Parent Commit: selects the first parent, paging the log until it is loaded. */
export async function goToParent(c: LogCommit) {
  const parent = c.parents[0];
  if (!parent) return;
  const find = () => useGitLog.getState().commits.find((x) => x.id === parent && (!c.repo || x.repo === c.repo));
  for (let i = 0; i < MAX_SEARCH_PAGES && !find() && !useGitLog.getState().done; i++) await loadMore();
  const hit = find();
  if (hit) selectCommit(parent, true, hit.repo);
}

/** Go to Child Commit: the nearest newer loaded commit having `c` as a parent. */
export function goToChild(c: LogCommit) {
  const { commits } = useGitLog.getState();
  const index = commits.findIndex((x) => x.id === c.id && (!c.repo || x.repo === c.repo));
  for (let i = index - 1; i >= 0; i--) {
    const child = commits[i]!;
    if ((!c.repo || child.repo === c.repo) && child.parents.includes(c.id))
      return selectCommit(child.id, true, child.repo);
  }
}

/** Graph / View Options change; options that change the query reload the log. */
export function updateLogOptions(patch: Partial<LogOptions>) {
  if (setLogOptions(patch)) void reloadLog();
}

/** Highlight › My Commits: authored by the current user. */
export function isMine(c: Commit, user: string | null): boolean {
  if (!user) return false;
  const u = user.toLowerCase();
  return c.email.toLowerCase() === u || c.author.toLowerCase() === u;
}

/**
 * Go to Hash/Branch/Tag: selects the commit `rev` names, paging the log until it is
 * loaded (and clearing the filters when they hide it). False when there is no such commit.
 */
export async function goToRef(rev: string): Promise<boolean> {
  const target = rev.trim();
  if (!target) return false;
  let id: string | undefined;
  let hitRepo: string | null | undefined;
  const activeRepo = currentRepo();
  const targets = resolveLogTargets();
  const targetRepos = targets.length ? targets.map((t) => t.repo) : [activeRepo];
  const reposToTry =
    activeRepo && targetRepos.includes(activeRepo)
      ? [activeRepo, ...targetRepos.filter((r) => r !== activeRepo)]
      : targetRepos;
  for (const repo of reposToTry) {
    try {
      const [hit] = await call(
        commands.vcsLog(repo, {
          branch: target,
          path: null,
          author: null,
          text: null,
          range: null,
          skip: 0,
          limit: 1,
        }),
      );
      if (hit?.id) {
        id = hit.id;
        hitRepo = repo;
        break;
      }
    } catch {
      // Try next repository.
    }
  }
  if (!id) return false;
  useGitLog.setState({ tab: "log" });
  const find = () =>
    useGitLog.getState().commits.some((c) => c.id === id && (!hitRepo || !c.repo || c.repo === hitRepo));
  if (!useGitLog.getState().commits.length) await reloadLog();
  for (let i = 0; i < MAX_SEARCH_PAGES && !find() && !useGitLog.getState().done; i++) await loadMore();
  if (!find()) await revealCommit(id, hitRepo);
  if (!find()) return false;
  // A commit inside a collapsed linear branch: expand them (IDEA does the same).
  if (logOptions().collapseLinear) {
    const head = useVcs.getState().branch?.headCommit;
    const shown = collapseLinear(useGitLog.getState().commits, new Set(head ? [head] : [])).commits;
    if (!shown.some((c) => c.id === id)) setLogOptions({ collapseLinear: false });
  }
  selectCommit(id, true, hitRepo);
  return true;
}
