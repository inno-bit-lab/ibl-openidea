/**
 * Agents catalog editor tab (`Agents`), `Manage Presets` modal dialog, and
 * `ACP Arguments` modal dialog.
 */
import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import type { AgentProvider } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { useTx } from "@/platform/i18n";
import { call, commands, isTauri } from "@/platform/ipc";
import { Button, Dialog, Icon, IconButton, Input, Select, T, showContextMenu, type SelectOption } from "@/ui";
import { providerIcon } from "./model";
import {
  refreshProviders,
  savePresets,
  setProviderArgs,
  toggleProviderEnabled,
  useAgents,
  type AgentPreset,
} from "./store";
import styles from "./AgentsCatalog.module.css";

export interface AgentCatalogMeta {
  version: string;
  summary: string;
  website: string;
  license: string;
  installCommand?: string;
}

export const AGENT_CATALOG_META: Record<string, AgentCatalogMeta> = {
  agy: {
    version: "v0.1.0",
    summary: "Google Antigravity ACP coding agent",
    website: "https://deepmind.google",
    license: "Apache-2.0",
  },
  pi: {
    version: "v0.0.34",
    summary: "ACP adapter for pi coding agent",
    website: "https://www.npmjs.com/package/pi-acp",
    license: "MIT",
    installCommand: "npm install -g pi-acp@0.0.34",
  },
  claude: {
    version: "v0.29.2",
    summary: "ACP wrapper for Anthropic's Claude",
    website: "https://github.com/zed-industries/claude-agent-acp",
    license: "Apache-2.0",
    installCommand: "npm install -g @zed-industries/claude-agent-acp",
  },
  codex: {
    version: "v0.11.1",
    summary: "ACP adapter for OpenAI's coding assistant",
    website: "https://github.com/zed-industries/codex-acp",
    license: "Apache-2.0",
    installCommand: "npm install -g @zed-industries/codex-acp",
  },
  gemini: {
    version: "v0.38.2",
    summary: "Google's official CLI for Gemini",
    website: "https://github.com/google-gemini/gemini-cli",
    license: "Apache-2.0",
    installCommand: "npm install -g @google/gemini-cli",
  },
  copilot: {
    version: "v1.0.32",
    summary: "GitHub's AI coding assistant",
    website: "https://github.com/features/copilot",
    license: "Proprietary",
  },
  cursor: {
    version: "v1.0.0",
    summary: "Cursor AI coding agent via ACP",
    website: "https://cursor.com",
    license: "Proprietary",
  },
  opencode: {
    version: "v1.3.14",
    summary: "The open source coding agent",
    website: "https://opencode.ai",
    license: "MIT",
    installCommand: "npm install -g opencode-ai",
  },
  qwen: {
    version: "v0.14.5",
    summary: "Alibaba's Qwen coding assistant",
    website: "https://github.com/QwenLM/qwen-code",
    license: "Apache-2.0",
    installCommand: "npm install -g @qwen-code/qwen-code",
  },
  kimi: {
    version: "v1.36.0",
    summary: "Kimi Code CLI is your next CLI agent.",
    website: "https://kimi.moonshot.cn",
    license: "Apache-2.0",
  },
  goose: {
    version: "v1.29.1",
    summary: "A local, extensible, open source AI agent that automates engineering tasks",
    website: "https://block.github.io/goose",
    license: "Apache-2.0",
  },
  auggie: {
    version: "v0.22.0",
    summary: "Augment Code's powerful software agent",
    website: "https://www.augmentcode.com",
    license: "Proprietary",
  },
  kiro: {
    version: "v1.29.0",
    summary: "Kiro CLI brings AI-powered coding assistance directly to your command line",
    website: "https://kiro.dev",
    license: "Proprietary",
  },
  vibe: {
    version: "v2.7.5",
    summary: "Mistral's open-source CLI coding assistant",
    website: "https://mistral.ai",
    license: "Apache-2.0",
  },
};

