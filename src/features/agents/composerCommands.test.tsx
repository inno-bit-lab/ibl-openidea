import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentCommand, AgentProvider } from "@/bindings";

const agentCommands = vi.fn();
const agentCreate = vi.fn();
const agentSetArgs = vi.fn();
const openInput = vi.fn();
const vcsBranches = vi.fn();
const vcsBranchInfo = vi.fn();

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: vi.fn(() => true),
    commands: {
      ...real.commands,
      agentCommands: (provider: string, task: string | null) => agentCommands(provider, task),
      agentCreate: (request: unknown) => agentCreate(request),
      agentSetArgs: (provider: string, args: string[]) => agentSetArgs(provider, args),
      vcsBranchInfo: (root: string | null) => vcsBranchInfo(root),
      vcsBranches: (root: string | null) => vcsBranches(root),
    },
  };
});
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));

import { isTauri } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import type { ProjectInfo } from "@/bindings";
import { defaultTaskProject } from "./project";
import { provideEditorService } from "@/workbench/contributions";
import { CATALOG_KEY, CATALOG_KIND } from "./model";
import { HomeEditor } from "./HomeEditor";
import { AcpArgumentsDialog, AgentsCatalogEditor, ManagePresetsDialog } from "./AgentsCatalogEditor";
import { HOME, updateComposer, useAgents } from "./store";
import { emptyDraft } from "./composerModel";

const command = (name: string, description: string): AgentCommand => ({ name, description, hint: null });
const claude: AgentProvider = {
  id: "claude",
  name: "Claude Code",
  command: "npx",
  installed: true,
  config: [],
  source: { kind: "builtin" },
  extraArgs: [],
  // Offered by the agent's last session in this project.
  commands: [command("compact", "Free up context")],
};

beforeEach(() => {
  vi.mocked(isTauri).mockReturnValue(true);
  useProject.setState({ project: null });
  openInput.mockReset().mockResolvedValue(undefined);
  provideEditorService({
    openFile: async () => {},
    openInput,
    activePath: () => null,
    activeCursor: () => null,
    saveAll: async () => {},
  });
  agentSetArgs.mockReset().mockResolvedValue({ status: "ok", data: [claude] });
  vcsBranches.mockReset().mockResolvedValue({ status: "ok", data: [] });
  vcsBranchInfo
    .mockReset()
    .mockImplementation((root: string | null) =>
      Promise.resolve({ status: "ok", data: { head: root === "/project-b" ? "b-main" : "a-main" } }),
    );
  agentCommands.mockReset();
  agentCreate.mockReset().mockResolvedValue({ status: "error", error: { kind: "invalid", message: "stop here" } });
  useAgents.setState({
    providers: [claude],
    presets: [],
    disabledProviders: [],
    draft: { provider: "claude", config: {}, isolation: "local", base: null },
  });
  updateComposer(HOME, emptyDraft());
});

describe("New Task composer commands", () => {
  it("completes the project's skills merged with the agent's commands", async () => {
    agentCommands.mockResolvedValue({
      status: "ok",
      data: [
        command("compact", "Free up context"),
        command("triage", "One pass over open issues and PRs"),
        command("issue-fix", "Fix an issue"),
      ],
    });
    render(<HomeEditor />);
    await waitFor(() => expect(agentCommands).toHaveBeenCalledWith("claude", null));
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "/trig" } });
    const list = await screen.findByRole("listbox", { name: "Commands" });
    const options = within(list).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["/triageOne pass over open issues and PRs"]);

    fireEvent.keyDown(box, { key: "Enter" });
    expect(useAgents.getState().composers.get(HOME)?.text).toBe("/triage ");

    // Sent as typed, so the agent runs the skill.
    fireEvent.change(box, { target: { value: "/triage dry-run" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(agentCreate).toHaveBeenCalled());
    expect(agentCreate.mock.calls[0]![0]).toMatchObject({ prompt: { text: "/triage dry-run" }, provider: "claude" });
  });

  it("offers nothing the project does not have", async () => {
    agentCommands.mockResolvedValue({ status: "ok", data: [command("compact", "Free up context")] });
    render(<HomeEditor />);
    await waitFor(() => expect(agentCommands).toHaveBeenCalled());
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "/trig" } });
    expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull();
    fireEvent.change(box, { target: { value: "/com" } });
    expect(await screen.findByRole("option")).toHaveTextContent("/compact");
  });

  it("completes at the caret without replacing the rest of the message", async () => {
    const user = userEvent.setup();
    agentCommands.mockResolvedValue({ status: "ok", data: [command("compact", "Free up context")] });
    render(<HomeEditor />);
    await waitFor(() => expect(agentCommands).toHaveBeenCalled());
    const box = screen.getByRole("textbox");
    box.focus();
    fireEvent.change(box, { target: { value: "/com keep this context", selectionStart: 4, selectionEnd: 4 } });
    expect(await screen.findByRole("option")).toHaveTextContent("/compact");
    expect(box).toHaveFocus();

    await user.keyboard("{Tab}");
    expect(box).toHaveValue("/compact keep this context");
    await waitFor(() => expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull());
    expect(agentCreate).not.toHaveBeenCalled();
  });
});

