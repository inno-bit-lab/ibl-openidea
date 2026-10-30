/**
 * Git file history tab (`History: <filename>` in the Git tool window),
 * `Show History for Selection…` dialog, and `Compare with Revision…` chooser.
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
import { Text } from "@codemirror/state";
import { Chunk } from "@codemirror/merge";
import type { Commit } from "@/bindings";
import { activeEditor, editorsFor } from "@/editor/api";
import { executeAction } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import {
  Checkbox,
  Dialog,
  EmptyState,
  HighlightedText,
  Icon,
  IconButton,
  List,
  SearchField,
  Spinner,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  T,
  fuzzyMatch,
  listNavigate,
  showContextMenu,
  type MenuItem,
} from "@/ui";
import { maybeEditorService, notifications } from "@/workbench/contributions";
import { DiffEditor, mapLine } from "./DiffEditor";
import { confirmDialog, openDialog } from "./dialogs";
import { diffInput, openDiff, type DiffData, type DiffSide } from "./diffInput";
import { computeGraph } from "./graph";
import { IssueText } from "./issueLinks";
import {
  logRepoOf,
  setFileHistoryBranch,
  type FileHistoryTab,
  type LogCommit,
} from "./logStore";
import { baseName, formatTime, relTo } from "./model";
import { errorMessage, readWorkingText, runOp, writeFileText } from "./ops";
import { currentRepo, loadBranches, useVcs } from "./store";
import { commitMenu, FilterButton, GraphCell, menuBelow, RefLabels } from "./GitLog";
import styles from "./GitLog.module.css";

const FILE_HISTORY_LIMIT = 500;
const SELECTION_HISTORY_LIMIT = 150;

// ---------------------------------------------------------------------------
// Line-range tracking for "Show History for Selection…"

/** Extracts 1-based inclusive `[startLine, endLine]` from `text`. */
export function sliceLineRange(text: string, startLine: number, endLine: number): string {
  if (!text) return "";
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const from = Math.max(1, Math.min(startLine, lines.length));
  const to = Math.max(from, Math.min(endLine, lines.length));
  return lines.slice(from - 1, to).join("\n");
}

/**
 * Maps a 1-based inclusive line range `[newStartLine, newEndLine]` in `newText`
 * back to its corresponding 1-based inclusive line range in `oldText`, and
 * reports whether the selected block changed between `oldText` and `newText`.
 */
export function mapRangeToOlder(
  oldText: string,
  newText: string,
  newStartLine: number,
  newEndLine: number,
): { startLine: number; endLine: number; changed: boolean; emptyInOld?: boolean } {
  const normOld = oldText.replace(/\r\n?/g, "\n");
  const normNew = newText.replace(/\r\n?/g, "\n");
  if (!normOld) {
    return { startLine: 1, endLine: 1, changed: normNew.length > 0, emptyInOld: true };
  }
  const docOld = Text.of(normOld.split("\n"));
  const docNew = Text.of(normNew.split("\n"));
  const clampedStart0 = Math.max(0, Math.min(newStartLine - 1, docNew.lines - 1));
  const clampedEnd0 = Math.max(clampedStart0, Math.min(newEndLine - 1, docNew.lines - 1));

  if (normOld === normNew) {
    return { startLine: clampedStart0 + 1, endLine: clampedEnd0 + 1, changed: false };
  }

  const span = (start: number, end: number, doc: Text) => {
    const first = doc.lineAt(Math.min(start, doc.length)).number - 1;
    return [first, end > start ? doc.lineAt(Math.min(end - 1, doc.length)).number : first] as const;
  };

  const chunks = Chunk.build(docNew, docOld);
  const chunkSpans = chunks.map((c) => {
    const [fromA, toA] = span(c.fromA, c.toA, docNew);
    const [fromB, toB] = span(c.fromB, c.toB, docOld);
    return { fromA, toA, fromB, toB };
  });

  let minOld0 = Infinity;
  let maxOld0 = -1;
  let overlapped = false;
  let anchorOld0: number | null = null;

  for (let line0 = clampedStart0; line0 <= clampedEnd0; line0++) {
    const inChunk = chunkSpans.find((c) => c.toA > c.fromA && line0 >= c.fromA && line0 < c.toA);
    if (!inChunk) {
      const mapped0 = mapLine(chunks, line0, docNew, docOld);
      minOld0 = Math.min(minOld0, mapped0);
      maxOld0 = Math.max(maxOld0, mapped0);
    }
  }

  for (const c of chunkSpans) {
    const aEndInclusive = Math.max(c.fromA, c.toA - 1);
    const touches =
      c.fromA === c.toA
        ? c.fromA > clampedStart0 && c.fromA <= clampedEnd0
        : c.fromA <= clampedEnd0 && aEndInclusive >= clampedStart0;
    if (touches) {
      overlapped = true;
      if (anchorOld0 === null) anchorOld0 = c.fromB;
      if (c.toB > c.fromB) {
        minOld0 = Math.min(minOld0, c.fromB);
        maxOld0 = Math.max(maxOld0, c.toB - 1);
      }
    }
  }

  if (minOld0 > maxOld0) {
    const anchor = Math.max(
      1,
      Math.min((anchorOld0 ?? mapLine(chunks, clampedStart0, docNew, docOld)) + 1, docOld.lines),
    );
    return {
      startLine: anchor,
      endLine: anchor,
      changed: true,
      emptyInOld: true,
    };
  }

  const startLine = Math.max(1, Math.min(minOld0 + 1, docOld.lines));
  const endLine = Math.max(startLine, Math.min(maxOld0 + 1, docOld.lines));
  const beforeSlice = sliceLineRange(normOld, startLine, endLine);
  const afterSlice = sliceLineRange(normNew, clampedStart0 + 1, clampedEnd0 + 1);
  return {
    startLine,
    endLine,
    changed: overlapped || beforeSlice !== afterSlice,
  };
}

