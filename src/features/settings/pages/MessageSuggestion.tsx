import { useEffect, useId, useState } from "react";
import type { AgentProvider } from "@/bindings";
import { call, commands, isTauri } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import type { SelectOption } from "@/ui";
import { Row, Select } from "../components/Form";
import { useSetting } from "../components/context";
import type { SectionSpec } from "./spec";
import styles from "./Workflow.module.css";

/** The agent that writes suggested commit messages, its model/thinking effort, and the rules it is given. */
function MessageSuggestion() {
  const [agent, setAgent] = useSetting<string>("vcs.commit.suggestAgent");
  const [model, setModel] = useSetting<string>("vcs.commit.suggestModel");
  const [thinking, setThinking] = useSetting<string>("vcs.commit.suggestThinking");
  const [rules, setRules] = useSetting<string>("vcs.commit.suggestRules");
  const [providers, setProviders] = useState<AgentProvider[]>([]);
  const rulesId = useId();
  useEffect(() => {
    if (!isTauri()) return;
    void call(commands.agentProviders()).then(setProviders, () => undefined);
  }, []);
  const options: SelectOption[] = [
    { value: "", label: "None" },
    ...providers
      .filter((p) => p.installed || p.id === agent)
      .map((p) => ({ value: p.id, label: p.installed ? p.name : tx`${p.name} (not installed)` })),
  ];
  if (agent && !options.some((o) => o.value === agent)) options.push({ value: agent, label: agent });

  const selectedProvider = providers.find((p) => p.id === agent);
  const modelOpt = selectedProvider?.config.find((c) => c.category === "model" || c.id === "model");
  const thinkingOpt = selectedProvider?.config.find((c) => c.category === "thought_level" || c.id === "thought_level");

  const modelOptions: SelectOption[] = [
    {
      value: "",
      label: modelOpt?.current
        ? tx`Default (${modelOpt.values.find((v) => v.value === modelOpt.current)?.name ?? modelOpt.current})`
        : "Default",
    },
    ...(modelOpt?.values ?? []).map((v) => ({ value: v.value, label: v.name || v.value })),
  ];
  if (model && !modelOptions.some((o) => o.value === model)) modelOptions.push({ value: model, label: model });

  const fallbackThinking = [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    { value: "xhigh", label: "Extra High" },
  ];
  const thinkingOptions: SelectOption[] = [
    {
      value: "",
      label: thinkingOpt?.current
        ? tx`Default (${thinkingOpt.values.find((v) => v.value === thinkingOpt.current)?.name ?? thinkingOpt.current})`
        : "Default",
    },
    ...(thinkingOpt?.values.length
      ? thinkingOpt.values.map((v) => ({ value: v.value, label: v.name || v.value }))
      : fallbackThinking),
  ];
  if (thinking && !thinkingOptions.some((o) => o.value === thinking)) {
    thinkingOptions.push({ value: thinking, label: thinking });
  }

  return (
    <>
      <Row
        label="Agent"
        hint="The agent runs read-only in an empty temporary folder. Only agents with a read-only or default permission mode can be used."
      >
        <Select
          value={agent}
          options={options}
          onChange={(next) => {
            setAgent(next);
            if (next !== agent) {
              setModel("");
              setThinking("");
            }
          }}
          aria-label={tx("Agent that suggests commit messages")}
        />
      </Row>
      <Row label="Model" hint="Model used by the selected agent when generating commit message suggestions.">
        <Select
          value={model}
          options={modelOptions}
          disabled={!agent}
          onChange={setModel}
          aria-label={tx("Model for commit message suggestions")}
        />
      </Row>
      <Row label="Thinking" hint="Reasoning effort (thinking level) used when generating commit message suggestions.">
        <Select
          value={thinking}
          options={thinkingOptions}
          disabled={!agent}
          onChange={setThinking}
          aria-label={tx("Thinking effort for commit message suggestions")}
        />
      </Row>
      <Row
        label="Rules"
        htmlFor={rulesId}
        stacked
        hint="Sent to the agent as they are, with the changes: naming convention, wording to avoid, language. Leave empty for a short subject in the imperative mood."
      >
        <textarea
          id={rulesId}
          className={styles.rules}
          value={rules}
          spellCheck={false}
          placeholder={tx(
            "Subject: <type>(<scope>): <summary>\nTake the ticket id from the branch name.\nNever mention tools or assistants.",
          )}
          onChange={(e) => setRules(e.target.value)}
        />
      </Row>
    </>
  );
}

export const MESSAGE_SUGGESTION_SECTION: SectionSpec = {
  title: "Commit Message Suggestion",
  options: [
    {
      kind: "custom",
      label: "Agent",
      keywords: ["suggest commit message", "generate", "AI", "prompt", "rules", "naming convention"],
      component: MessageSuggestion,
    },
  ],
};
