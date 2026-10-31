/** Agent preferences, presets and command-line arguments. Registry installs stay in Settings. */
import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import type { AgentProvider } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { useTx } from "@/platform/i18n";
import { isTauri } from "@/platform/ipc";
import { Button, Checkbox, Dialog, Icon, IconButton, Input, Select, T, type SelectOption } from "@/ui";
import { providerIcon } from "./model";
import {
  formatCliArgs,
  refreshProviders,
  savePresets,
  setProviderArgs,
  toggleProviderEnabled,
  useAgents,
  type AgentPreset,
} from "./store";
import styles from "./AgentsCatalog.module.css";

let presetCounter = 0;
function nextPresetId(): string {
  return `preset-${Date.now()}-${++presetCounter}-${Math.random().toString(36).slice(2, 6)}`;
}

export function AcpArgumentsDialog({ provider, onClose }: { provider: AgentProvider | null; onClose: () => void }) {
  const initialValue = provider ? formatCliArgs(provider.extraArgs ?? []) : "";
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [previous, setPrevious] = useState({ id: provider?.id ?? null, args: initialValue });
  if ((provider?.id ?? null) !== previous.id || initialValue !== previous.args) {
    setPrevious({ id: provider?.id ?? null, args: initialValue });
    setValue(initialValue);
    setError(null);
  }
  if (!provider) return null;
  const submit = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await setProviderArgs(provider.id, value);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      open
      onClose={() => {
        if (!saving) onClose();
      }}
      title="Agent Arguments"
      width={420}
      buttons={[
        { label: "OK", role: "default", onClick: () => void submit(), disabled: saving },
        { label: "Cancel", role: "cancel", onClick: onClose, disabled: saving },
      ]}
    >
      <div className={styles.argsPrompt}>
        <span>{provider.name}</span>
        <label htmlFor="agent-arguments">
          <T>Enter command-line arguments</T>
        </label>
        <Input
          id="agent-arguments"
          data-autofocus
          value={value}
          disabled={saving}
          placeholder="e.g. --model sonnet"
          onChange={(e) => setValue(e.target.value)}
        />
        {error && (
          <div role="alert" className={styles.error}>
            {error}
          </div>
        )}
      </div>
    </Dialog>
  );
}

export function ManagePresetsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
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
      name: providerObj?.name ?? tx("New Preset"),
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
    const copy: AgentPreset = { ...selected, id, name: tx`${selected.name} Copy` };
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
  const inputData = input?.data;
  const openPresets = Boolean((inputData as { openPresets?: boolean } | undefined)?.openPresets);
  const [search, setSearch] = useState("");
  const [presetsOpen, setPresetsOpen] = useState(openPresets);
  const [previousData, setPreviousData] = useState(inputData);
  const [editingArgsFor, setEditingArgsFor] = useState<string | null>(null);
  if (inputData !== previousData) {
    setPreviousData(inputData);
    if (openPresets) setPresetsOpen(true);
  }
  useEffect(() => {
    if (isTauri()) void refreshProviders();
  }, []);
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return providers.filter((p) => [p.id, p.name, p.command].some((text) => text.toLowerCase().includes(query)));
  }, [providers, search]);
  return (
    <div className={styles.page}>
      <div className={styles.topBar}>
        <Input
          className={styles.searchInput}
          value={search}
          placeholder={tx("Search agents…")}
          aria-label={tx("Search agents")}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Button size="small" onClick={() => setPresetsOpen(true)}>
          <T>Manage Presets…</T>
        </Button>
        <Button size="small" onClick={() => void executeAction("agents.addAgent")}>
          <T>More agents…</T>
        </Button>
      </div>
      <div className={styles.providers}>
        {filtered.map((provider) => (
          <section key={provider.id} className={styles.provider} aria-label={provider.name}>
            <div className={styles.providerMain}>
              <Icon name={providerIcon(provider.id)} size={18} />
              <span className={styles.providerName}>{provider.name}</span>
              {!provider.installed && (
                <span className={styles.unavailable}>
                  <T>Not installed</T>
                </span>
              )}
              <span className={styles.command} title={provider.command}>
                {provider.command}
              </span>
            </div>
            <div className={styles.providerActions}>
              <Checkbox
                checked={!disabledProviders.includes(provider.id)}
                aria-label={tx`Enable ${provider.name}`}
                onChange={(enabled) => toggleProviderEnabled(provider.id, enabled)}
              />
              <Button
                size="small"
                aria-label={tx`Edit arguments for ${provider.name}`}
                onClick={() => setEditingArgsFor(provider.id)}
              >
                <T>Arguments…</T>
              </Button>
            </div>
          </section>
        ))}
        {!filtered.length && (
          <div className={styles.empty}>
            <T>No agents match your search</T>
          </div>
        )}
      </div>
      <ManagePresetsDialog open={presetsOpen} onClose={() => setPresetsOpen(false)} />
      <AcpArgumentsDialog
        provider={providers.find((p) => p.id === editingArgsFor) ?? null}
        onClose={() => setEditingArgsFor(null)}
      />
    </div>
  );
}
