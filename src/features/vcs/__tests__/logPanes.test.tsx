import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Branch, Commit } from "@/bindings";

const vcsCommitFiles = vi.fn();
const vcsTags = vi.fn();
const branchesOf = vi.fn((_repo: string | null): Branch[] => []);
const vcsRemote = vi.fn();
const vcsDeleteBranch = vi.fn();
const vcsRestoreBranch = vi.fn();

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsCommitFiles: (repo: unknown, id: string) => vcsCommitFiles(repo, id),
      vcsTags: (repo: unknown) => vcsTags(repo),
      vcsLog: () => Promise.resolve({ status: "ok", data: [] }),
      vcsConfigGet: () => Promise.resolve({ status: "ok", data: null }),
      vcsBranches: async (repo: string | null) => ({ status: "ok", data: branchesOf(repo) }),
      vcsRemote: (repo: string | null, _request: number, op: unknown) => vcsRemote(repo, op),
      vcsDeleteBranch: (repo: string | null, name: string) => vcsDeleteBranch(repo, name),
      vcsRestoreBranch: (repo: string | null, deleted: unknown) => vcsRestoreBranch(repo, deleted),
      vcsBranchInfo: async () => ({
        status: "ok",
        data: { head: "main", headCommit: "1", upstream: "origin/main", ahead: 0, behind: 0, operation: null },
      }),
      vcsStatus: async () => ({ status: "ok", data: [] }),
      vcsRoots: async () => ({
        status: "ok",
        data: useVcs.getState().roots.map((root) => ({ root, operation: null, head: "main", headCommit: "1" })),
      }),
    },
  };
});
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  Channel: class {
    onmessage: ((m: unknown) => void) | null = null;
  },
}));

import { setContext } from "@/platform/context";
import { isMacHost } from "@/platform/keymap";
import { useProject } from "@/platform/project";
import { provideNotificationService } from "@/workbench/contributions";
import { MessagesHost } from "@/workbench/messages";
import { buildBranchTree, filterBranchTree } from "../branches";
import { VcsDialogHost } from "../dialogs";
import { buildFileTree } from "../fileTree";
import { filesUnder, filterPatch, flatFileNodes, toLogChanges, useLogChanges } from "../logChanges";
import { canDeleteBranch, canUpdateBranch, registerLogPaneActions, useBranchesPane } from "../logPaneActions";
import { BranchesPanel, CommitDetails, changesMenu, graphOptionsMenu } from "../GitLog";
import { LogSettingsPage } from "../LogSettingsPage";
import { DEFAULT_LOG_OPTIONS, useLogOptions } from "../logOptions";
import { emptyFilters, useGitLog } from "../logStore";
import { useVcs } from "../store";

const b = (name: string, opts: Partial<Branch> = {}): Branch => ({
  name,
  remote: false,
  current: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  lastCommitMs: 0,
  commit: "",
  ...opts,
});

const commit: Commit = {
  id: "c".repeat(40),
  shortId: "c".repeat(8),
  parents: ["p".repeat(40)],
  author: "A",
  email: "a@example.com",
  timeMs: 0,
  summary: "Change",
  message: "Change",
  refs: [],
};

beforeEach(() => {
  vcsTags.mockResolvedValue({ status: "ok", data: [] });
});

afterEach(() => {
  useGitLog.setState({ commits: [], selection: [], selected: null, filters: emptyFilters() });
  useLogOptions.setState({ ...DEFAULT_LOG_OPTIONS });
  vcsCommitFiles.mockReset();
  vcsTags.mockReset();
});

