/** Agents tool window: tasks grouped by what they need from the user. */
import { useMemo, useRef, useState } from "react";
import type { AgentStatus as Status, AgentTask } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { confirmChecked } from "@/workbench/messages";
import { EmptyState, Icon, IconButton, Menu, Spinner, T, Tree, showContextMenu, type MenuItem } from "@/ui";
import { age, branchLabel, groupTasks, isBusy, providerIcon, type TaskGroup } from "./model";
import {
  applyPreset,
  archiveTask,
  deleteTask,
  openCatalog,
  openHome,
  openTask,
  updateDraft,
  useAgents,
} from "./store";
import styles from "./Agents.module.css";
import { tx } from "@/platform/i18n";

export function AgentsHeaderActions() {
  return (
    <>
      <IconButton icon="plus" action="agents.newTask" size="small" />
      <IconButton icon="settings" action="agents.manageAgents" size="small" />
    </>
  );
}

type Node = { kind: "group"; group: TaskGroup } | { kind: "task"; task: AgentTask };

const nodeKey = (n: Node) => (n.kind === "group" ? `g:${n.group.status}` : n.task.id);

export function TaskStatusIcon({ status }: { status: Status }) {
  switch (status) {
    case "needsInput":
      return <Icon name="warning" size={13} label="Needs input" />;
    case "running":
    case "starting":
      return <Spinner size={11} />;
    case "ready":
      return <Icon name="check" size={13} className={styles.ready} label="Ready" />;
    case "failed":
      return <Icon name="close" size={13} className={styles.failed} label="Failed" />;
    case "archived":
      return <Icon name="minus" size={13} className={styles.archived} label="Archived" />;
  }
}