export interface SelectionRevision {
  commit: Commit;
  parentId: string | null;
  startLine: number;
  endLine: number;
  parentStartLine: number;
  parentEndLine: number;
  beforeText: string;
  afterText: string;
  changed: boolean;
}

/**
 * Computes the selection history revisions across `commits` (newest first).
 * If `workingText` is provided and differs from the newest commit's text, maps
 * `initialRange` from `workingText` to the newest commit first.
 */
export function buildSelectionRevisions(
  commits: readonly Commit[],
  fileTexts: ReadonlyMap<string, string | null>,
  parentTexts: ReadonlyMap<string, string | null>,
  initialRange: { startLine: number; endLine: number },
  workingText?: string | null,
): SelectionRevision[] {
  if (!commits.length) return [];
  let curStart = Math.max(1, initialRange.startLine);
  let curEnd = Math.max(curStart, initialRange.endLine);

  const firstCommitText = fileTexts.get(commits[0]!.id) ?? "";
  if (workingText != null && workingText !== firstCommitText && firstCommitText) {
    const mapped = mapRangeToOlder(firstCommitText, workingText, curStart, curEnd);
    if (!mapped.emptyInOld) {
      curStart = mapped.startLine;
      curEnd = mapped.endLine;
    }
  }

  const out: SelectionRevision[] = [];
  for (const commit of commits) {
    const commitText = (fileTexts.get(commit.id) ?? "").replace(/\r\n?/g, "\n");
    const parentId = commit.parents[0] ?? null;
    const parentText = (parentId ? (parentTexts.get(commit.id) ?? "") : "").replace(/\r\n?/g, "\n");
    const afterText = sliceLineRange(commitText, curStart, curEnd);

    if (!parentId || !parentText) {
      out.push({
        commit,
        parentId,
        startLine: curStart,
        endLine: curEnd,
        parentStartLine: 1,
        parentEndLine: 1,
        beforeText: "",
        afterText,
        changed: afterText.length > 0 || commitText.length > 0,
      });
      break;
    }

    const mapped = mapRangeToOlder(parentText, commitText, curStart, curEnd);
    if (mapped.emptyInOld) {
      out.push({
        commit,
        parentId,
        startLine: curStart,
        endLine: curEnd,
        parentStartLine: mapped.startLine,
        parentEndLine: mapped.endLine,
        beforeText: "",
        afterText,
        changed: true,
      });
      break;
    }

    const beforeText = sliceLineRange(parentText, mapped.startLine, mapped.endLine);
    out.push({
      commit,
      parentId,
      startLine: curStart,
      endLine: curEnd,
      parentStartLine: mapped.startLine,
      parentEndLine: mapped.endLine,
      beforeText,
      afterText,
      changed: mapped.changed,
    });
    curStart = mapped.startLine;
    curEnd = mapped.endLine;
  }
  return out;
}

// ---------------------------------------------------------------------------
// FileHistoryView (`History: <filename>` tab in the Git tool window)

