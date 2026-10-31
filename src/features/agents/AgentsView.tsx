/** Agents tool window: tasks grouped by what they need from the user. */
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentStatus as Status, AgentTask } from "@/bindings";
import { maybeEditorService, type EditorInput } from "@/workbench/contributions";
import { EmptyState, Icon, IconButton, Menu, Spinner, T, Tree, showContextMenu, type MenuItem } from "@/ui";
import { SESSION_KIND, age, branchLabel, groupTasks, providerIcon, type TaskGroup } from "./model";
import { applyPreset, openCatalog, openHome, openTask, updateDraft, useAgents } from "./store";
import { taskMenu } from "./taskActions";
import styles from "./Agents.module.css";
import { basename, useProject } from "@/platform/project";
import { useTx } from "@/platform/i18n";

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

const sessionTask = (input: EditorInput | null | undefined) =>
  input?.kind === SESSION_KIND ? (input.data as { task?: string } | undefined)?.task : undefined;

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
    case "limited":
      return <Icon name="clock" size={13} className={styles.failed} label="Usage limit" />;
    case "archived":
      return <Icon name="minus" size={13} className={styles.archived} label="Archived" />;
  }
}

export function AgentsView() {
  const project = useProject((s) => s.project);
  const tx = useTx();
  const loaded = useAgents((s) => s.loaded);
  const error = useAgents((s) => s.error);
  const tasks = useAgents((s) => s.tasks);
  const unread = useAgents((s) => s.unread);
  const providers = useAgents((s) => s.providers);
  const presets = useAgents((s) => s.presets);
  const disabledProviders = useAgents((s) => s.disabledProviders);
  const draft = useAgents((s) => s.draft);
  const [menuOpen, setMenuOpen] = useState(false);
  const splitRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(["g:archived"]));
  const [selected, setSelected] = useState<Set<string>>(() => {
    const task = sessionTask(maybeEditorService()?.activeInput?.());
    return new Set(task ? [task] : []);
  });
  // Follow the active session tab.
  useEffect(
    () =>
      maybeEditorService()?.onActiveInputChange?.((input) => {
        const task = sessionTask(input);
        if (!task) return;
        setSelected((current) => (current.has(task) ? current : new Set([task])));
        const group = groupTasks(useAgents.getState().tasks.values()).find((g) => g.tasks.some((t) => t.id === task));
        const key = group && `g:${group.status}`;
        if (key) setCollapsed((c) => (c.has(key) ? new Set([...c].filter((k) => k !== key)) : c));
      }),
    [],
  );
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
  const menuProviders = providers.filter((p) => p.installed && !disabledProviders.includes(p.id));
  const availablePresets = presets.filter(
    (preset) =>
      !disabledProviders.includes(preset.provider) && providers.some((p) => p.id === preset.provider && p.installed),
  );
  const menuItems: MenuItem[] = [
    ...menuProviders.map((p): MenuItem => ({
      id: `agent:${p.id}`,
      label: p.name,
      verbatim: true,
      icon: providerIcon(p.id),
      checked: !draft.presetId && draft.provider === p.id,
      run: () => {
        updateDraft({ provider: p.id, presetId: null, config: {} });
        openHome();
      },
    })),
    ...(availablePresets.length
      ? [
          { kind: "separator" as const },
          ...availablePresets.map((preset): MenuItem => ({
            id: `preset:${preset.id}`,
            label: preset.name,
            verbatim: true,
            icon: providerIcon(preset.provider),
            checked: draft.presetId === preset.id,
            run: () => {
              applyPreset(preset.id);
              openHome();
            },
          })),
        ]
      : []),
    { kind: "separator" },
    { kind: "action", action: "agents.addAgent" },
    { kind: "action", action: "agents.manageAgents" },
  ];

  return (
    <div className={styles.view}>
      <div className={styles.topActions}>
        <div ref={splitRef} className={styles.splitGroup}>
          <button type="button" className={styles.splitMain} onClick={() => openHome()}>
            <Icon name={providerIcon(draft.provider)} size={14} />
            <T>New Session</T>
          </button>
          <button
            type="button"
            className={styles.splitArrow}
            aria-label={tx("Select Agent")}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
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
            if (sel.size === 1 && lead?.kind === "task" && sel.has(lead.task.id)) openTask(lead.task.id);
          }}
          onActivate={(n) => n.kind === "task" && openTask(n.task.id)}
          onContextMenu={(n, sel, e) => {
            if (n?.kind !== "task") return;
            const selection = [...sel].flatMap((id) => {
              const task = tasks.get(id);
              return task ? [task] : [];
            });
            showContextMenu(e, taskMenu(selection));
          }}
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
                <span className={styles.title} data-unread={unread.has(n.task.id) || undefined}>
                  {n.task.title}
                </span>
                {unread.has(n.task.id) && (
                  <span className={styles.unreadDot} role="img" aria-label={tx("Unread")} title={tx("Unread")} />
                )}
                {project?.workspace && (
                  <span className={styles.taskProject} title={n.task.projectRoot ?? project.root}>
                    {basename(n.task.projectRoot ?? project.root)}
                  </span>
                )}
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
