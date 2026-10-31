import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Branch, BranchInfo } from "@/bindings";
import { isMacHost } from "@/platform/keymap";

const branchesOf = vi.fn((_repo: string | null): Branch[] => []);
const vcsRemote = vi.fn();
const vcsDeleteBranch = vi.fn();
const vcsCheckout = vi.fn();

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsLog: () => Promise.resolve({ status: "ok", data: [] }),
      vcsConfigGet: () => Promise.resolve({ status: "ok", data: null }),
      vcsBranches: async (repo: string | null) => ({ status: "ok", data: branchesOf(repo) }),
      vcsTags: async () => ({ status: "ok", data: [] }),
      vcsRemotes: async () => ({ status: "ok", data: [] }),
      vcsRemote: (repo: string | null, _request: number, op: unknown) => vcsRemote(repo, op),
      vcsDeleteBranch: (repo: string | null, name: string) => vcsDeleteBranch(repo, name),
      vcsCheckout: (repo: string | null, rev: string) => vcsCheckout(repo, rev),
      vcsBranchInfo: async () => ({ status: "ok", data: { ...head, upstream: "origin/main" } }),
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
import { useProject } from "@/platform/project";
import { ContextMenuHost, hideContextMenu } from "@/ui/Menu";
import { provideNotificationService } from "@/workbench/contributions";
import { MessagesHost } from "@/workbench/messages";
import { registerVcsActions } from "../actions";
import { branchMenu, inRepo } from "../branchMenu";
import { VcsDialogHost } from "../dialogs";
import { BranchesPanel } from "../GitLog";
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

beforeEach(() => {
  writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  useVcs.setState({ root: "/p", repo: "/p", branches, branchesLoaded: true, branch: head });
  useGitLog.setState({ filters: emptyFilters() });
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
    fireEvent.keyDown(screen.getByLabelText("Filter branches and tags"), { key: "c", ...cmd() });
    await Promise.resolve();
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe("Git Log branches pane with several repositories", () => {
  const FRONT = "/p/front";
  const BACK = "/p/back";
  let off: () => void = () => {};

  beforeEach(() => {
    hideContextMenu();
    off = registerVcsActions();
    setContext("vcsAvailable", true);
    provideNotificationService({ notify: () => {} });
    useProject.setState({ settings: { vcs: { confirmation: { showUpdateOptions: false } } } });
    branchesOf
      .mockReset()
      .mockImplementation(() => [
        b("main", { current: true, upstream: "origin/main", commit: "1" }),
        b("feature", { upstream: "origin/feature", commit: "2" }),
      ]);
    vcsRemote.mockReset().mockResolvedValue({ status: "ok", data: { summary: "ok" } });
    vcsDeleteBranch.mockReset().mockImplementation(async (_repo: string, name: string) => ({
      status: "ok",
      data: { name, tip: "2", upstream: null, unmerged: false },
    }));
    vcsCheckout.mockReset().mockResolvedValue({ status: "ok", data: { kind: "done" } });
    useVcs.setState({
      available: true,
      root: "/p",
      roots: [FRONT, BACK],
      repo: FRONT,
      heads: { [FRONT]: { head: "main", headCommit: "1" }, [BACK]: { head: "main", headCommit: "1" } },
      branches: branchesOf(FRONT),
      branchesLoaded: true,
      branch: { ...head, upstream: "origin/main" },
      remoteBusy: null,
    });
  });

  afterEach(() => off());

  const renderPane = () =>
    render(
      <>
        <BranchesPanel />
        <ContextMenuHost />
        <VcsDialogHost />
        <MessagesHost />
      </>,
    );
  /** `feature` in both repositories' Local groups. */
  const selectBothFeatures = async () => {
    await waitFor(() => expect(screen.getAllByText("feature")).toHaveLength(2));
    const [front, back] = screen.getAllByText("feature");
    fireEvent.mouseDown(front!);
    fireEvent.mouseDown(back!, cmd());
    return back!;
  };

  it("Update in a repository's branch menu pulls only that repository", async () => {
    const update = inRepo(BACK, branchMenu(b("main", { current: true }), "main")).find(
      (i) => "label" in i && i.label === "Update",
    );
    if (update && "run" in update) update.run?.();
    await waitFor(() => expect(vcsRemote.mock.calls).toEqual([[BACK, { op: "pull", rebase: false }]]));
  });

  it("Delete in the menu of branches selected in two repositories asks once and deletes each in its repository", async () => {
    renderPane();
    const back = await selectBothFeatures();
    fireEvent.contextMenu(back);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Branches" });
    expect(vcsDeleteBranch).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(vcsDeleteBranch.mock.calls).toEqual([
        [FRONT, "feature"],
        [BACK, "feature"],
      ]),
    );
  });

  it("Checkout in the menu of the same branch selected in two repositories checks it out in each", async () => {
    renderPane();
    const back = await selectBothFeatures();
    fireEvent.contextMenu(back);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Checkout" }));
    await waitFor(() =>
      expect(vcsCheckout.mock.calls).toEqual([
        [FRONT, "feature"],
        [BACK, "feature"],
      ]),
    );
  });

  it("offers Manage Remotes… on the Remote group and in the toolbar", async () => {
    renderPane();
    fireEvent.contextMenu(await screen.findByText("Remote"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Manage Remotes…" }));
    expect(await screen.findByRole("dialog", { name: "Git Remotes" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Manage Remotes…" })).toBeInTheDocument();
  });
});