describe("workspace task project", () => {
  const project = {
    root: "/workspace",
    name: "Workspace",
    isGit: false,
    workspace: { version: 1, name: "Workspace", projects: ["/project-a", "/project-b"] },
  } as ProjectInfo;
  it("defaults to the active member, last used member, then first member", () => {
    expect(defaultTaskProject(project, "/project-b/src/main.ts", "/project-a")).toBe("/project-b");
    expect(defaultTaskProject(project, null, "/project-b")).toBe("/project-b");
    expect(defaultTaskProject(project, "/project-b-other/file", "/removed")).toBe("/project-a");
    expect(defaultTaskProject({ ...project, workspace: null }, "/project-b/file", "/project-b")).toBe("/workspace");
  });
  it.each(["local", "worktree"] as const)("sends the selected project with %s isolation", async (isolation) => {
    vi.mocked(isTauri).mockReturnValue(false);
    useProject.setState({ project });
    agentCommands.mockResolvedValue({ status: "ok", data: [] });
    useAgents.setState({ draft: { ...useAgents.getState().draft, projectRoot: "/project-b", isolation } });
    render(<HomeEditor />);
    const selector = screen.getByRole("button", { name: "Project" });
    expect(selector).toHaveTextContent("project-b");
    await waitFor(() => expect(vcsBranchInfo).toHaveBeenCalledWith("/project-b"));
    expect(vcsBranches).toHaveBeenCalledWith("/project-b");
    fireEvent.click(selector);
    expect(within(screen.getByRole("listbox")).getByText("/project-a")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: /project-a/ }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Update member" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Start" })).toBeEnabled());
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    await waitFor(() => expect(agentCreate).toHaveBeenCalled());
    expect(agentCreate.mock.calls[0]![0]).toMatchObject({ projectRoot: "/project-a", isolation });
    expect(vcsBranchInfo).toHaveBeenLastCalledWith("/project-a");
    expect(vcsBranches).toHaveBeenLastCalledWith("/project-a");
    await vi.dynamicImportSettled();
  });
});

