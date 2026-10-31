import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfigOption, AgentEntry, AgentProvider, AgentStatus, AgentTask } from "@/bindings";
import {
  applyCompletion,
  atEdgeLine,
  canSend,
  completionAt,
  isPathQuery,
  resolveTyped,
  imageFromDataUrl,
  mainOptions,
  matchCommands,
  mentionOf,
  modeIcon,
  nextValue,
  recall,
  toPrompt,
  retryParts,
  usageLabel,
  workTime,
} from "./composerModel";
import {
  age,
  attentionChange,
  branchLabel,
  entriesKey,
  findSubagent,
  groupTasks,
  subagentTitle,
  turnNumbers,
  upsertEntry,
  type SubagentEntry,
} from "./model";
import { markdownHtml } from "./Markdown";

const argsApi = vi.hoisted(() => ({ agentProviders: vi.fn(), agentSetArgs: vi.fn(), agentCreate: vi.fn() }));
vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: { ...real.commands, ...argsApi },
  };
});

function task(id: string, status: AgentStatus, updatedMs: number): AgentTask {
  return {
    id,
    title: id,
    provider: "claude",
    model: null,
    status,
    isolation: "worktree",
    cwd: "/w",
    branch: `agent/${id}`,
    base: "main",
    baseCommit: "abc",
    error: null,
    createdMs: 0,
    updatedMs,
    config: [],
    commands: [],
    usage: null,
    queue: [],
  };
}

const option = (category: string, values: string[], current: string | null): AgentConfigOption => ({
  id: category,
  name: category,
  description: null,
  category,
  current,
  values: values.map((value) => ({ value, name: value, description: null })),
  via: "option",
});

describe("agent composer", () => {
  it("completes @files anywhere and /commands as the first word", () => {
    expect(completionAt("fix @src/le", 11)).toEqual({ kind: "file", query: "src/le", from: 4, to: 11 });
    expect(completionAt("/rev", 4)).toEqual({ kind: "command", query: "rev", from: 0, to: 4 });
    expect(completionAt("run /rev", 8)).toBeNull();
    expect(completionAt("a@b", 3)).toBeNull();
    const c = completionAt("see @le and", 7)!;
    expect(applyCompletion("see @le and", c, "@src/lexer.rs")).toEqual({ text: "see @src/lexer.rs and", caret: 18 });
    const cmds = [
      { name: "init", description: "", hint: null },
      { name: "review", description: "", hint: null },
      { name: "pr-review", description: "", hint: null },
    ];
    expect(matchCommands(cmds, "rev").map((c) => c.name)).toEqual(["review", "pr-review"]);
  });

  it("matches commands by prefix, plugin name, substring, then letters in order", () => {
    const cmds = ["triage", "verify", "issue-fix", "brooks-lint:brooks-review", "pr-review", "init"].map((name) => ({
      name,
      description: "",
      hint: null,
    }));
    const names = (q: string) => matchCommands(cmds, q).map((c) => c.name);
    expect(names("trig")).toEqual(["triage"]);
    expect(names("brooks-r")).toEqual(["brooks-lint:brooks-review"]);
    expect(names("rev")).toEqual(["brooks-lint:brooks-review", "pr-review"]);
    expect(names("if")).toEqual(["verify", "issue-fix"]);
    expect(names("xyz")).toEqual([]);
    expect(names("")).toHaveLength(cmds.length);
  });

  it("sends only the files still mentioned", () => {
    const prompt = toPrompt({
      text: " look at @src/a.rs:3-5 and @b.rs ",
      files: [
        { path: "/w/src/a.rs", rel: "src/a.rs" },
        { path: "/w/b.rs", rel: "b.rs" },
        { path: "/w/b.rs", rel: "b.rs" },
        { path: "/w/gone.rs", rel: "gone.rs" },
      ],
      images: [],
    });
    expect(prompt).toEqual({ text: "look at @src/a.rs:3-5 and @b.rs", files: ["/w/src/a.rs", "/w/b.rs"], images: [] });
    expect(mentionOf("a.rs", { from: 3, to: 3 })).toBe("@a.rs:3");
    expect(canSend({ text: " ", files: [], images: [] })).toBe(false);
  });

  it("recalls history from the edge lines only", () => {
    const h = ["newest", "older"];
    expect(recall(h, -1, -1)).toBe(0);
    expect(recall(h, 0, -1)).toBe(1);
    expect(recall(h, 1, -1)).toBeNull();
    expect(recall(h, 0, 1)).toBe(-1);
    expect(recall(h, -1, 1)).toBeNull();
    expect(atEdgeLine("a\nb", 1, -1)).toBe(true);
    expect(atEdgeLine("a\nb", 3, -1)).toBe(false);
    expect(atEdgeLine("a\nb", 1, 1)).toBe(false);
  });

  it("picks the main settings and cycles the mode", () => {
    const config = [option("fast", ["on"], null), option("mode", ["ask", "code"], "code"), option("model", ["m"], "m")];
    expect(mainOptions(config).map((o) => o.id)).toEqual(["model", "mode"]);
    expect(nextValue(config[1]!)).toBe("ask");
    const approvals = { ...option("openidea.cursor.approval", ["ask", "bypass"], "ask"), category: "approval" };
    expect(mainOptions([...config, approvals]).map((o) => o.id)).toEqual(["model", "mode", approvals.id]);
    expect(
      ["default", "acceptEdits", "plan", "auto", "bypassPermissions", "auto_edit", "read-only", "x"].map(modeIcon),
    ).toEqual(["lock", "edit", "todo", "run", "unlock", "edit", "eye", "lock"]);
    expect(usageLabel({ used: 24_000, size: 200_000 })).toEqual({
      short: "12%",
      detail: "24k / 200k tokens",
    });
    expect(imageFromDataUrl("data:image/png;base64,AAA", "a.png")).toEqual({
      mimeType: "image/png",
      data: "AAA",
      name: "a.png",
    });
    expect(imageFromDataUrl("data:text/plain;base64,AAA")).toBeNull();
  });
});

