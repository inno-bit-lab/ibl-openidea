import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Branch, BranchInfo } from "@/bindings";
import { isMacHost } from "@/platform/keymap";

const vcsBranches = vi.fn();
const vcsCheckout = vi.fn();
const vcsRemote = vi.fn();
const vcsRemotes = vi.fn();
const vcsEditRemote = vi.fn();
const vcsDeleteBranch = vi.fn();

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsLog: () => Promise.resolve({ status: "ok", data: [] }),
      vcsConfigGet: () => Promise.resolve({ status: "ok", data: null }),
      vcsBranches: (repo: string | null) => vcsBranches(repo),
      vcsCheckout: (repo: string | null, rev: string, create: boolean, opts: unknown) =>
        vcsCheckout(repo, rev, create, opts),
      vcsRemote: (repo: string | null, _request: number, req: unknown) => vcsRemote(repo, req),
      vcsRemotes: (repo: string | null) => vcsRemotes(repo),
      vcsEditRemote: (repo: string | null, req: unknown) => vcsEditRemote(repo, req),
      vcsDeleteBranch: (repo: string | null, name: string, force: boolean) => vcsDeleteBranch(repo, name, force),
      vcsBranchInfo: () => Promise.resolve({ status: "ok", data: { ...head, upstream: "origin/main" } }),
      vcsRoots: () =>
        Promise.resolve({
          status: "ok",
          data: (useVcs.getState().roots.length ? useVcs.getState().roots : ["/p"]).map((root) => ({
            root,
            operation: null,
            head: useVcs.getState().heads[root]?.head ?? "main",
            headCommit: useVcs.getState().heads[root]?.headCommit ?? "1",
          })),
        }),
      vcsStatus: () => Promise.resolve({ status: "ok", data: [] }),
    },
  };
});

import { ContextMenuHost, hideContextMenu } from "@/ui/Menu";
import { argRepos, registerVcsActions } from "../actions";
import { BranchWidget, useBranchesPopup } from "../BranchWidget";
import { branchMenu, inRepo } from "../branchMenu";
import { updateBranch, useFavoriteBranches } from "../branchOps";
import * as messagesMod from "@/workbench/messages";
import { VcsDialogHost, closeAllDialogs } from "../dialogs";

const MessageHost = Object.entries(messagesMod).find(([k, v]) => /^[A-Z]/.test(k) && typeof v === "function")?.[1] as
  | (() => JSX.Element | null)
  | undefined;
import { showManageRemotes } from "../gitMenuDialogs";
import { BranchesPanel } from "../GitLog";
import { emptyFilters, selectCommit, useGitLog } from "../logStore";
import { updateProject } from "../remoteUi";
import { refreshNow, useVcs } from "../store";

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

const branches = [b("main", { current: true, commit: "1" }), b("feature", { commit: "2" })];

const head: BranchInfo = {
  head: "main",
  headCommit: "1",
  upstream: null,
  ahead: 0,
  behind: 0,
  operation: null,
};

const writeText = vi.fn().mockResolvedValue(undefined);
/** The copy modifier on this host: ⌘ on macOS, Ctrl elsewhere. */
const cmd = () => (isMacHost() ? { metaKey: true } : { ctrlKey: true });

beforeEach(async () => {
  hideContextMenu();
  closeAllDialogs();
  vcsBranches.mockReset().mockImplementation(async () => ({ status: "ok", data: useVcs.getState().branches }));
  await refreshNow();
  writeText.mockClear();
  vcsCheckout.mockReset().mockResolvedValue({ status: "ok", data: { kind: "done" } });
  vcsRemote.mockReset().mockResolvedValue({ status: "ok", data: { summary: "Already up to date." } });
  vcsRemotes.mockReset().mockResolvedValue({ status: "ok", data: [] });
  vcsEditRemote.mockReset().mockResolvedValue({ status: "ok", data: null });
  vcsDeleteBranch.mockReset().mockResolvedValue({ status: "ok", data: { unmergedCommit: null } });
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  useVcs.setState({ root: "/p", roots: [], heads: {}, repo: "/p", branches, branchesLoaded: true, branchesRepo: null, branch: head });
  useGitLog.setState({ filters: emptyFilters() });
  useFavoriteBranches.setState({ names: ["main"] });
});

