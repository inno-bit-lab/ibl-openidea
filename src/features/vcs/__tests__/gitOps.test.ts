import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Branch, BranchInfo, Commit, FileStatus } from "@/bindings";

const vcsStatus = vi.fn();
const vcsRemote = vi.fn();
const vcsLog = vi.fn();
const branchInfo = vi.fn((_repo: string | null) => info());
const vcsRoots = vi.fn((): Array<{ root: string; operation: null; head?: string; headCommit?: string }> => [
  { root: "/p", operation: null },
]);
const branchesOf = vi.fn((_repo: string | null): Branch[] => []);
const remotesOf = vi.fn((_repo: string | null) => [{ name: "origin", url: "https://example.com/r.git" }]);
/** Repository-scoped git calls of the dialogs: `[command, repo, ...args]`. */
const gitCall = vi.fn((..._args: unknown[]) => Promise.resolve({ status: "ok", data: null }));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsStatus: () => vcsStatus(),
      vcsBranchInfo: async (repo: string | null) => ({ status: "ok", data: branchInfo(repo) }),
      vcsRoots: async () => ({ status: "ok", data: vcsRoots() }),
      vcsRemote: (repo: string | null, _request: number, op: unknown) => vcsRemote(repo, op),
      vcsLog: (repo: string | null, query: unknown) => vcsLog(repo, query),
      vcsRemotes: async (repo: string | null) => ({ status: "ok", data: remotesOf(repo) }),
      vcsBranches: async (repo: string | null) => ({ status: "ok", data: branchesOf(repo) }),
      vcsMergeWith: (...a: unknown[]) => gitCall("merge", ...a),
      vcsRebaseWith: (...a: unknown[]) => gitCall("rebase", ...a),
      vcsEditRemote: (...a: unknown[]) => gitCall("editRemote", ...a),
      vcsStashPush: (...a: unknown[]) => gitCall("stash", ...a),
      vcsAddWorktree: (...a: unknown[]) => gitCall("addWorktree", ...a),
      vcsWorktrees: async () => ({ status: "ok", data: [] }),
    },
  };
});
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  Channel: class {
    onmessage: ((m: unknown) => void) | null = null;
  },
}));

import { useProject } from "@/platform/project";
import { provideNotificationService, provideToolWindowService } from "@/workbench/contributions";
import { addToVcsTargets, rollbackPlan, stashChanges } from "../changeOps";
import { planCommit, renamedFromPath } from "../changes";
import { VcsDialogHost } from "../dialogs";
import {
  showManageRemotes,
  showMergeDialog,
  showNewWorktree,
  showPullDialog,
  showRebaseDialog,
} from "../gitMenuDialogs";
import { refsSignature, useGitLog } from "../logStore";
import { newestFirst } from "../operations";
import {
  clearConsole,
  formatRemoteFailures,
  lastRemoteFailure,
  runRemote,
  summarizeRepoError,
  useVcsConsole,
} from "../ops";
import { showPushDialog, showUpdateDialog } from "../remoteUi";
import {
  headPushed,
  initialRows,
  moveRow,
  planIsNoop,
  planProblem,
  rebaseRange,
  singleCommitPlan,
  squashPlan,
  toEntries,
  undoCommitProblem,
} from "../rebasePlan";
import { refreshNow, useVcs } from "../store";

const info = (patch: Partial<BranchInfo> = {}): BranchInfo => ({
  head: "main",
  headCommit: "c3",
  upstream: null,
  ahead: 0,
  behind: 0,
  operation: null,
  ...patch,
});

const commit = (id: string, parents: string[] = [], summary = id): Commit => ({
  id,
  shortId: id.slice(0, 8),
  parents,
  author: "A",
  email: "a@example.com",
  timeMs: 0,
  summary,
  message: summary,
  refs: [],
});

const fs = (rel: string, patch: Partial<FileStatus> = {}): FileStatus => ({
  path: `/p/${rel}`,
  relPath: rel,
  staged: null,
  unstaged: null,
  renamedFrom: null,
  ...patch,
});

