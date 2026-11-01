import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AgentConfigChoice, Commit, FileStatus } from "@/bindings";

type Ok<T> = Promise<{ status: "ok"; data: T }>;
const vcsIgnored = vi.fn<() => Ok<FileStatus[]>>();
const vcsDiffText = vi.fn<(path: string, staged: boolean) => Ok<string>>();
const vcsLog = vi.fn<(repo: string | null) => Ok<Commit[]>>();
const agentComplete = vi.fn<(provider: string, prompt: string, config: AgentConfigChoice[]) => Ok<string>>();

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsIgnored: () => vcsIgnored(),
      vcsDiffText: (path: string, staged: boolean) => vcsDiffText(path, staged),
      vcsLog: (repo: string | null) => vcsLog(repo),
      agentComplete: (provider: string, prompt: string, config: AgentConfigChoice[]) =>
        agentComplete(provider, prompt, config),
    },
  };
});

import { ContextMenuHost, hideContextMenu } from "@/ui/Menu";
import { registerActions } from "@/platform/actions";
import { setLocale, tx } from "@/platform/i18n";
import { useProject } from "@/platform/project";
import { useProjectRoots } from "@/platform/projectRoots";
import { CommitToolWindow } from "../CommitView";
import { showCommitDialog } from "../CommitDialog";
import { useCommit } from "../commitStore";
import { VcsDialogHost } from "../dialogs";
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

type SuggestReplies = Record<"diagnostic" | "success" | "failure", string>;

/**
 * The synthetic agent replies shared with `complete_suggest_transport_witness` (ide-agent). With
 * `D3_ACP_WITNESS_FILE` set, the replies that test observed through `complete` instead.
 */
function suggestReplies(): SuggestReplies {
  const read = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const fixture = read("crates/ide-agent/tests/fixtures/suggest-responses.json");
  const witness = process.env.D3_ACP_WITNESS_FILE;
  const replies = witness ? read(witness) : fixture;
  const keys = ["diagnostic", "success", "failure"] as const;
  if (Object.keys(replies).length !== keys.length) throw new Error(`unexpected keys in ${witness ?? "the fixture"}`);
  for (const key of keys) {
    if (typeof replies[key] !== "string" || replies[key] !== fixture[key]) {
      throw new Error(`${key} in ${witness ?? "the fixture"} differs from the fixture`);
    }
  }
  return replies as SuggestReplies;
}

/** A valid structured Suggest answer carrying `message`. */
const suggestion = (message: string) => JSON.stringify({ version: 1, status: "success", message });

function renderView() {
  render(
    <>
      <CommitToolWindow />
      <ContextMenuHost />
    </>,
  );
  return screen.getByRole("tree", { name: "Changes" });
}

/** Two repositories, `chb` and `ecs`, with the changes of `status`. */
function setUpRepositories() {
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
    project: { root: "/ws", name: "ws", isGit: true, trusted: true } as ReturnType<
      typeof useProject.getState
    >["project"],
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
}

