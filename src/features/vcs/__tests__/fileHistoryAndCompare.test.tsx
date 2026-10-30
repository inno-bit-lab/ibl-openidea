import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ChangedFile, Commit } from "@/bindings";

const vcsLog = vi.fn();
const vcsFileAt = vi.fn();
const vcsCommitFiles = vi.fn();
const vcsCommitsChanges = vi.fn();
const vcsConfigGet = vi.fn();
const fsReadText = vi.fn();
const docEdit = vi.fn();
const docSave = vi.fn();

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: {
      ...real.commands,
      vcsLog: (repo: string | null, opts: unknown) => vcsLog(repo, opts),
      vcsFileAt: (path: string, rev: string) => vcsFileAt(path, rev),
      vcsCommitFiles: (repo: string | null, id: string) => vcsCommitFiles(repo, id),
      vcsCommitsChanges: (repo: string | null, ids: string[]) => vcsCommitsChanges(repo, ids),
      vcsConfigGet: (repo: string | null, key: string) => vcsConfigGet(repo, key),
      fsReadText: (path: string) => fsReadText(path),
      docOpen: (path: string) => Promise.resolve({ status: "ok", data: { id: 1, version: 1, path } }),
      docEdit: (id: number, version: number, edit: unknown) => docEdit(id, version, edit),
      docSave: (id: number) => docSave(id),
      docClose: () => Promise.resolve({ status: "ok", data: null }),
    },
  };
});

vi.mock("../DiffEditor", async (importOriginal) => {
  const real = await importOriginal<typeof import("../DiffEditor")>();
  return {
    ...real,
    DiffEditor: ({
      input,
      headerContent,
    }: {
      input: {
        data: {
          path: string;
          left: { label?: string; text?: string; rev?: string; firstLine?: number };
          right: { label?: string; text?: string; rev?: string; firstLine?: number };
        };
      };
      headerContent?: import("react").ReactNode;
    }) => (
      <div data-testid="mock-diff-editor">
        {headerContent && <div data-testid="diff-custom-header">{headerContent}</div>}
        <span data-testid="diff-left">{input.data.left.label ?? input.data.left.rev}</span>
        <span data-testid="diff-right">{input.data.right.label ?? input.data.right.rev}</span>
        <span data-testid="diff-left-text">{input.data.left.text ?? ""}</span>
        <span data-testid="diff-right-text">{input.data.right.text ?? ""}</span>
        <span data-testid="diff-left-first-line">{input.data.left.firstLine ?? ""}</span>
        <span data-testid="diff-right-first-line">{input.data.right.firstLine ?? ""}</span>
      </div>
    ),
  };
});

import { ContextMenuHost, hideContextMenu } from "@/ui/Menu";
import { MessagesHost } from "@/workbench/messages";
import {
  CompareBranchesEditor,
  compareBranchesInput,
  compareBranchesTitle,
  showCompareBranches,
} from "../CompareBranches";
import { VcsDialogHost, closeAllDialogs } from "../dialogs";
import {
  SelectionHistoryDialog,
  buildSelectionRevisions,
  mapRangeToOlder,
  resolveSelectionTarget,
  sliceLineRange,
} from "../FileHistory";
import { GitTabs, GitToolWindow } from "../GitLog";
import { closeFileHistory, emptyFilters, openFileHistory, useGitLog } from "../logStore";
import { commonBranchMenu } from "../branchMenu";
import { useVcs } from "../store";

function makeCommit(id: string, summary: string, parents: string[] = [], author = "Alice"): Commit {
  return {
    id,
    shortId: id.slice(0, 8),
    summary,
    message: `${summary}\n\nDetailed body for ${id}`,
    author,
    email: `${author.toLowerCase()}@example.com`,
    timeMs: 1_700_000_000_000,
    commitTimeMs: 1_700_000_000_000,
    parents,
    refs: [],
  };
}