describe("changed files model", () => {
  it("keeps the revisions before and after each file's change", () => {
    const [mod, add, del] = toLogChanges(
      [
        { path: "a.ts", kind: "modified", oldPath: null },
        { path: "b.ts", kind: "added", oldPath: null },
        { path: "c.ts", kind: "deleted", oldPath: null },
      ],
      commit,
    );
    expect([mod!.before, mod!.after]).toEqual([commit.parents[0], commit.id]);
    expect([add!.before, add!.after]).toEqual([null, commit.id]);
    expect([del!.before, del!.after]).toEqual([commit.parents[0], null]);
  });

  it("lists files without directories by name, and the files under selected directories", () => {
    const files = ["src/b.ts", "lib/a.ts", "src/x/a.ts"];
    expect(flatFileNodes(files, (f) => f).map((n) => n.key)).toEqual(["f:lib/a.ts", "f:src/x/a.ts", "f:src/b.ts"]);
    const tree = buildFileTree(files, (f) => f);
    expect(filesUnder(tree)).toEqual(["lib/a.ts", "src/x/a.ts", "src/b.ts"]);
    expect(filesUnder(tree, new Set(["d:src"]))).toEqual(["src/x/a.ts", "src/b.ts"]);
    expect(filesUnder(tree, new Set(["d:src", "f:src/b.ts"]))).toEqual(["src/x/a.ts", "src/b.ts"]);
  });

  it("keeps only the patch sections of the given files, renames by either name", () => {
    const section = (a: string, bb: string) =>
      `diff --git a/${a} b/${bb}\nindex 1..2\n--- a/${a}\n+++ b/${bb}\n@@ -1 +1 @@\n-x\n+y\n`;
    const patch = section("a.ts", "a.ts") + section("old.ts", "new.ts") + section("c.ts", "c.ts");
    expect(filterPatch(patch, new Set(["a.ts"]))).toBe(section("a.ts", "a.ts"));
    expect(filterPatch(patch, new Set(["new.ts", "c.ts"]))).toBe(section("old.ts", "new.ts") + section("c.ts", "c.ts"));
    expect(filterPatch(patch, new Set(["zzz"]))).toBe("");
  });

  it("offers Compare with Local only for a file that still exists after the change", () => {
    const [del] = toLogChanges([{ path: "c.ts", kind: "deleted", oldPath: null }], commit);
    const item = changesMenu([del!]).find((i) => "action" in i && i.action === "vcs.log.changes.compareWithLocal");
    expect(item).toMatchObject({ disabled: true });
  });
});

describe("changed files pane", () => {
  it("shows the files flat or by directory and shares the selection with its actions", async () => {
    vcsCommitFiles.mockResolvedValue({
      status: "ok",
      data: [
        { path: "src/a.ts", kind: "modified", oldPath: null },
        { path: "src/b.ts", kind: "added", oldPath: null },
      ],
    });
    useGitLog.setState({ commits: [commit], selected: commit.id, selection: [commit.id] });
    const { unmount } = render(<CommitDetails commits={[commit]} />);
    expect(await screen.findByText("src")).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByText("a.ts"));
    expect(useLogChanges.getState().selected.map((c) => c.path)).toEqual(["src/a.ts"]);
    expect(useLogChanges.getState().commits).toEqual([commit]);
    expect(screen.getByRole("button", { name: "Show Diff" })).toBeEnabled();

    useLogOptions.setState({ groupByDirectory: false });
    expect(await screen.findByText("b.ts")).toBeInTheDocument();
    // Flat: each file shows its directory instead of sitting under it.
    expect(screen.getAllByText("src")).toHaveLength(2);
    unmount();
    expect(useLogChanges.getState().selected).toEqual([]);
  });
});