const branch = (name: string, commitId: string, remote = false): Branch => ({
  name,
  remote,
  current: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  lastCommitMs: 0,
  commit: commitId,
});

describe("commit plan and rollback with renames", () => {
  const renamed = fs("src/new.ts", { staged: "renamed", renamedFrom: "src/old.ts" });

  it("resolves the absolute source of a rename", () => {
    expect(renamedFromPath(renamed)).toBe("/p/src/old.ts");
    expect(renamedFromPath(fs("a.ts"))).toBeNull();
  });

  it("unstages both sides of an excluded rename so the deletion is not committed alone", () => {
    const plan = planCommit([renamed], new Map([[renamed.path, "none"]]));
    expect(plan.unstage).toEqual(["/p/src/new.ts", "/p/src/old.ts"]);
    expect(plan.included).toEqual([]);
  });

  it("rolls back renames on both paths and keeps added files unless asked", () => {
    const added = fs("added.ts", { staged: "added" });
    const modified = fs("m.ts", { staged: "modified", unstaged: "modified" });
    const conflicted = fs("c.ts", { unstaged: "conflicted" });
    expect(rollbackPlan([renamed, added, modified, conflicted], false)).toEqual({
      unstage: ["/p/src/new.ts", "/p/src/old.ts", "/p/added.ts", "/p/m.ts"],
      discard: ["/p/src/new.ts", "/p/src/old.ts", "/p/m.ts", "/p/c.ts"],
    });
    expect(rollbackPlan([added], true).discard).toEqual(["/p/added.ts"]);
  });
});

describe("Add to VCS", () => {
  it("adds only unversioned files, also below a selected directory", () => {
    const status = [
      fs("dir/new.ts", { unstaged: "untracked" }),
      fs("dir/sub/n2.ts", { unstaged: "untracked" }),
      fs("dir/tracked.ts", { unstaged: "modified" }),
      fs("other.ts", { unstaged: "untracked" }),
    ];
    expect(addToVcsTargets(["/p/dir"], status)).toEqual(["/p/dir/new.ts", "/p/dir/sub/n2.ts"]);
    expect(addToVcsTargets(["/p/dir/tracked.ts", "/p/other.ts"], status)).toEqual(["/p/other.ts"]);
    expect(addToVcsTargets(["/p/di"], status)).toEqual([]);
  });
});

describe("Undo Commit", () => {
  it("is offered for the latest non-merge commit only", () => {
    expect(undoCommitProblem(commit("c3", ["c2"]), info())).toBeNull();
    expect(undoCommitProblem(commit("c2", ["c1"]), info())).toMatch(/latest commit/);
    expect(undoCommitProblem(commit("c3", ["c2", "x"]), info())).toMatch(/merge commit/);
    expect(undoCommitProblem(commit("c3", ["c2"]), info({ operation: "rebase" }))).toMatch(/rebase is in progress/);
    expect(undoCommitProblem(commit("c3"), info())).toBeNull();
    expect(undoCommitProblem(commit("c3"), info({ head: null }))).toMatch(/detached/);
  });

  it("warns when HEAD is already pushed", () => {
    expect(headPushed(info({ upstream: "origin/main", ahead: 0 }))).toBe(true);
    expect(headPushed(info({ upstream: "origin/main", ahead: 1 }))).toBe(false);
    expect(headPushed(info())).toBe(false);
  });
});