beforeEach(() => {
  hideContextMenu();
  closeAllDialogs();
  vcsLog.mockReset().mockResolvedValue({ status: "ok", data: [] });
  vcsFileAt.mockReset().mockResolvedValue({ status: "ok", data: "" });
  vcsCommitFiles.mockReset().mockResolvedValue({ status: "ok", data: [] });
  vcsCommitsChanges.mockReset().mockResolvedValue({ status: "ok", data: [] });
  vcsConfigGet.mockReset().mockResolvedValue({ status: "ok", data: "alice@example.com" });
  fsReadText.mockReset().mockRejectedValue(new Error("not open"));
  docEdit.mockReset().mockResolvedValue({ status: "ok", data: 2 });
  docSave.mockReset().mockResolvedValue({ status: "ok", data: null });

  useVcs.setState({
    available: true,
    root: "/p",
    roots: ["/p"],
    repo: "/p",
    heads: { "/p": { head: "main", headCommit: "c3333333" } },
    branch: {
      head: "main",
      headCommit: "c3333333",
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      operation: null,
    },
    branches: [
      {
        name: "main",
        remote: false,
        current: true,
        upstream: "origin/main",
        ahead: 0,
        behind: 0,
        lastCommitMs: 0,
        commit: "c3333333",
      },
      {
        name: "origin/develop",
        remote: true,
        current: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        lastCommitMs: 0,
        commit: "d4444444",
      },
    ],
    branchesLoaded: true,
  });
  useGitLog.setState({
    filters: emptyFilters(),
    tab: "log",
    historyTabs: [],
    commits: [],
    rows: [],
    selection: [],
    selected: null,
  });
});

