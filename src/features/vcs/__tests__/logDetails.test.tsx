import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Commit } from "@/bindings";

const vcsCommitFiles = vi.fn();
const vcsCommitsChanges = vi.fn();
const vcsLog = vi.fn().mockResolvedValue({ status: "ok", data: [] });

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsCommitFiles: (repo: unknown, id: string) => vcsCommitFiles(repo, id),
      vcsCommitsChanges: (repo: unknown, ids: string[]) => vcsCommitsChanges(repo, ids),
      vcsLog: (repo: unknown, query: unknown) => vcsLog(repo, query),
    },
  };
});

import { CommitDetails, FilterBar } from "../GitLog";
import { emptyFilters, selectCommit, useGitLog, type LogCommit } from "../logStore";
import { useVcs } from "../store";

const commit = (summary: string, d: string): Commit => ({
  id: d.repeat(40),
  shortId: d.repeat(8),
  parents: [],
  author: "A",
  email: "a@example.com",
  timeMs: 0,
  summary,
  message: `${summary}\n\nBody of ${summary}`,
  refs: [],
});

// Log order: newest first.
const log = [commit("Third", "3"), commit("Second", "2"), commit("First", "1")];

afterEach(() => {
  useGitLog.setState({ commits: [], selection: [], selected: null, filters: emptyFilters() });
  useVcs.setState({ root: null, roots: [], repo: null });
  vcsCommitFiles.mockReset();
  vcsCommitsChanges.mockReset();
  vcsLog.mockClear();
});

describe("Git Log commit details", () => {
  it("shows one commit's files and full message", async () => {
    vcsCommitFiles.mockResolvedValue({ status: "ok", data: [{ path: "a.ts", kind: "modified", oldPath: null }] });
    useGitLog.setState({ commits: log, selected: log[1]!.id, selection: [log[1]!.id] });
    render(<CommitDetails commits={log} />);
    expect(await screen.findByText("1 file")).toBeInTheDocument();
    expect(vcsCommitFiles).toHaveBeenCalledWith(null, log[1]!.id);
    expect(screen.getByText("Body of Second")).toBeInTheDocument();
  });

  it("queries commit files from the commit's own repository in a multi-repo project", async () => {
    vcsCommitFiles.mockResolvedValue({ status: "ok", data: [{ path: "a.ts", kind: "modified", oldPath: null }] });
    const multiLog: LogCommit[] = [{ ...commit("Sub commit", "9"), repo: "/w/sub-repo" }];
    useVcs.setState({ root: "/w", roots: ["/w/main-repo", "/w/sub-repo"], repo: "/w/main-repo" });
    useGitLog.setState({ commits: multiLog, selected: multiLog[0]!.id, selection: [multiLog[0]!.id] });
    render(<CommitDetails commits={multiLog} />);
    expect(await screen.findByText("1 file")).toBeInTheDocument();
    expect(vcsCommitFiles).toHaveBeenCalledWith("/w/sub-repo", multiLog[0]!.id);
  });

  it("combines the changes of several selected commits, oldest first, and lists them", async () => {
    vcsCommitsChanges.mockResolvedValue({
      status: "ok",
      data: [
        { path: "a.ts", kind: "modified", oldPath: null, before: "0".repeat(40), after: log[0]!.id },
        { path: "b.ts", kind: "added", oldPath: null, before: null, after: log[2]!.id },
      ],
    });
    // Selected in click order (Cmd-click), not log order; non-contiguous.
    useGitLog.setState({ commits: log, selected: log[0]!.id, selection: [log[2]!.id, log[0]!.id] });
    render(<CommitDetails commits={log} />);
    expect(await screen.findByText(/2 files\s*in 2 commits/)).toBeInTheDocument();
    expect(vcsCommitsChanges).toHaveBeenCalledWith(null, [log[2]!.id, log[0]!.id]);
    expect(vcsCommitFiles).not.toHaveBeenCalled();
    expect(screen.getByText("First")).toBeInTheDocument();
    expect(screen.getByText("Third")).toBeInTheDocument();
    expect(screen.queryByText("Second")).toBeNull();
  });
  it("queries each repository separately when multiple commits across different repos are selected", async () => {
    vcsCommitsChanges.mockImplementation(async (repo: string, ids: string[]) => ({
      status: "ok",
      data:
        repo === "/w/repo-a"
          ? [{ path: "src/a.ts", kind: "modified", oldPath: null, before: "0".repeat(40), after: ids[0]! }]
          : [{ path: "pkg/b.ts", kind: "added", oldPath: null, before: null, after: ids[0]! }],
    }));
    const multiLog: LogCommit[] = [
      { ...commit("Repo B commit", "b"), repo: "/w/repo-b" },
      { ...commit("Repo A commit", "a"), repo: "/w/repo-a" },
    ];
    useVcs.setState({ root: "/w", roots: ["/w/repo-a", "/w/repo-b"], repo: "/w/repo-a" });
    useGitLog.setState({
      commits: multiLog,
      selected: multiLog[0]!.id,
      selectedRepo: "/w/repo-b",
      selection: [multiLog[0]!.id, multiLog[1]!.id],
    });
    render(<CommitDetails commits={multiLog} />);
    expect(await screen.findByText(/2 files\s*in 2 commits/)).toBeInTheDocument();
    expect(vcsCommitsChanges).toHaveBeenCalledWith("/w/repo-b", [multiLog[0]!.id]);
    expect(vcsCommitsChanges).toHaveBeenCalledWith("/w/repo-a", [multiLog[1]!.id]);
    expect(screen.getByText("a.ts")).toBeInTheDocument();
    expect(screen.getByText("b.ts")).toBeInTheDocument();
  });

  it("disambiguates identical commit SHAs across multiple clones using selectedRepo", async () => {
    vcsCommitFiles.mockResolvedValue({ status: "ok", data: [{ path: "clone.ts", kind: "modified", oldPath: null }] });
    const sharedCommit = commit("Shared commit", "7");
    const multiLog: LogCommit[] = [
      { ...sharedCommit, repo: "/w/clone-1" },
      { ...sharedCommit, repo: "/w/clone-2" },
    ];
    useVcs.setState({ root: "/w", roots: ["/w/clone-1", "/w/clone-2"], repo: "/w/clone-1" });
    useGitLog.setState({ commits: multiLog });
    selectCommit(sharedCommit.id, false, "/w/clone-2");
    render(<CommitDetails commits={multiLog} />);
    expect(await screen.findByText("1 file")).toBeInTheDocument();
    expect(vcsCommitFiles).toHaveBeenCalledWith("/w/clone-2", sharedCommit.id);
  });
});