describe("interactive rebase plan", () => {
  const history = [commit("c4", ["c3"]), commit("c3", ["c2"]), commit("c2", ["c1"]), commit("c1")];

  it("takes the commits from the target to HEAD, oldest first", () => {
    const range = rebaseRange(history[2]!, history);
    expect(range).toEqual({ base: "c1", commits: [history[2], history[1], history[0]] });
    expect(rebaseRange(history[3]!, history)).toMatchObject({ base: null });
    expect(rebaseRange(commit("zz", ["c1"]), history)).toEqual({ error: "The commit is not in the current branch" });
    const merged = [commit("m", ["c2", "x"]), ...history.slice(2)];
    expect(rebaseRange(history[2]!, merged)).toMatchObject({ error: expect.stringMatching(/merge commits/) });
  });

  it("validates, reorders and serialises the plan", () => {
    const commits = [history[2]!, history[1]!, history[0]!];
    let rows = initialRows(commits);
    expect(planIsNoop(rows, commits)).toBe(true);
    expect(planProblem(rows)).toBeNull();
    rows = moveRow(rows, 2, -1);
    expect(rows.map((r) => r.commit.id)).toEqual(["c2", "c4", "c3"]);
    expect(moveRow(rows, 0, -1).map((r) => r.commit.id)).toEqual(["c2", "c4", "c3"]);
    expect(planIsNoop(rows, commits)).toBe(false);

    rows = rows.map((r, i) => (i === 0 ? { ...r, action: "squash" as const } : r));
    expect(planProblem(rows)).toMatch(/first commit cannot be squashed/);
    rows = rows.map((r, i) => (i === 0 ? { ...r, action: "drop" as const } : r));
    expect(planProblem(rows)).toBeNull();
    rows = rows.map((r, i) => (i === 1 ? { ...r, action: "fixup" as const } : r));
    expect(planProblem(rows)).toMatch(/fixed up/);
    rows = rows.map((r, i) => (i === 1 ? { ...r, action: "reword" as const, message: "  " } : r));
    expect(planProblem(rows)).toMatch(/needs a message/);
    rows = rows.map((r, i) => (i === 1 ? { ...r, message: " new message " } : r));
    expect(toEntries(rows)).toEqual([
      { commit: "c2", action: "drop", message: null },
      { commit: "c4", action: "reword", message: "new message" },
      { commit: "c3", action: "pick", message: null },
    ]);
    expect(planProblem(rows.map((r) => ({ ...r, action: "drop" as const })))).toMatch(/At least one/);
  });

  it("builds single-commit plans for Edit Commit Message and Drop Commit", () => {
    const range = { base: "c1", commits: [history[2]!, history[1]!] };
    expect(singleCommitPlan(range, "c3", "reword", "msg\n")).toEqual([
      { commit: "c2", action: "pick", message: null },
      { commit: "c3", action: "reword", message: "msg" },
    ]);
    expect(singleCommitPlan(range, "c2", "drop").map((e) => e.action)).toEqual(["drop", "pick"]);
  });

  it("autosquashes fixup! / squash! commits after their target", () => {
    const commits = [
      commit("a1", [], "Add parser"),
      commit("b2", ["a1"], "Add lexer"),
      commit("c3", ["b2"], "fixup! Add parser"),
      commit("d4", ["c3"], "squash! Add lexer"),
      commit("e5", ["d4"], "fixup! fixup! Add parser"),
      commit("f6", ["e5"], "fixup! Unknown"),
    ];
    const rows = initialRows(commits);
    expect(rows.map((r) => `${r.action}:${r.commit.id}`)).toEqual([
      "pick:a1",
      "fixup:c3",
      "fixup:e5",
      "pick:b2",
      "squash:d4",
      "pick:f6",
    ]);
    expect(planIsNoop(rows, commits)).toBe(false);
  });

  it("squashes selected commits into the oldest one's position", () => {
    const range = { base: "c1", commits: [history[2]!, history[1]!, history[0]!] };
    expect(squashPlan(range, new Set(["c2", "c4"]), " merged \n")).toEqual([
      { commit: "c2", action: "pick", message: null },
      { commit: "c4", action: "squash", message: "merged" },
      { commit: "c3", action: "pick", message: null },
    ]);
  });
});