describe("Selection history line-range tracking", () => {
  it("slices 1-based inclusive line ranges and normalizes CRLF", () => {
    const text = "alpha\r\nbeta\r\ngamma\r\ndelta";
    expect(sliceLineRange(text, 2, 3)).toBe("beta\ngamma");
    expect(sliceLineRange(text, 1, 1)).toBe("alpha");
    expect(sliceLineRange(text, 0, 99)).toBe("alpha\nbeta\ngamma\ndelta");
    expect(sliceLineRange("", 1, 5)).toBe("");
  });

  it("maps line ranges accurately across commits when lines are inserted above", () => {
    const oldText = ["line1", "targetA", "targetB", "line4"].join("\n");
    const newText = ["header1", "header2", "line1", "targetA", "targetB", "line4"].join("\n");

    // In newText, targetA..targetB is at lines 4..5; in oldText it was at lines 2..3.
    const mapped = mapRangeToOlder(oldText, newText, 4, 5);
    expect(mapped).toEqual({
      startLine: 2,
      endLine: 3,
      changed: false,
    });
  });

  it("detects changes inside the selected line range and maps to the pre-change block", () => {
    const oldText = ["line1", "oldTarget", "line3"].join("\n");
    const newText = ["line1", "newTarget1", "newTarget2", "line3"].join("\n");

    const mapped = mapRangeToOlder(oldText, newText, 2, 3);
    expect(mapped.changed).toBe(true);
    expect(mapped.startLine).toBe(2);
    expect(mapped.endLine).toBe(2);
  });

  it("builds selection revisions across history including working-tree offset and root commit", () => {
    const c3 = makeCommit("c3333333", "Add top comment", ["c2222222"]);
    const c2 = makeCommit("c2222222", "Update greeting", ["c1111111"]);
    const c1 = makeCommit("c1111111", "Initial file", []);

    const textC1 = ["fn main() {", '  println!("hi");', "}"].join("\n");
    const textC2 = ["fn main() {", '  println!("hello world");', "}"].join("\n");
    const textC3 = ["// header", "// header 2", "fn main() {", '  println!("hello world");', "}"].join("\n");

    const fileTexts = new Map<string, string | null>([
      [c3.id, textC3],
      [c2.id, textC2],
      [c1.id, textC1],
    ]);
    const parentTexts = new Map<string, string | null>([
      [c3.id, textC2],
      [c2.id, textC1],
      [c1.id, null],
    ]);

    // Select line 4 in c3 (`  println!("hello world");`)
    const revs = buildSelectionRevisions([c3, c2, c1], fileTexts, parentTexts, {
      startLine: 4,
      endLine: 4,
    });

    expect(revs).toHaveLength(3);
    // In c3, only the header above changed; the selected println line did not change
    expect(revs[0]).toMatchObject({
      commit: c3,
      startLine: 4,
      endLine: 4,
      parentStartLine: 2,
      parentEndLine: 2,
      changed: false,
    });
    // In c2, line 2 changed from "hi" to "hello world"
    expect(revs[1]).toMatchObject({
      commit: c2,
      startLine: 2,
      endLine: 2,
      beforeText: '  println!("hi");',
      afterText: '  println!("hello world");',
      changed: true,
    });
    // In c1, initial commit created the line
    expect(revs[2]).toMatchObject({
      commit: c1,
      beforeText: "",
      afterText: '  println!("hi");',
      changed: true,
    });
  });

  it("resolves selection target from both startLine/endLine and fromLine/toLine", () => {
    expect(resolveSelectionTarget({ path: "/p/a.ts", startLine: 5, endLine: 10 })).toEqual({
      path: "/p/a.ts",
      startLine: 5,
      endLine: 10,
    });
    expect(resolveSelectionTarget({ path: "/p/a.ts", fromLine: 8, toLine: 12 })).toEqual({
      path: "/p/a.ts",
      startLine: 8,
      endLine: 12,
    });
  });

  it("handles pure-insertion chunks without pulling in unrelated neighboring lines from older revisions", () => {
    const c2 = makeCommit("c2222222", "Insert helper function", ["c1111111"]);
    const c1 = makeCommit("c1111111", "Initial file", []);

    const textC1 = ["line1", "line2", "line3"].join("\n");
    const textC2 = ["line1", "insertedA", "insertedB", "line2", "line3"].join("\n");

    // 1) Pure insertion selected (lines 2..3 in c2): emptyInOld is true, stops at c2 with beforeText = ""
    const pureMapped = mapRangeToOlder(textC1, textC2, 2, 3);
    expect(pureMapped.changed).toBe(true);
    expect(pureMapped.emptyInOld).toBe(true);

    const fileTexts = new Map<string, string | null>([
      [c2.id, textC2],
      [c1.id, textC1],
    ]);
    const parentTexts = new Map<string, string | null>([
      [c2.id, textC1],
      [c1.id, null],
    ]);

    const revs = buildSelectionRevisions([c2, c1], fileTexts, parentTexts, {
      startLine: 2,
      endLine: 3,
    });
    expect(revs).toHaveLength(1);
    expect(revs[0]).toMatchObject({
      commit: c2,
      beforeText: "",
      afterText: "insertedA\ninsertedB",
      changed: true,
    });

    // 2) Mixed selection (line 1 + inserted lines 2..3): maps only to line 1 in oldText without pulling in line 2
    const mixedMapped = mapRangeToOlder(textC1, textC2, 1, 3);
    expect(mixedMapped).toEqual({
      startLine: 1,
      endLine: 1,
      changed: true,
    });
  });
});