describe("usage meters", () => {
  it("formats token counts", () => {
    expect(usageLabel({ used: 83_100, size: 1_000_000 }).detail).toBe("83.1k / 1M tokens");
  });

  it("adds up the time spent on turns", () => {
    const user = (sentMs: number, doneMs: number | null): AgentEntry => ({
      type: "user",
      text: "",
      attachments: [],
      sentMs,
      doneMs,
    });
    const entries = [user(0, 5_000), { type: "agent", text: "" } as AgentEntry, user(10_000, null)];
    expect(workTime(entries, 12_000)).toBe(7_000);
    expect(workTime(entries, null)).toBe(5_000);
  });
});

describe("agents model", () => {
  it("groups tasks by what they need, newest first", () => {
    const groups = groupTasks([
      task("a", "ready", 1),
      task("b", "needsInput", 2),
      task("c", "running", 3),
      task("d", "starting", 4),
      task("e", "ready", 5),
    ]);
    expect(groups.map((g) => [g.status, g.tasks.map((t) => t.id)])).toEqual([
      ["needsInput", ["b"]],
      ["running", ["d", "c"]],
      ["ready", ["e", "a"]],
    ]);
  });

  it("upserts entries in place and refuses gaps", () => {
    const a: AgentEntry = { type: "agent", text: "a" };
    const b: AgentEntry = { type: "agent", text: "b" };
    expect(upsertEntry([a], 0, b)).toEqual([b]);
    expect(upsertEntry([a], 1, b)).toEqual([a, b]);
    expect(upsertEntry([a], 3, b)).toBeNull();
  });

  it("notifies on finish, failure and questions only", () => {
    expect(attentionChange("running", "ready")).toBe("finished");
    expect(attentionChange("running", "failed")).toBe("failed");
    expect(attentionChange("running", "limited")).toBe("failed");
    expect(attentionChange("running", "needsInput")).toBe("input");
    expect(attentionChange("needsInput", "running")).toBeNull();
    expect(attentionChange("ready", "archived")).toBeNull();
    expect(attentionChange(undefined, "ready")).toBeNull();
  });

  it("finds subagent cards and keys their conversations apart", () => {
    const card: SubagentEntry = {
      type: "subagent",
      id: "c1",
      title: null,
      description: "Find the lexer",
      status: "running",
      error: null,
      prompt: null,
      reply: null,
      tools: 0,
      activity: null,
      startedMs: 0,
      endedMs: null,
      cancellable: false,
    };
    expect(findSubagent([{ type: "agent", text: "a" }, card], "c1")).toBe(card);
    expect(findSubagent(undefined, "c1")).toBeUndefined();
    expect(subagentTitle(card)).toBe("Find the lexer");
    expect(subagentTitle({ ...card, title: "Explore" })).toBe("Explore");
    expect(entriesKey("t", null)).toBe("t");
    expect(entriesKey("t", "c1")).not.toBe(entriesKey("t", null));
  });

  it("formats labels", () => {
    expect(branchLabel("agent/fix-lexer")).toBe("fix-lexer");
    expect(branchLabel(null)).toBe("");
    expect(age(0, 30_000)).toBe("now");
    expect(age(0, 5 * 60_000)).toBe("5m");
    expect(age(0, 3 * 3_600_000)).toBe("3h");
  });

  it("renders agent markdown without scripts", () => {
    const html = markdownHtml("**bold** <img src=x onerror=alert(1)><script>alert(1)</script>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("<script");
  });

  it("gives the text of a list item with a nested list its own block", () => {
    const html = markdownHtml("- **parent** text:\n  - child\n- plain");
    expect(html).toContain("<li><div><strong>parent</strong> text:</div><ul>");
    expect(html).toContain("<li>child</li>");
    expect(html).toContain("<li>plain</li>");
  });
});

describe("turns", () => {
  it("numbers the messages that start a turn, not those steered into one", () => {
    const user = (text: string, steered = false): AgentEntry => ({
      type: "user",
      text,
      attachments: [],
      sentMs: null,
      doneMs: null,
      steered,
    });
    const entries: AgentEntry[] = [
      user("first"),
      { type: "agent", text: "ok" },
      user("also", true),
      user("second"),
      { type: "agent", text: "done" },
    ];
    expect([...turnNumbers(entries)]).toEqual([
      [0, 0],
      [3, 1],
    ]);
  });
});

describe("retryParts", () => {
  it("counts down to the next attempt and shows the limit when known", () => {
    const retry = { attempt: 3, maxRetries: 10, retryAtMs: 5_400, error: "Connection error." };
    expect(retryParts(retry, 1_000)).toEqual({ attempt: "3/10", wait: 5 });
    expect(retryParts({ ...retry, maxRetries: null }, 9_000)).toEqual({ attempt: "3", wait: 0 });
  });
});

describe("typed path references", () => {
  it("tells a path from a search", () => {
    for (const q of ["../", "..", "./a", "/etc", "../x/y"]) expect(isPathQuery(q)).toBe(true);
    for (const q of ["", "src/le", ".gitignore", "a/../b"]) expect(isPathQuery(q)).toBe(false);
  });

  it("resolves against the task root", () => {
    expect(resolveTyped("/r/idea", "../kalo/a.ts")).toBe("/r/kalo/a.ts");
    expect(resolveTyped("/r/idea", "./src")).toBe("/r/idea/src");
    expect(resolveTyped("/r/idea", "/etc/hosts")).toBe("/etc/hosts");
    expect(resolveTyped("C:\\r\\idea", "../kalo/a.ts")).toBe("C:/r/kalo/a.ts");
    expect(resolveTyped("C:\\r", "../../x")).toBe("C:/x");
  });
});

describe("fork agent selections and arguments", () => {
  const argsKey = "openidea.agents.args.v1";
  let backend: AgentProvider[];
  const provider = (id: string, extraArgs: string[] = []): AgentProvider => ({
    id,
    name: id,
    command: id,
    extraArgs,
    installed: true,
    config: [],
    commands: [],
    source: { kind: "builtin" },
  });
  const preset = (id: string, agent: string) => ({
    id,
    name: id,
    provider: agent,
    model: "test-model",
    effort: "high",
    mode: "read-only",
    instructions: "Run the relevant checks.",
  });
  const result = () => ({ status: "ok", data: backend.map((p) => ({ ...p, extraArgs: [...(p.extraArgs ?? [])] })) });

  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    backend = [provider("antigravity-acp"), provider("pi-acp"), provider("codex")];
    argsApi.agentProviders.mockReset().mockImplementation(async () => result());
    argsApi.agentSetArgs.mockReset().mockImplementation(async (id: string, args: string[]) => {
      backend = backend.map((p) =>
        p.id === id ? { ...p, extraArgs: args.map((arg) => arg.trim()).filter(Boolean) } : p,
      );
      return result();
    });
    argsApi.agentCreate.mockReset();
  });

  it("maps only legacy user-selection ids and uses registry icons", async () => {
    const { legacyAgentId, providerIcon } = await import("./model");
    expect(["agy", "pi", "codex", "custom"].map(legacyAgentId)).toEqual([
      "antigravity-acp",
      "pi-acp",
      "codex",
      "custom",
    ]);
    expect(providerIcon("antigravity-acp")).toBe("agent-antigravity-acp");
    expect(providerIcon("pi-acp")).toBe("agent-pi-acp");
    expect(providerIcon("custom")).toBe("toolwindow-agents");
  });

  it("migrates presets, disabled ids and the selected draft once without touching prompt history", async () => {
    localStorage.setItem("openidea.agents.presets.v1", JSON.stringify([preset("a", "agy"), preset("p", "pi")]));
    localStorage.setItem("openidea.agents.disabled.v1", JSON.stringify(["agy", "antigravity-acp", "pi"]));
    localStorage.setItem(
      "openidea.agents.draft.v2",
      JSON.stringify({
        provider: "pi",
        presetId: "p",
        config: { model: "saved" },
        isolation: "local",
        base: null,
        projectRoot: "/member",
      }),
    );
    localStorage.setItem("openidea.agents.history.v1", JSON.stringify(["ask agy about pi"]));
    const saved = vi.spyOn(Storage.prototype, "setItem");
    const { useAgents, applyPreset } = await import("./store");
    expect(useAgents.getState().presets.map((p) => p.provider)).toEqual(["antigravity-acp", "pi-acp"]);
    expect(useAgents.getState().disabledProviders).toEqual(["antigravity-acp", "pi-acp"]);
    expect(useAgents.getState().draft).toMatchObject({ provider: "pi-acp", presetId: "p", projectRoot: "/member" });
    expect(useAgents.getState().history).toEqual(["ask agy about pi"]);
    expect(saved).toHaveBeenCalledTimes(3);
    saved.mockClear();
    vi.resetModules();
    await import("./store");
    expect(saved).not.toHaveBeenCalled();
    saved.mockRestore();
    applyPreset("a");
    expect(useAgents.getState().draft).toMatchObject({
      provider: "antigravity-acp",
      presetId: "a",
      projectRoot: "/member",
    });
  });

  it("parses quoted arguments while preserving Windows paths and formats them losslessly", async () => {
    const { parseCliArgs, formatCliArgs, presetConfigFor, withInjectedInstructions } = await import("./store");
    expect(parseCliArgs(`  --model test --prompt "hello world" 'single arg' `)).toEqual([
      "--model",
      "test",
      "--prompt",
      "hello world",
      "single arg",
    ]);
    expect(parseCliArgs(String.raw`--config "C:\Users\Innotech\cfg.toml" --flag "say \"hi\""`)).toEqual([
      "--config",
      String.raw`C:\Users\Innotech\cfg.toml`,
      "--flag",
      'say "hi"',
    ]);
    expect(formatCliArgs(["--model", "two words"])).toBe('--model "two words"');
    const args = [
      "--flag",
      "two words",
      'say "hi"',
      "don't",
      "",
      "C:\\Users\\Name With Spaces\\",
      String.raw`\\server\share\folder`,
      String.raw`a\b'c"d`,
    ];
    expect(parseCliArgs(formatCliArgs(args))).toEqual(args);
    expect(parseCliArgs("\"\" ''")).toEqual(["", ""]);
    expect(presetConfigFor({ model: "m", effort: "xhigh", mode: "read-only" })).toEqual({
      model: "m",
      thought_level: "xhigh",
      mode: "read-only",
    });
    expect(withInjectedInstructions("Fix bug", "")).toBe("Fix bug");
    expect(withInjectedInstructions("Fix bug", "  Run tests.  ")).toBe("Run tests.\n\nFix bug");
  });

  it("imports old arguments once and reads the server's returned values", async () => {
    localStorage.setItem(argsKey, JSON.stringify({ agy: '--model "two words"', pi: "--fast" }));
    const { refreshProviders, useAgents } = await import("./store");
    await refreshProviders();
    expect(argsApi.agentSetArgs.mock.calls).toEqual([
      ["antigravity-acp", ["--model", "two words"]],
      ["pi-acp", ["--fast"]],
    ]);
    expect(localStorage.getItem(argsKey)).toBeNull();
    expect(useAgents.getState().providers.find((p) => p.id === "pi-acp")?.extraArgs).toEqual(["--fast"]);
    await refreshProviders();
    expect(argsApi.agentSetArgs).toHaveBeenCalledTimes(2);
  });

  it("persists import progress and keeps failed or unknown entries pending", async () => {
    localStorage.setItem(argsKey, JSON.stringify({ agy: "--ok", pi: "--retry", missing: "--keep" }));
    const write = argsApi.agentSetArgs.getMockImplementation()!;
    argsApi.agentSetArgs.mockImplementation(async (id, args) => {
      if (id === "pi-acp") throw new Error("offline");
      return write(id, args);
    });
    const { refreshProviders } = await import("./store");
    await refreshProviders();
    expect(JSON.parse(localStorage.getItem(argsKey)!)).toEqual({ pi: "--retry", missing: "--keep" });
    argsApi.agentSetArgs.mockImplementation(write);
    await refreshProviders();
    expect(JSON.parse(localStorage.getItem(argsKey)!)).toEqual({ missing: "--keep" });
    expect(argsApi.agentSetArgs.mock.calls.filter(([id]) => id === "antigravity-acp")).toHaveLength(1);
  });

  it("keeps alias collisions and server conflicts pending without overwriting them", async () => {
    backend[0] = provider("antigravity-acp", ["--server"]);
    const pending = { agy: "--legacy", pi: "--one", "pi-acp": "--two" };
    localStorage.setItem(argsKey, JSON.stringify(pending));
    const { refreshProviders } = await import("./store");
    await refreshProviders();
    expect(argsApi.agentSetArgs).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(argsKey)!)).toEqual(pending);
    expect(backend[0]!.extraArgs).toEqual(["--server"]);
  });

  it("recognizes already-persisted arguments and preserves malformed storage", async () => {
    backend[0] = provider("antigravity-acp", ["--same"]);
    localStorage.setItem(argsKey, JSON.stringify({ agy: "--same" }));
    const { refreshProviders } = await import("./store");
    await refreshProviders();
    expect(localStorage.getItem(argsKey)).toBeNull();
    expect(argsApi.agentSetArgs).not.toHaveBeenCalled();
    localStorage.setItem(argsKey, "{invalid");
    await refreshProviders();
    expect(localStorage.getItem(argsKey)).toBe("{invalid");
  });

  it("lets an explicit edit resolve all aliases but leaves unrelated pending values intact", async () => {
    localStorage.setItem(argsKey, JSON.stringify({ pi: "--one", "pi-acp": "--two", missing: "--keep" }));
    const { setProviderArgs, refreshProviders, useAgents } = await import("./store");
    await setProviderArgs("pi", "--chosen");
    expect(argsApi.agentSetArgs).toHaveBeenCalledWith("pi-acp", ["--chosen"]);
    expect(JSON.parse(localStorage.getItem(argsKey)!)).toEqual({ missing: "--keep" });
    await refreshProviders();
    expect(useAgents.getState().providers.find((p) => p.id === "pi-acp")?.extraArgs).toEqual(["--chosen"]);
    expect(argsApi.agentSetArgs).toHaveBeenCalledTimes(1);
  });

  it("preserves pending args on a failed edit and allows explicit clearing without reimport", async () => {
    localStorage.setItem(argsKey, JSON.stringify({ agy: "--legacy" }));
    const { setProviderArgs, refreshProviders } = await import("./store");
    argsApi.agentSetArgs.mockRejectedValueOnce(new Error("offline"));
    await expect(setProviderArgs("antigravity-acp", "--new")).rejects.toThrow("offline");
    expect(JSON.parse(localStorage.getItem(argsKey)!)).toEqual({ agy: "--legacy" });
    await setProviderArgs("antigravity-acp", "");
    expect(localStorage.getItem(argsKey)).toBeNull();
    await refreshProviders();
    expect(backend[0]!.extraArgs).toEqual([]);
    expect(argsApi.agentSetArgs).toHaveBeenCalledTimes(2);
  });

  it("does not start a disabled provider through the programmatic entry point", async () => {
    const { useAgents, updateComposer, startTask, HOME } = await import("./store");
    useAgents.setState({
      providers: backend,
      disabledProviders: ["codex"],
      draft: { provider: "codex", config: {}, isolation: "local", base: null },
    });
    updateComposer(HOME, { text: "Do something" });
    await startTask();
    expect(argsApi.agentCreate).not.toHaveBeenCalled();
  });

  it("imports identical aliases once and lets a queued explicit edit win", async () => {
    localStorage.setItem(argsKey, JSON.stringify({ agy: "--old", "antigravity-acp": "--old" }));
    const write = argsApi.agentSetArgs.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    argsApi.agentSetArgs.mockImplementationOnce(async (id, args) => {
      await gate;
      return write(id, args);
    });
    const { refreshProviders, setProviderArgs, useAgents } = await import("./store");
    const importing = refreshProviders();
    await vi.waitFor(() => expect(argsApi.agentSetArgs).toHaveBeenCalledTimes(1));
    const editing = setProviderArgs("antigravity-acp", "--new");
    release();
    await Promise.all([importing, editing]);
    expect(argsApi.agentSetArgs.mock.calls).toEqual([
      ["antigravity-acp", ["--old"]],
      ["antigravity-acp", ["--new"]],
    ]);
    expect(localStorage.getItem(argsKey)).toBeNull();
    expect(backend[0]!.extraArgs).toEqual(["--new"]);
    expect(useAgents.getState().providers.find((p) => p.id === "antigravity-acp")?.extraArgs).toEqual(["--new"]);
  });

  it("preserves a missing preset provider and refuses a mismatched fallback task", async () => {
    const { useAgents, applyPreset, updateComposer, startTask, HOME } = await import("./store");
    useAgents.setState({ providers: [provider("codex")], presets: [preset("a", "antigravity-acp")] });
    applyPreset("a");
    updateComposer(HOME, { text: "Work" });
    await startTask();
    expect(useAgents.getState().draft).toMatchObject({ provider: "antigravity-acp", presetId: "a" });
    expect(argsApi.agentCreate).not.toHaveBeenCalled();
  });

  it("does not import against stale provider data when the queued refresh fails", async () => {
    localStorage.setItem(argsKey, JSON.stringify({ agy: "--keep" }));
    argsApi.agentProviders.mockResolvedValueOnce(result()).mockRejectedValueOnce(new Error("offline"));
    const { refreshProviders } = await import("./store");
    await refreshProviders();
    expect(argsApi.agentSetArgs).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(argsKey)!)).toEqual({ agy: "--keep" });
  });
});
