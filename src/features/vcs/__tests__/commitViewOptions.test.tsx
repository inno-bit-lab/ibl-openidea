import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { FileStatus } from "@/bindings";

const vcsIgnored = vi.fn<() => Promise<{ status: "ok"; data: FileStatus[] }>>();

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsIgnored: () => vcsIgnored(),
    },
  };
});

import { ContextMenuHost, hideContextMenu } from "@/ui/Menu";
import { useProject } from "@/platform/project";
import { useProjectRoots } from "@/platform/projectRoots";
import { CommitToolWindow } from "../CommitView";
import { setGroupByDir, setGroupByModule, setGroupByRepo, setShowIgnored, useCommit } from "../commitStore";
import { useVcs } from "../store";

const nonIgnoredStatus: FileStatus[] = [
  {
    path: "/ws/chb/src/Main.java",
    relPath: "src/Main.java",
    staged: null,
    unstaged: "modified",
    renamedFrom: null,
  },
  {
    path: "/ws/ecs/api/Service.java",
    relPath: "api/Service.java",
    staged: "added",
    unstaged: null,
    renamedFrom: null,
  },
  {
    path: "/ws/chb/notes.txt",
    relPath: "notes.txt",
    staged: null,
    unstaged: "untracked",
    renamedFrom: null,
  },
];

const ignoredOnlyStatus: FileStatus[] = [
  {
    // Matches backend IpcPath serialization: `path` has no trailing slash while `relPath` ends with `/`.
    path: "/ws/chb/target",
    relPath: "target/",
    staged: null,
    unstaged: "ignored",
    renamedFrom: null,
  },
  {
    path: "/ws/ecs/debug.log",
    relPath: "debug.log",
    staged: null,
    unstaged: "ignored",
    renamedFrom: null,
  },
];

const status: FileStatus[] = [...nonIgnoredStatus, ...ignoredOnlyStatus];