describe("SelectionHistoryDialog", () => {
  it("filters to 'Changes only' by default, shows commit messages, passes firstLine offsets, and deduplicates vcsFileAt calls", async () => {
    const c3 = makeCommit("c3333333", "Unrelated header change", ["c2222222"], "Alice");
    const c2 = makeCommit("c2222222", "Modify selected function", ["c1111111"], "Bob");
    const c1 = makeCommit("c1111111", "Initial commit", [], "Alice");

    vcsLog.mockResolvedValue({ status: "ok", data: [c3, c2, c1] });
    const texts: Record<string, string> = {
      c3333333: "// header\nfn calc() {\n  return 42;\n}",
      c2222222: "fn calc() {\n  return 42;\n}",
      c1111111: "fn calc() {\n  return 1;\n}",
    };
    vcsFileAt.mockImplementation((_path: string, rev: string) =>
      Promise.resolve({ status: "ok", data: texts[rev] ?? "" }),
    );

    render(<SelectionHistoryDialog target={{ path: "/p/src/calc.ts", startLine: 2, endLine: 4 }} onClose={() => {}} />);

    const listbox = await screen.findByRole("listbox", { name: "Selection revisions" });
    await waitFor(() => expect(within(listbox).getAllByRole("option")).toHaveLength(2));

    // Each unique revision (c3, c2, c1) is fetched only once (3 calls, not 5)
    expect(vcsFileAt).toHaveBeenCalledTimes(3);

    // Only c2 and c1 touched the selected function; c3 is hidden when "Changes only" is checked
    const options = within(listbox).getAllByRole("option");
    expect(options[0]).toHaveTextContent("Modify selected function");
    expect(options[1]).toHaveTextContent("Initial commit");
    expect(screen.getByTestId("diff-right-text")).toHaveTextContent("return 42;");
    expect(screen.getByTestId("diff-left-text")).toHaveTextContent("return 1;");
    expect(screen.getByTestId("diff-left-first-line")).toHaveTextContent("1");
    expect(screen.getByTestId("diff-right-first-line")).toHaveTextContent("1");
    expect(screen.getByTestId("diff-custom-header")).toHaveTextContent("Revision c1111111");
    expect(screen.getByTestId("diff-custom-header")).toHaveTextContent("Revision c2222222");

    // Uncheck "Changes only" to reveal all 3 revisions
    fireEvent.click(screen.getByRole("checkbox", { name: "Changes only" }));
    expect(within(listbox).getAllByRole("option")).toHaveLength(3);

    // Keyboard navigation works on the revision table
    fireEvent.keyDown(listbox, { key: "End" });
    expect(within(listbox).getAllByRole("option")[2]).toHaveAttribute("aria-selected", "true");
  });

  it("follows file renames across commits using vcsCommitFiles", async () => {
    const c2 = makeCommit("c2222222", "Rename and update calc", ["c1111111"], "Bob");
    const c1 = makeCommit("c1111111", "Initial old_calc", [], "Alice");

    vcsLog.mockResolvedValue({ status: "ok", data: [c2, c1] });
    vcsFileAt.mockImplementation((filePath: string, rev: string) => {
      if (filePath === "/p/src/calc.ts" && rev === "c2222222") {
        return Promise.resolve({ status: "ok", data: "export const v = 2;\n" });
      }
      if (filePath === "/p/src/old_calc.ts" && rev === "c1111111") {
        return Promise.resolve({ status: "ok", data: "export const v = 1;\n" });
      }
      return Promise.resolve({ status: "ok", data: null });
    });
    vcsCommitFiles.mockImplementation((_repo: string | null, id: string) => {
      if (id === "c2222222") {
        return Promise.resolve({
          status: "ok",
          data: [{ path: "src/calc.ts", oldPath: "src/old_calc.ts", kind: "renamed" }],
        });
      }
      return Promise.resolve({ status: "ok", data: [] });
    });

    render(<SelectionHistoryDialog target={{ path: "/p/src/calc.ts", startLine: 1, endLine: 1 }} onClose={() => {}} />);

    const listbox = await screen.findByRole("listbox", { name: "Selection revisions" });
    await waitFor(() => expect(within(listbox).getAllByRole("option")).toHaveLength(2));
    expect(screen.getByTestId("diff-left-text")).toHaveTextContent("export const v = 1;");
    expect(screen.getByTestId("diff-right-text")).toHaveTextContent("export const v = 2;");
  });
});

