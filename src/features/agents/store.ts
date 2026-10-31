/** Agent tasks of the open project, mirrored from `ide-agent` through `agentSubscribe`. */
import { Channel } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { create } from "zustand";
import type {
  AgentChange,
  AgentCommand,
  AgentEntry,
  AgentEvent,
  AgentImage,
  AgentProvider,
  AgentTask,
  Isolation,
} from "@/bindings";
import { useProject } from "@/platform/project";
import { defaultTaskProject } from "./project";
import { call, commands, isTauri } from "@/platform/ipc";
import { editorService, notifications } from "@/workbench/contributions";
import { bypassDefaults, canSend, emptyDraft, toPrompt, type ComposerDraft, type FileRef } from "./composerModel";
import { withQuote } from "./conversation";
import {
  CATALOG_KEY,
  CATALOG_KIND,
  HOME_KEY,
  HOME_KIND,
  SESSION_KIND,
  attentionChange,
  entriesKey,
  isBusy,
  legacyAgentId,
  sessionKey,
  upsertEntry,
} from "./model";

export interface AgentPreset {
  id: string;
  name: string;
  provider: string;
  model: string;
  effort: string;
  mode: string;
  instructions: string;
}

/** New Task page settings (its text lives in the `HOME` composer). */
export interface Draft {
  projectRoot?: string | null;
  provider: string;
  /** Active preset id, when a preset was selected. */
  presetId?: string | null;
  /** Settings chosen for the next task, by option id (reset when the agent changes). */
  config: Record<string, string>;
  isolation: Isolation;
  /** `null`: the current branch. */
  base: string | null;
}

/** Composer key of the New Task page; sessions use their task id. */
export const HOME = "home";

interface AgentsState {
  loaded: boolean;
  /** Why the tasks could not be loaded. */
  error: string | null;
  tasks: Map<string, AgentTask>;
  /** Tasks with unseen replies or status changes in this project. */
  unread: Set<string>;
  /** Entries of the tasks (and subagents) opened in this window, by `entriesKey`. */
  entries: Map<string, AgentEntry[]>;
  changes: Map<string, AgentChange[]>;
  providers: AgentProvider[];
  presets: AgentPreset[];
  disabledProviders: string[];
  draft: Draft;
  composers: Map<string, ComposerDraft>;
  /** The composer typed in last: where "Send to Agent" adds references. */
  lastComposer: string;
  /** First messages of past tasks, newest first (New Task page ↑). */
  history: string[];
  /** The composer asked to take focus (`seq` tells repeated requests apart). */
  focus: { key: string; seq: number } | null;
}

const DRAFT_KEY = "openidea.agents.draft.v2";
const HISTORY_KEY = "openidea.agents.history.v1";
const PRESETS_KEY = "openidea.agents.presets.v1";
const DISABLED_KEY = "openidea.agents.disabled.v1";
const ARGS_KEY = "openidea.agents.args.v1";
const HISTORY_SIZE = 50;

