import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Branch, BranchInfo, Commit, FileStatus } from "@/bindings";

const vcsStatus = vi.fn();
const vcsBranches = vi.fn();
const vcsRoots = vi.fn();
const vcsRemote = vi.fn();

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsStatus: () => vcsStatus(),
      vcsBranches: (repo: string | null) => vcsBranches(repo),
      vcsBranchInfo: async () => ({ status: "ok", data: info() }),
      vcsRoots: () => vcsRoots(),
      vcsRemote: (repo: string | null, req: number, op: unknown) => vcsRemote(repo, req, op),
    },
  };
});

import { provideNotificationService, provideToolWindowService } from "@/workbench/contributions";
import { addToVcsTargets, rollbackPlan } from "../changeOps";
import { planCommit, renamedFromPath } from "../changes";
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
import { loadBranches, refreshNow, selectRepo, useVcs } from "../store";

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
    const picked = [{ ...log[2]!, timeMs: 3 }, { ...log[0]!, timeMs: 1 }];
    expect(newestFirst(picked, log).map((c) => c.id)).toEqual(["new", "old"]);
    expect(newestFirst([commit("a"), { ...commit("b"), timeMs: 5 }], []).map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("changes the refs signature when HEAD or any branch tip moves", () => {
    const base = refsSignature(info(), [branch("main", "c3"), branch("origin/main", "c3", true)]);
    expect(refsSignature(info(), [branch("origin/main", "c3", true), branch("main", "c3")])).toBe(base);
    expect(refsSignature(info({ headCommit: "c2" }), [branch("main", "c2"), branch("origin/main", "c3", true)])).not.toBe(
      base,
    );
    expect(refsSignature(info(), [branch("main", "c3"), branch("origin/main", "c4", true)])).not.toBe(base);
    expect(refsSignature(info(), [branch("main", "c3")])).not.toBe(base);
  });
});