describe("log ordering and staleness", () => {
  it("orders commits by their position in the log, not by date", () => {
    const log = [commit("new"), commit("mid"), commit("old")];
    const picked = [
      { ...log[2]!, timeMs: 3 },
      { ...log[0]!, timeMs: 1 },
    ];
    expect(newestFirst(picked, log).map((c) => c.id)).toEqual(["new", "old"]);
    expect(newestFirst([commit("a"), { ...commit("b"), timeMs: 5 }], []).map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("changes the refs signature when HEAD or any branch tip moves", () => {
    const base = refsSignature(info(), [branch("main", "c3"), branch("origin/main", "c3", true)]);
    expect(refsSignature(info(), [branch("origin/main", "c3", true), branch("main", "c3")])).toBe(base);
    expect(
      refsSignature(info({ headCommit: "c2" }), [branch("main", "c2"), branch("origin/main", "c3", true)]),
    ).not.toBe(base);
    expect(refsSignature(info(), [branch("main", "c3"), branch("origin/main", "c4", true)])).not.toBe(base);
    expect(refsSignature(info(), [branch("main", "c3")])).not.toBe(base);
  });
});

describe("status refresh", () => {
  beforeEach(() => {
    vcsStatus.mockReset();
    useVcs.setState({ available: true, branchesLoaded: false, stashesLoaded: false, status: [] });
  });

  it("a refresh requested while one is running resolves only after a newer refresh", async () => {
    let release: (v: unknown) => void = () => {};
    vcsStatus
      .mockImplementationOnce(() => new Promise((r) => (release = r)))
      .mockImplementationOnce(async () => ({ status: "ok", data: [fs("after.ts", { unstaged: "modified" })] }));
    const first = refreshNow();
    await Promise.resolve();
    // An operation finished while the first refresh was in flight.
    const second = refreshNow();
    const third = refreshNow();
    expect(third).toBe(second);
    release({ status: "ok", data: [fs("before.ts", { unstaged: "modified" })] });
    await first;
    await second;
    expect(useVcs.getState().status.map((f) => f.relPath)).toEqual(["after.ts"]);
    expect(vcsStatus).toHaveBeenCalledTimes(2);
  });
});

type Notice = { level: string; title: string; body?: unknown; actions?: Array<{ label: string; run: () => void }> };

describe("multi-repository remote failure formatting", () => {
  it("extracts the primary error line without its fatal/error prefix", () => {
    const multiRemoteStderr = [
      "fatal: unable to access 'https://example.com/a.git/': The requested URL returned error: 999",
      "error: could not fetch origin",
      "fatal: unable to access 'https://example.com/b.git/': The requested URL returned error: 999",
      "error: could not fetch upstream",
    ].join("\n");
    expect(summarizeRepoError(multiRemoteStderr)).toBe(
      "unable to access 'https://example.com/a.git/': The requested URL returned error: 999",
    );
    expect(summarizeRepoError("error: RPC failed; HTTP 502")).toBe("RPC failed; HTTP 502");
    expect(summarizeRepoError("  Connection reset by peer  ")).toBe("Connection reset by peer");
  });

  it("bounds the failures to 4 repositories plus a count of the others", () => {
    const two = [
      { name: "chb", message: "fatal: unable to access 'https://example/chb.git/': error 999" },
      { name: "ecs", message: "fatal: unable to access 'https://example/ecs.git/': error 999" },
    ];
    expect(formatRemoteFailures(two)).toBe(
      "chb: unable to access 'https://example/chb.git/': error 999\necs: unable to access 'https://example/ecs.git/': error 999",
    );
    const five = Array.from({ length: 5 }, (_, i) => ({
      name: `repo-${i + 1}`,
      message: `fatal: network unreachable (${i + 1})`,
    }));
    expect(formatRemoteFailures(five)).toBe(
      [
        "repo-1: network unreachable (1)",
        "repo-2: network unreachable (2)",
        "repo-3: network unreachable (3)",
        "repo-4: network unreachable (4)",
        "…and 1 more repository",
      ].join("\n"),
    );
    const sixteen = Array.from({ length: 16 }, (_, i) => ({
      name: `repo-${i + 1}`,
      message: `fatal: unable to access 'https://example/repo-${i + 1}.git/': error 999\nerror: could not fetch origin`,
    }));
    const formatted = formatRemoteFailures(sixteen);
    expect(formatted.split("\n")).toHaveLength(5);
    expect(formatted).toContain("…and 12 more repositories");
  });

  it("summarizes a 16-repository fetch failure in the balloon, keeps the full output, and opens the Git console", async () => {
    clearConsole();
    vcsStatus.mockResolvedValue({ status: "ok", data: [] });
    const repos = Array.from({ length: 16 }, (_, i) => `/p/repo-${i + 1}`);
    useVcs.setState({ available: true, root: "/p", roots: repos, repo: repos[0]!, remoteBusy: null });
    vcsRemote.mockReset().mockImplementation(async (repo: string) => ({
      status: "error",
      error: {
        code: "git",
        message: `fatal: unable to access 'https://example/${repo.slice(3)}.git/': The requested URL returned error: 999\nerror: could not fetch origin`,
      },
    }));
    const notified: Notice[] = [];
    provideNotificationService({ notify: (n) => void notified.push(n) });
    const shown: Array<{ id: string; focus?: boolean }> = [];
    provideToolWindowService({
      show: (id, focus) => void shown.push({ id, focus }),
      hide: () => {},
      toggle: () => {},
      isVisible: () => false,
    });
    useGitLog.setState({ tab: "log" });

    expect(await runRemote({ op: "fetch" }, "16 repositories", repos)).toBe(false);

    const error = notified.at(-1)!;
    expect(error).toMatchObject({ level: "error", title: "Fetch failed" });
    expect(String(error.body).split("\n")).toEqual([
      "repo-1: unable to access 'https://example/repo-1.git/': The requested URL returned error: 999",
      "repo-2: unable to access 'https://example/repo-2.git/': The requested URL returned error: 999",
      "repo-3: unable to access 'https://example/repo-3.git/': The requested URL returned error: 999",
      "repo-4: unable to access 'https://example/repo-4.git/': The requested URL returned error: 999",
      "…and 12 more repositories",
    ]);
    // The full output stays available: in lastRemoteFailure() and once per repository in the console.
    expect(lastRemoteFailure()?.split("\n")).toHaveLength(32);
    expect(useVcsConsole.getState().lines.filter((l) => l.kind === "err")).toHaveLength(32);

    error.actions!.find((a) => a.label === "View in Console")!.run();
    await waitFor(() => expect(useGitLog.getState().tab).toBe("console"));
    expect(shown).toEqual([{ id: "git", focus: true }]);
  });
});

describe("Update Project and Push scoped to repositories", () => {
  const ROOTS = ["/p/a", "/p/b", "/p/c"];
  const outgoing = { ...commit("o1"), summary: "outgoing change" };

  beforeEach(() => {
    vcsStatus.mockReset().mockResolvedValue({ status: "ok", data: [] });
    vcsRemote.mockReset().mockResolvedValue({ status: "ok", data: { summary: "ok" } });
    vcsLog.mockReset().mockResolvedValue({ status: "ok", data: [outgoing] });
    branchInfo.mockReset().mockImplementation(() => info({ upstream: "origin/main" }));
    vcsRoots
      .mockReset()
      .mockReturnValue(ROOTS.map((root) => ({ root, operation: null, head: "main", headCommit: "c3" })));
    provideNotificationService({ notify: () => {} });
    useProject.setState({ settings: { vcs: { confirmation: { showUpdateOptions: false } } } });
    useVcs.setState({
      available: true,
      root: "/p",
      roots: ROOTS,
      repo: "/p/a",
      branch: info({ upstream: "origin/main" }),
      remoteBusy: null,
    });
  });

  const pulled = () => vcsRemote.mock.calls.map(([repo, op]) => [repo, op]);

  it("Update Project without the options dialog pulls at once in the one chosen repository", async () => {
    render(createElement(VcsDialogHost));
    showUpdateDialog({ repo: "/p/b" });
    await waitFor(() => expect(pulled()).toEqual([["/p/b", { op: "pull", rebase: false }]]));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("pulls only the chosen subset, with the configured update method", async () => {
    useProject.setState({
      settings: { vcs: { git: { updateMethod: "rebase" }, confirmation: { showUpdateOptions: false } } },
    });
    showUpdateDialog({ repos: ["/p/a", "/p/c"] });
    await waitFor(() =>
      expect(pulled()).toEqual([
        ["/p/a", { op: "pull", rebase: true }],
        ["/p/c", { op: "pull", rebase: true }],
      ]),
    );
  });

  it("without a target updates every repository", async () => {
    showUpdateDialog();
    await waitFor(() => expect(pulled().map(([repo]) => repo)).toEqual(ROOTS));
  });

  it("the Update Project dialog keeps the chosen repository", async () => {
    useProject.setState({ settings: { vcs: { confirmation: { showUpdateOptions: true } } } });
    render(createElement(VcsDialogHost));
    showUpdateDialog({ repo: "/p/c" });
    const dialog = await screen.findByRole("dialog", { name: "Update Project" });
    fireEvent.click(within(dialog).getByRole("button", { name: "OK" }));
    await waitFor(() => expect(pulled()).toEqual([["/p/c", { op: "pull", rebase: false }]]));
  });

  it("Push for a subset lists and pushes only those repositories", async () => {
    render(createElement(VcsDialogHost));
    void showPushDialog({ repos: ["/p/a", "/p/c"] });
    const dialog = await screen.findByRole("dialog", { name: "Push Commits" });
    await within(dialog).findByText("a");
    expect(within(dialog).getByText("c")).toBeInTheDocument();
    expect(within(dialog).queryByText("b")).not.toBeInTheDocument();
    expect(vcsLog.mock.calls.map(([repo]) => repo).sort()).toEqual(["/p/a", "/p/c"]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Push" }));
    await waitFor(() =>
      expect(vcsRemote.mock.calls.map(([repo, op]) => [repo, (op as { op: string }).op])).toEqual([
        ["/p/a", "push"],
        ["/p/c", "push"],
      ]),
    );
  });

  it("Push for one repository opens that repository's push dialog", async () => {
    render(createElement(VcsDialogHost));
    void showPushDialog({ repo: "/p/b" });
    const dialog = await screen.findByRole("dialog", { name: "Push Commits to origin/main" });
    expect(useVcs.getState().repo).toBe("/p/b");
    await within(dialog).findByText("outgoing change");
    expect(vcsLog.mock.calls.map(([repo]) => repo)).toEqual(["/p/b"]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Push" }));
    await waitFor(() =>
      expect(vcsRemote.mock.calls.map(([repo, op]) => [repo, (op as { op: string }).op])).toEqual([["/p/b", "push"]]),
    );
  });
});

describe("Git dialogs: repository picker", () => {
  const ROOTS = ["/p/a", "/p/b", "/p/c"];

  beforeEach(() => {
    vcsStatus.mockReset().mockResolvedValue({ status: "ok", data: [] });
    vcsRemote.mockReset().mockResolvedValue({ status: "ok", data: { summary: "ok" } });
    gitCall.mockClear();
    branchInfo.mockReset().mockImplementation(() => info({ upstream: "origin/main" }));
    branchesOf
      .mockReset()
      .mockImplementation((repo) =>
        repo === "/p/a"
          ? [{ ...branch("main", "c3"), current: true }]
          : [{ ...branch("main", "c3"), current: true }, branch("feature", "c4"), branch("origin/main", "c3", true)],
      );
    remotesOf.mockReset().mockImplementation(() => [{ name: "origin", url: "https://example.com/r.git" }]);
    provideNotificationService({ notify: () => {} });
    useProject.setState({ settings: {} });
    useVcs.setState({
      available: true,
      root: "/p",
      roots: ROOTS,
      repo: "/p/a",
      branch: info({ upstream: "origin/main" }),
      remoteBusy: null,
    });
  });

  const pick = async (dialog: HTMLElement, label: string, option: RegExp) => {
    fireEvent.click(within(dialog).getByLabelText(label));
    fireEvent.click(await screen.findByRole("option", { name: option }));
  };
  const repoCalls = (command: string) => gitCall.mock.calls.filter(([c]) => c === command).map(([, repo]) => repo);

  it("Pull pulls into the picked repository", async () => {
    render(createElement(VcsDialogHost));
    showPullDialog();
    const dialog = await screen.findByRole("dialog", { name: /^Pull to/ });
    await pick(dialog, "Repository", /^b/);
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Pull" })).toBeEnabled());
    fireEvent.click(within(dialog).getByRole("button", { name: "Pull" }));
    await waitFor(() =>
      expect(vcsRemote.mock.calls.map(([repo, op]) => [repo, (op as { op: string }).op])).toEqual([
        ["/p/b", "pullFrom"],
      ]),
    );
  });

  it("Merge offers and merges the picked repository's branches", async () => {
    render(createElement(VcsDialogHost));
    showMergeDialog();
    const dialog = await screen.findByRole("dialog", { name: /^Merge into/ });
    await pick(dialog, "Repository", /^b/);
    await pick(dialog, "Branch to merge", /^feature/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Merge" }));
    await waitFor(() => expect(repoCalls("merge")).toEqual(["/p/b"]));
    expect(gitCall.mock.calls.find(([c]) => c === "merge")?.[2]).toEqual(["feature"]);
  });

  it("Rebase rebases the picked repository", async () => {
    render(createElement(VcsDialogHost));
    showRebaseDialog();
    const dialog = await screen.findByRole("dialog", { name: "Rebase" });
    await pick(dialog, "Repository", /^c/);
    await pick(dialog, "Upstream", /^feature/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Rebase" }));
    await waitFor(() => expect(repoCalls("rebase")).toEqual(["/p/c"]));
  });

  it("Stash stashes the picked repository's changes", async () => {
    render(createElement(VcsDialogHost));
    void stashChanges();
    const dialog = await screen.findByRole("dialog", { name: "Stash" });
    await pick(dialog, "Repository", /^b/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Create Stash" }));
    await waitFor(() => expect(repoCalls("stash")).toEqual(["/p/b"]));
  });

  it("New Worktree creates the worktree of the picked repository", async () => {
    render(createElement(VcsDialogHost));
    showNewWorktree();
    const dialog = await screen.findByRole("dialog", { name: "New Worktree" });
    await pick(dialog, "Repository", /^c/);
    await pick(dialog, "Check out", /^feature/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(repoCalls("addWorktree")).toEqual(["/p/c"]));
    expect(gitCall.mock.calls.find(([c]) => c === "addWorktree")?.slice(2)).toEqual([
      "/p/c-feature-wt",
      "feature",
      "feature-wt",
    ]);
  });

  it("Manage Remotes groups remotes by repository and adds a remote to the chosen one", async () => {
    remotesOf.mockImplementation((repo) =>
      repo === "/p/a" ? [{ name: "origin", url: "https://example.com/a.git" }] : [],
    );
    render(createElement(VcsDialogHost));
    showManageRemotes("/p/b");
    const dialog = await screen.findByRole("dialog", { name: "Git Remotes" });
    await within(dialog).findByText("https://example.com/a.git");
    for (const name of ["a", "b", "c"]) expect(within(dialog).getByRole("group", { name })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Add Remote…" }));
    const define = await screen.findByRole("dialog", { name: "Define Remote" });
    fireEvent.change(within(define).getByLabelText("URL"), { target: { value: "https://example.com/b.git" } });
    fireEvent.click(within(define).getByRole("button", { name: "OK" }));
    await waitFor(() =>
      expect(gitCall.mock.calls.filter(([c]) => c === "editRemote").map(([, ...rest]) => rest)).toEqual([
        ["/p/b", { op: "add", name: "origin", url: "https://example.com/b.git" }],
      ]),
    );
  });

  it("shows no picker for a single repository", async () => {
    useVcs.setState({ roots: ["/p"], repo: "/p" });
    render(createElement(VcsDialogHost));
    showMergeDialog();
    const dialog = await screen.findByRole("dialog", { name: /^Merge into/ });
    expect(within(dialog).queryByLabelText("Repository")).not.toBeInTheDocument();
  });
});