function load<T>(key: string, fallback: T): T {
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(key) ?? "null") as T | null;
    return saved ?? fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown) {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

const fallbackDraft: Draft = { provider: "claude", presetId: null, config: {}, isolation: "worktree", base: null };

/** Rewrite only ids in user selections; persisted task ids remain backend-owned. */
function loadSelection<T>(key: string, fallback: T, migrate: (saved: T) => T): T {
  const saved = load(key, fallback);
  if (Array.isArray(fallback) ? !Array.isArray(saved) : !saved || typeof saved !== "object" || Array.isArray(saved)) {
    return fallback;
  }
  try {
    const next = migrate(saved);
    if (JSON.stringify(saved) !== JSON.stringify(next)) save(key, next);
    return next;
  } catch {
    return fallback;
  }
}

function canonicalPreset(preset: AgentPreset): AgentPreset {
  return { ...preset, provider: legacyAgentId(preset.provider) };
}

export const useAgents = create<AgentsState>(() => ({
  loaded: false,
  error: null,
  tasks: new Map(),
  unread: new Set(),
  entries: new Map(),
  changes: new Map(),
  providers: [],
  presets: loadSelection<AgentPreset[]>(PRESETS_KEY, [], (presets) => presets.map(canonicalPreset)),
  disabledProviders: loadSelection<string[]>(DISABLED_KEY, [], (ids) => [...new Set(ids.map(legacyAgentId))]),
  draft: loadSelection(DRAFT_KEY, fallbackDraft, (draft) => ({
    ...fallbackDraft,
    ...draft,
    provider: legacyAgentId(draft.provider ?? fallbackDraft.provider),
  })),
  composers: new Map(),
  lastComposer: HOME,
  history: load<string[]>(HISTORY_KEY, []),
  focus: null,
}));

export function updateDraft(patch: Partial<Draft>) {
  const draft = { ...useAgents.getState().draft, ...patch };
  draft.provider = legacyAgentId(draft.provider);
  useAgents.setState({ draft });
  save(DRAFT_KEY, draft);
}

/** Builds a draft `config` map from a preset's model, effort, and mode for `provider`. */
export function presetConfigFor(
  preset: Pick<AgentPreset, "model" | "effort" | "mode">,
  provider?: AgentProvider,
): Record<string, string> {
  const config: Record<string, string> = {};
  const modelId = provider?.config.find((c) => c.category === "model" || c.id === "model")?.id ?? "model";
  const effortId =
    provider?.config.find((c) => c.category === "thought_level" || c.id === "thought_level")?.id ?? "thought_level";
  const modeId = provider?.config.find((c) => c.category === "mode" || c.id === "mode")?.id ?? "mode";
  if (preset.model.trim()) config[modelId] = preset.model.trim();
  if (preset.effort.trim()) config[effortId] = preset.effort.trim();
  if (preset.mode.trim()) config[modeId] = preset.mode.trim();
  return config;
}

export function savePresets(presets: AgentPreset[]) {
  presets = presets.map(canonicalPreset);
  useAgents.setState({ presets });
  save(PRESETS_KEY, presets);
  const { draft, providers } = useAgents.getState();
  if (draft.presetId) {
    const active = presets.find((p) => p.id === draft.presetId);
    if (!active) {
      updateDraft({ presetId: null });
    } else {
      const prov = providers.find((p) => p.id === active.provider);
      updateDraft({
        provider: active.provider,
        presetId: active.id,
        config: presetConfigFor(active, prov),
      });
    }
  }
}

export function applyPreset(presetId: string | null) {
  if (!presetId) {
    updateDraft({ presetId: null });
    return;
  }
  const { presets, providers } = useAgents.getState();
  const preset = presets.find((p) => p.id === presetId);
  if (!preset) return;
  const prov = providers.find((p) => p.id === preset.provider);
  updateDraft({
    provider: preset.provider,
    presetId: preset.id,
    config: presetConfigFor(preset, prov),
  });
}

export function toggleProviderEnabled(providerId: string, enabled?: boolean) {
  providerId = legacyAgentId(providerId);
  const current = new Set(useAgents.getState().disabledProviders);
  const shouldEnable = enabled ?? current.has(providerId);
  if (shouldEnable) current.delete(providerId);
  else current.add(providerId);
  const disabledProviders = [...current];
  useAgents.setState({ disabledProviders });
  save(DISABLED_KEY, disabledProviders);
}

/** Splits args as typed in the editor; backslashes in Windows paths stay literal. */
export function parseCliArgs(raw: string): string[] {
  const out: string[] = [];
  let cur = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && raw[i + 1] === '"') cur += raw[++i]!;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) {
        out.push(cur);
        cur = "";
        started = false;
      }
    } else {
      cur += ch;
      started = true;
    }
  }
  if (started) out.push(cur);
  return out;
}