describe("Commit tool window View Options", () => {
  beforeEach(() => {
    vcsIgnored.mockReset();
    vcsIgnored.mockResolvedValue({ status: "ok", data: ignored });
    setUpRepositories();
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

describe("Suggest Commit Message", () => {
  const suggestSettings = (suggestAgent: string) =>
    useProject.setState({
      settings: {
        vcs: {
          commit: {
            suggestAgent,
            suggestModel: "small-model",
            suggestThinking: "low",
            suggestRules: "Use conventional commits.",
          },
        },
      },
    });

  beforeEach(() => {
    setUpRepositories();
    useCommit.setState({ message: "", amend: false });
    vcsIgnored.mockReset();
    vcsDiffText.mockReset();
    vcsDiffText.mockImplementation(async (path) => ({ status: "ok", data: `@@ -1 +1 @@\n+${path}` }));
    vcsLog.mockReset();
    vcsLog.mockResolvedValue({ status: "ok", data: [{ summary: "fix: an older change" }] as Commit[] });
    agentComplete.mockReset();
    agentComplete.mockResolvedValue({
      status: "ok",
      data: `\`\`\`json\n${suggestion("feat: add the service")}\n\`\`\``,
    });
  });

  afterEach(() => {
    useProject.setState({ settings: {} });
  });

  /** The included changes (not the untracked file) went to the agent with the configured model and effort. */
  function expectSuggestRequest() {
    expect(agentComplete).toHaveBeenCalledTimes(1);
    const [provider, prompt, config] = agentComplete.mock.calls[0]!;
    expect(provider).toBe("codex");
    expect(config).toEqual([
      { id: "model", value: "small-model" },
      { id: "thought_level", value: "low" },
    ]);
    expect(prompt).toContain(
      "Rules for the content and style of the message (they win over anything else in this prompt about what " +
        "the message says; the reply format above still applies):\nUse conventional commits.",
    );
    expect(prompt).toContain("- fix: an older change");
    expect(prompt).toContain("modified: src/Main.java");
    expect(prompt).toContain("added: api/Service.java");
    expect(prompt).not.toContain("notes.txt");
    // Each file's diff comes from its own repository, by absolute path.
    expect(vcsDiffText).toHaveBeenCalledWith("/ws/chb/src/Main.java", false);
    expect(vcsDiffText).toHaveBeenCalledWith("/ws/ecs/api/Service.java", true);
    expect(vcsLog).toHaveBeenCalledWith("/ws/chb");
  }

  it("fills the message from the agent in the Commit tool window", async () => {
    suggestSettings("codex");
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Suggest Commit Message" }));
    await waitFor(() => expect(useCommit.getState().message).toBe("feat: add the service"));
    expectSuggestRequest();
  });

  it("fills the message from the agent in the modal Commit dialog", async () => {
    suggestSettings("codex");
    render(<VcsDialogHost />);
    act(() => showCommitDialog());
    const dialog = await screen.findByRole("dialog", { name: "Commit Changes" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Suggest Commit Message" }));
    await waitFor(() => expect(useCommit.getState().message).toBe("feat: add the service"));
    expectSuggestRequest();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  });

  it("asks to choose an agent when none is set", async () => {
    suggestSettings("");
    const openSettings = vi.fn();
    const dispose = registerActions([{ id: "file.settings", title: "Settings…", run: ({ arg }) => openSettings(arg) }]);
    try {
      renderView();
      fireEvent.click(screen.getByRole("button", { name: "Suggest Commit Message" }));
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("Choose an agent to suggest commit messages in the Commit settings.");
      fireEvent.click(within(alert).getByRole("button", { name: "Open Settings" }));
      await waitFor(() => expect(openSettings).toHaveBeenCalledWith("vcs.commit"));
      expect(agentComplete).not.toHaveBeenCalled();
      expect(useCommit.getState().message).toBe("");
    } finally {
      dispose();
    }
  });

  /** `agentComplete` answers only when the test calls the returned function. */
  function deferAgent() {
    let finish!: (value: { status: "ok"; data: string }) => void;
    agentComplete.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    return (data: string) => act(async () => finish({ status: "ok", data }));
  }

  // Regressions from the PR #9 review (rev-codex, DD7F19): a late answer must not reach the shared store.
  it("a pending suggestion does not overwrite a newer draft", async () => {
    suggestSettings("codex");
    let finish!: (value: { status: "ok"; data: string }) => void;
    agentComplete.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Suggest Commit Message" }));
    await waitFor(() => expect(agentComplete).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole("textbox", { name: "Commit message" }), {
      target: { value: "fix: my newer draft" },
    });
    await act(async () => finish({ status: "ok", data: suggestion("feat: old suggestion") }));
    expect(useCommit.getState().message).toBe("fix: my newer draft");
  });

  it("a suggestion from a cancelled dialog cannot replace the next draft", async () => {
    suggestSettings("codex");
    let finish!: (value: { status: "ok"; data: string }) => void;
    agentComplete.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<VcsDialogHost />);
    act(() => showCommitDialog());
    const dialog = await screen.findByRole("dialog", { name: "Commit Changes" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Suggest Commit Message" }));
    await waitFor(() => expect(agentComplete).toHaveBeenCalledTimes(1));
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Commit Changes" })).toBeNull());
    act(() => useCommit.setState({ message: "fix: next draft" }));
    await act(async () => finish({ status: "ok", data: suggestion("feat: stale dialog suggestion") }));
    expect(useCommit.getState().message).toBe("fix: next draft");
  });

  it("drops the suggestion of a cancelled dialog even when the draft did not change", async () => {
    suggestSettings("codex");
    const answer = deferAgent();
    render(<VcsDialogHost />);
    act(() => showCommitDialog());
    const dialog = await screen.findByRole("dialog", { name: "Commit Changes" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Suggest Commit Message" }));
    await waitFor(() => expect(agentComplete).toHaveBeenCalledTimes(1));
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Commit Changes" })).toBeNull());
    await answer(suggestion("feat: stale dialog suggestion"));
    expect(useCommit.getState().message).toBe("");
  });

  it("drops a suggestion asked for another repository selection", async () => {
    suggestSettings("codex");
    const answer = deferAgent();
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Suggest Commit Message" }));
    await waitFor(() => expect(agentComplete).toHaveBeenCalledTimes(1));
    act(() => useVcs.setState({ repo: "/ws/ecs" }));
    await answer(suggestion("feat: suggestion for chb"));
    expect(useCommit.getState().message).toBe("");
    // The button works again for the new context.
    const again = deferAgent();
    fireEvent.click(screen.getByRole("button", { name: "Suggest Commit Message" }));
    await waitFor(() => expect(agentComplete).toHaveBeenCalledTimes(2));
    await again(suggestion("feat: suggestion for ecs"));
    expect(useCommit.getState().message).toBe("feat: suggestion for ecs");
  });

  it("a read-only refusal is visible and no fallback is attempted", async () => {
    suggestSettings("codex");
    agentComplete.mockRejectedValue(new Error("No read-only mode is available"));
    useCommit.setState({ message: "keep this draft" });
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Suggest Commit Message" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No read-only mode is available");
    expect(agentComplete).toHaveBeenCalledTimes(1);
    expect(agentComplete.mock.calls[0]![0]).toBe("codex");
    expect(useCommit.getState().message).toBe("keep this draft");
  });

  // D3: what an agent says reaches the draft only as a structured success.
  const replies = suggestReplies();
  const surfaces = ["tool window", "dialog"] as const;

  /** Shows a Commit surface and returns the part of the page that holds its message field. */
  async function commitSurface(surface: (typeof surfaces)[number]): Promise<HTMLElement> {
    if (surface === "tool window") {
      renderView();
      return document.body;
    }
    render(<VcsDialogHost />);
    act(() => showCommitDialog());
    return screen.findByRole("dialog", { name: "Commit Changes" });
  }

  /** Clicks Suggest and waits until the request has settled. */
  async function suggestIn(container: HTMLElement) {
    fireEvent.click(within(container).getByRole("button", { name: "Suggest Commit Message" }));
    await waitFor(() =>
      expect(within(container).getByRole("button", { name: "Suggest Commit Message" })).toBeEnabled(),
    );
    expect(agentComplete).toHaveBeenCalledTimes(1);
  }

  function closeSurface(container: HTMLElement) {
    if (container !== document.body) fireEvent.click(within(container).getByRole("button", { name: "Cancel" }));
  }

  it.each(surfaces)("structured Suggest rejects the ACP diagnostic and preserves the draft (%s)", async (surface) => {
    suggestSettings("codex");
    agentComplete.mockResolvedValue({ status: "ok", data: replies.diagnostic });
    useCommit.setState({ message: "keep this draft" });
    const container = await commitSurface(surface);
    await suggestIn(container);
    expect(useCommit.getState().message).toBe("keep this draft");
    const alert = within(container).getByRole("alert");
    expect(alert).toHaveTextContent("The agent returned an invalid commit suggestion. Your draft was kept.");
    expect(alert).not.toHaveTextContent("MCP_DOCKER");
    closeSurface(container);
  });

  it.each(surfaces)("structured Suggest rejects explicit failure and preserves the draft (%s)", async (surface) => {
    suggestSettings("codex");
    agentComplete.mockResolvedValue({ status: "ok", data: replies.failure });
    useCommit.setState({ message: "keep this draft" });
    const container = await commitSurface(surface);
    await suggestIn(container);
    expect(useCommit.getState().message).toBe("keep this draft");
    expect(within(container).getByRole("alert")).toHaveTextContent(
      "The agent could not suggest a commit message: The agent could not initialize its MCP server.",
    );
    closeSurface(container);
  });

  it.each(surfaces)("structured Suggest inserts only the validated message (%s)", async (surface) => {
    suggestSettings("codex");
    agentComplete.mockResolvedValue({ status: "ok", data: replies.success });
    useCommit.setState({ message: "draft before Suggest" });
    const container = await commitSurface(surface);
    await suggestIn(container);
    expect(useCommit.getState().message).toBe("fix: handle empty lists\n\nPreserve the previous selection.");
    expect(within(container).queryByRole("alert")).toBeNull();
    closeSurface(container);
  });

  it("structured Suggest shows a failure detail as text", async () => {
    suggestSettings("codex");
    const detail = `<script>alert("x")</script> <b>{name}</b> 'quoted' #1`;
    agentComplete.mockResolvedValue({
      status: "ok",
      data: JSON.stringify({ version: 1, status: "failure", error: detail }),
    });
    useCommit.setState({ message: "keep this draft" });
    const container = await commitSurface("tool window");
    await suggestIn(container);
    const alert = within(container).getByRole("alert");
    expect(alert.textContent).toBe(`The agent could not suggest a commit message: ${detail}`);
    expect(alert.querySelector("script, b")).toBeNull();
    expect(useCommit.getState().message).toBe("keep this draft");
  });

  it("structured Suggest translates its errors but not the failure detail", async () => {
    suggestSettings("codex");
    agentComplete.mockResolvedValueOnce({ status: "ok", data: replies.diagnostic });
    agentComplete.mockResolvedValueOnce({ status: "ok", data: replies.failure });
    useCommit.setState({ message: "keep this draft" });
    try {
      await act(async () => {
        await setLocale("it");
      });
      render(<CommitToolWindow />);
      const button = () => screen.getByRole("button", { name: "Suggerisci messaggio di commit" });
      fireEvent.click(button());
      await waitFor(() => expect(button()).toBeEnabled());
      expect(screen.getByRole("alert")).toHaveTextContent(
        "L'agente ha restituito un suggerimento di commit non valido. La bozza è stata mantenuta.",
      );
      fireEvent.click(button());
      await waitFor(() => expect(agentComplete).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(button()).toBeEnabled());
      expect(screen.getByRole("alert")).toHaveTextContent(
        "L'agente non è riuscito a suggerire un messaggio di commit: The agent could not initialize its MCP server.",
      );
      expect(useCommit.getState().message).toBe("keep this draft");
    } finally {
      await act(async () => {
        await setLocale("en");
      });
    }
  });

  it("structured Suggest works again after an invalid answer and never retries on its own", async () => {
    suggestSettings("codex");
    agentComplete.mockResolvedValueOnce({ status: "ok", data: replies.diagnostic });
    agentComplete.mockResolvedValueOnce({ status: "ok", data: replies.success });
    useCommit.setState({ message: "keep this draft" });
    const container = await commitSurface("tool window");
    await suggestIn(container);
    expect(useCommit.getState().message).toBe("keep this draft");
    expect(within(container).getByRole("alert")).toHaveTextContent("The agent returned an invalid commit suggestion.");
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(agentComplete).toHaveBeenCalledTimes(1);
    fireEvent.click(within(container).getByRole("button", { name: "Suggest Commit Message" }));
    await waitFor(() =>
      expect(useCommit.getState().message).toBe("fix: handle empty lists\n\nPreserve the previous selection."),
    );
    expect(agentComplete).toHaveBeenCalledTimes(2);
    expect(within(container).queryByRole("alert")).toBeNull();
  });

  function setTrust(trusted: boolean) {
    act(() => useProject.setState((s) => ({ project: s.project && { ...s.project, trusted } })));
  }

  const restrictedMessage = "Project is in Restricted Mode. Trust the project to enable execution.";

  it("disables Suggest in Restricted Mode with its explanation", () => {
    suggestSettings("codex");
    setTrust(false);
    renderView();
    expect(screen.getByRole("button", { name: "Trust the project to suggest commit messages." })).toBeDisabled();
    expect(agentComplete).not.toHaveBeenCalled();
  });

  it("retires a suggestion immediately on revoke and ignores its late rejection", async () => {
    suggestSettings("codex");
    let reject!: (reason: Error) => void;
    agentComplete.mockImplementation(
      () =>
        new Promise((_, no) => {
          reject = no;
        }),
    );
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Suggest Commit Message" }));
    await waitFor(() => expect(agentComplete).toHaveBeenCalledTimes(1));
    setTrust(false);
    expect(screen.getByRole("alert")).toHaveTextContent(restrictedMessage);
    expect(screen.queryByRole("button", { name: "Suggesting a commit message…" })).toBeNull();
    await act(async () => reject(new Error("late backend failure")));
    expect(screen.getByRole("alert")).toHaveTextContent(restrictedMessage);
    expect(screen.getByRole("alert")).not.toHaveTextContent("late backend failure");
  });

  it("keeps the unedited draft when a revoked suggestion succeeds late", async () => {
    suggestSettings("codex");
    const answer = deferAgent();
    useCommit.setState({ message: "keep the draft" });
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Suggest Commit Message" }));
    await waitFor(() => expect(agentComplete).toHaveBeenCalledTimes(1));
    setTrust(false);
    await answer(suggestion("feat: revoked result"));
    expect(useCommit.getState().message).toBe("keep the draft");
    expect(screen.getByRole("alert")).toHaveTextContent(restrictedMessage);
  });

  it("keeps a new request busy when the old request settles after re-trust", async () => {
    suggestSettings("codex");
    const replies: ((value: { status: "ok"; data: string }) => void)[] = [];
    agentComplete.mockImplementation(() => new Promise((resolve) => replies.push(resolve)));
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Suggest Commit Message" }));
    await waitFor(() => expect(agentComplete).toHaveBeenCalledTimes(1));
    setTrust(false);
    setTrust(true);
    fireEvent.click(screen.getByRole("button", { name: "Suggest Commit Message" }));
    await waitFor(() => expect(agentComplete).toHaveBeenCalledTimes(2));
    await act(async () => replies[0]!({ status: "ok", data: suggestion("feat: stale") }));
    expect(screen.getByRole("button", { name: "Suggesting a commit message…" })).toBeDisabled();
    expect(useCommit.getState().message).toBe("");
    await act(async () => replies[1]!({ status: "ok", data: suggestion("feat: current") }));
    expect(useCommit.getState().message).toBe("feat: current");
    expect(screen.getByRole("button", { name: "Suggest Commit Message" })).toBeEnabled();
  });

  it("clears the busy state after included files retire a pending suggestion", async () => {
    suggestSettings("codex");
    const answer = deferAgent();
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Suggest Commit Message" }));
    await waitFor(() => expect(agentComplete).toHaveBeenCalledTimes(1));
    act(() => useCommit.setState({ checks: new Map([[status[0]!.path, "none"]]) }));
    await answer(suggestion("feat: stale included files"));
    expect(useCommit.getState().message).toBe("");
    expect(screen.getByRole("button", { name: "Suggest Commit Message" })).toBeEnabled();
  });

  it("still loads ignored files in Restricted Mode", async () => {
    vcsIgnored.mockResolvedValue({ status: "ok", data: ignored });
    setTrust(false);
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "View Options" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitemcheckbox", { name: /Ignored Files/ }));
    await screen.findByText("Ignored Files");
    expect(vcsIgnored).toHaveBeenCalledTimes(1);
  });

  it("revoke clears busy state even after included files already retired the answer", async () => {
    suggestSettings("codex");
    const replies: ((value: { status: "ok"; data: string }) => void)[] = [];
    agentComplete.mockImplementation(() => new Promise((resolve) => replies.push(resolve)));
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Suggest Commit Message" }));
    await waitFor(() => expect(agentComplete).toHaveBeenCalledTimes(1));
    act(() => useCommit.setState({ checks: new Map([[status[0]!.path, "none"]]) }));
    setTrust(false);
    expect(screen.getByRole("alert")).toHaveTextContent(restrictedMessage);
    setTrust(true);
    fireEvent.click(screen.getByRole("button", { name: "Suggest Commit Message" }));
    await waitFor(() => expect(agentComplete).toHaveBeenCalledTimes(2));
    await act(async () => replies[0]!({ status: "ok", data: suggestion("feat: retired") }));
    expect(screen.getByRole("button", { name: "Suggesting a commit message…" })).toBeDisabled();
    await act(async () => replies[1]!({ status: "ok", data: suggestion("feat: current files") }));
    expect(useCommit.getState().message).toBe("feat: current files");
  });

  it("translates a restricted refusal when the backend answers before the trust event", async () => {
    suggestSettings("codex");
    let reject!: (reason: Error) => void;
    agentComplete.mockImplementation(
      () =>
        new Promise((_, no) => {
          reject = no;
        }),
    );
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Suggest Commit Message" }));
    await waitFor(() => expect(agentComplete).toHaveBeenCalledTimes(1));
    try {
      await act(async () => {
        await setLocale("it");
      });
      await act(async () => reject(new Error(restrictedMessage)));
      setTrust(false);
      expect(screen.getByRole("alert")).toHaveTextContent(tx(restrictedMessage));
    } finally {
      await act(async () => {
        await setLocale("en");
      });
    }
  });

  it.each(["failure", "diagnostic"] as const)(
    "structured Suggest keeps the trust error when a revoked request settles with a %s",
    async (kind) => {
      suggestSettings("codex");
      const answer = deferAgent();
      useCommit.setState({ message: "keep the draft" });
      renderView();
      fireEvent.click(screen.getByRole("button", { name: "Suggest Commit Message" }));
      await waitFor(() => expect(agentComplete).toHaveBeenCalledTimes(1));
      setTrust(false);
      await answer(replies[kind]);
      expect(screen.getByRole("alert")).toHaveTextContent(restrictedMessage);
      expect(screen.getByRole("alert")).not.toHaveTextContent("The agent");
      expect(useCommit.getState().message).toBe("keep the draft");
    },
  );

  it.each(["failure", "diagnostic"] as const)(
    "structured Suggest keeps a newer request busy when an old one settles with a %s after re-trust",
    async (kind) => {
      suggestSettings("codex");
      const pending: ((value: { status: "ok"; data: string }) => void)[] = [];
      agentComplete.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
      renderView();
      fireEvent.click(screen.getByRole("button", { name: "Suggest Commit Message" }));
      await waitFor(() => expect(agentComplete).toHaveBeenCalledTimes(1));
      setTrust(false);
      setTrust(true);
      fireEvent.click(screen.getByRole("button", { name: "Suggest Commit Message" }));
      await waitFor(() => expect(agentComplete).toHaveBeenCalledTimes(2));
      await act(async () => pending[0]!({ status: "ok", data: replies[kind] }));
      expect(screen.getByRole("button", { name: "Suggesting a commit message…" })).toBeDisabled();
      expect(screen.queryByRole("alert")).toBeNull();
      await act(async () => pending[1]!({ status: "ok", data: replies.success }));
      expect(useCommit.getState().message).toBe("fix: handle empty lists\n\nPreserve the previous selection.");
      expect(screen.getByRole("button", { name: "Suggest Commit Message" })).toBeEnabled();
    },
  );
});