describe("CommitView View Options & Group By / Show Ignored Files", () => {
  beforeEach(() => {
    vcsIgnored.mockReset();
    vcsIgnored.mockResolvedValue({ status: "ok", data: ignoredOnlyStatus });
    hideContextMenu();
    setGroupByDir(false);
    setGroupByRepo(true);
    setGroupByModule(false);
    setShowIgnored(false);
    useCommit.setState({
      tab: "changes",
      checks: new Map(),
      selection: [],
    });
    useProject.setState({
      project: {
        root: "/ws",
        name: "ws",
        isGit: true,
      } as ReturnType<typeof useProject.getState>["project"],
    });
    useProjectRoots.setState({
      root: "/ws",
      detected: [
        { path: "chb/src", kind: "source", detectedFrom: "chb/pom.xml" },
        { path: "ecs/api", kind: "source", detectedFrom: "ecs/api/pom.xml" },
      ],
    });
    useVcs.setState({
      available: true,
      root: "/ws",
      roots: ["/ws/chb", "/ws/ecs"],
      repo: "/ws/chb",
      heads: {
        "/ws/chb": { head: "feature/Sviluppi-vari", headCommit: "11111111" },
        "/ws/ecs": { head: "main", headCommit: "22222222" },
      },
      operations: {},
      status,
      statusLoaded: true,
    });
  });

  it("opens View Options menu with Group By (Directory, Repository, Module) and Show (Ignored Files) and toggles them", () => {
    render(
      <>
        <CommitToolWindow />
        <ContextMenuHost />
      </>,
    );

    // Multi-repo defaults to grouping by Repository with branch badges
    const tree = screen.getByRole("tree", { name: "Changes" });
    expect(within(tree).getByText("chb")).toBeTruthy();
    expect(within(tree).getByText("feature/Sviluppi-vari")).toBeTruthy();
    expect(within(tree).getByText("ecs")).toBeTruthy();
    expect(within(tree).getByText("main")).toBeTruthy();
    expect(within(tree).queryByText("Ignored Files")).toBeNull();

    // Open View Options menu
    fireEvent.click(screen.getByRole("button", { name: "View Options" }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getByText("Group By")).toBeTruthy();
    expect(within(menu).getByRole("menuitemcheckbox", { name: /Directory/ })).toBeTruthy();
    expect(within(menu).getByRole("menuitemcheckbox", { name: /Repository/ })).toBeTruthy();
    expect(within(menu).getByRole("menuitemcheckbox", { name: /Module/ })).toBeTruthy();
    expect(within(menu).getByText("Show")).toBeTruthy();
    const showIgnoredItem = within(menu).getByRole("menuitemcheckbox", { name: /Ignored Files/ });
    expect(showIgnoredItem).toBeTruthy();

    // Toggle Show -> Ignored Files
    fireEvent.click(showIgnoredItem);
    expect(useCommit.getState().showIgnored).toBe(true);
    const ignoredRow = within(tree).getByText("Ignored Files").closest("[role='treeitem']") as HTMLElement;
    expect(ignoredRow).toBeTruthy();
    expect(within(ignoredRow).getByText("1 directory and 1 file")).toBeTruthy();
    // Ignored Files node has no commit inclusion checkbox
    expect(within(ignoredRow).queryByRole("checkbox")).toBeNull();

    // Expand Ignored Files and check context menus on ignored folder vs ignored file
    fireEvent.click(screen.getByRole("button", { name: "Expand All" }));
    const targetRow = within(tree).getByText("target").closest("[role='treeitem']") as HTMLElement;
    fireEvent.contextMenu(targetRow);
    const targetMenu = screen.getByRole("menu");
    expect(within(targetMenu).queryByRole("menuitem", { name: /Stage/ })).toBeNull();
    expect(within(targetMenu).queryByRole("menuitem", { name: /Rollback/ })).toBeNull();
    expect(
      within(targetMenu).getByRole("menuitem", { name: /Jump to Source/ }).getAttribute("aria-disabled"),
    ).toBe("true");
    hideContextMenu();

    const debugRow = within(tree).getByText("debug.log").closest("[role='treeitem']") as HTMLElement;
    fireEvent.contextMenu(debugRow);
    const debugMenu = screen.getByRole("menu");
    expect(within(debugMenu).queryByRole("menuitem", { name: /Stage/ })).toBeNull();
    expect(
      within(debugMenu).getByRole("menuitem", { name: /Jump to Source/ }).getAttribute("aria-disabled"),
    ).toBeNull();
    hideContextMenu();

    // Toggle Group By -> Module and Directory via keyboard shortcuts (including macOS Option-modified key values)
    fireEvent.keyDown(tree, { key: "π", code: "KeyP", metaKey: true, altKey: true });
    expect(useCommit.getState().groupByDir).toBe(true);
    fireEvent.keyDown(tree, { key: "µ", code: "KeyM", metaKey: true, altKey: true });
    expect(useCommit.getState().groupByModule).toBe(true);
    expect(within(tree).getByText("api")).toBeTruthy();
  });

  it("does not call vcsIgnored while Show Ignored is off", () => {
    useVcs.setState({ status: nonIgnoredStatus });
    render(
      <>
        <CommitToolWindow />
        <ContextMenuHost />
      </>,
    );

    const tree = screen.getByRole("tree", { name: "Changes" });
    expect(within(tree).queryByText("Ignored Files")).toBeNull();
    expect(vcsIgnored).not.toHaveBeenCalled();
  });

  it("shows the files returned by vcsIgnored while Show Ignored is on", async () => {
    useVcs.setState({ status: nonIgnoredStatus });
    render(
      <>
        <CommitToolWindow />
        <ContextMenuHost />
      </>,
    );

    expect(vcsIgnored).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "View Options" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitemcheckbox", { name: /Ignored Files/ }));

    expect(vcsIgnored).toHaveBeenCalledTimes(1);
    const tree = screen.getByRole("tree", { name: "Changes" });
    const ignoredLabel = await within(tree).findByText("Ignored Files");
    const ignoredRow = ignoredLabel.closest("[role='treeitem']") as HTMLElement;
    expect(within(ignoredRow).getByText("1 directory and 1 file")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Expand All" }));
    expect(within(tree).getByText("target")).toBeTruthy();
    expect(within(tree).getByText("debug.log")).toBeTruthy();
  });
});