/** Quotes values without changing Windows paths or losing empty arguments. */
export function formatCliArgs(args: readonly string[]): string {
  return args
    .map((arg) => {
      if (/^[^\s'"\\]+$/.test(arg)) return arg;
      if (!arg.includes("\\")) return `"${arg.replaceAll('"', '\\"')}"`;
      return `'${arg.replaceAll("'", `'"'"'`)}'`;
    })
    .join(" ");
}

interface LegacyArgs {
  raw: string;
  entries: Record<string, unknown>;
}

function readLegacyArgs(): LegacyArgs | null {
  try {
    const raw = globalThis.localStorage?.getItem(ARGS_KEY);
    if (raw === null || raw === undefined) return null;
    const entries: unknown = JSON.parse(raw);
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) return null;
    return { raw, entries: entries as Record<string, unknown> };
  } catch {
    // Keep unreadable legacy storage intact for recovery.
    return null;
  }
}

/** Compare before writing: another window may have edited its pending import. */
function saveLegacyProgress(snapshot: LegacyArgs): boolean {
  try {
    if (globalThis.localStorage?.getItem(ARGS_KEY) !== snapshot.raw) return false;
    if (Object.keys(snapshot.entries).length) {
      snapshot.raw = JSON.stringify(snapshot.entries);
      globalThis.localStorage?.setItem(ARGS_KEY, snapshot.raw);
    } else {
      globalThis.localStorage?.removeItem(ARGS_KEY);
    }
    return true;
  } catch {
    return false;
  }
}

// Imports and explicit edits share one queue so an older import cannot finish after a user edit.
let argsWrites: Promise<unknown> = Promise.resolve();
let explicitArgsRevision = 0;
function queueArgsWrite<T>(write: () => Promise<T>): Promise<T> {
  const next = argsWrites.then(write, write);
  argsWrites = next.catch(() => {});
  return next;
}

function sameArgs(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((arg, i) => arg === b[i]);
}

/** Import only unambiguous legacy values, leaving unknown or conflicting entries pending. */
async function importLegacyArgs(initial: AgentProvider[]): Promise<AgentProvider[]> {
  if (!isTauri() || !readLegacyArgs()) return initial;
  return queueArgsWrite(async () => {
    const pending = readLegacyArgs();
    // A queued explicit save may already have completed the import.
    let providers: AgentProvider[];
    try {
      providers = await call(commands.agentProviders());
    } catch {
      return initial;
    }
    if (!pending) return providers;
    const groups = new Map<string, Array<[string, unknown]>>();
    for (const entry of Object.entries(pending.entries)) {
      const id = legacyAgentId(entry[0]);
      const group = groups.get(id) ?? [];
      group.push(entry);
      groups.set(id, group);
    }
    for (const [id, entries] of groups) {
      const provider = providers.find((p) => p.id === id);
      if (!provider || entries.some(([, raw]) => typeof raw !== "string")) continue;
      const values = entries.map(([, raw]) =>
        parseCliArgs(raw as string)
          .map((arg) => arg.trim())
          .filter(Boolean),
      );
      const args = values[0]!;
      if (values.some((value) => !sameArgs(value, args))) continue;
      const existing = provider.extraArgs ?? [];
      // Server settings are authoritative, including args migrated from on-disk files.
      if (existing.length && !sameArgs(existing, args)) continue;
      if (!sameArgs(existing, args)) {
        try {
          providers = await call(commands.agentSetArgs(id, args));
        } catch {
          continue;
        }
      }
      for (const [oldId] of entries) delete pending.entries[oldId];
      if (!saveLegacyProgress(pending)) break;
    }
    // An empty legacy object needs no writes to the backend.
    if (!Object.keys(pending.entries).length) saveLegacyProgress(pending);
    return providers;
  });
}

/** Saves only to the backend; the returned provider list carries the stored extraArgs. */
export async function setProviderArgs(providerId: string, rawArgs: string): Promise<void> {
  const id = legacyAgentId(providerId);
  const args = parseCliArgs(rawArgs.trim());
  await queueArgsWrite(async () => {
    const providers = await call(commands.agentSetArgs(id, args));
    explicitArgsRevision++;
    useAgents.setState({ providers });
    // An explicit edit/clear resolves legacy values for this id, even when they conflicted.
    const pending = readLegacyArgs();
    if (!pending) return;
    for (const oldId of Object.keys(pending.entries)) {
      if (legacyAgentId(oldId) === id) delete pending.entries[oldId];
    }
    saveLegacyProgress(pending);
  });
}

/** Prepends a preset's injected instructions to the first prompt when present. */
export function withInjectedInstructions(promptText: string, instructions?: string): string {
  const trimmed = instructions?.trim();
  if (!trimmed) return promptText;
  return `${trimmed}\n\n${promptText}`;
}

export const composerDraft = (key: string) => useAgents.getState().composers.get(key) ?? emptyDraft();

export function updateComposer(key: string, patch: Partial<ComposerDraft>) {
  useAgents.setState((s) => ({
    composers: new Map(s.composers).set(key, { ...(s.composers.get(key) ?? emptyDraft()), ...patch }),
    lastComposer: key,
  }));
}

/** Session tabs on screen; a task can be shown in more than one split. */
const visible = new Map<string, number>();
const windowFocused = () => document.visibilityState !== "hidden" && document.hasFocus();
const viewing = (task: string) => visible.has(task) && windowFocused();

function setUnread(task: string, value: boolean) {
  const s = useAgents.getState();
  if (s.unread.has(task) === value) return;
  const unread = new Set(s.unread);
  if (value) unread.add(task);
  else unread.delete(task);
  useAgents.setState({ unread });
}

function markUnread(task: string) {
  const current = useAgents.getState().tasks.get(task);
  if (current && current.status !== "archived" && !viewing(task)) setUnread(task, true);
}

export function markVisible(task: string): () => void {
  visible.set(task, (visible.get(task) ?? 0) + 1);
  const read = () => {
    if (viewing(task)) setUnread(task, false);
  };
  read();
  window.addEventListener("focus", read);
  document.addEventListener("visibilitychange", read);
  return () => {
    const count = (visible.get(task) ?? 1) - 1;
    if (count) visible.set(task, count);
    else visible.delete(task);
    window.removeEventListener("focus", read);
    document.removeEventListener("visibilitychange", read);
  };
}

let generation = 0;

/** Subscribes this window to the project's agents (again after the project changed). */
export async function connect(): Promise<void> {
  if (!isTauri()) return;
  const gen = ++generation;
  const argsRevision = explicitArgsRevision;
  const channel = new Channel<AgentEvent>();
  channel.onmessage = (e) => {
    if (gen === generation) onEvent(e);
  };
  let tasks: AgentTask[], providers: AgentProvider[];
  try {
    [tasks, providers] = await Promise.all([call(commands.agentSubscribe(channel)), call(commands.agentProviders())]);
  } catch (e) {
    if (gen === generation) useAgents.setState({ loaded: true, error: e instanceof Error ? e.message : String(e) });
    return;
  }
  if (gen !== generation) return;
  providers = await importLegacyArgs(providers);
  if (gen !== generation) return;
  useAgents.setState({
    loaded: true,
    error: null,
    tasks: new Map(tasks.map((t) => [t.id, t])),
    entries: new Map(),
    changes: new Map(),
    providers: argsRevision === explicitArgsRevision ? providers : useAgents.getState().providers,
  });
  // Restored tabs of tasks deleted meanwhile close, like editors of deleted files.
  const editors = editorService();
  for (const t of editors.openTabs?.() ?? []) {
    const task = (t.input.data as { task?: string } | undefined)?.task;
    if (t.input.kind === SESSION_KIND && task && !useAgents.getState().tasks.has(task))
      await editors.closeInput?.(t.input.key);
  }
}

export function disconnect() {
  generation++;
  useAgents.setState({
    loaded: false,
    error: null,
    tasks: new Map(),
    unread: new Set(),
    entries: new Map(),
    changes: new Map(),
  });
}

function onEvent(e: AgentEvent) {
  const s = useAgents.getState();
  switch (e.type) {
    case "task": {
      const prev = s.tasks.get(e.task.id);
      useAgents.setState({ tasks: new Map(s.tasks).set(e.task.id, e.task) });
      if (e.task.status === "archived") setUnread(e.task.id, false);
      else if (attentionChange(prev?.status, e.task.status)) markUnread(e.task.id);
      notifyChange(prev, e.task);
      if (prev?.status !== e.task.status && !isBusy(e.task.status)) {
        void refreshChanges(e.task.id);
        void refreshProviders();
      }
      break;
    }
    case "removed": {
      const tasks = new Map(s.tasks);
      tasks.delete(e.id);
      const composers = new Map(s.composers);
      composers.delete(e.id);
      const unread = new Set(s.unread);
      unread.delete(e.id);
      useAgents.setState({ tasks, composers, unread });
      void editorService().closeInput?.(sessionKey(e.id));
      break;
    }
    case "truncated": {
      const current = s.entries.get(e.task);
      if (current) useAgents.setState({ entries: new Map(s.entries).set(e.task, current.slice(0, e.length)) });
      scheduleChanges(e.task);
      break;
    }
    case "entry": {
      if (
        !e.subagent &&
        ((e.entry.type === "agent" && e.entry.text.trim()) ||
          e.entry.type === "error" ||
          (e.entry.type === "permission" && e.entry.chosen === null))
      ) {
        markUnread(e.task);
      }
      const key = entriesKey(e.task, e.subagent);
      const current = s.entries.get(key);
      if (!current) return;
      const next = upsertEntry(current, e.index, e.entry);
      if (next) useAgents.setState({ entries: new Map(s.entries).set(key, next) });
      else void loadEntries(e.task, e.subagent);
      if (e.entry.type === "tool" && e.entry.status === "completed" && e.entry.diffs.length) {
        scheduleChanges(e.task);
      }
      break;
    }
  }
}

function notifyChange(prev: AgentTask | undefined, task: AgentTask) {
  const change = attentionChange(prev?.status, task.status);
  if (!change) return;
  if (viewing(task.id)) return;
  const body =
    change === "input"
      ? "Waiting for your answer"
      : change === "failed"
        ? (task.error ?? "The agent stopped")
        : "Finished";
  notifications().notify({
    level: change === "failed" ? "error" : "info",
    title: task.title,
    body,
    key: `agent:${task.id}`,
    group: "tools",
    sticky: change !== "finished",
    actions: [{ label: change === "finished" ? "Review" : "Open", run: () => openTask(task.id) }],
  });
}

/** Loads the entries of the task's conversation, or of its subagent `subagent`'s. */
export async function loadEntries(task: string, subagent: string | null = null): Promise<void> {
  const entries = await call(commands.agentEntries(task, subagent));
  useAgents.setState((s) => ({ entries: new Map(s.entries).set(entriesKey(task, subagent), entries) }));
}

export async function refreshChanges(task: string): Promise<void> {
  try {
    const changes = await call(commands.agentChanges(task));
    useAgents.setState((s) => ({ changes: new Map(s.changes).set(task, changes) }));
  } catch {
    // The worktree is gone or not a repository: nothing to list.
    useAgents.setState((s) => ({ changes: new Map(s.changes).set(task, []) }));
  }
}

const pendingChanges = new Map<string, ReturnType<typeof setTimeout>>();
function scheduleChanges(task: string) {
  if (pendingChanges.has(task)) return;
  pendingChanges.set(
    task,
    setTimeout(() => {
      pendingChanges.delete(task);
      void refreshChanges(task);
    }, 500),
  );
}

/** Reloads the agent list (custom and registry agents are re-read). */
export async function refreshProviders() {
  const gen = generation;
  const argsRevision = explicitArgsRevision;
  const providers = await call(commands.agentProviders()).catch(() => null);
  if (!providers || gen !== generation) return;
  const imported = await importLegacyArgs(providers);
  if (gen === generation && argsRevision === explicitArgsRevision) useAgents.setState({ providers: imported });
}

export const NO_COMMANDS: readonly AgentCommand[] = [];

/**
 * Slash commands to complete: what the agent offered (`offered`; fetched again when it
 * changes) plus, for Claude Code, the skills and custom commands on disk. Without `task`,
 * those of the project.
 */
export function useAgentCommands(
  provider: string | undefined,
  task: string | null,
  offered: readonly AgentCommand[],
): readonly AgentCommand[] {
  const [found, setFound] = useState<{ for: unknown[]; list: readonly AgentCommand[] } | null>(null);
  useEffect(() => {
    if (!provider || !isTauri()) return;
    let alive = true;
    call(commands.agentCommands(provider, task))
      .then((list) => alive && setFound({ for: [provider, task, offered], list }))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [provider, task, offered]);
  // Until the list for these arguments arrives, what the agent offered.
  const current = found && found.for[0] === provider && found.for[1] === task && found.for[2] === offered;
  return current ? found.list : offered;
}

export function openTask(task: string) {
  // The title rides along so a restored tab has it before the tasks load.
  const title = useAgents.getState().tasks.get(task)?.title;
  void editorService().openInput({ kind: SESSION_KIND, key: sessionKey(task), data: { task, title } }, { focus: true });
}

/** Opens the New Task page; `prompt` pre-fills it. */
export function openHome(prompt?: string) {
  const project = useProject.getState().project;
  if (project?.workspace) {
    const previous = useAgents.getState().draft.projectRoot;
    const projectRoot = defaultTaskProject(project, editorService().activePath(), previous);
    updateDraft({ projectRoot, ...(projectRoot !== previous ? { base: null } : {}) });
  }
  if (prompt !== undefined) updateComposer(HOME, { text: prompt });
  void editorService().openInput({ kind: HOME_KIND, key: HOME_KEY, data: {} }, { focus: true });
}

/** UI-only state for the catalog while Welcome or LightEdit has no project editor. */
export const useCatalogOverlay = create<{ input: { data: { openPresets: boolean } } | null }>(() => ({ input: null }));

export function closeCatalogOverlay() {
  useCatalogOverlay.setState({ input: null });
}

/** Opens the catalog in the current project, or above Welcome and LightEdit. */
export function openCatalog(openPresets = false) {
  if (!useAgents.getState().providers.length && isTauri()) void refreshProviders();
  if (!useProject.getState().project) {
    useCatalogOverlay.setState({ input: { data: { openPresets } } });
    return;
  }
  closeCatalogOverlay();
  void editorService().openInput({ kind: CATALOG_KIND, key: CATALOG_KEY, data: { openPresets } }, { focus: true });
}

/** `isolation` overrides the draft's (a project without git can only use the local checkout). */
export async function startTask(
  isolation: Isolation = useAgents.getState().draft.isolation,
  projectRoot: string | null = null,
): Promise<void> {
  const { draft, providers, presets, disabledProviders } = useAgents.getState();
  const composer = composerDraft(HOME);
  if (
    !canSend(composer) ||
    disabledProviders.includes(draft.provider) ||
    !providers.some((p) => p.id === draft.provider)
  )
    return;
  const activePreset = draft.presetId
    ? presets.find((p) => p.id === draft.presetId && p.provider === draft.provider)
    : undefined;
  const instructions = activePreset?.instructions?.trim() || null;
  const config = { ...bypassDefaults(providers.find((p) => p.id === draft.provider)?.config ?? []), ...draft.config };
  const task = await call(
    commands.agentCreate({
      projectRoot,
      prompt: toPrompt(composer),
      provider: draft.provider,
      config: Object.entries(config).map(([id, value]) => ({ id, value })),
      isolation,
      base: isolation === "worktree" ? draft.base : null,
      instructions,
    }),
  );
  // Its events can arrive before this reply: keep the newer state they carried.
  useAgents.setState((s) => ({
    tasks: s.tasks.has(task.id) ? s.tasks : new Map(s.tasks).set(task.id, task),
    entries: new Map(s.entries).set(task.id, s.entries.get(task.id) ?? []),
  }));
  updateDraft({ projectRoot });
  remember(composer.text.trim());
  updateComposer(HOME, emptyDraft());
  if ((await editorService().closeInput?.(HOME_KEY)) !== false) openTask(task.id);
}

function remember(text: string) {
  if (!text) return;
  const history = [text, ...useAgents.getState().history.filter((h) => h !== text)].slice(0, HISTORY_SIZE);
  useAgents.setState({ history });
  save(HISTORY_KEY, history);
}

/** Sends the session composer's message: queued while the agent works, or with `now` interrupting it. */
export async function sendMessage(task: string, now: boolean): Promise<void> {
  const composer = composerDraft(task);
  if (!canSend(composer)) return;
  await call(commands.agentPrompt(task, toPrompt(composer), now));
  updateComposer(task, emptyDraft());
}

/** Moves the caret to the end of composer `key`. */
export function focusComposer(key: string) {
  useAgents.setState((s) => ({ focus: { key, seq: (s.focus?.seq ?? 0) + 1 } }));
}

/** Quotes `text` (a selection of the conversation) in the task's composer, to reply to it. */
export function quoteInComposer(task: string, text: string) {
  updateComposer(task, { text: withQuote(composerDraft(task).text, text) });
  focusComposer(task);
}

/** Copies the task's conversation into a new task (up to its first `turns` turns) and opens it. */
export async function forkTask(task: string, turns: number | null): Promise<void> {
  const copy = await call(commands.agentFork(task, turns));
  useAgents.setState((s) => ({
    tasks: s.tasks.has(copy.id) ? s.tasks : new Map(s.tasks).set(copy.id, copy),
  }));
  openTask(copy.id);
}

/**
 * Runs the conversation again from turn `turn` with `text` as its message: the agent is
 * stopped if it works, that turn and the later ones are dropped, then `text` is sent.
 */
export async function rerunFrom(task: string, turn: number, text: string, images: AgentImage[] = []): Promise<void> {
  if (isBusy(useAgents.getState().tasks.get(task)?.status ?? "ready")) {
    await cancelTask(task);
    await settled(task);
  }
  await call(commands.agentRollback(task, turn));
  try {
    await call(commands.agentPrompt(task, { text, files: [], images }, false));
  } catch (e) {
    // Rollback removes the inline editor; recover its text in the session composer.
    const current = composerDraft(task);
    updateComposer(task, { text: current.text ? `${text}\n${current.text}` : text });
    focusComposer(task);
    throw e;
  }
}

/** Resolves once the task's turn has ended (or after a while). */
function settled(task: string, timeoutMs = 15_000): Promise<void> {
  const done = () => !isBusy(useAgents.getState().tasks.get(task)?.status ?? "ready");
  if (done()) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      stop();
      clearTimeout(timer);
      resolve();
    };
    const stop = useAgents.subscribe(() => done() && finish());
    const timer = setTimeout(finish, timeoutMs);
  });
}