export function FileHistoryView({ tab }: { tab: FileHistoryTab }) {
  const { path, repo, branch } = tab;
  const version = useVcs((s) => s.version);
  const root = useVcs((s) => s.root) ?? "";
  const branches = useVcs((s) => s.branches);
  const remoteNames = useMemo(() => new Set(branches.filter((b) => b.remote).map((b) => b.name)), [branches]);

  const [commits, setCommits] = useState<LogCommit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const anchorRef = useRef<string | null>(null);

  const load = useCallback(() => {
    call(
      commands.vcsLog(repo, {
        branch: branch ?? null,
        branches: branch ? [branch] : [],
        path,
        author: null,
        text: null,
        range: null,
        skip: 0,
        limit: FILE_HISTORY_LIMIT,
      }),
    )
      .then((list) => {
        const tagged: LogCommit[] = repo ? list.map((c) => ({ ...c, repo })) : list;
        setCommits(tagged);
        setError(null);
        setSelected((prev) => {
          const keep = prev && tagged.some((c) => c.id === prev) ? prev : (tagged[0]?.id ?? null);
          setSelection((prevSel) => {
            const valid = prevSel.filter((id) => tagged.some((c) => c.id === id));
            return valid.length ? valid : keep ? [keep] : [];
          });
          return keep;
        });
      })
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setLoading(false));
  }, [path, repo, branch]);

  useEffect(() => {
    load();
    void loadBranches().catch(() => undefined);
  }, [load, version]);

  const rows = useMemo(() => computeGraph(commits).rows, [commits]);
  const selectedSet = useMemo(() => new Set(selection), [selection]);
  const chosenCommits = useMemo(
    () => commits.filter((c) => selectedSet.has(c.id)),
    [commits, selectedSet],
  );
  const activeCommit = useMemo(
    () => (selected ? commits.find((c) => c.id === selected) : commits[0]) ?? null,
    [commits, selected],
  );

  // Build diff data for the right-hand diff pane:
  // - 2+ commits selected: older commit ↔ newer commit
  // - 1 commit selected: its first parent (<id>^) ↔ commit (<id>)
  const diffMeta = useMemo((): { data: DiffData; leftRev: string; rightRev: string } | null => {
    if (!activeCommit) return null;
    if (chosenCommits.length >= 2) {
      const newer = chosenCommits[0]!;
      const older = chosenCommits[chosenCommits.length - 1]!;
      const left: DiffSide = { type: "rev", rev: older.id, path, label: older.shortId };
      const right: DiffSide = { type: "rev", rev: newer.id, path, label: newer.shortId };
      return {
        data: { path, left, right, title: `${baseName(path)} (${older.shortId} ↔ ${newer.shortId})` },
        leftRev: older.shortId,
        rightRev: newer.shortId,
      };
    }
    const parent = activeCommit.parents[0];
    const left: DiffSide = parent
      ? { type: "rev", rev: parent, path, label: parent.slice(0, 8) }
      : { type: "text", text: "", label: "(does not exist)" };
    const right: DiffSide = { type: "rev", rev: activeCommit.id, path, label: activeCommit.shortId };
    return {
      data: {
        path,
        left,
        right,
        title: `${baseName(path)} (${parent ? parent.slice(0, 8) : "root"} ↔ ${activeCommit.shortId})`,
      },
      leftRev: parent ? parent.slice(0, 8) : tx("(does not exist)"),
      rightRev: activeCommit.shortId,
    };
  }, [activeCommit, chosenCommits, path]);

  const pickCommit = (id: string, e?: ReactMouseEvent) => {
    if (e?.shiftKey && anchorRef.current) {
      const a = commits.findIndex((c) => c.id === anchorRef.current);
      const b = commits.findIndex((c) => c.id === id);
      if (a >= 0 && b >= 0) {
        const [from, to] = a <= b ? [a, b] : [b, a];
        const range = commits.slice(from, to + 1).map((c) => c.id);
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

  const getFromRevision = async (c: Commit) => {
    const ok = await confirmDialog({
      title: "Get from Revision",
      message: tx`Replace ${baseName(path)} with its version from revision ${c.shortId} (${c.summary})?`,
      okLabel: "Get",
    });
    if (!ok) return;
    await runOp(
      "Get from Revision",
      async () => {
        const content = (await call(commands.vcsFileAt(path, c.id))) ?? "";
        await writeFileText(path, content, { save: true });
      },
      {
        success: tx`Loaded ${baseName(path)} from revision ${c.shortId}`,
        refresh: true,
      },
    );
  };

  const openBranchMenu = (e: ReactMouseEvent<HTMLElement>) => {
    const names = branches.filter((b) => !b.name.endsWith("/HEAD")).map((b) => b.name);
    menuBelow(e, [
      {
        label: "HEAD (Current Branch)",
        checked: branch === "HEAD",
        run: () => setFileHistoryBranch(tab.id, "HEAD"),
      },
      {
        label: "All Branches",
        checked: branch === null,
        run: () => setFileHistoryBranch(tab.id, null),
      },
      ...(names.length ? [{ kind: "separator" as const }] : []),
      ...names.map((name) => ({
        label: name,
        icon: "branch",
        checked: branch === name,
        run: () => setFileHistoryBranch(tab.id, name),
      })),
    ]);
  };

  const selectedIndex = selected ? commits.findIndex((c) => c.id === selected) : -1;
  const onKeyDown = (e: KeyboardEvent) => {
    if (!commits.length) return;
    if (e.key === "Enter" && diffMeta) {
      e.preventDefault();
      void openDiff(diffMeta.data);
      return;
    }
    let next: number;
    if (e.key === "ArrowDown") next = Math.min(commits.length - 1, selectedIndex + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, selectedIndex - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = commits.length - 1;
    else return;
    e.preventDefault();
    const target = commits[next];
    if (target) pickCommit(target.id);
  };

  const relFile = relTo(repo ?? root, path) || baseName(path);

  return (
    <div className={styles.logWrap}>
      <SplitGroup orientation="horizontal" id="git-file-history" className={styles.split}>
        <SplitPanel id="commits" defaultSize="46%" minSize="220px">
          <div className={styles.log}>
            <div className={styles.filters} role="toolbar" aria-label={tx("File history actions")}>
              <FilterButton
                label="Branch"
                value={branch}
                onOpen={openBranchMenu}
                onClear={() => setFileHistoryBranch(tab.id, null)}
              />
              <IconButton icon="refresh" title="Refresh" size="small" onClick={load} />
              <IconButton
                icon="diff"
                title="Show Diff"
                size="small"
                disabled={!diffMeta}
                onClick={() => diffMeta && void openDiff(diffMeta.data)}
              />
              <IconButton
                icon="history"
                title="Annotate with Git Blame"
                size="small"
                onClick={() => void executeAction("vcs.annotate", path)}
              />
              <IconButton
                icon="undo"
                title="Get from Revision"
                size="small"
                disabled={!activeCommit}
                onClick={() => activeCommit && void getFromRevision(activeCommit)}
              />
            </div>
            <div className={styles.historyHeaderCols} role="presentation">
              <span className={styles.historyColAuthor}>
                <T>Author</T>
              </span>
              <span className={styles.historyColDate}>
                <T>Date</T>
              </span>
              <span className={styles.historyColMessage}>
                <T>Commit Message</T>
              </span>
            </div>
            <div className={styles.listWrap}>
              <div
                className={styles.list}
                role="listbox"
                aria-label={tx("File history commits")}
                aria-multiselectable
                tabIndex={0}
                onKeyDown={onKeyDown}
              >
                {error && !commits.length && <div className={styles.message}>{error}</div>}
                {loading && !commits.length && (
                  <div className={styles.message}>
                    <Spinner size={12} />{" "}
                    <span className={styles.muted}>
                      <T>Loading…</T>
                    </span>
                  </div>
                )}
                {!loading && !error && !commits.length && (
                  <div className={styles.message}>
                    <T>No commits found for this file</T>
                  </div>
                )}
                {commits.map((c, idx) => {
                  const isSel = selectedSet.has(c.id);
                  return (
                    <div
                      key={c.id}
                      role="option"
                      aria-selected={isSel}
                      className={clsx(styles.row, isSel && styles.selected)}
                      style={{ position: "relative" }}
                      onMouseDown={(e) => {
                        if (e.button === 2 && !selectedSet.has(c.id)) {
                          pickCommit(c.id);
                        } else if (e.button === 0) {
                          if (e.shiftKey) e.preventDefault();
                          pickCommit(c.id, e);
                        }
                      }}
                      onDoubleClick={() => diffMeta && void openDiff(diffMeta.data)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        const rowMenu: MenuItem[] = [
                          {
                            label: "Show Diff",
                            icon: "diff",
                            run: () => diffMeta && void openDiff(diffMeta.data),
                          },
                          {
                            label: "Get from Revision",
                            icon: "undo",
                            run: () => void getFromRevision(c),
                          },
                          { kind: "separator" },
                          ...commitMenu(c, chosenCommits.length ? chosenCommits : [c]),
                        ];
                        showContextMenu(e, rowMenu);
                      }}
                    >
                      <span className={clsx(styles.historyColAuthor, styles.muted)} title={`${c.author} <${c.email}>`}>
                        {c.author}
                      </span>
                      <span className={clsx(styles.historyColDate, styles.muted)}>{formatTime(c.timeMs)}</span>
                      <span className={styles.historyColMessage}>
                        {rows[idx] && <GraphCell row={rows[idx]!} head={idx === 0} />}
                        <span className={styles.subject} title={c.message}>
                          {c.summary}
                        </span>
                        {c.refs.length > 0 && <RefLabels refs={c.refs} remoteNames={remoteNames} />}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </SplitPanel>
        <SplitHandle />
        <SplitPanel id="diff" defaultSize="54%" minSize="240px">
          <div className={styles.historyDiffPane}>
            {diffMeta ? (
              <div className={styles.historyDiffBody}>
                <DiffEditor
                  key={`${path}:${diffMeta.leftRev}:${diffMeta.rightRev}`}
                  input={diffInput(diffMeta.data)}
                  headerContent={
                    <div className={styles.historyRevHeaders}>
                      <div className={styles.historyRevLine}>
                        <Icon name="lock" size={12} />
                        <span>{diffMeta.leftRev}</span>
                        <span className={styles.historyRevPath}>{relFile}</span>
                      </div>
                      <div className={styles.historyRevLine}>
                        <Icon name="lock" size={12} />
                        <span>{diffMeta.rightRev}</span>
                      </div>
                    </div>
                  }
                />
              </div>
            ) : (
              <EmptyState>
                <T>Select a revision to view changes</T>
              </EmptyState>
            )}
          </div>
        </SplitPanel>
      </SplitGroup>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Show History for Selection… (Screenshot 2)

export interface SelectionHistoryTarget {
  path: string;
  startLine: number;
  endLine: number;
}

function resolveRenamedOldPath(
  curPath: string,
  files: readonly { path: string; oldPath: string | null }[],
): string | null {
  const normCur = curPath.replace(/\\/g, "/");
  for (const f of files) {
    if (!f.oldPath) continue;
    const normF = f.path.replace(/\\/g, "/");
    if (normCur === normF) return f.oldPath;
    if (normCur.endsWith(`/${normF}`)) {
      const prefix = curPath.slice(0, curPath.length - normF.length);
      return `${prefix}${f.oldPath}`;
    }
  }
  return null;
}

/** Resolves the active editor selection (or explicit arg) into a 1-based line range. */
export function resolveSelectionTarget(arg?: unknown): SelectionHistoryTarget | null {
  if (arg && typeof arg === "object" && "path" in arg) {
    const a = arg as {
      path?: unknown;
      startLine?: unknown;
      endLine?: unknown;
      fromLine?: unknown;
      toLine?: unknown;
    };
    if (typeof a.path === "string") {
      const rawStart =
        typeof a.startLine === "number" ? a.startLine : typeof a.fromLine === "number" ? a.fromLine : null;
      const rawEnd =
        typeof a.endLine === "number" ? a.endLine : typeof a.toLine === "number" ? a.toLine : rawStart;
      if (rawStart !== null && rawEnd !== null) {
        const start = Math.max(1, Math.floor(rawStart));
        const end = Math.max(start, Math.floor(rawEnd));
        return { path: a.path, startLine: start, endLine: end };
      }
      const ed = editorsFor(a.path)[0] ?? activeEditor();
      if (ed && ed.ctx.path === a.path) {
        return selectionFromEditor(ed.view.state, a.path);
      }
      return { path: a.path, startLine: 1, endLine: 25 };
    }
  }
  const ed = activeEditor();
  if (ed) return selectionFromEditor(ed.view.state, ed.ctx.path);
  const active = maybeEditorService()?.activePath();
  if (active) return { path: active, startLine: 1, endLine: 25 };
  return null;
}

function selectionFromEditor(
  state: { doc: { lineAt(pos: number): { number: number; from: number }; lines: number }; selection: { main: { from: number; to: number; empty: boolean } } },
  path: string,
): SelectionHistoryTarget {
  const sel = state.selection.main;
  const startLine = state.doc.lineAt(sel.from).number;
  if (sel.empty) {
    return { path, startLine, endLine: startLine };
  }
  const toLine = state.doc.lineAt(sel.to);
  const endLine = sel.to > sel.from && toLine.from === sel.to ? Math.max(startLine, toLine.number - 1) : toLine.number;
  return { path, startLine, endLine };
}

export function showSelectionHistory(arg?: unknown) {
  const target = resolveSelectionTarget(arg);
  if (!target) {
    notifications().notify({
      group: "vcs",
      level: "info",
      title: "Open a file and select lines to show history for selection",
    });
    return;
  }
  openDialog((close) => <SelectionHistoryDialog target={target} onClose={close} />);
}

export function SelectionHistoryDialog({
  target,
  onClose,
}: {
  target: SelectionHistoryTarget;
  onClose: () => void;
}) {
  const { path, startLine, endLine } = target;
  const repo = logRepoOf(path) ?? currentRepo();
  const [revisions, setRevisions] = useState<SelectionRevision[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changesOnly, setChangesOnly] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [compareId, setCompareId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [commits, workingText] = await Promise.all([
          call(
            commands.vcsLog(repo, {
              branch: "HEAD",
              path,
              author: null,
              text: null,
              range: null,
              skip: 0,
              limit: SELECTION_HISTORY_LIMIT,
            }),
          ),
          readWorkingText(path),
        ]);
        if (!alive) return;
        const blobCache = new Map<string, Promise<string | null>>();
        const fetchFileAt = (filePath: string, rev: string): Promise<string | null> => {
          const key = `${filePath}\0${rev}`;
          let pending = blobCache.get(key);
          if (!pending) {
            pending = Promise.resolve(call(commands.vcsFileAt(filePath, rev))).catch(() => null);
            blobCache.set(key, pending);
          }
          return pending;
        };
        // Warm cache in parallel for all commit and parent revisions at the initial path.
        for (const c of commits) {
          void fetchFileAt(path, c.id);
          if (c.parents[0]) void fetchFileAt(path, c.parents[0]);
        }
        const fileTexts = new Map<string, string | null>();
        const parentTexts = new Map<string, string | null>();
        let curPath = path;
        for (const c of commits) {
          const parent = c.parents[0];
          const atCommit = await fetchFileAt(curPath, c.id);
          let atParent = parent ? await fetchFileAt(curPath, parent) : null;
          if (parent && atParent === null && atCommit !== null) {
            const files = await Promise.resolve(call(commands.vcsCommitFiles(repo, c.id))).catch(() => []);
            const oldPath = Array.isArray(files) ? resolveRenamedOldPath(curPath, files) : null;
            if (oldPath) {
              curPath = oldPath;
              atParent = await fetchFileAt(curPath, parent);
            }
          }
          fileTexts.set(c.id, atCommit);
          parentTexts.set(c.id, atParent);
        }
        if (!alive) return;
        const built = buildSelectionRevisions(commits, fileTexts, parentTexts, { startLine, endLine }, workingText);
        setRevisions(built);
        const firstChanged = built.find((r) => r.changed) ?? built[0];
        setSelectedId(firstChanged?.commit.id ?? null);
        setCompareId(null);
      } catch (e) {
        if (alive) setError(errorMessage(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [path, repo, startLine, endLine]);

  const visible = useMemo(() => {
    if (!revisions) return [];
    if (!changesOnly) return revisions;
    const filtered = revisions.filter((r) => r.changed);
    return filtered.length ? filtered : revisions;
  }, [revisions, changesOnly]);

  const activeRev = useMemo(
    () => visible.find((r) => r.commit.id === selectedId) ?? visible[0] ?? null,
    [visible, selectedId],
  );
  const secondRev = useMemo(
    () => (compareId ? visible.find((r) => r.commit.id === compareId) ?? null : null),
    [visible, compareId],
  );

  const diffSides = useMemo(() => {
    if (!activeRev) return null;
    if (secondRev && secondRev.commit.id !== activeRev.commit.id) {
      const idxA = visible.indexOf(activeRev);
      const idxB = visible.indexOf(secondRev);
      const [newer, older] = idxA <= idxB ? [activeRev, secondRev] : [secondRev, activeRev];
      return {
        leftRevId: older.commit.id,
        rightRevId: newer.commit.id,
        leftText: older.afterText,
        rightText: newer.afterText,
        leftFirstLine: older.startLine,
        rightFirstLine: newer.startLine,
      };
    }
    return {
      leftRevId: activeRev.parentId ?? tx("(initial)"),
      rightRevId: activeRev.commit.id,
      leftText: activeRev.beforeText,
      rightText: activeRev.afterText,
      leftFirstLine: activeRev.parentStartLine,
      rightFirstLine: activeRev.startLine,
    };
  }, [activeRev, secondRev, visible]);

  return (
    <Dialog
      open
      title={tx("History for Selection")}
      onClose={onClose}
      width={980}
      buttons={[{ label: "Close", role: "cancel" }]}
    >
      <div className={styles.selectionDialog}>
        <SplitGroup orientation="vertical" id="vcs-selection-history" className={styles.split}>
          <SplitPanel id="diff" defaultSize="54%" minSize="180px">
            <div className={styles.selectionTopPane}>
              {diffSides ? (
                <div className={styles.historyDiffBody}>
                  <DiffEditor
                    key={`${diffSides.leftRevId}:${diffSides.rightRevId}`}
                    input={diffInput({
                      path,
                      left: {
                        type: "text",
                        text: diffSides.leftText,
                        label: tx`Revision ${diffSides.leftRevId.slice(0, 8)}`,
                        firstLine: diffSides.leftFirstLine,
                      },
                      right: {
                        type: "text",
                        text: diffSides.rightText,
                        label: tx`Revision ${diffSides.rightRevId.slice(0, 8)}`,
                        firstLine: diffSides.rightFirstLine,
                      },
                    })}
                    headerContent={
                      <div className={styles.selectionSideHeaders}>
                        <div className={styles.selectionSideHeader}>
                          <Icon name="lock" size={12} />
                          <span>{tx`Revision ${diffSides.leftRevId}`}</span>
                        </div>
                        <div className={styles.selectionSideHeader}>
                          <Icon name="lock" size={12} />
                          <span>{tx`Revision ${diffSides.rightRevId}`}</span>
                        </div>
                      </div>
                    }
                  />
                </div>
              ) : error ? (
                <div className={styles.message}>{error}</div>
              ) : !revisions ? (
                <div className={styles.message}>
                  <Spinner size={14} />
                </div>
              ) : (
                <div className={styles.message}>
                  <T>No history found for selection</T>
                </div>
              )}
            </div>
          </SplitPanel>
          <SplitHandle />
          <SplitPanel id="revisions" defaultSize="30%" minSize="110px">
            <div className={styles.selectionTablePane}>
              <div className={styles.selectionControlsBar}>
                <Checkbox
                  checked={changesOnly}
                  onChange={setChangesOnly}
                  label={tx("Changes only")}
                />
                <span className={styles.grow} />
                <IconButton
                  icon="diff"
                  title="Show Diff"
                  size="small"
                  disabled={!activeRev}
                  onClick={() => {
                    if (!activeRev) return;
                    const parent = activeRev.parentId;
                    void openDiff({
                      path,
                      left: parent
                        ? { type: "rev", rev: parent, path, label: parent.slice(0, 8) }
                        : { type: "text", text: "", label: "(does not exist)" },
                      right: { type: "rev", rev: activeRev.commit.id, path, label: activeRev.commit.shortId },
                    });
                  }}
                />
                <IconButton
                  icon="copy"
                  title="Copy Revision Number"
                  size="small"
                  disabled={!activeRev}
                  onClick={() => activeRev && void navigator.clipboard?.writeText(activeRev.commit.id)}
                />
              </div>
              <div className={styles.selectionTableHeader} role="presentation">
                <span className={styles.selectionColVersion}>
                  <T>Version</T>
                </span>
                <span className={styles.selectionColDate}>
                  <T>Date</T>
                </span>
                <span className={styles.selectionColAuthor}>
                  <T>Author</T>
                </span>
                <span className={styles.selectionColSubject}>
                  <T>Commit Message</T>
                </span>
              </div>
              <div
                className={styles.selectionTableList}
                role="listbox"
                aria-label={tx("Selection revisions")}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (!visible.length) return;
                  const curIdx = activeRev ? visible.indexOf(activeRev) : -1;
                  let next: number;
                  if (e.key === "ArrowDown") next = Math.min(visible.length - 1, curIdx + 1);
                  else if (e.key === "ArrowUp") next = Math.max(0, curIdx - 1);
                  else if (e.key === "Home") next = 0;
                  else if (e.key === "End") next = visible.length - 1;
                  else return;
                  e.preventDefault();
                  const targetRev = visible[next];
                  if (targetRev) {
                    setSelectedId(targetRev.commit.id);
                    setCompareId(null);
                  }
                }}
              >
                {visible.map((rev) => {
                  const id = rev.commit.id;
                  const isSelected = id === activeRev?.commit.id || id === secondRev?.commit.id;
                  return (
                    <div
                      key={id}
                      role="option"
                      aria-selected={isSelected}
                      className={clsx(styles.selectionTableRow, isSelected && styles.selectionTableRowSelected)}
                      onClick={(e) => {
                        if ((e.metaKey || e.ctrlKey || e.shiftKey) && activeRev && activeRev.commit.id !== id) {
                          setCompareId((prev) => (prev === id ? null : id));
                        } else {
                          setSelectedId(id);
                          setCompareId(null);
                        }
                      }}
                    >
                      <span className={styles.selectionColVersion}>{rev.commit.shortId}</span>
                      <span className={styles.selectionColDate}>{formatTime(rev.commit.timeMs)}</span>
                      <span className={styles.selectionColAuthor}>{rev.commit.author}</span>
                      <span className={styles.selectionColSubject} title={rev.commit.message}>
                        {rev.commit.summary}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </SplitPanel>
          <SplitHandle />
          <SplitPanel id="message" defaultSize="16%" minSize="72px">
            <div className={styles.selectionBottomPane}>
              <div className={styles.selectionBottomLabel}>
                <T>Commit Message:</T>
              </div>
              <div className={styles.selectionBottomMessage}>
                {activeRev ? <IssueText text={activeRev.commit.message} /> : null}
              </div>
            </div>
          </SplitPanel>
        </SplitGroup>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Compare with Revision… chooser (file-specific commit history)

export function chooseFileRevision(
  path: string,
  title = "Compare with Revision",
): Promise<{ id: string; shortId: string } | null> {
  return new Promise((resolve) => {
    const close = openDialog(() => (
      <FileRevisionChooser
        path={path}
        title={title}
        onDone={(r) => {
          close();
          resolve(r);
        }}
      />
    ));
  });
}

function FileRevisionChooser({
  path,
  title,
  onDone,
}: {
  path: string;
  title: string;
  onDone: (rev: { id: string; shortId: string } | null) => void;
}) {
  const repo = logRepoOf(path) ?? currentRepo();
  const [commits, setCommits] = useState<Commit[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  useEffect(() => {
    let alive = true;
    call(
      commands.vcsLog(repo, {
        branch: null,
        path,
        author: null,
        text: null,
        range: null,
        skip: 0,
        limit: 200,
      }),
    )
      .then((list) => alive && setCommits(list))
      .catch(() => undefined)
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [path, repo]);

  const items = useMemo(() => {
    const q = query.trim();
    const base = commits.map((c) => ({
      rev: c.id,
      shortId: c.shortId,
      summary: c.summary,
      author: c.author,
      timeMs: c.timeMs,
      matches: null as number[] | null,
    }));
    const filtered = q
      ? base.flatMap((it) => {
          const m = fuzzyMatch(`${it.shortId} ${it.summary} ${it.author}`, q);
          return m ? [{ ...it, matches: m }] : [];
        })
      : base;
    if (q && !filtered.some((i) => i.rev === q || i.shortId === q)) {
      filtered.push({
        rev: q,
        shortId: q.slice(0, 8),
        summary: tx("Custom revision"),
        author: "",
        timeMs: 0,
        matches: null,
      });
    }
    return filtered;
  }, [commits, query]);

  const idx = Math.min(active, Math.max(0, items.length - 1));
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const it = items[idx];
      if (it) onDone({ id: it.rev, shortId: it.shortId });
      return;
    }
    const n = listNavigate(e.key, { items, active: idx, wrap: true });
    if (n !== null) {
      e.preventDefault();
      setActive(n);
    }
  };

  return (
    <Dialog open title={tx(title)} onClose={() => onDone(null)} width={580} position="top">
      <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--border-popup)" }}>
        <SearchField
          data-autofocus
          value={query}
          onChange={(v) => {
            setQuery(v);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Filter revisions by hash, message or author"
          aria-label="Revision"
          variant="bare"
        />
      </div>
      <div style={{ height: 300, display: "flex", flexDirection: "column", padding: "4px 0" }}>
        {loading && !commits.length ? (
          <div className={styles.message}>
            <Spinner size={14} />
          </div>
        ) : (
          <List
            items={items}
            getKey={(i) => i.rev}
            activeIndex={idx}
            onActiveChange={setActive}
            onActivate={(i) => onDone({ id: i.rev, shortId: i.shortId })}
            focusable={false}
            hoverSelects
            rowHeight={24}
            aria-label="Revisions"
            className={styles.grow}
            empty={
              <span>
                <T>No revisions found</T>
              </span>
            }
            renderItem={(i) => (
              <span className={styles.fileRow} style={{ flex: 1, padding: 0, gap: 8 }}>
                <Icon name="commit" size={14} />
                <span className={styles.hash} style={{ width: 68, flex: "none" }}>
                  {i.shortId}
                </span>
                <HighlightedText
                  className={styles.fileName}
                  text={i.summary}
                  indices={i.matches}
                  tone="accent"
                />
                <span className={styles.fileDir} style={{ marginLeft: "auto" }}>
                  {i.author}
                  {i.timeMs ? ` · ${formatTime(i.timeMs)}` : ""}
                </span>
              </span>
            )}
          />
        )}
      </div>
    </Dialog>
  );
}