describe("Branches pane", () => {
  it("lists tags in their own group, newest version first, and finds them by name", () => {
    const roots = buildBranchTree([b("main", { current: true })], null, ["v1.2", "v1.10", "v1.9"]);
    const tags = roots.find((n) => n.key === "g:tags");
    expect(tags?.children?.map((n) => n.label)).toEqual(["v1.10", "v1.9", "v1.2"]);
    expect(filterBranchTree(roots, "1.9").map((n) => n.key)).toEqual(["g:tags"]);
    expect(buildBranchTree([b("main")], null).some((n) => n.key === "g:tags")).toBe(false);
  });

  it("enables Update and Delete for the branches they apply to", () => {
    const current = b("main", { current: true });
    const tracked = b("feature", { upstream: "origin/feature" });
    expect(canDeleteBranch({ ref: "main", branch: current })).toBe(false);
    expect(canDeleteBranch({ ref: "feature", branch: tracked })).toBe(true);
    expect(canDeleteBranch({ ref: "v1" })).toBe(false);
    expect(canUpdateBranch({ ref: "feature", branch: tracked })).toBe(true);
    expect(canUpdateBranch({ ref: "x", branch: b("x") })).toBe(false);
    expect(canUpdateBranch({ ref: "origin/x", branch: b("origin/x", { remote: true }) })).toBe(false);
  });

  it("has a vertical toolbar acting on the selected branch, and shows tags", async () => {
    vcsTags.mockResolvedValue({ status: "ok", data: ["v1"] });
    useVcs.setState({
      root: "/p",
      repo: "/p",
      branchesLoaded: true,
      branches: [b("main", { current: true }), b("feature")],
      branch: { head: "main", headCommit: "1", upstream: null, ahead: 0, behind: 0, operation: null },
    });
    render(<BranchesPanel />);
    expect(screen.getByRole("toolbar", { name: "Branches" })).toHaveAttribute("aria-orientation", "vertical");
    expect(screen.getByPlaceholderText("Branch or tag")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete Branch" })).toBeDisabled();
    fireEvent.mouseDown(screen.getByText("feature"));
    expect(useBranchesPane.getState().selected.map((t) => t.ref)).toEqual(["feature"]);
    expect(screen.getByRole("button", { name: "Delete Branch" })).toBeEnabled();
    expect(await screen.findByText("Tags")).toBeInTheDocument();
  });

  it("enables Update and Delete when any selected branch qualifies", () => {
    const current = b("main", { current: true });
    const tracked = b("feature", { upstream: "origin/feature" });
    expect(canDeleteBranch([{ ref: "main", branch: current, repo: "/p/a" }])).toBe(false);
    expect(
      canDeleteBranch([
        { ref: "main", branch: current, repo: "/p/a" },
        { ref: "feature", branch: tracked, repo: "/p/b" },
      ]),
    ).toBe(true);
    expect(canUpdateBranch([{ ref: "x", branch: b("x"), repo: "/p/a" }])).toBe(false);
    expect(
      canUpdateBranch([
        { ref: "x", branch: b("x"), repo: "/p/a" },
        { ref: "feature", branch: tracked, repo: "/p/b" },
      ]),
    ).toBe(true);
  });
});

describe("Branches pane with branches selected in several repositories", () => {
  const FRONT = "/p/front";
  const BACK = "/p/back";
  let off: () => void = () => {};

  beforeEach(() => {
    off = registerLogPaneActions();
    setContext("vcsAvailable", true);
    provideNotificationService({ notify: () => {} });
    useProject.setState({ settings: { vcs: { confirmation: { showUpdateOptions: false } } } });
    branchesOf
      .mockReset()
      .mockImplementation((repo) => [
        b("main", { current: true, upstream: "origin/main", commit: "1" }),
        b("feature", { upstream: "origin/feature", commit: "2" }),
        ...(repo === BACK ? [b("origin/old", { remote: true, commit: "3" })] : []),
      ]);
    vcsRemote.mockReset().mockResolvedValue({ status: "ok", data: { summary: "ok" } });
    vcsDeleteBranch.mockReset().mockImplementation(async (_repo: string, name: string) => ({
      status: "ok",
      data: { name, tip: "2", upstream: null, unmerged: false },
    }));
    useVcs.setState({
      available: true,
      root: "/p",
      roots: [FRONT, BACK],
      repo: FRONT,
      heads: { [FRONT]: { head: "main", headCommit: "1" }, [BACK]: { head: "main", headCommit: "1" } },
      branchesLoaded: true,
      branches: branchesOf(FRONT),
      branch: { head: "main", headCommit: "1", upstream: "origin/main", ahead: 0, behind: 0, operation: null },
      remoteBusy: null,
    });
    useBranchesPane.setState({ selected: [] });
  });

  afterEach(() => off());

  /** Selects branch `name` of the Local group in each of `repos` (Local lists the repositories in order). */
  const selectLocal = async (name: string, repos: number[]) => {
    await waitFor(() => expect(screen.getAllByText(name)).toHaveLength(2));
    const rows = screen.getAllByText(name);
    repos.forEach((i, n) => fireEvent.mouseDown(rows[i]!, n ? cmd() : {}));
  };
  const cmd = () => (isMacHost() ? { metaKey: true } : { ctrlKey: true });
  const remoteCalls = () => vcsRemote.mock.calls.map(([repo, op]) => [repo, op]);

  it("Update runs in the repository of each selected branch", async () => {
    render(<BranchesPanel />);
    await selectLocal("feature", [0, 1]);
    expect(useBranchesPane.getState().selected.map((t) => [t.repo, t.ref])).toEqual([
      [FRONT, "feature"],
      [BACK, "feature"],
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Update Selected" }));
    await waitFor(() =>
      expect(remoteCalls()).toEqual([
        [FRONT, { op: "updateBranch", branch: "feature" }],
        [BACK, { op: "updateBranch", branch: "feature" }],
      ]),
    );
  });

  it("Update of current branches pulls only their repositories", async () => {
    render(<BranchesPanel />);
    await selectLocal("main", [1]);
    fireEvent.click(screen.getByRole("button", { name: "Update Selected" }));
    await waitFor(() => expect(remoteCalls()).toEqual([[BACK, { op: "pull", rebase: false }]]));
  });

  it("Delete asks once for branches selected in two repositories, then deletes each in its repository", async () => {
    render(
      <>
        <BranchesPanel />
        <VcsDialogHost />
        <MessagesHost />
      </>,
    );
    // The repositories' remote folders load collapsed: open back's origin.
    fireEvent.mouseDown(await screen.findByText("origin"));
    fireEvent.keyDown(screen.getByRole("tree", { name: "Branches" }), { key: "ArrowRight" });
    await selectLocal("feature", [0, 1]);
    fireEvent.mouseDown(await screen.findByText("old"), cmd());
    fireEvent.click(screen.getByRole("button", { name: "Delete Branch" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Branches" });
    expect(dialog).toHaveTextContent("front: feature");
    expect(dialog).toHaveTextContent("back: feature");
    expect(dialog).toHaveTextContent("back: origin/old (remote)");
    expect(vcsDeleteBranch).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(remoteCalls()).toEqual([[BACK, { op: "deleteBranch", branch: "origin/old" }]]));
    expect(vcsDeleteBranch.mock.calls).toEqual([
      [FRONT, "feature"],
      [BACK, "feature"],
    ]);
    // One confirmation: the remote branch is not confirmed again.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("review regression: deleting equal branch names retains both Restore actions", async () => {
    const { notify, useNotifications } = await import("@/workbench/notificationStore");
    useNotifications.setState({ items: [] });
    provideNotificationService({ notify });
    vcsDeleteBranch.mockImplementation(async (repo, name) => ({
      status: "ok",
      data: { name, tip: repo === FRONT ? "front-tip" : "back-tip", upstream: null, unmerged: true },
    }));
    render(
      <>
        <BranchesPanel />
        <VcsDialogHost />
        <MessagesHost />
      </>,
    );
    await selectLocal("feature", [0, 1]);
    fireEvent.click(screen.getByRole("button", { name: "Delete Branch" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Branches" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(vcsDeleteBranch).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(useNotifications.getState().items.filter((n) => n.title === "Deleted branch feature")).toHaveLength(2),
    );
  });

  it("each Restore after deleting the same name in two repositories restores it in its own repository", async () => {
    const { notify, useNotifications } = await import("@/workbench/notificationStore");
    useNotifications.setState({ items: [] });
    provideNotificationService({ notify });
    vcsRestoreBranch.mockReset().mockResolvedValue({ status: "ok", data: null });
    vcsDeleteBranch.mockImplementation(async (repo: string, name: string) => ({
      status: "ok",
      data: { name, tip: repo === FRONT ? "front-tip" : "back-tip", upstream: null, unmerged: true },
    }));
    render(
      <>
        <BranchesPanel />
        <VcsDialogHost />
        <MessagesHost />
      </>,
    );
    await selectLocal("feature", [0, 1]);
    fireEvent.click(screen.getByRole("button", { name: "Delete Branch" }));
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "Delete Branches" })).getByRole("button", { name: "Delete" }),
    );
    await waitFor(() =>
      expect(useNotifications.getState().items.filter((n) => n.title === "Deleted branch feature")).toHaveLength(2),
    );
    const deleted = useNotifications.getState().items.filter((n) => n.title === "Deleted branch feature");
    // Each balloon names its repository.
    expect(deleted.map((n) => String(n.body).split("\n")[0]).sort()).toEqual(["back", "front"]);
    for (const n of deleted) n.actions!.find((a) => a.label === "Restore")!.run();
    await waitFor(() => expect(vcsRestoreBranch).toHaveBeenCalledTimes(2));
    expect(vcsRestoreBranch.mock.calls.map(([repo, d]) => [repo, (d as { tip: string }).tip]).sort()).toEqual([
      [BACK, "back-tip"],
      [FRONT, "front-tip"],
    ]);
  });

  it("cancelling the one confirmation deletes nothing", async () => {
    render(
      <>
        <BranchesPanel />
        <VcsDialogHost />
        <MessagesHost />
      </>,
    );
    await selectLocal("feature", [0, 1]);
    fireEvent.click(screen.getByRole("button", { name: "Delete Branch" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Branches" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(vcsDeleteBranch).not.toHaveBeenCalled();
    expect(vcsRemote).not.toHaveBeenCalled();
  });
});

describe("Graph Options", () => {
  it("offers Collapse and Expand Linear Branches as two actions", () => {
    for (const collapseLinear of [false, true]) {
      const items = graphOptionsMenu({ ...DEFAULT_LOG_OPTIONS, collapseLinear });
      const actions = items.filter((i) => "action" in i).map((i) => ("action" in i ? [i.action, i.disabled] : []));
      expect(actions).toEqual([
        ["vcs.log.collapseLinear", undefined],
        ["vcs.log.expandLinear", undefined],
      ]);
    }
  });
});

describe("Settings › Version Control › Log", () => {
  it("edits the log's display options", () => {
    render(<LogSettingsPage />);
    fireEvent.click(screen.getByLabelText("Show tag names"));
    expect(useLogOptions.getState().tagNames).toBe(!DEFAULT_LOG_OPTIONS.tagNames);
    fireEvent.click(screen.getByLabelText("Hash"));
    expect(useLogOptions.getState().showHash).toBe(!DEFAULT_LOG_OPTIONS.showHash);
  });
});
