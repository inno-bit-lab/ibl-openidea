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
import { useCommit } from "../commitStore";
import { useVcs } from "../store";

// `vcs_status` never reports ignored files: only `vcs_ignored` does.
const status: FileStatus[] = [
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

const ignored: FileStatus[] = [
  {
    // As the backend sends a folder: no trailing slash on `path`, one on `relPath`.
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

const row = (el: HTMLElement) => el.closest("[role='treeitem']") as HTMLElement;

function renderView() {
  render(
    <>
      <CommitToolWindow />
      <ContextMenuHost />
    </>,
  );
  return screen.getByRole("tree", { name: "Changes" });
}

describe("Commit tool window View Options", () => {
  beforeEach(() => {
    vcsIgnored.mockReset();
    vcsIgnored.mockResolvedValue({ status: "ok", data: ignored });
    hideContextMenu();
    useCommit.setState({
      tab: "changes",
      groupByDir: false,
      groupByModule: false,
      showIgnored: false,
      checks: new Map(),
      selection: [],
    });
    useProject.setState({
      project: { root: "/ws", name: "ws", isGit: true } as ReturnType<typeof useProject.getState>["project"],
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
      operations: {},
      status,
      statusLoaded: true,
    });
  });

  it("offers Module grouping and Show Ignored Files", async () => {
    const tree = renderView();
    // Several repositories: a node per repository.
    expect(within(tree).getByText("chb")).toBeTruthy();
    expect(within(tree).getByText("ecs")).toBeTruthy();
    expect(within(tree).queryByText("Ignored Files")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "View Options" }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getByText("Group By")).toBeTruthy();
    expect(within(menu).getByRole("menuitemcheckbox", { name: /Directory/ })).toBeTruthy();
    expect(within(menu).getByRole("menuitemcheckbox", { name: /Module/ })).toBeTruthy();
    expect(within(menu).getByText("Show")).toBeTruthy();
    fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: /Ignored Files/ }));
    expect(useCommit.getState().showIgnored).toBe(true);

    const ignoredRow = row(await within(tree).findByText("Ignored Files"));
    expect(within(ignoredRow).getByText("1 directory and 1 file")).toBeTruthy();
    // Ignored files are never committed: no inclusion checkbox, and the changes count leaves them out.
    expect(within(ignoredRow).queryByRole("checkbox")).toBeNull();
    expect(within(row(within(tree).getByText("Changes"))).getByText("2 files")).toBeTruthy();

    // Group By › Module: a node per module ("api" of ecs/api/pom.xml) inside its repository.
    fireEvent.click(screen.getByRole("button", { name: "View Options" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitemcheckbox", { name: /Module/ }));
    expect(useCommit.getState().groupByModule).toBe(true);
    expect(row(within(tree).getByText("api")).getAttribute("aria-expanded")).toBe("true");
  });

  it("offers neither Stage nor Rollback on ignored files", async () => {
    useCommit.setState({ showIgnored: true });
    const tree = renderView();
    await within(tree).findByText("Ignored Files");

    // A folder cannot be opened; a file opens in the editor.
    fireEvent.click(screen.getByRole("button", { name: "Expand All" }));
    fireEvent.contextMenu(row(within(tree).getByText("target")));
    const targetMenu = screen.getByRole("menu");
    expect(within(targetMenu).queryByRole("menuitem", { name: /Stage/ })).toBeNull();
    expect(within(targetMenu).queryByRole("menuitem", { name: /Rollback/ })).toBeNull();
    expect(
      within(targetMenu)
        .getByRole("menuitem", { name: /Jump to Source/ })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    hideContextMenu();

    fireEvent.contextMenu(row(within(tree).getByText("debug.log")));
    const debugMenu = screen.getByRole("menu");
    expect(within(debugMenu).queryByRole("menuitem", { name: /Stage/ })).toBeNull();
    expect(
      within(debugMenu)
        .getByRole("menuitem", { name: /Jump to Source/ })
        .getAttribute("aria-disabled"),
    ).toBeNull();
    hideContextMenu();
  });

  it("does not call vcsIgnored while Show Ignored is off", () => {
    const tree = renderView();
    expect(within(tree).queryByText("Ignored Files")).toBeNull();
    expect(vcsIgnored).not.toHaveBeenCalled();
  });

  it("shows the files returned by vcsIgnored while Show Ignored is on", async () => {
    const tree = renderView();
    expect(vcsIgnored).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "View Options" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitemcheckbox", { name: /Ignored Files/ }));

    expect(vcsIgnored).toHaveBeenCalledTimes(1);
    const ignoredRow = row(await within(tree).findByText("Ignored Files"));
    expect(within(ignoredRow).getByText("1 directory and 1 file")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Expand All" }));
    expect(within(tree).getByText("target")).toBeTruthy();
    expect(within(tree).getByText("debug.log")).toBeTruthy();
  });
});