describe("Git Log branches pane", () => {
  it("one click only selects the branch", () => {
    render(<BranchesPanel />);
    fireEvent.mouseDown(screen.getByText("feature"));
    expect(useGitLog.getState().filters.branches).toEqual([]);
    expect(screen.getByText("feature").closest("[data-row]")).toHaveAttribute("aria-selected", "true");
  });

  it("double click switches the log to that branch", () => {
    render(<BranchesPanel />);
    fireEvent.doubleClick(screen.getByText("feature"));
    expect(useGitLog.getState().filters.branches).toEqual(["feature"]);
  });

  it("double click on the current branch switches to its log too", () => {
    render(<BranchesPanel />);
    fireEvent.doubleClick(screen.getByText("main"));
    expect(useGitLog.getState().filters.branches).toEqual(["main"]);
  });

  it("double click on HEAD shows HEAD's log", () => {
    render(<BranchesPanel />);
    fireEvent.doubleClick(screen.getByText("HEAD (Current Branch)"));
    expect(useGitLog.getState().filters.branches).toEqual(["HEAD"]);
  });

  it("Enter switches the log to every selected branch, in tree order", () => {
    useVcs.setState({ branches: [b("main", { current: true }), b("beta"), b("alpha")] });
    render(<BranchesPanel />);
    fireEvent.mouseDown(screen.getByText("beta"));
    fireEvent.mouseDown(screen.getByText("alpha"), cmd());
    expect(useGitLog.getState().filters.branches).toEqual([]);
    fireEvent.keyDown(screen.getByRole("tree", { name: "Branches" }), { key: "Enter" });
    expect(useGitLog.getState().filters.branches).toEqual(["alpha", "beta"]);
  });

  it("follows the log filter when it changes elsewhere", () => {
    render(<BranchesPanel />);
    fireEvent.mouseDown(screen.getByText("main"));
    act(() => useGitLog.setState({ filters: { ...emptyFilters(), branches: ["feature"] } }));
    expect(screen.getByText("feature").closest("[data-row]")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("main").closest("[data-row]")).toHaveAttribute("aria-selected", "false");
  });

  it("copies the selected branch name", async () => {
    render(<BranchesPanel />);
    fireEvent.mouseDown(screen.getByText("feature"));
    fireEvent.keyDown(screen.getByText("feature"), { key: "c", ...cmd() });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("feature"));
  });

  it("copies HEAD as HEAD", async () => {
    render(<BranchesPanel />);
    fireEvent.mouseDown(screen.getByText("HEAD (Current Branch)"));
    fireEvent.keyDown(screen.getByText("HEAD (Current Branch)"), { key: "c", ...cmd() });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("HEAD"));
  });

  it("copies the folder path along with the branch name", async () => {
    useVcs.setState({
      branches: [b("feat/idea-parity", { current: true, commit: "1" })],
      branch: { ...head, head: "feat/idea-parity" },
    });
    render(<BranchesPanel />);
    fireEvent.mouseDown(screen.getByText("idea-parity"));
    fireEvent.keyDown(screen.getByText("idea-parity"), { key: "c", ...cmd() });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("feat/idea-parity"));
  });

  it("copies every selected branch, one per line, in tree order", async () => {
    useVcs.setState({ branches: [b("main", { current: true }), b("beta"), b("alpha")] });
    render(<BranchesPanel />);
    fireEvent.mouseDown(screen.getByText("beta"), cmd());
    fireEvent.mouseDown(screen.getByText("alpha"), cmd());
    fireEvent.keyDown(screen.getByText("alpha"), { key: "c", ...cmd() });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("alpha\nbeta"));
  });

  it("leaves Cmd/Ctrl+C in the branch search field alone", async () => {
    render(<BranchesPanel />);
    fireEvent.mouseDown(screen.getByText("feature"));
    fireEvent.keyDown(screen.getByLabelText("Filter branches"), { key: "c", ...cmd() });
    await Promise.resolve();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("loads the selected commit's repository branches without emptying the branches tree in a multi-repo project", async () => {
    vcsBranches.mockImplementation(async (repo: string | null) => ({
      status: "ok",
      data:
        repo === "/p/xcs"
          ? [b("develop", { current: true, commit: "91668f10b" }), b("origin/develop", { remote: true, commit: "91668f10b" })]
          : branches,
    }));
    useVcs.setState({
      available: true,
      root: "/p",
      roots: ["/p/chb", "/p/xcs"],
      repo: "/p/chb",
      heads: {
        "/p/chb": { head: "main", headCommit: "1" },
        "/p/xcs": { head: "develop", headCommit: "91668f10b" },
      },
      branches,
      branchesLoaded: true,
      branch: head,
    });
    render(<BranchesPanel />);
    expect(screen.getByText("Local")).toBeInTheDocument();
    expect(screen.getByText("feature")).toBeInTheDocument();

    act(() => selectCommit("91668f10b", false, "/p/xcs"));
    await waitFor(() => expect(screen.getAllByText("develop")).toHaveLength(2));
    expect(screen.getByText("Local")).toBeInTheDocument();
    expect(screen.getByText("Remote")).toBeInTheDocument();
    expect(screen.getByText("origin")).toBeInTheDocument();
  });

  it("aggregates branches across repositories with checked-out repo names and scopes to a single filtered root", async () => {
    const byRepo: Record<string, Branch[]> = {
      "/p/appcall-iac": [b("main", { current: true, commit: "1" })],
      "/p/chb": [
        b("main", { commit: "1" }),
        b("release/2026-PI5", { current: true, commit: "2" }),
        b("release/2026-PI2-1", { behind: 1, commit: "3" }),
      ],
      "/p/xcs": [
        b("release/2026-PI5", { current: true, commit: "2" }),
        b("release/2026-PI2-1", { behind: 3, commit: "3" }),
        b("release/2026-PI4-2", { behind: 16, commit: "4" }),
      ],
    };
    vcsBranches.mockImplementation(async (repo: string | null) => ({
      status: "ok",
      data: (repo && byRepo[repo]) ?? [],
    }));
    useVcs.setState({
      available: true,
      root: "/p",
      roots: ["/p/appcall-iac", "/p/chb", "/p/xcs"],
      repo: "/p/chb",
      heads: {
        "/p/appcall-iac": { head: "main", headCommit: "1" },
        "/p/chb": { head: "release/2026-PI5", headCommit: "2" },
        "/p/xcs": { head: "release/2026-PI5", headCommit: "2" },
      },
      branches: byRepo["/p/chb"]!,
      branchesLoaded: true,
      branchesRepo: "/p/chb",
      branch: { ...head, head: "release/2026-PI5" },
    });
    render(<BranchesPanel />);

    await waitFor(() => expect(screen.getByText("(appcall-iac)")).toBeInTheDocument());
    expect(screen.getByText("2026-PI5")).toBeInTheDocument();
    expect(screen.getByText("(chb, xcs)")).toBeInTheDocument();
    expect(screen.getByText("(chb, xcs) ↓4")).toBeInTheDocument();
    expect(screen.getByText("(xcs) ↓16")).toBeInTheDocument();

    // Filtering Paths › Roots to a single repository shows only that repository's branches.
    act(() => useGitLog.setState({ filters: { ...emptyFilters(), roots: ["/p/appcall-iac"] } }));
    await waitFor(() => expect(screen.getByText("current")).toBeInTheDocument());
    expect(screen.queryByText("2026-PI5")).not.toBeInTheDocument();
  });

  it("scopes multi-repo context menu actions to the repositories containing the branch and protects checked-out roots", async () => {
    const byRepo: Record<string, Branch[]> = {
      "/p/appcall-iac": [b("main", { current: true, commit: "1" })],
      "/p/chb": [
        b("main", { commit: "1" }),
        b("release/2026-PI5", { current: true, commit: "2" }),
        b("release/2026-PI2-1", { behind: 1, commit: "3" }),
      ],
      "/p/xcs": [
        b("release/2026-PI5", { current: true, commit: "2" }),
        b("release/2026-PI2-1", { behind: 3, commit: "3" }),
      ],
    };
    vcsBranches.mockImplementation(async (repo: string | null) => ({
      status: "ok",
      data: (repo && byRepo[repo]) ?? [],
    }));
    // Also verify when `repo` is the workspace root `/p` (not in `roots`).
    useVcs.setState({
      available: true,
      root: "/p",
      roots: ["/p/appcall-iac", "/p/chb", "/p/xcs"],
      repo: "/p",
      heads: {
        "/p/appcall-iac": { head: "main", headCommit: "1" },
        "/p/chb": { head: "release/2026-PI5", headCommit: "2" },
        "/p/xcs": { head: "release/2026-PI5", headCommit: "2" },
      },
      branches: [],
      branchesLoaded: false,
      branchesRepo: null,
      branch: head,
    });
    render(
      <>
        <BranchesPanel />
        <ContextMenuHost />
      </>,
    );

    await waitFor(() => expect(screen.getByText("2026-PI2-1")).toBeInTheDocument());

    // 1. Non-current branch in a subset of repos (`chb` and `xcs`): Checkout acts only on `/p/chb` and `/p/xcs`.
    fireEvent.contextMenu(screen.getByText("2026-PI2-1"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Checkout" }));
    await waitFor(() =>
      expect(vcsCheckout.mock.calls.map((c) => [c[0], c[1]])).toEqual([
        ["/p/chb", "release/2026-PI2-1"],
        ["/p/xcs", "release/2026-PI2-1"],
      ]),
    );

    // 2. Partially checked-out branch (`main`: current in `appcall-iac`, non-current in `chb`):
    // offers Update/Push, hides Delete, and scopes Checkout to `/p/chb`.
    vcsCheckout.mockClear();
    fireEvent.contextMenu(screen.getByText("main"));
    expect(await screen.findByRole("menuitem", { name: "Update" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Push…" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Delete" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Checkout" }));
    await waitFor(() => expect(vcsCheckout.mock.calls.map((c) => [c[0], c[1]])).toEqual([["/p/chb", "main"]]));
  });

  it("executes Update directly without opening a modal dialog and scopes Update to the target repository or subset", async () => {
    const byRepo: Record<string, Branch[]> = {
      "/p/appcall-iac": [b("main", { current: true, commit: "1" })],
      "/p/chb": [b("release/2026-PI5", { current: true, commit: "2" })],
      "/p/xcs": [b("release/2026-PI5", { current: true, commit: "2" })],
    };
    vcsBranches.mockImplementation(async (repo: string | null) => ({
      status: "ok",
      data: (repo && byRepo[repo]) ?? [],
    }));
    useVcs.setState({
      available: true,
      root: "/p",
      roots: ["/p/appcall-iac", "/p/chb", "/p/xcs"],
      repo: "/p/chb",
      heads: {
        "/p/appcall-iac": { head: "main", headCommit: "1" },
        "/p/chb": { head: "release/2026-PI5", headCommit: "2" },
        "/p/xcs": { head: "release/2026-PI5", headCommit: "2" },
      },
      branches: byRepo["/p/chb"]!,
      branchesLoaded: true,
      branchesRepo: "/p/chb",
      branch: { ...head, head: "release/2026-PI5" },
    });

    render(
      <>
        <BranchesPanel />
        <ContextMenuHost />
        <VcsDialogHost />
      </>,
    );

    await waitFor(() => expect(screen.getByText("2026-PI5")).toBeInTheDocument());

    // 1. Single-repo menu item (`Repositories › chb › Local › release/2026-PI5 › Update`) pulls ONLY `/p/chb`.
    const singleRepoItems = inRepo(
      "/p/chb",
      branchMenu(b("release/2026-PI5", { current: true, commit: "2" }), "release/2026-PI5"),
    );
    const updateItem = singleRepoItems.find((i) => "label" in i && i.label === "Update");
    expect(updateItem && "run" in updateItem).toBeTruthy();
    if (updateItem && "run" in updateItem && updateItem.run) updateItem.run();
    await waitFor(() =>
      expect(vcsRemote.mock.calls).toEqual([["/p/chb", { op: "pull", rebase: false }]]),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    // 2. Multi-repo branch context menu on `2026-PI5` (checked out in `chb` and `xcs`, not `appcall-iac`) pulls ONLY `chb` and `xcs`.
    vcsRemote.mockClear();
    fireEvent.contextMenu(screen.getByText("2026-PI5"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Update" }));
    await waitFor(() =>
      expect(vcsRemote.mock.calls).toEqual([
        ["/p/chb", { op: "pull", rebase: false }],
        ["/p/xcs", { op: "pull", rebase: false }],
      ]),
    );

    // 3. Full Update Project pulls all roots without opening a modal dialog.
    vcsRemote.mockClear();
    await updateProject();
    expect(vcsRemote.mock.calls.map((c) => c[0])).toEqual(["/p/appcall-iac", "/p/chb", "/p/xcs"]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("provides the vertical branch action toolbar and Remote context menu", async () => {
    useVcs.setState({
      branches: [
        b("main", { current: true, commit: "1", upstream: "origin/main" }),
        b("feature", { commit: "2", upstream: "origin/feature" }),
        b("origin/main", { remote: true, commit: "1" }),
      ],
    });
    useFavoriteBranches.setState({ names: ["main"] });

    render(
      <>
        <BranchesPanel />
        <ContextMenuHost />
        <VcsDialogHost />
      </>,
    );

    // Vertical toolbar buttons are rendered.
    const toolbar = screen.getByRole("toolbar", { name: "Branch Actions" });
    expect(toolbar).toBeInTheDocument();
    const updateBtn = screen.getByRole("button", { name: "Update Selected" });
    const deleteBtn = screen.getByRole("button", { name: "Delete" });
    const favBtn = screen.getByRole("button", { name: "Show Only Favorites" });
    const selectCurrentBtn = screen.getByRole("button", { name: "Select Current" });
    const hideBtn = screen.getByRole("button", { name: "Hide Branches" });

    // Selecting `feature` enables Update Selected and Delete.
    fireEvent.mouseDown(screen.getByText("feature"));
    expect(updateBtn).not.toBeDisabled();
    expect(deleteBtn).not.toBeDisabled();
    fireEvent.click(updateBtn);
    await waitFor(() =>
      expect(vcsRemote).toHaveBeenCalledWith("/p", { op: "updateBranch", branch: "feature" }),
    );

    // Show Only Favorites filters out non-favorite branches (`feature`).
    fireEvent.click(favBtn);
    expect(screen.queryByText("feature")).not.toBeInTheDocument();
    expect(screen.getAllByText("main").length).toBeGreaterThan(0);
    fireEvent.click(favBtn);
    expect(screen.getByText("feature")).toBeInTheDocument();

    // Select Current highlights the current branch (`main`).
    fireEvent.click(selectCurrentBtn);
    const localMain = screen.getAllByText("main")[0]!;
    expect(localMain.closest("[data-row]")).toHaveAttribute("aria-selected", "true");

    // Right-clicking `Remote` offers `Manage Remotes…` and clicking it opens the dialog.
    fireEvent.contextMenu(screen.getByText("Remote"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Manage Remotes…" }));
    expect(await screen.findByRole("dialog", { name: "Git Remotes" })).toBeInTheDocument();
    act(() => closeAllDialogs());

    // Clicking Branch Settings gear icon also offers `Manage Remotes…`.
    fireEvent.click(screen.getByRole("button", { name: "Branch Settings" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Manage Remotes…" }));
    expect(await screen.findByRole("dialog", { name: "Git Remotes" })).toBeInTheDocument();
    act(() => closeAllDialogs());

    // Hide Branches collapses the tree and shows Show Branches.
    fireEvent.click(hideBtn);
    expect(screen.queryByRole("tree", { name: "Branches" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show Branches" }));
    expect(screen.getByRole("tree", { name: "Branches" })).toBeInTheDocument();
  });

  it("groups remotes by repository in the Git Remotes dialog for multi-repo projects and defaults Add Remote to an empty target repository", async () => {
    vcsRemotes.mockImplementation(async (repo: string | null) => ({
      status: "ok",
      data: repo === "/p/appcall-iac" ? [{ name: "origin", url: "https://example.com/p/appcall-iac.git" }] : [],
    }));
    useVcs.setState({
      available: true,
      root: "/p",
      roots: ["/p/appcall-iac", "/p/chb"],
      repo: "/p/chb",
    });

    render(<VcsDialogHost />);
    // Open Manage Remotes targeting `/p/chb`, which currently has zero remotes.
    act(() => showManageRemotes("/p/chb"));

    expect(await screen.findByRole("dialog", { name: "Git Remotes" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("https://example.com/p/appcall-iac.git")).toBeInTheDocument());
    expect(screen.getByRole("group", { name: "appcall-iac" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "chb" })).toBeInTheDocument();

    // Clicking `+` (Add Remote…) defaults the Repository selector to `/p/chb` (not `appcall-iac`).
    fireEvent.click(screen.getByRole("button", { name: "Add Remote…" }));
    const defineDialog = await screen.findByRole("dialog", { name: "Define Remote" });
    fireEvent.change(within(defineDialog).getByLabelText("URL"), { target: { value: "https://example.com/p/chb.git" } });
    fireEvent.click(within(defineDialog).getByRole("button", { name: "OK" }));

    await waitFor(() =>
      expect(vcsEditRemote).toHaveBeenCalledWith("/p/chb", {
        op: "add",
        name: "origin",
        url: "https://example.com/p/chb.git",
      }),
    );
    fireEvent.click(within(screen.getByRole("dialog", { name: "Git Remotes" })).getByRole("button", { name: "OK" }));
  });

  it("offers Manage Remotes… on Remote group headers in the multi-repo Branches popup", async () => {
    vcsBranches.mockImplementation(async () => ({
      status: "ok",
      data: [b("main", { current: true, commit: "1" }), b("origin/main", { remote: true, commit: "1" })],
    }));
    useVcs.setState({
      available: true,
      root: "/p",
      roots: ["/p/appcall-iac", "/p/chb"],
      repo: "/p/chb",
      heads: {
        "/p/appcall-iac": { head: "main", headCommit: "1" },
        "/p/chb": { head: "release/2026-PI5", headCommit: "2" },
      },
      branch: { ...head, head: "release/2026-PI5" },
    });
    useBranchesPopup.setState({ open: true });

    render(
      <>
        <BranchWidget />
        <ContextMenuHost />
        <VcsDialogHost />
      </>,
    );

    const remoteGroup = await screen.findByText("Remote Branches in chb");
    fireEvent.contextMenu(remoteGroup);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Manage Remotes…" }));
    const remotesDialog = await screen.findByRole("dialog", { name: "Git Remotes" });
    expect(remotesDialog).toBeInTheDocument();
    fireEvent.click(within(remotesDialog).getByRole("button", { name: "OK" }));
    useBranchesPopup.setState({ open: false });
  });

  it("updates multiple selected branches sequentially and scopes Fetch to filtered multi-repo roots", async () => {
    const dispose = registerVcsActions();
    try {
      useVcs.setState({
        available: true,
        root: "/p",
        roots: ["/p/appcall-iac", "/p/chb", "/p/xcs"],
        repo: "/p/chb",
        heads: {
          "/p/appcall-iac": { head: "main", headCommit: "1" },
          "/p/chb": { head: "main", headCommit: "1" },
          "/p/xcs": { head: "main", headCommit: "1" },
        },
        branches: [
          b("main", { current: true, commit: "1", upstream: "origin/main" }),
          b("alpha", { commit: "2", upstream: "origin/alpha" }),
          b("beta", { commit: "3", upstream: "origin/beta" }),
        ],
        branchesLoaded: true,
      });
      // Filter Git Log to 2 of the 3 repositories (`appcall-iac` and `chb`).
      useGitLog.setState({ filters: { ...emptyFilters(), roots: ["/p/appcall-iac", "/p/chb"] } });

      render(<BranchesPanel />);
      await waitFor(() => expect(screen.getByText("alpha")).toBeInTheDocument());

      // Multi-select `alpha` and `beta` and click `Update Selected`.
      fireEvent.mouseDown(screen.getByText("alpha"));
      fireEvent.mouseDown(screen.getByText("beta"), cmd());
      fireEvent.click(screen.getByRole("button", { name: "Update Selected" }));

      await waitFor(() =>
        expect(vcsRemote.mock.calls).toEqual([
          ["/p/appcall-iac", { op: "updateBranch", branch: "alpha" }],
          ["/p/chb", { op: "updateBranch", branch: "alpha" }],
          ["/p/appcall-iac", { op: "updateBranch", branch: "beta" }],
          ["/p/chb", { op: "updateBranch", branch: "beta" }],
        ]),
      );
      await waitFor(() => expect(useVcs.getState().remoteBusy).toBe(null));

      // Clicking `Fetch` in the vertical toolbar fetches only the 2 active filtered roots.
      vcsRemote.mockClear();
      fireEvent.click(screen.getByRole("button", { name: "Fetch" }));
      await waitFor(() =>
        expect(vcsRemote.mock.calls).toEqual([
          ["/p/appcall-iac", { op: "fetch" }],
          ["/p/chb", { op: "fetch" }],
        ]),
      );
    } finally {
      dispose();
    }
  });

  it("scopes argRepos to a nested repository without including its enclosing parent and guards updateBranch head fallback", async () => {
    useVcs.setState({
      available: true,
      root: "/p",
      roots: ["/p", "/p/sub"],
      repo: "/p",
      heads: {},
      branch: { ...head, head: "main" },
      branches: [b("main", { current: true, commit: "1" })],
      branchesLoaded: true,
      branchesRepo: "/p",
    });

    expect(argRepos("/p/sub")).toEqual(["/p/sub"]);
    expect(argRepos("/p/sub/src/a.ts")).toEqual(["/p/sub"]);
    expect(argRepos("/p/src/a.ts")).toEqual(["/p"]);

    // Updating `main` in `/p/sub` when `state.repo` is `/p` and `heads["/p/sub"]` is unknown fast-forwards `main` instead of pulling `/p/sub` as if it were checked out.
    await updateBranch("main", "/p/sub");
    expect(vcsRemote.mock.calls).toEqual([["/p/sub", { op: "updateBranch", branch: "main" }]]);
  });

  it("asks once before deleting several selected branches", async () => {
    const byRepo: Record<string, Branch[]> = {
      "/p/appcall-iac": [
        b("main", { current: true, commit: "1" }),
        b("alpha", { commit: "2" }),
        b("origin/gamma", { remote: true, commit: "4" }),
      ],
      "/p/chb": [
        b("main", { current: true, commit: "1" }),
        b("alpha", { commit: "2" }),
        b("beta", { commit: "3" }),
      ],
    };
    vcsBranches.mockImplementation(async (repo: string | null) => ({
      status: "ok",
      data: (repo && byRepo[repo]) ?? [],
    }));
    useVcs.setState({
      available: true,
      root: "/p",
      roots: ["/p/appcall-iac", "/p/chb"],
      repo: "/p/chb",
      heads: {
        "/p/appcall-iac": { head: "main", headCommit: "1" },
        "/p/chb": { head: "main", headCommit: "1" },
      },
      branches: byRepo["/p/chb"]!,
      branchesLoaded: true,
      branchesRepo: "/p/chb",
      branch: head,
    });

    render(
      <>
        <BranchesPanel />
        <VcsDialogHost />
        {MessageHost ? <MessageHost /> : null}
      </>,
    );
    await waitFor(() => expect(screen.getByText("gamma")).toBeInTheDocument());

    fireEvent.mouseDown(screen.getByText("alpha"));
    fireEvent.mouseDown(screen.getByText("beta"), cmd());
    fireEvent.mouseDown(screen.getByText("gamma"), cmd());
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    const dialog = await screen.findByRole("dialog", { name: "Delete Branches" });
    expect(dialog).toHaveTextContent("alpha");
    expect(dialog).toHaveTextContent("beta");
    expect(dialog).toHaveTextContent("origin/gamma (remote)");
    expect(vcsDeleteBranch).not.toHaveBeenCalled();
    expect(vcsRemote).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(vcsRemote.mock.calls).toEqual([
        ["/p/appcall-iac", { op: "deleteBranch", branch: "origin/gamma" }],
      ]),
    );
    expect(vcsDeleteBranch.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ["/p/appcall-iac", "alpha"],
      ["/p/chb", "alpha"],
      ["/p/chb", "beta"],
    ]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("cancelling the batch confirmation deletes nothing", async () => {
    const byRepo: Record<string, Branch[]> = {
      "/p/appcall-iac": [
        b("main", { current: true, commit: "1" }),
        b("alpha", { commit: "2" }),
        b("origin/gamma", { remote: true, commit: "4" }),
      ],
      "/p/chb": [
        b("main", { current: true, commit: "1" }),
        b("alpha", { commit: "2" }),
        b("beta", { commit: "3" }),
      ],
    };
    vcsBranches.mockImplementation(async (repo: string | null) => ({
      status: "ok",
      data: (repo && byRepo[repo]) ?? [],
    }));
    useVcs.setState({
      available: true,
      root: "/p",
      roots: ["/p/appcall-iac", "/p/chb"],
      repo: "/p/chb",
      heads: {
        "/p/appcall-iac": { head: "main", headCommit: "1" },
        "/p/chb": { head: "main", headCommit: "1" },
      },
      branches: byRepo["/p/chb"]!,
      branchesLoaded: true,
      branchesRepo: "/p/chb",
      branch: head,
    });

    render(
      <>
        <BranchesPanel />
        <VcsDialogHost />
        {MessageHost ? <MessageHost /> : null}
      </>,
    );
    await waitFor(() => expect(screen.getByText("gamma")).toBeInTheDocument());

    fireEvent.mouseDown(screen.getByText("alpha"));
    fireEvent.mouseDown(screen.getByText("beta"), cmd());
    fireEvent.mouseDown(screen.getByText("gamma"), cmd());
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    const dialog = await screen.findByRole("dialog", { name: "Delete Branches" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(vcsDeleteBranch).not.toHaveBeenCalled();
    expect(vcsRemote).not.toHaveBeenCalled();
  });

  it("deleting one branch still needs no confirmation", async () => {
    render(
      <>
        <BranchesPanel />
        <VcsDialogHost />
      </>,
    );
    fireEvent.mouseDown(screen.getByText("feature"));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(vcsDeleteBranch.mock.calls.map((c) => [c[0], c[1]])).toEqual([["/p", "feature"]]));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
