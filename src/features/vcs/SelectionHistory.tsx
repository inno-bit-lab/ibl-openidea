/** Git `Show History for Selection…` dialog and a chooser of a file's revisions. */
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import { Text, type EditorState } from "@codemirror/state";
import { Chunk } from "@codemirror/merge";
import type { Commit } from "@/bindings";
import { activeEditor, editorsFor } from "@/editor/api";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import {
  Checkbox,
  Dialog,
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
} from "@/ui";
import { maybeEditorService, notifications } from "@/workbench/contributions";
import { DiffEditor, mapLine } from "./DiffEditor";
import { openDialog } from "./dialogs";
import { diffInput, openDiff } from "./diffInput";
import { IssueText } from "./issueLinks";
import { formatTime } from "./model";
import { errorMessage, readWorkingText } from "./ops";
import { currentRepo, repoOf } from "./store";
import styles from "./GitLog.module.css";

const SELECTION_HISTORY_LIMIT = 150;

// ---------------------------------------------------------------------------
// Line-range tracking

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
// Show History for Selection…

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
      const rawEnd = typeof a.endLine === "number" ? a.endLine : typeof a.toLine === "number" ? a.toLine : rawStart;
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

function selectionFromEditor(state: EditorState, path: string): SelectionHistoryTarget {
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

export function SelectionHistoryDialog({ target, onClose }: { target: SelectionHistoryTarget; onClose: () => void }) {
  const { path, startLine, endLine } = target;
  const repo = repoOf(path) ?? currentRepo();
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
    () => (compareId ? (visible.find((r) => r.commit.id === compareId) ?? null) : null),
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
                <Checkbox checked={changesOnly} onChange={setChangesOnly} label={tx("Changes only")} />
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
// Revision chooser (file-specific commit history)

export function chooseFileRevision(path: string, title: string): Promise<{ id: string; shortId: string } | null> {
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
  const repo = repoOf(path) ?? currentRepo();
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
                <HighlightedText className={styles.fileName} text={i.summary} indices={i.matches} tone="accent" />
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
