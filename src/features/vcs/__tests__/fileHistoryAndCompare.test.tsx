import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Commit } from "@/bindings";

const vcsLog = vi.fn();
const vcsFileAt = vi.fn();
const vcsCommitFiles = vi.fn();
const vcsCommitsChanges = vi.fn();
const vcsConfigGet = vi.fn();
const vcsDiffWithWorktree = vi.fn();
const vcsDiffRevisions = vi.fn();
const fsReadText = vi.fn();
const editor = vi.hoisted(() => ({ current: undefined as { openInput: (...args: unknown[]) => unknown } | undefined }));

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
      vcsDiffWithWorktree: (repo: string | null, rev: string) => vcsDiffWithWorktree(repo, rev),
      vcsDiffRevisions: (repo: string | null, from: string, to: string) => vcsDiffRevisions(repo, from, to),
      fsReadText: (path: string) => fsReadText(path),
    },
  };
});

// No editor service unless a test provides one (Compare then opens as a dialog).
vi.mock("@/workbench/contributions", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/workbench/contributions")>();
  return {
    ...real,
    maybeEditorService: () => editor.current as never,
    editorService: () => (editor.current ?? real.editorService()) as never,
  };
});

vi.mock("../graph", async (importOriginal) => {
  const real = await importOriginal<typeof import("../graph")>();
  return { ...real, computeGraph: vi.fn(real.computeGraph) };
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

import { registerActions } from "@/platform/actions";
import type { MenuItem } from "@/ui";
import { ContextMenuHost, hideContextMenu } from "@/ui/Menu";
import { commonBranchMenu, selectedBranchesMenu } from "../branchMenu";
import { CompareBranchesEditor, showCompareBranches } from "../CompareBranches";
import { compareBranchesInput, compareBranchesTitle } from "../compareBranchesKind";
import { VcsDialogHost } from "../dialogs";
import { computeGraph } from "../graph";
import { commitKey } from "../multiRoot";
import {
  SelectionHistoryDialog,
  buildSelectionRevisions,
  mapRangeToOlder,
  resolveSelectionTarget,
  sliceLineRange,
} from "../SelectionHistory";
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
  vcsLog.mockReset().mockResolvedValue({ status: "ok", data: [] });
  vcsFileAt.mockReset().mockResolvedValue({ status: "ok", data: "" });
  vcsCommitFiles.mockReset().mockResolvedValue({ status: "ok", data: [] });
  fsReadText.mockReset().mockRejectedValue(new Error("not open"));

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
    // Another repository is selected: the file's own repository is read.
    useVcs.setState({ roots: ["/p", "/p/other"], repo: "/p/other" });
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
    expect(vcsLog).toHaveBeenCalledWith("/p", expect.objectContaining({ path: "/p/src/calc.ts" }));
    expect(vcsCommitFiles).toHaveBeenCalledWith("/p", "c2222222");
    expect(screen.getByTestId("diff-left-text")).toHaveTextContent("export const v = 1;");
    expect(screen.getByTestId("diff-right-text")).toHaveTextContent("export const v = 2;");
  });
});