describe("FileHistoryView in Git tool window", () => {
  it("opens a 'History: <file>' tab in GitTabs, loads commits, switches branches, and restores a revision", async () => {
    const c2 = makeCommit("b2222222", "Refactor parser", ["a1111111"], "Marco");
    const c1 = makeCommit("a1111111", "Add parser", [], "Marco");
    vcsLog.mockResolvedValue({ status: "ok", data: [c2, c1] });
    vcsFileAt.mockResolvedValue({ status: "ok", data: "export const parsed = true;\n" });

    openFileHistory("/p/src/parser.ts");

    render(
      <>
        <GitTabs />
        <GitToolWindow />
        <ContextMenuHost />
        <VcsDialogHost />
        <MessagesHost />
      </>,
    );

    // Tab header shows Log, Console, and History: parser.ts
    expect(screen.getByRole("tab", { name: "Log" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Console" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /History: parser\.ts/ })).toHaveAttribute("aria-selected", "true");

    // Commits load into the file history list and diff pane renders
    const list = await screen.findByRole("listbox", { name: "File history commits" });
    await waitFor(() => expect(within(list).getAllByRole("option")).toHaveLength(2));
    expect(vcsLog).toHaveBeenCalledWith(
      "/p",
      expect.objectContaining({
        branch: "HEAD",
        path: "/p/src/parser.ts",
      }),
    );
    expect(screen.getByTestId("mock-diff-editor")).toBeInTheDocument();
    expect(screen.getByTestId("diff-left")).toHaveTextContent("a1111111");
    expect(screen.getByTestId("diff-right")).toHaveTextContent("b2222222");

    // Clicking "Get from Revision" opens confirmation dialog and writes file content
    fsReadText.mockResolvedValue({ status: "ok", data: "old content" });
    fireEvent.click(screen.getByRole("button", { name: "Get from Revision" }));
    const dialog = await screen.findByRole("dialog", { name: "Get from Revision" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Get" }));
    await waitFor(() =>
      expect(docEdit).toHaveBeenCalledWith(1, 1, {
        changes: [{ from: 0, to: 11, insert: "export const parsed = true;\n" }],
      }),
    );
    expect(docSave).toHaveBeenCalledWith(1);

    // Closing the file history tab returns to Log
    closeFileHistory("history:/p/src/parser.ts");
    expect(useGitLog.getState().tab).toBe("log");
  });
});

describe("CompareBranchesEditor", () => {
  it("renders top and bottom branch comparison panes with warning banners, filters, and changed files", async () => {
    const incomingCommit = makeCommit("d4444444", "feat: add new payment gateway", ["c0000000"], "Elena");
    const outgoingCommit = makeCommit("c3333333", "fix: hotfix null pointer on checkout", ["c0000000"], "Marco");
    const changedFiles: ChangedFile[] = [
      { path: "/p/src/payment.ts", oldPath: null, kind: "modified" },
    ];

    vcsLog.mockImplementation((_repo: string | null, opts: { range?: string }) => {
      if (opts.range === "main..origin/develop") {
        return Promise.resolve({ status: "ok", data: [incomingCommit] });
      }
      if (opts.range === "origin/develop..main") {
        return Promise.resolve({ status: "ok", data: [outgoingCommit] });
      }
      return Promise.resolve({ status: "ok", data: [] });
    });
    vcsCommitFiles.mockResolvedValue({ status: "ok", data: changedFiles });

    const input = compareBranchesInput("origin/develop", "main", "/p");
    expect(compareBranchesTitle(input.data as never)).toBe("Compare: origin/develop and main");

    render(
      <>
        <CompareBranchesEditor input={input} />
        <ContextMenuHost />
        <VcsDialogHost />
      </>,
    );

    // Both warning banners match IntelliJ IDEA's exact phrasing
    expect(
      await screen.findByText("Commits that exist in origin/develop but don't exist in main"),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("Commits that exist in main but don't exist in origin/develop"),
    ).toBeInTheDocument();

    // Both panes load their respective commits
    const topList = screen.getByRole("listbox", { name: "Commits in origin/develop not in main" });
    const bottomList = screen.getByRole("listbox", { name: "Commits in main not in origin/develop" });
    await waitFor(() => expect(within(topList).getAllByRole("option")).toHaveLength(1));
    await waitFor(() => expect(within(bottomList).getAllByRole("option")).toHaveLength(1));

    expect(topList).toHaveTextContent("feat: add new payment gateway");
    expect(bottomList).toHaveTextContent("fix: hotfix null pointer on checkout");

    // Changed files header shows "Changes to <shortId> <summary>"
    expect(await screen.findByText("Changes to d4444444 feat: add new payment gateway")).toBeInTheDocument();
    expect(await screen.findByText("Changes to c3333333 fix: hotfix null pointer on checkout")).toBeInTheDocument();

    // Filtering the top pane by text hides non-matching commits
    const searchFields = screen.getAllByPlaceholderText("Text or hash");
    fireEvent.change(searchFields[0]!, { target: { value: "nonexistent-commit-hash" } });
    await waitFor(() => expect(within(topList).queryAllByRole("option")).toHaveLength(0));
    expect(within(bottomList).getAllByRole("option")).toHaveLength(1);
  });

  it("scopes Paths filter to the target repo in multi-repo workspaces and resolves relative paths in Show History", async () => {
    useVcs.setState({
      root: "/p",
      roots: ["/p/open-idea-backend", "/p/open-idea-frontend"],
      repo: "/p/open-idea-backend",
      heads: {
        "/p/open-idea-backend": { head: "feature/auth", headCommit: "f1111111" },
        "/p/open-idea-frontend": { head: "main", headCommit: "f2222222" },
      },
    });

    const backendCommit = makeCommit("a9999999", "feat(backend): add payment endpoint", ["a0000000"], "Marco");
    vcsLog.mockResolvedValue({ status: "ok", data: [backendCommit] });
    vcsCommitFiles.mockResolvedValue({
      status: "ok",
      data: [{ path: "src/payment.ts", oldPath: null, kind: "modified" }],
    });

    const input = compareBranchesInput("main", "feature/auth", "/p/open-idea-backend");
    render(
      <>
        <CompareBranchesEditor input={input} />
        <ContextMenuHost />
        <VcsDialogHost />
      </>,
    );

    // Filter bar shows Paths: open-idea-backend
    const topToolbar = screen.getByRole("toolbar", { name: "Compare main with feature/auth" });
    expect(topToolbar).toHaveTextContent("Paths:");
    expect(topToolbar).toHaveTextContent("open-idea-backend");

    // Changed file tree groups under open-idea-backend -> src -> payment.ts
    const fileItems = await screen.findAllByText("payment.ts");
    expect(fileItems.length).toBeGreaterThan(0);

    // Right-click payment.ts -> Show History resolves relative path against repo root
    fireEvent.contextMenu(fileItems[0]!);
    const showHistoryItem = await screen.findByRole("menuitem", { name: "Show History" });
    fireEvent.click(showHistoryItem);

    expect(useGitLog.getState().historyTabs).toEqual([
      expect.objectContaining({
        path: "/p/open-idea-backend/src/payment.ts",
        repo: "/p/open-idea-backend",
      }),
    ]);
  });

  it("includes Compare with Current in commonBranchMenu for multi-repo branches", async () => {
    const items = commonBranchMenu(
      { name: "origin/develop", remote: true, current: false, favorite: false },
      ["/p/repo-a", "/p/repo-b"],
    );
    const compareItem = items.find((i) => i.kind !== "separator" && i.label === "Compare with Current");
    expect(compareItem).toBeDefined();

    render(<VcsDialogHost />);
    if (compareItem && "run" in compareItem && compareItem.run) {
      compareItem.run();
    }
    expect(await screen.findByRole("dialog", { name: "Compare: origin/develop and main" })).toBeInTheDocument();
  });

  it("opens CompareBranchesEditor via showCompareBranches fallback dialog when no editorService is mounted", async () => {
    render(<VcsDialogHost />);
    showCompareBranches("origin/develop");
    expect(await screen.findByRole("dialog", { name: "Compare: origin/develop and main" })).toBeInTheDocument();
  });
});