export function AgentsView() {
  const loaded = useAgents((s) => s.loaded);
  const error = useAgents((s) => s.error);
  const tasks = useAgents((s) => s.tasks);
  const providers = useAgents((s) => s.providers);
  const presets = useAgents((s) => s.presets);
  const disabledProviders = useAgents((s) => s.disabledProviders);
  const draft = useAgents((s) => s.draft);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(["g:archived"]));
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [menuOpen, setMenuOpen] = useState(false);
  const splitRef = useRef<HTMLDivElement>(null);
  const roots = useMemo<Node[]>(() => groupTasks(tasks.values()).map((group) => ({ kind: "group", group })), [tasks]);
  const expanded = useMemo(() => new Set(roots.map(nodeKey).filter((k) => !collapsed.has(k))), [roots, collapsed]);
  if (!loaded)
    return (
      <div className={styles.loading}>
        <Spinner />
      </div>
    );
  if (error) return <EmptyState title="Cannot load agent tasks">{error}</EmptyState>;
  const providerName = (id: string) => providers.find((p) => p.id === id)?.name ?? id;

  const enabledInstalled = providers.filter((p) => p.installed && !disabledProviders.includes(p.id));
  const menuProviders = enabledInstalled.length ? enabledInstalled : providers.filter((p) => p.installed);
  const activeIcon = providerIcon(draft.provider);

  const menuItems: MenuItem[] = [
    ...menuProviders.map(
      (p): MenuItem => ({
        id: `agent:${p.id}`,
        label: p.name,
        verbatim: true,
        icon: providerIcon(p.id),
        checked: !draft.presetId && draft.provider === p.id,
        run: () => {
          updateDraft({ provider: p.id, presetId: null, config: {} });
          openHome();
        },
      }),
    ),
    ...(presets.length
      ? [
          { kind: "separator" as const },
          ...presets.map(
            (preset): MenuItem => ({
              id: `preset:${preset.id}`,
              label: preset.name,
              verbatim: true,
              icon: providerIcon(preset.provider),
              checked: draft.presetId === preset.id,
              run: () => {
                applyPreset(preset.id);
                openHome();
              },
            }),
          ),
        ]
      : []),
    { kind: "separator" },
    {
      id: "manage-agents",
      label: "Manage Agents...",
      icon: "plus",
      run: () => openCatalog(),
    },
  ];

  return (
    <div className={styles.view}>
      <div className={styles.topActions}>
        <div ref={splitRef} className={styles.splitGroup}>
          <button type="button" className={styles.splitMain} onClick={() => openHome()}>
            <Icon name={activeIcon} size={14} />
            <T>New Session</T>
          </button>
          <button
            type="button"
            className={styles.splitArrow}
            aria-label={tx("Select Agent")}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
          >
            <Icon name="chevron-down" size={12} />
          </button>
        </div>
        <Menu
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          anchor={splitRef}
          placement="bottom-end"
          aria-label="Select Agent"
          items={menuItems}
        />
      </div>
      <div className={styles.treeArea}>
        <Tree<Node>
          aria-label="Agent tasks"
          roots={roots}
          getKey={nodeKey}
          getLabel={(n) => (n.kind === "group" ? n.group.label : n.task.title)}
          getChildren={(n) =>
            n.kind === "group" ? n.group.tasks.map((task) => ({ kind: "task", task }) as Node) : undefined
          }
          isExpandable={(n) => n.kind === "group"}
          expanded={expanded}
          onExpandedChange={(_next, node, open) =>
            setCollapsed((c) => {
              const s = new Set(c);
              if (open) s.delete(nodeKey(node));
              else s.add(nodeKey(node));
              return s;
            })
          }
          selected={selected}
          onSelectionChange={(sel, lead) => {
            setSelected(sel);
            if (lead?.kind === "task") openTask(lead.task.id);
          }}
          onActivate={(n) => n.kind === "task" && openTask(n.task.id)}
          onContextMenu={(n, _sel, e) => n?.kind === "task" && showContextMenu(e, taskMenu(n.task))}
          renderNode={(n) =>
            n.kind === "group" ? (
              <span className={styles.row}>
                <span className={styles.groupLabel}>
                  <T>{n.group.label}</T>
                </span>
                <span className={styles.count}>{n.group.tasks.length}</span>
              </span>
            ) : (
              <span className={styles.row} title={n.task.error ?? n.task.title}>
                <TaskStatusIcon status={n.task.status} />
                <span className={styles.title}>{n.task.title}</span>
                <span className={styles.detail}>
                  {providerName(n.task.provider)}
                  {n.task.isolation === "worktree" ? ` · ${branchLabel(n.task.branch)}` : ""}
                </span>
                <span className={styles.age}>{age(n.task.updatedMs ?? 0)}</span>
              </span>
            )
          }
          empty={
            <div className={styles.empty}>
              <T>No agent tasks yet</T>
              <button type="button" className={styles.link} onClick={() => openHome()}>
                <T>New Task…</T>
              </button>
            </div>
          }
        />
      </div>
      <div className={styles.bottomBar}>
        <button type="button" className={styles.settingsBtn} onClick={() => openCatalog()}>
          <Icon name="settings" size={14} />
          <T>Settings</T>
        </button>
      </div>
    </div>
  );
}

function taskMenu(task: AgentTask): MenuItem[] {
  const busy = isBusy(task.status);
  return [
    { label: "Open", run: () => openTask(task.id) },
    { label: "Open in Terminal", icon: "terminal", run: () => void executeAction("terminal.openAt", task.cwd) },
    { kind: "separator" },
    { label: "Archive", disabled: busy || task.status === "archived", run: () => void archiveTask(task.id) },
    { label: "Delete…", run: () => void confirmDelete(task) },
  ];
}

async function confirmDelete(task: AgentTask) {
  const worktree = task.isolation === "worktree";
  const r = await confirmChecked({
    title: "Delete Agent Task",
    message: worktree
      ? tx`Delete “${task.title}”? Its branch ${task.branch ?? ""} is kept.`
      : tx`Delete “${task.title}”? Files it changed are kept.`,
    ok: "Delete",
    icon: "warning",
    checkbox: worktree ? "Also remove its worktree folder" : undefined,
    checked: worktree,
  });
  if (r) await deleteTask(task.id, worktree && r.checked);
}