describe("status refresh", () => {
  beforeEach(() => {
    vcsStatus.mockReset();
    vcsBranches.mockReset();
    vcsRoots.mockReset().mockResolvedValue({ status: "ok", data: [{ root: "/p", operation: null, head: "main", headCommit: "c3" }] });
    useVcs.setState({ root: "/p", roots: ["/p"], repo: "/p", available: true, branches: [], branchesLoaded: false, stashesLoaded: false, status: [] });
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

  it("does not overwrite loaded branches when selectRepo + loadBranches finish before a slow vcsStatus refresh", async () => {
    let releaseStatus: (v: unknown) => void = () => {};
    vcsRoots.mockResolvedValue({
      status: "ok",
      data: [
        { root: "/p/repo-a", operation: null, head: "main", headCommit: "a1" },
        { root: "/p/repo-b", operation: null, head: "develop", headCommit: "b1" },
      ],
    });
    vcsStatus.mockImplementationOnce(() => new Promise((r) => (releaseStatus = r)));
    const repoBBranches = [branch("develop", "b1"), branch("origin/develop", "b1", true)];
    vcsBranches.mockImplementation(async (repo: string | null) => ({
      status: "ok",
      data: repo === "/p/repo-b" ? repoBBranches : [branch("main", "a1")],
    }));

    useVcs.setState({
      root: "/p",
      roots: ["/p/repo-a", "/p/repo-b"],
      repo: "/p/repo-a",
      branches: [branch("main", "a1")],
      branchesLoaded: true,
    });

    // Selecting repo-b starts refreshNow() (blocked on slow vcsStatus) and loads repo-b's branches quickly.
    const selecting = selectRepo("/p/repo-b");
    await loadBranches();
    expect(useVcs.getState().branches).toEqual(repoBBranches);
    expect(useVcs.getState().branchesLoaded).toBe(true);

    // When the slow multi-repo vcsStatus finally settles, it must not wipe branches back to [].
    releaseStatus({ status: "ok", data: [] });
    await selecting;
    expect(useVcs.getState().repo).toBe("/p/repo-b");
    expect(useVcs.getState().branches).toEqual(repoBBranches);
    expect(useVcs.getState().branchesLoaded).toBe(true);
    expect(useVcs.getState().branchesRepo).toBe("/p/repo-b");
  });

  it("loads final repository branches across rapid repo-a -> repo-b -> repo-c switches while repo-b is still in flight", async () => {
    let releaseRepoBBranches: (v: unknown) => void = () => {};
    const repoABranches = [branch("main", "a1")];
    const repoBBranches = [branch("develop", "b1")];
    const repoCBranches = [branch("release/pi5", "c1"), branch("origin/release/pi5", "c1", true)];
    vcsRoots.mockResolvedValue({
      status: "ok",
      data: [
        { root: "/p/repo-a", operation: null, head: "main", headCommit: "a1" },
        { root: "/p/repo-b", operation: null, head: "develop", headCommit: "b1" },
        { root: "/p/repo-c", operation: null, head: "release/pi5", headCommit: "c1" },
      ],
    });
    vcsBranches.mockImplementation((repo: string | null) => {
      if (repo === "/p/repo-b") return new Promise((r) => (releaseRepoBBranches = r));
      if (repo === "/p/repo-c") return Promise.resolve({ status: "ok", data: repoCBranches });
      return Promise.resolve({ status: "ok", data: repoABranches });
    });

    useVcs.setState({
      root: "/p",
      roots: ["/p/repo-a", "/p/repo-b", "/p/repo-c"],
      repo: "/p/repo-a",
      heads: {
        "/p/repo-a": { head: "main", headCommit: "a1" },
        "/p/repo-b": { head: "develop", headCommit: "b1" },
        "/p/repo-c": { head: "release/pi5", headCommit: "c1" },
      },
      operations: { "/p/repo-a": "merge" },
      branch: {
        head: "main",
        headCommit: "a1",
        upstream: "origin/main",
        ahead: 3,
        behind: 2,
        operation: "merge",
      },
      branches: repoABranches,
      branchesLoaded: true,
      branchesRepo: "/p/repo-a",
    });

    // Switch to repo-b (its vcsBranches stays pending), then immediately switch to repo-c.
    const p1 = selectRepo("/p/repo-b");
    expect(useVcs.getState().branch).toEqual({
      head: "develop",
      headCommit: "b1",
      upstream: null,
      ahead: 0,
      behind: 0,
      operation: null,
    });
    const p2 = selectRepo("/p/repo-c");

    // Resolve repo-b's stale vcsBranches after repo-c has already been selected.
    releaseRepoBBranches({ status: "ok", data: repoBBranches });
    await Promise.all([p1, p2]);

    expect(useVcs.getState().repo).toBe("/p/repo-c");
    expect(useVcs.getState().branches).toEqual(repoCBranches);
    expect(useVcs.getState().branchesLoaded).toBe(true);
    expect(useVcs.getState().branchesRepo).toBe("/p/repo-c");
  });
});

describe("multi-repository remote failure formatting", () => {
  it("extracts the primary error line without fatal/error prefix from multi-remote git output", () => {
    const multiRemoteStderr = [
      "fatal: unable to access 'https://atc-github.azure.cloud.bmw/CHB/ngtp-sr-iac.git/': The requested URL returned error: 999",
      "error: could not fetch origin",
      "fatal: unable to access 'https://atc-github.azure.cloud.bmw/CHB/ngtp-iac.git/': The requested URL returned error: 999",
      "error: could not fetch upstream",
    ].join("\n");
    expect(summarizeRepoError(multiRemoteStderr)).toBe(
      "unable to access 'https://atc-github.azure.cloud.bmw/CHB/ngtp-sr-iac.git/': The requested URL returned error: 999",
    );
    expect(summarizeRepoError("error: RPC failed; HTTP 502")).toBe("RPC failed; HTTP 502");
    expect(summarizeRepoError("  Connection reset by peer  ")).toBe("Connection reset by peer");
  });

  it("bounds multi-repo failure balloons to 4 repositories plus a count of remaining repositories", () => {
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
      message: `fatal: unable to access 'https://example/repo-${i + 1}.git/': The requested URL returned error: 999\nerror: could not fetch origin`,
    }));
    const formatted = formatRemoteFailures(sixteen);
    expect(formatted.split("\n")).toHaveLength(5);
    expect(formatted).toContain("…and 12 more repositories");
  });

  it("summarizes 16-repo fetch failure in the notification balloon, logs each repo once, and opens Git Console on action", async () => {
    clearConsole();
    vcsStatus.mockResolvedValue({ status: "ok", data: [] });
    vcsRoots.mockResolvedValue({ status: "ok", data: [] });
    const repos = Array.from({ length: 16 }, (_, i) => `/p/repo-${i + 1}`);
    useVcs.setState({ root: "/p", roots: repos, repo: repos[0]!, remoteBusy: null });
    vcsRemote.mockImplementation(async (repo: string) => ({
      status: "error",
      error: {
        code: "git",
        message: `fatal: unable to access 'https://example/${repo.slice(3)}.git/': The requested URL returned error: 999\nerror: could not fetch origin`,
      },
    }));

    const notified: Array<{ level: string; title: string; body?: unknown; actions?: Array<{ label: string; run: () => void }> }> = [];
    provideNotificationService({
      notify: (n) => notified.push(n),
    });
    const shownWindows: Array<{ id: string; focus?: boolean }> = [];
    provideToolWindowService({
      show: (id, focus) => shownWindows.push({ id, focus }),
      hide: () => {},
      toggle: () => {},
      isVisible: () => false,
    });
    useGitLog.setState({ tab: "log" });

    const ok = await runRemote({ op: "fetch" }, "16 repositories", repos);
    expect(ok).toBe(false);

    const errNote = notified.at(-1)!;
    expect(errNote.level).toBe("error");
    expect(errNote.title).toBe("Fetch failed");
    expect(String(errNote.body).split("\n")).toEqual([
      "repo-1: unable to access 'https://example/repo-1.git/': The requested URL returned error: 999",
      "repo-2: unable to access 'https://example/repo-2.git/': The requested URL returned error: 999",
      "repo-3: unable to access 'https://example/repo-3.git/': The requested URL returned error: 999",
      "repo-4: unable to access 'https://example/repo-4.git/': The requested URL returned error: 999",
      "…and 12 more repositories",
    ]);

    // Full raw failure is still preserved in lastRemoteFailure() and logged once per repo in the console.
    expect(lastRemoteFailure()?.split("\n")).toHaveLength(32);
    const errLines = useVcsConsole.getState().lines.filter((l) => l.kind === "err");
    expect(errLines).toHaveLength(32);

    const viewInConsole = errNote.actions?.find((a) => a.label === "View in Console");
    expect(viewInConsole).toBeDefined();
    viewInConsole!.run();
    expect(useGitLog.getState().tab).toBe("console");
    expect(shownWindows).toEqual([{ id: "git", focus: true }]);
  });
});