/** Sends an earlier message again (queued while the agent works). */
export const resendMessage = (task: string, text: string) =>
  call(commands.agentPrompt(task, { text, files: [], images: [] }, false));

/** Takes a queued message back into the composer to edit it. */
export async function editQueued(task: string, queued: string): Promise<void> {
  const item = await call(commands.agentUnqueue(task, queued));
  const current = composerDraft(task);
  const cwd = useAgents.getState().tasks.get(task)?.cwd ?? "";
  const files: FileRef[] = item.prompt.files.map((path) => ({
    path,
    rel: path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path,
  }));
  updateComposer(task, {
    text: current.text ? `${item.prompt.text}\n${current.text}` : item.prompt.text,
    files: [...files, ...current.files],
    images: [...item.prompt.images, ...current.images],
  });
}

export const removeQueued = (task: string, queued: string) => call(commands.agentUnqueue(task, queued));
export const sendQueuedNow = (task: string, queued: string) => call(commands.agentSendQueuedNow(task, queued));
export const setTaskConfig = (task: string, option: string, value: string) =>
  call(commands.agentSetConfig(task, option, value));

/**
 * Adds `@file` references (with an optional line range) to the composer typed in last and
 * shows it: IDEA-style "send this to the chat".
 */
export function addReferences(refs: Array<{ path: string; rel: string; mention: string }>) {
  const s = useAgents.getState();
  const key = s.lastComposer !== HOME && s.tasks.has(s.lastComposer) ? s.lastComposer : HOME;
  const task = key === HOME ? null : s.tasks.get(key)!;
  const current = composerDraft(key);
  // A worktree task sees the same files under its own directory.
  const root = task?.isolation === "worktree" ? task.cwd : null;
  const files: FileRef[] = refs.map((r) => ({ path: root ? `${root}/${r.rel}` : r.path, rel: r.rel }));
  const mentions = refs.map((r) => r.mention).join(" ");
  const text =
    current.text && !/\s$/.test(current.text) ? `${current.text} ${mentions} ` : `${current.text}${mentions} `;
  updateComposer(key, { text, files: [...current.files, ...files] });
  if (task) openTask(task.id);
  else openHome();
}

/** Stops the task's turn, or with `subagent` only that subagent's work. */
export const cancelTask = (task: string, subagent: string | null = null) => call(commands.agentCancel(task, subagent));
export const respond = (task: string, permission: number, option: string | null) =>
  call(commands.agentRespond(task, permission, option));
export const unarchiveTask = (task: string) => call(commands.agentUnarchive(task));
export const archiveTask = (task: string) => call(commands.agentArchive(task));
export const deleteTask = (task: string, removeWorktree: boolean) => call(commands.agentDelete(task, removeWorktree));