describe("agent preferences and presets", () => {
  const italianPreset = {
    id: "italian",
    name: "Italian",
    provider: "claude",
    model: "",
    effort: "",
    mode: "",
    instructions: "  Always reply in Italian.  ",
  };

  it("sends a selected preset's instructions separately from the user's prompt", async () => {
    agentCommands.mockResolvedValue({ status: "ok", data: [] });
    useAgents.setState({ presets: [italianPreset] });
    render(<HomeEditor />);
    fireEvent.click(screen.getByRole("button", { name: "Agent" }));
    fireEvent.click(screen.getByRole("option", { name: "Italian" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Fix the login bug" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    await waitFor(() => expect(agentCreate).toHaveBeenCalledOnce());
    expect(agentCreate.mock.calls[0]![0]).toMatchObject({
      provider: "claude",
      instructions: "Always reply in Italian.",
      prompt: { text: "Fix the login bug" },
    });
  });

  it("opens the slimmed Agents tab from the picker and keeps the registry link", async () => {
    vi.mocked(isTauri).mockReturnValue(false);
    agentCommands.mockResolvedValue({ status: "ok", data: [] });
    const home = render(<HomeEditor />);
    fireEvent.click(screen.getByRole("button", { name: "Agent" }));
    fireEvent.click(screen.getByRole("option", { name: "Manage Agents…" }));
    expect(openInput).toHaveBeenCalledWith(
      { kind: CATALOG_KIND, key: CATALOG_KEY, data: { openPresets: false } },
      { focus: true },
    );
    home.unmount();
    render(<AgentsCatalogEditor input={openInput.mock.calls[0]![0]} />);
    expect(screen.getByRole("checkbox", { name: "Enable Claude Code" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Edit arguments for Claude Code" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "More agents…" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Enable Claude Code" }));
    expect(useAgents.getState().disabledProviders).toEqual(["claude"]);
  });

  it("cannot start a disabled agent retained in the draft", () => {
    vi.mocked(isTauri).mockReturnValue(false);
    agentCommands.mockResolvedValue({ status: "ok", data: [] });
    useAgents.setState({ disabledProviders: ["claude"] });
    render(<HomeEditor />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Fix a bug" } });
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(agentCreate).not.toHaveBeenCalled();
  });

  it("does not display a fallback agent when the saved provider is absent", () => {
    vi.mocked(isTauri).mockReturnValue(false);
    useAgents.setState({ draft: { ...useAgents.getState().draft, provider: "antigravity-acp", presetId: null } });
    render(<HomeEditor />);
    expect(screen.getByRole("button", { name: "Agent" })).toHaveTextContent("antigravity-acp");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Fix a bug" } });
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(agentCreate).not.toHaveBeenCalled();
  });

  it("does not substitute another provider for a preset whose agent is missing", () => {
    vi.mocked(isTauri).mockReturnValue(false);
    const preset = { ...italianPreset, provider: "antigravity-acp" };
    useAgents.setState({
      presets: [preset],
      draft: { ...useAgents.getState().draft, presetId: preset.id, provider: preset.provider },
    });
    render(<HomeEditor />);
    expect(screen.getByRole("button", { name: "Agent" })).toHaveTextContent("Italian");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Fix a bug" } });
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(agentCreate).not.toHaveBeenCalled();
  });

  it("keeps failed argument edits open and resets an abandoned edit on reopen", async () => {
    const provider = { ...claude, extraArgs: ["--model", "two words"] };
    const onClose = vi.fn();
    const view = render(<AcpArgumentsDialog provider={provider} onClose={onClose} />);
    const field = screen.getByLabelText("Enter command-line arguments");
    expect(field).toHaveValue('--model "two words"');
    fireEvent.change(field, { target: { value: "--unsaved" } });
    view.rerender(<AcpArgumentsDialog provider={null} onClose={onClose} />);
    view.rerender(<AcpArgumentsDialog provider={provider} onClose={onClose} />);
    expect(screen.getByLabelText("Enter command-line arguments")).toHaveValue('--model "two words"');
    fireEvent.change(screen.getByLabelText("Enter command-line arguments"), { target: { value: "--trace" } });
    agentSetArgs.mockResolvedValueOnce({
      status: "error",
      error: { kind: "invalid", message: "Cannot save arguments" },
    });
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Cannot save arguments");
    expect(onClose).not.toHaveBeenCalled();
    expect(agentSetArgs).toHaveBeenCalledWith("claude", ["--trace"]);
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("duplicates presets with distinct identities and discards cancelled edits", () => {
    vi.mocked(isTauri).mockReturnValue(false);
    useAgents.setState({ presets: [italianPreset] });
    const view = render(<ManagePresetsDialog open onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Duplicate Preset" }));
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    const saved = useAgents.getState().presets;
    expect(saved).toHaveLength(2);
    expect(new Set(saved.map((p) => p.id)).size).toBe(2);
    expect(saved[1]?.instructions).toBe(italianPreset.instructions);
    view.rerender(<ManagePresetsDialog open={false} onClose={() => {}} />);
    view.rerender(<ManagePresetsDialog open onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Unsaved name" } });
    view.rerender(<ManagePresetsDialog open={false} onClose={() => {}} />);
    view.rerender(<ManagePresetsDialog open onClose={() => {}} />);
    expect(screen.getByLabelText("Name")).toHaveValue("Italian");
  });

  it("reopens Manage Presets only for a new catalog request", () => {
    vi.mocked(isTauri).mockReturnValue(false);
    useAgents.setState({ presets: [italianPreset] });
    const data = { openPresets: true };
    const view = render(<AgentsCatalogEditor input={{ data }} />);
    expect(screen.getByRole("dialog", { name: "Manage Presets" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.change(screen.getByLabelText("Search agents"), { target: { value: "claude" } });
    expect(screen.queryByRole("dialog", { name: "Manage Presets" })).toBeNull();
    view.rerender(<AgentsCatalogEditor input={{ data: { openPresets: true } }} />);
    expect(screen.getByRole("dialog", { name: "Manage Presets" })).toBeInTheDocument();
  });
});
