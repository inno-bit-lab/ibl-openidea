import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AgentCommand, AgentProvider } from "@/bindings";

const agentCommands = vi.fn();
const agentCreate = vi.fn();

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: {
      ...real.commands,
      agentCommands: (provider: string, task: string | null) => agentCommands(provider, task),
      agentCreate: (request: unknown) => agentCreate(request),
      vcsBranches: () => Promise.resolve({ status: "ok", data: [] }),
    },
  };
});
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));

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
  // Offered by the agent's last session in this project.
  commands: [command("compact", "Free up context")],
};

beforeEach(() => {
  agentCommands.mockReset();
  agentCreate.mockReset().mockResolvedValue({ status: "error", error: { kind: "invalid", message: "stop here" } });
  useAgents.setState({
    providers: [claude],
    presets: [],
    customArgs: {},
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

  it("sends preset injected instructions separately from the user prompt text", async () => {
    agentCommands.mockResolvedValue({ status: "ok", data: [] });
    useAgents.setState({
      providers: [claude],
      presets: [
        {
          id: "p1",
          name: "Preset 1",
          provider: "claude",
          model: "",
          effort: "",
          mode: "",
          instructions: "  Always reply in Italian.  ",
        },
      ],
      draft: { provider: "claude", presetId: "p1", config: {}, isolation: "local", base: null },
    });
    render(<HomeEditor />);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "Fix the login bug" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(agentCreate).toHaveBeenCalled());
    expect(agentCreate.mock.calls[0]![0]).toMatchObject({
      prompt: { text: "Fix the login bug" },
      provider: "claude",
      instructions: "Always reply in Italian.",
    });
  });

  it("resets AcpArgumentsDialog and ManagePresetsDialog state across open/close cycles and duplicates presets", () => {
    useAgents.setState({
      providers: [claude],
      customArgs: { claude: "--model opus" },
      presets: [
        {
          id: "p1",
          name: "Base Preset",
          provider: "claude",
          model: "",
          effort: "",
          mode: "",
          instructions: "Be concise",
        },
      ],
    });

    const { rerender } = render(<AcpArgumentsDialog provider={claude} onClose={() => {}} />);
    const argInput = screen.getByLabelText("Enter command-line arguments") as HTMLInputElement;
    expect(argInput.value).toBe("--model opus");
    fireEvent.change(argInput, { target: { value: "--unsaved" } });
    expect(argInput.value).toBe("--unsaved");

    // Closing and reopening for the same provider resets to saved customArgs.
    rerender(<AcpArgumentsDialog provider={null} onClose={() => {}} />);
    rerender(<AcpArgumentsDialog provider={claude} onClose={() => {}} />);
    expect((screen.getByLabelText("Enter command-line arguments") as HTMLInputElement).value).toBe("--model opus");
    rerender(<AcpArgumentsDialog provider={null} onClose={() => {}} />);

    // ManagePresetsDialog resets unsaved edits on reopen and duplicates with distinct IDs.
    const { rerender: rerenderPresets } = render(<ManagePresetsDialog open={true} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Duplicate Preset" }));
    expect(screen.getAllByRole("option")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Add Preset" }));
    expect(screen.getAllByRole("option")).toHaveLength(3);
    rerenderPresets(<ManagePresetsDialog open={false} onClose={() => {}} />);
    rerenderPresets(<ManagePresetsDialog open={true} onClose={() => {}} />);
    expect(screen.getAllByRole("option")).toHaveLength(1);
    rerenderPresets(<ManagePresetsDialog open={false} onClose={() => {}} />);

    // AgentsCatalogEditor opens ManagePresetsDialog when input.data.openPresets becomes true,
    // stays closed across local re-renders after dismissal, and reopens on a new openPresets payload.
    const initialData = { openPresets: false };
    const { rerender: rerenderCatalog } = render(<AgentsCatalogEditor input={{ data: initialData }} />);
    expect(screen.queryByRole("dialog", { name: "Manage Presets" })).toBeNull();

    const firstOpenData = { openPresets: true };
    rerenderCatalog(<AgentsCatalogEditor input={{ data: firstOpenData }} />);
    expect(screen.getByRole("dialog", { name: "Manage Presets" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Manage Presets" })).toBeNull();

    // Local re-render with the same input.data reference must keep the dialog closed.
    fireEvent.change(screen.getByLabelText("Search agents"), { target: { value: "claude" } });
    expect(screen.queryByRole("dialog", { name: "Manage Presets" })).toBeNull();

    // Re-invoking openCatalog(true) passes a fresh data object with openPresets: true and reopens the dialog.
    rerenderCatalog(<AgentsCatalogEditor input={{ data: { openPresets: true } }} />);
    expect(screen.getByRole("dialog", { name: "Manage Presets" })).toBeTruthy();
  });
});