describe("CompareBranchesEditor", () => {
  const ok = (data: unknown) => Promise.resolve({ status: "ok", data });
  const run = (items: MenuItem[], label: string) => {
    const item = items.find((i) => "label" in i && i.label === label);
    expect(item).toBeDefined();
    (item as { run: () => void }).run();
  };
  const closeDialogs = (name: string) => {
    for (const d of screen.queryAllByRole("dialog", { name }))
      fireEvent.click(within(d).getAllByRole("button", { name: "Close" })[0]!);
  };

  beforeEach(() => {
    hideContextMenu();
    editor.current = undefined;
    vcsCommitsChanges.mockReset().mockResolvedValue({ status: "ok", data: [] });
    vcsConfigGet.mockReset().mockResolvedValue({ status: "ok", data: "alice@example.com" });
    vcsDiffWithWorktree.mockReset().mockResolvedValue({ status: "ok", data: [] });
    vcsDiffRevisions.mockReset().mockResolvedValue({ status: "ok", data: [] });
    vi.mocked(computeGraph).mockClear();
    useVcs.setState({
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
  });

  it("renders top and bottom branch comparison panes with warning banners, filters, and changed files", async () => {
    const incomingCommit = makeCommit("d4444444", "feat: add new payment gateway", ["c0000000"], "Elena");
    const outgoingCommit = makeCommit("c3333333", "fix: hotfix null pointer on checkout", ["c0000000"], "Marco");

    // Each side is the branch against HEAD (the current branch) of the repository.
    vcsLog.mockImplementation((_repo: string | null, opts: { range?: string }) => {
      if (opts.range === "HEAD..origin/develop") return ok([incomingCommit]);
      if (opts.range === "origin/develop..HEAD") return ok([outgoingCommit]);
      return ok([]);
    });
    vcsCommitFiles.mockResolvedValue({
      status: "ok",
      data: [{ path: "src/payment.ts", oldPath: null, kind: "modified" }],
    });

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
    expect(await screen.findByText("Commits that exist in origin/develop but don't exist in main")).toBeInTheDocument();
    expect(await screen.findByText("Commits that exist in main but don't exist in origin/develop")).toBeInTheDocument();

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

  it("queries only the compared repository, filters by a typed path and shows a file's history", async () => {
    const backend = "/p/open-idea-backend";
    useVcs.setState({
      root: "/p",
      roots: [backend, "/p/open-idea-frontend"],
      repo: backend,
      heads: {
        [backend]: { head: "feature/auth", headCommit: "f1111111" },
        "/p/open-idea-frontend": { head: "main", headCommit: "f2222222" },
      },
    });
    const showHistory = vi.fn();
    const dispose = registerActions([
      { id: "vcs.showHistory", title: "Show History", run: ({ arg }) => showHistory(arg) },
    ]);

    const backendCommit = makeCommit("a9999999", "feat(backend): add payment endpoint", ["a0000000"], "Marco");
    vcsLog.mockResolvedValue({ status: "ok", data: [backendCommit] });
    vcsCommitFiles.mockResolvedValue({
      status: "ok",
      data: [{ path: "src/payment.ts", oldPath: null, kind: "modified" }],
    });

    const input = compareBranchesInput("main", "feature/auth", backend);
    render(
      <>
        <CompareBranchesEditor input={input} />
        <ContextMenuHost />
        <VcsDialogHost />
      </>,
    );

    const topToolbar = screen.getByRole("toolbar", { name: "Compare main with feature/auth" });
    await waitFor(() => expect(vcsLog).toHaveBeenCalledWith(backend, expect.objectContaining({ range: "HEAD..main" })));

    // Paths › Select Folders…: a path relative to the compared repository
    fireEvent.click(within(topToolbar).getByRole("button", { name: "Paths" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Select Folders…" }));
    const prompt = await screen.findByRole("dialog", { name: "Filter by Path" });
    fireEvent.change(within(prompt).getByRole("textbox", { name: "File or folder" }), { target: { value: "src" } });
    fireEvent.click(within(prompt).getByRole("button", { name: "OK" }));
    await waitFor(() =>
      expect(vcsLog).toHaveBeenCalledWith(
        backend,
        expect.objectContaining({ range: "HEAD..main", path: `${backend}/src` }),
      ),
    );
    expect(topToolbar).toHaveTextContent("Paths:");
    expect(topToolbar).toHaveTextContent("src");
    // Another repository of the project is never asked.
    expect(vcsLog.mock.calls.every(([repo]) => repo === backend)).toBe(true);

    // Right-click payment.ts -> Show History with its path in the compared repository
    const fileItems = await screen.findAllByText("payment.ts");
    fireEvent.contextMenu(fileItems[0]!);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Show History" }));
    await waitFor(() => expect(showHistory).toHaveBeenCalledWith(`${backend}/src/payment.ts`));
    dispose();
  });

  it("includes Compare with Current in commonBranchMenu for multi-repo branches", async () => {
    const roots = ["/p/repo-a", "/p/repo-b"];
    useVcs.setState({
      roots,
      repo: roots[0],
      heads: {
        "/p/repo-a": { head: "main", headCommit: "a1111111" },
        "/p/repo-b": { head: "main", headCommit: "b1111111" },
      },
    });
    const items = commonBranchMenu({ name: "origin/develop", remote: true, current: false, favorite: false }, roots);

    render(<VcsDialogHost />);
    run(items, "Compare with Current");
    expect(await screen.findByRole("dialog", { name: "Compare: origin/develop and main" })).toBeInTheDocument();
    // The branch against HEAD in each repository.
    await waitFor(() =>
      expect(vcsLog).toHaveBeenCalledWith("/p/repo-a", expect.objectContaining({ range: "HEAD..origin/develop" })),
    );
    expect(vcsLog).toHaveBeenCalledWith("/p/repo-b", expect.objectContaining({ range: "HEAD..origin/develop" }));
    closeDialogs("Compare: origin/develop and main");
  });

  it("shows every file that differs between the branches, in each compared repository", async () => {
    vcsLog.mockImplementation(() => ok([]));
    render(
      <>
        <CompareBranchesEditor input={compareBranchesInput("develop", "main", "/p/a", ["/p/a", "/p/b"])} />
        <VcsDialogHost />
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Show Diff Between Branches" }));
    await waitFor(() =>
      expect(vcsDiffRevisions.mock.calls).toEqual([
        ["/p/a", "develop", "HEAD"],
        ["/p/b", "develop", "HEAD"],
      ]),
    );
    expect(screen.getAllByRole("button", { name: "Show Diff Between Branches" })).toHaveLength(1);
  });

  it("opens CompareBranchesEditor via showCompareBranches fallback dialog when no editorService is mounted", async () => {
    render(<VcsDialogHost />);
    showCompareBranches("origin/develop");
    expect(await screen.findByRole("dialog", { name: "Compare: origin/develop and main" })).toBeInTheDocument();
    expect(await screen.findByRole("listbox", { name: "Commits in origin/develop not in main" })).toBeInTheDocument();
    closeDialogs("Compare: origin/develop and main");
  });

  it("offers Compare with Current and Show Diff with Working Tree for branches selected in several repositories", async () => {
    const [a, b] = ["/p/a", "/p/b"];
    useVcs.setState({
      roots: [a, b],
      repo: a,
      heads: { [a]: { head: "main", headCommit: "a1111111" }, [b]: { head: "main", headCommit: "b1111111" } },
    });
    const develop = (repo: string, name = "develop") => ({
      repo,
      branch: {
        name,
        remote: false,
        current: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        lastCommitMs: 0,
        commit: "d4444444",
      },
    });
    const labels = (items: MenuItem[]) => items.flatMap((i) => ("label" in i && i.label ? [i.label] : []));
    const items = selectedBranchesMenu([develop(a), develop(b)]);
    // Different branches have no common "current" to compare with.
    expect(labels(selectedBranchesMenu([develop(a), develop(b, "feature")]))).not.toContain("Compare with Current");
    // Current in one repository only: still compared in the others.
    const currentInA = { ...develop(a), branch: { ...develop(a).branch, current: true } };
    expect(labels(selectedBranchesMenu([currentInA, develop(b)]))).toContain("Compare with Current");
    expect(labels(selectedBranchesMenu([currentInA, { ...currentInA, repo: b }]))).not.toContain(
      "Compare with Current",
    );

    render(<VcsDialogHost />);
    run(items, "Compare with Current");
    expect(await screen.findByRole("dialog", { name: "Compare: develop and main" })).toBeInTheDocument();
    await waitFor(() => expect(vcsLog).toHaveBeenCalledWith(b, expect.objectContaining({ range: "HEAD..develop" })));
    expect(vcsLog).toHaveBeenCalledWith(a, expect.objectContaining({ range: "HEAD..develop" }));
    closeDialogs("Compare: develop and main");

    // Each selected branch against the working tree of its own repository.
    run(items, "Show Diff with Working Tree");
    await waitFor(() =>
      expect(vcsDiffWithWorktree.mock.calls).toEqual([
        [a, "develop"],
        [b, "develop"],
      ]),
    );
    closeDialogs("Changes between develop and Local Working Tree");
  });

  it("keeps identical SHAs distinct across Compare repositories", async () => {
    const [a, b] = ["/p/a", "/p/b"];
    useVcs.setState({
      root: "/p",
      roots: [a, b],
      repo: a,
      heads: { [a]: { head: "main", headCommit: "a1111111" }, [b]: { head: "main", headCommit: "b1111111" } },
    });
    const openInput = vi.fn();
    editor.current = { openInput };
    const consoleError = vi.spyOn(console, "error");
    // The same commit id in both repositories (e.g. one cloned from the other).
    const sha = "abcdef0123456789abcdef0123456789abcdef01";
    const inA = { ...makeCommit(sha, "same id in a", ["9999999999"]), commitTimeMs: 2_000 };
    const inB = { ...makeCommit(sha, "same id in b", ["9999999999"]), commitTimeMs: 1_000 };
    vcsLog.mockImplementation((repo: string | null, opts: { range?: string }) =>
      ok(opts.range === "HEAD..develop" ? (repo === a ? [inA] : repo === b ? [inB] : []) : []),
    );
    vcsCommitFiles.mockImplementation((repo: string | null) =>
      ok([{ path: repo === a ? "src/a.ts" : "src/b.ts", oldPath: null, kind: "modified" }]),
    );

    render(
      <>
        <CompareBranchesEditor input={compareBranchesInput("develop", "main", a, [a, b])} />
        <ContextMenuHost />
      </>,
    );
    const top = screen.getByRole("listbox", { name: "Commits in develop not in main" });
    await waitFor(() => expect(within(top).getAllByRole("option")).toHaveLength(2));
    const [rowA, rowB] = within(top).getAllByRole("option");

    // (c) Each repository is asked in its own name.
    expect(vcsLog).toHaveBeenCalledWith(a, expect.objectContaining({ range: "HEAD..develop" }));
    expect(vcsLog).toHaveBeenCalledWith(b, expect.objectContaining({ range: "HEAD..develop" }));
    expect(vcsConfigGet).toHaveBeenCalledWith(a, "user.email");
    expect(vcsConfigGet).toHaveBeenCalledWith(b, "user.email");

    // (b) The graph links commits by repository-qualified keys.
    const laid = vi
      .mocked(computeGraph)
      .mock.calls.map(([commits]) => commits)
      .find((commits) => commits.length === 2);
    expect(laid?.map((c) => c.id)).toEqual([commitKey({ id: sha, repo: a }), commitKey({ id: sha, repo: b })]);
    expect(laid?.map((c) => c.parents)).toEqual([
      [commitKey({ id: "9999999999", repo: a })],
      [commitKey({ id: "9999999999", repo: b })],
    ]);

    // (a) Rows and selection tell the two apart: one row is selected at a time.
    expect(rowA).toHaveAttribute("aria-selected", "true");
    expect(rowB).toHaveAttribute("aria-selected", "false");
    await waitFor(() => expect(vcsCommitFiles).toHaveBeenCalledWith(a, sha));
    fireEvent.mouseDown(rowB!, { button: 0 });
    expect(rowB).toHaveAttribute("aria-selected", "true");
    expect(rowA).toHaveAttribute("aria-selected", "false");
    await waitFor(() => expect(vcsCommitFiles).toHaveBeenCalledWith(b, sha));
    expect(await screen.findByText("b.ts")).toBeInTheDocument();
    // Ctrl-click in another repository starts a new selection there.
    fireEvent.mouseDown(rowA!, { button: 0, ctrlKey: true });
    expect(rowA).toHaveAttribute("aria-selected", "true");
    expect(rowB).toHaveAttribute("aria-selected", "false");
    expect(vcsCommitsChanges).not.toHaveBeenCalled();
    expect(consoleError.mock.calls.some((args) => args.some((x) => String(x).includes("same key")))).toBe(false);

    // (d) The diff reads the file in the commit's own repository.
    expect(await screen.findByText("a.ts")).toBeInTheDocument();
    fireEvent.doubleClick(rowA!);
    await waitFor(() => expect(openInput).toHaveBeenCalled());
    expect(openInput.mock.calls[0]![0]).toMatchObject({
      path: `${a}/src/a.ts`,
      data: { left: { type: "rev", rev: "9999999999" }, right: { type: "rev", rev: sha } },
    });
    fireEvent.mouseDown(rowB!, { button: 0 });
    expect(await screen.findByText("b.ts")).toBeInTheDocument();
    fireEvent.doubleClick(rowB!);
    await waitFor(() => expect(openInput).toHaveBeenCalledTimes(2));
    expect(openInput.mock.calls[1]![0]).toMatchObject({ path: `${b}/src/b.ts` });
    consoleError.mockRestore();
  });
});