describe("Git Log Paths filter popup", () => {
  it("renders Select…, Select in Tree…, Roots checkboxes, and Delete hint in a multi-repo project", () => {
    useVcs.setState({
      root: "/w",
      roots: ["/w/claude-howto", "/w/ecc", "/w/gstack"],
      repo: "/w/claude-howto",
    });
    render(<FilterBar />);

    fireEvent.click(screen.getByRole("button", { name: "Paths" }));
    expect(screen.getByRole("menuitem", { name: "Select…" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Select in Tree…" })).toBeInTheDocument();
    expect(screen.getByText("Roots")).toBeInTheDocument();
    expect(screen.getByText("Press Delete to clear the filter")).toBeInTheDocument();

    // All roots are checked by default
    const eccCheckbox = screen.getByRole("checkbox", { name: "Toggle ecc" });
    expect(eccCheckbox).toHaveAttribute("aria-checked", "true");

    // Clicking a root's checkbox toggles that root while keeping the popup open
    fireEvent.click(eccCheckbox);
    expect(useGitLog.getState().filters.roots).toEqual(["/w/claude-howto", "/w/gstack"]);
    expect(screen.getByRole("checkbox", { name: "Toggle ecc" })).toHaveAttribute("aria-checked", "false");

    // Clicking a root row label selects only that root and closes the popup
    fireEvent.click(screen.getByText("gstack"));
    expect(useGitLog.getState().filters.roots).toEqual(["/w/gstack"]);
    expect(screen.queryByRole("menu", { name: "Paths" })).toBeNull();
  });

  it("checks only the clicked root when toggling an unchecked root checkbox while a folder path filter is active", () => {
    useVcs.setState({
      root: "/w",
      roots: ["/w/claude-howto", "/w/ecc", "/w/gstack"],
      repo: "/w/claude-howto",
    });
    useGitLog.setState({
      filters: { ...emptyFilters(), path: "/w/claude-howto/src", roots: [] },
    });
    render(<FilterBar />);

    fireEvent.click(screen.getByRole("button", { name: "Paths: claude-howto/src" }));
    const eccCheckbox = screen.getByRole("checkbox", { name: "Toggle ecc" });
    expect(eccCheckbox).toHaveAttribute("aria-checked", "false");

    fireEvent.click(eccCheckbox);
    expect(useGitLog.getState().filters.path).toBeNull();
    expect(useGitLog.getState().filters.roots).toEqual(["/w/ecc"]);
  });
});