export function filterCatalogProviders(providers: readonly AgentProvider[], query: string): AgentProvider[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...providers];
  return providers.filter((p) => {
    const meta = AGENT_CATALOG_META[p.id];
    return (
      p.name.toLowerCase().includes(q) ||
      p.id.toLowerCase().includes(q) ||
      p.command.toLowerCase().includes(q) ||
      (meta?.summary.toLowerCase().includes(q) ?? false)
    );
  });
}

function openExternal(url: string) {
  if (isTauri()) {
    void call(commands.webOpen(url, null)).catch(() => window.open(url, "_blank", "noopener,noreferrer"));
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

let presetCounter = 0;

function nextPresetId(): string {
  return `preset-${Date.now()}-${++presetCounter}-${Math.random().toString(36).slice(2, 6)}`;
}

export function AcpArgumentsDialog({
  provider,
  onClose,
}: {
  provider: AgentProvider | null;
  onClose: () => void;
}) {
  const customArgs = useAgents((s) => s.customArgs);
  const initialValue = provider ? (customArgs[provider.id] ?? "") : "";
  const [value, setValue] = useState(initialValue);
  const [prevInit, setPrevInit] = useState<{ id: string | null; args: string }>({
    id: provider?.id ?? null,
    args: initialValue,
  });

  if ((provider?.id ?? null) !== prevInit.id || initialValue !== prevInit.args) {
    setPrevInit({ id: provider?.id ?? null, args: initialValue });
    setValue(initialValue);
  }

  if (!provider) return null;

  const submit = () => {
    void setProviderArgs(provider.id, value);
    onClose();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      icon="question"
      title="ACP Arguments"
      width={420}
      buttons={[
        { label: "OK", role: "default", onClick: submit },
        { label: "Cancel", role: "cancel", onClick: onClose },
      ]}
    >
      <div className={styles.argsPrompt}>
        <span>
          <T>Enter command-line arguments</T>
        </span>
        <Input
          data-autofocus
          aria-label="Enter command-line arguments"
          value={value}
          placeholder="e.g. --model sonnet"
          onChange={(e) => setValue(e.target.value)}
        />
      </div>
    </Dialog>
  );
}

export function ManagePresetsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const tx = useTx();
  const providers = useAgents((s) => s.providers);
  const savedPresets = useAgents((s) => s.presets);
  const [items, setItems] = useState<AgentPreset[]>(savedPresets);
  const [selectedId, setSelectedId] = useState<string | null>(savedPresets[0]?.id ?? null);
  const [advancedOpen, setAdvancedOpen] = useState(true);
  const [prevSync, setPrevSync] = useState({ open, savedPresets });

  if (open !== prevSync.open || savedPresets !== prevSync.savedPresets) {
    setPrevSync({ open, savedPresets });
    if (open) {
      setItems(savedPresets);
      setSelectedId(savedPresets[0]?.id ?? null);
    }
  }

  const selected = items.find((p) => p.id === selectedId) ?? null;
  const selectedIndex = items.findIndex((p) => p.id === selectedId);

  const updateSelected = (patch: Partial<AgentPreset>) => {
    if (!selected) return;
    setItems((prev) => prev.map((item) => (item.id === selected.id ? { ...item, ...patch } : item)));
  };

  const addPreset = () => {
    const defaultProvider = providers.find((p) => p.installed)?.id ?? providers[0]?.id ?? "claude";
    const providerObj = providers.find((p) => p.id === defaultProvider);
    const id = nextPresetId();
    const next: AgentPreset = {
      id,
      name: providerObj?.name ?? "New Preset",
      provider: defaultProvider,
      model: "",
      effort: "",
      mode: "",
      instructions: "",
    };
    setItems((prev) => [...prev, next]);
    setSelectedId(id);
  };

  const removePreset = () => {
    if (!selected) return;
    const next = items.filter((i) => i.id !== selected.id);
    setItems(next);
    setSelectedId(next[Math.min(selectedIndex, next.length - 1)]?.id ?? null);
  };

  const duplicatePreset = () => {
    if (!selected) return;
    const id = nextPresetId();
    const copy: AgentPreset = { ...selected, id, name: `${selected.name} Copy` };
    const next = [...items];
    next.splice(selectedIndex + 1, 0, copy);
    setItems(next);
    setSelectedId(id);
  };

  const movePreset = (delta: -1 | 1) => {
    if (selectedIndex < 0) return;
    const target = selectedIndex + delta;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    const [moved] = next.splice(selectedIndex, 1);
    next.splice(target, 0, moved!);
    setItems(next);
  };

  const provider = providers.find((p) => p.id === selected?.provider);
  const modelOpt = provider?.config.find((c) => c.category === "model" || c.id === "model");
  const effortOpt = provider?.config.find((c) => c.category === "thought_level" || c.id === "thought_level");
  const modeOpt = provider?.config.find((c) => c.category === "mode" || c.id === "mode");

  const agentOptions: SelectOption[] = providers.map((p) => ({
    value: p.id,
    label: p.name,
    icon: providerIcon(p.id),
  }));

  const modelOptions: SelectOption[] = [
    { value: "", label: "Default" },
    ...(modelOpt?.values ?? []).map((v) => ({ value: v.value, label: v.name || v.value })),
  ];
  if (selected?.model && !modelOptions.some((o) => o.value === selected.model)) {
    modelOptions.push({ value: selected.model, label: selected.model });
  }

  const effortOptions: SelectOption[] = [
    { value: "", label: "Default" },
    ...(effortOpt?.values.length
      ? effortOpt.values.map((v) => ({ value: v.value, label: v.name || v.value }))
      : [
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
          { value: "xhigh", label: "Extra High" },
        ]),
  ];
  if (selected?.effort && !effortOptions.some((o) => o.value === selected.effort)) {
    effortOptions.push({ value: selected.effort, label: selected.effort });
  }

  const modeOptions: SelectOption[] = [
    { value: "", label: "Default" },
    ...(modeOpt?.values ?? []).map((v) => ({ value: v.value, label: v.name || v.value })),
  ];
  if (selected?.mode && !modeOptions.some((o) => o.value === selected.mode)) {
    modeOptions.push({ value: selected.mode, label: selected.mode });
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Manage Presets"
      width={680}
      buttons={[
        {
          label: "OK",
          role: "default",
          onClick: () => {
            savePresets(items);
            onClose();
          },
        },
        { label: "Cancel", role: "cancel", onClick: onClose },
      ]}
    >
      <div className={styles.presetsDialog}>
        <div className={styles.presetsLeft}>
          <div className={styles.presetsToolbar}>
            <IconButton icon="plus" size="small" title="Add Preset" onClick={addPreset} />
            <IconButton icon="minus" size="small" title="Remove Preset" disabled={!selected} onClick={removePreset} />
            <IconButton
              icon="copy"
              size="small"
              title="Duplicate Preset"
              disabled={!selected}
              onClick={duplicatePreset}
            />
            <IconButton
              icon="arrow-up"
              size="small"
              title="Move Up"
              disabled={selectedIndex <= 0}
              onClick={() => movePreset(-1)}
            />
            <IconButton
              icon="arrow-down"
              size="small"
              title="Move Down"
              disabled={selectedIndex < 0 || selectedIndex >= items.length - 1}
              onClick={() => movePreset(1)}
            />
          </div>
          <div className={styles.presetsList} role="listbox" aria-label={tx("Presets")}>
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={item.id === selectedId}
                className={clsx(styles.presetItem, item.id === selectedId && styles.presetItemActive)}
                onClick={() => setSelectedId(item.id)}
              >
                <Icon name={providerIcon(item.provider)} size={16} />
                <span className={styles.presetItemName}>{item.name || tx("Untitled")}</span>
              </button>
            ))}
          </div>
        </div>
        <div className={styles.presetsRight}>
          {selected ? (
            <>
              <div className={styles.formGrid}>
                <label className={styles.fieldLabel} htmlFor="preset-name">
                  <T>Name</T>
                </label>
                <Input
                  id="preset-name"
                  value={selected.name}
                  onChange={(e) => updateSelected({ name: e.target.value })}
                />
                <span className={styles.fieldLabel}>
                  <T>Agent</T>
                </span>
                <Select
                  aria-label="Preset Agent"
                  value={selected.provider}
                  options={agentOptions}
                  onChange={(nextProvider) =>
                    updateSelected({ provider: nextProvider, model: "", effort: "", mode: "" })
                  }
                />
                <span className={styles.fieldLabel}>
                  <T>Model</T>
                </span>
                <Select
                  aria-label="Preset Model"
                  value={selected.model}
                  options={modelOptions}
                  onChange={(model) => updateSelected({ model })}
                />
                <span className={styles.fieldLabel}>
                  <T>Effort</T>
                </span>
                <Select
                  aria-label="Preset Effort"
                  value={selected.effort}
                  options={effortOptions}
                  onChange={(effort) => updateSelected({ effort })}
                />
                <span className={styles.fieldLabel}>
                  <T>Mode</T>
                </span>
                <Select
                  aria-label="Preset Mode"
                  value={selected.mode}
                  options={modeOptions}
                  onChange={(mode) => updateSelected({ mode })}
                />
              </div>
              <button
                type="button"
                className={styles.advancedToggle}
                onClick={() => setAdvancedOpen((o) => !o)}
                aria-expanded={advancedOpen}
              >
                <Icon name={advancedOpen ? "chevron-down" : "chevron-right"} size={12} />
                <T>Advanced</T>
              </button>
              {advancedOpen && (
                <div className={styles.instructionsWrap}>
                  <label className={styles.fieldLabel} htmlFor="preset-instructions">
                    <T>Injected instructions</T>
                  </label>
                  <textarea
                    id="preset-instructions"
                    className={styles.instructionsArea}
                    value={selected.instructions}
                    onChange={(e) => updateSelected({ instructions: e.target.value })}
                  />
                  <span className={styles.instructionsHint}>
                    <T>Sent before the first prompt and hidden from editor, transcript, and session title</T>
                  </span>
                </div>
              )}
            </>
          ) : (
            <div className={styles.emptyPreset}>
              <T>Select or add a preset (+)</T>
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}

export function AgentsCatalogEditor({ input }: { input?: { data?: unknown } }) {
  const tx = useTx();
  const providers = useAgents((s) => s.providers);
  const disabledProviders = useAgents((s) => s.disabledProviders);
  const customArgs = useAgents((s) => s.customArgs);
  const inputData = input?.data;
  const openPresetsFlag = Boolean((inputData as { openPresets?: boolean } | undefined)?.openPresets);
  const [search, setSearch] = useState("");
  const [presetsOpen, setPresetsOpen] = useState(openPresetsFlag);
  const [prevInputData, setPrevInputData] = useState(inputData);
  const [editingArgsFor, setEditingArgsFor] = useState<AgentProvider | null>(null);

  if (inputData !== prevInputData) {
    setPrevInputData(inputData);
    if (openPresetsFlag) setPresetsOpen(true);
  }

  useEffect(() => {
    if (isTauri()) void refreshProviders();
  }, []);

  const filtered = useMemo(() => filterCatalogProviders(providers, search), [providers, search]);
  const installed = useMemo(() => filtered.filter((p) => p.installed), [filtered]);
  const available = useMemo(() => filtered.filter((p) => !p.installed), [filtered]);

  const showCardMenu = (e: React.MouseEvent, p: AgentProvider) => {
    const meta = AGENT_CATALOG_META[p.id];
    showContextMenu(e, [
      {
        label: "Check for Updates",
        run: () => void refreshProviders(),
      },
      {
        label: "Uninstall",
        disabled: !p.installed,
        run: () => toggleProviderEnabled(p.id, false),
      },
      {
        label: "Open Website",
        disabled: !meta?.website,
        run: () => meta?.website && openExternal(meta.website),
      },
      {
        label: "View License",
        disabled: !meta?.website,
        run: () => meta?.website && openExternal(meta.website),
      },
      { kind: "separator" },
      {
        label: "Edit ACP Arguments...",
        run: () => setEditingArgsFor(p),
      },
    ]);
  };

  return (
    <div className={styles.page}>
      <div className={styles.topBar}>
        <div className={styles.searchWrap}>
          <Icon name="search" size={14} className={styles.searchIcon} />
          <Input
            className={styles.searchInput}
            value={search}
            placeholder={tx("Search agents...")}
            aria-label={tx("Search agents")}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <button type="button" className={styles.manageLink} onClick={() => setPresetsOpen(true)}>
          <T>Manage Presets...</T>
        </button>
      </div>

      {installed.length > 0 && (
        <div className={styles.grid}>
          {installed.map((p) => {
            const meta = AGENT_CATALOG_META[p.id];
            const enabled = !disabledProviders.includes(p.id);
            const args = customArgs[p.id];
            return (
              <div key={p.id} className={styles.card}>
                <div>
                  <div className={styles.cardHeader}>
                    <Icon name={providerIcon(p.id)} size={18} />
                    <span className={styles.cardTitle}>{p.name}</span>
                    {meta?.version && <span className={styles.version}>{meta.version}</span>}
                    <span className={styles.spacer} />
                    <button
                      type="button"
                      role="switch"
                      aria-checked={enabled}
                      aria-label={`Enable ${p.name}`}
                      className={clsx(styles.switch, enabled && styles.switchOn)}
                      onClick={() => toggleProviderEnabled(p.id, !enabled)}
                    >
                      <span className={styles.switchThumb} />
                    </button>
                    <IconButton
                      icon="more"
                      size="small"
                      title="More Actions"
                      onClick={(e) => showCardMenu(e, p)}
                    />
                  </div>
                  <div className={styles.desc}>{meta?.summary ?? p.command}</div>
                </div>
                <div className={styles.cardFooter}>
                  <span className={styles.statusBadge}>
                    <span className={clsx(styles.statusDot, !enabled && styles.statusDotOff)} />
                    <T>Chat</T>
                  </span>
                  {args && (
                    <span className={styles.argsBadge} title={args}>
                      {args}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {installed.length > 0 && available.length > 0 && <div className={styles.divider} />}

      {available.length > 0 && (
        <div className={styles.grid}>
          {available.map((p) => {
            const meta = AGENT_CATALOG_META[p.id];
            return (
              <div key={p.id} className={styles.card}>
                <div>
                  <div className={styles.cardHeader}>
                    <Icon name={providerIcon(p.id)} size={18} />
                    <span className={styles.cardTitle}>{p.name}</span>
                    {meta?.version && <span className={styles.version}>{meta.version}</span>}
                    <span className={styles.spacer} />
                    <Button
                      size="small"
                      variant="secondary"
                      onClick={() => {
                        if (meta?.installCommand) {
                          void executeAction("terminal.open");
                        }
                        void refreshProviders();
                      }}
                    >
                      <T>Install</T>
                    </Button>
                    <IconButton
                      icon="more"
                      size="small"
                      title="More Actions"
                      onClick={(e) => showCardMenu(e, p)}
                    />
                  </div>
                  <div className={styles.desc}>{meta?.summary ?? p.command}</div>
                </div>
                <div className={styles.cardFooter}>
                  <span>{p.command}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className={styles.footer}>
        <button
          type="button"
          className={styles.acpLink}
          onClick={() => openExternal("https://agentclientprotocol.com")}
        >
          <T>Powered by ACP</T>
          <Icon name="external-link" size={12} />
        </button>
      </div>

      <ManagePresetsDialog open={presetsOpen} onClose={() => setPresetsOpen(false)} />
      <AcpArgumentsDialog provider={editingArgsFor} onClose={() => setEditingArgsFor(null)} />
    </div>
  );
}
