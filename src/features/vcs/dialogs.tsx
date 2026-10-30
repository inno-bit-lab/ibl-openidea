/** Imperative dialogs for VCS actions, rendered by one overlay contribution. */
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { create } from "zustand";
import { call, commands } from "@/platform/ipc";
import { Checkbox, Dialog, Icon, Input, Tree, T } from "@/ui";
import { confirm } from "@/workbench/messages";
import { baseName, stripSlash } from "./model";
import styles from "./common.module.css";

interface DialogEntry {
  id: number;
  render: (close: () => void) => ReactNode;
}

const useVcsDialogs = create<{ stack: DialogEntry[] }>(() => ({ stack: [] }));
let seq = 0;

/** Shows `render(close)` above the workbench; returns `close`. */
export function openDialog(render: (close: () => void) => ReactNode): () => void {
  const id = ++seq;
  const close = () => useVcsDialogs.setState((s) => ({ stack: s.stack.filter((e) => e.id !== id) }));
  useVcsDialogs.setState((s) => ({ stack: [...s.stack, { id, render }] }));
  return close;
}

export function closeAllDialogs() {
  useVcsDialogs.setState({ stack: [] });
}

export function VcsDialogHost() {
  const stack = useVcsDialogs((s) => s.stack);
  return (
    <>
      {stack.map((e) => (
        <Fragment key={e.id}>
          {e.render(() => useVcsDialogs.setState((s) => ({ stack: s.stack.filter((x) => x.id !== e.id) })))}
        </Fragment>
      ))}
    </>
  );
}

export interface PromptOptions {
  title: string;
  label?: string;
  initial?: string;
  placeholder?: string;
  okLabel?: string;
  mono?: boolean;
  /** Returns an error message, or null when valid. */
  validate?: (value: string) => string | null;
  /** Optional checkbox below the field. */
  checkbox?: { label: string; initial: boolean };
}

export interface PromptResult {
  value: string;
  checked: boolean;
}

export function promptText(opts: PromptOptions): Promise<PromptResult | null> {
  return new Promise((resolve) => {
    const close = openDialog(() => (
      <PromptDialog
        {...opts}
        onDone={(r) => {
          close();
          resolve(r);
        }}
      />
    ));
  });
}

function PromptDialog(props: PromptOptions & { onDone: (r: PromptResult | null) => void }) {
  const { title, label, initial = "", placeholder, okLabel = "OK", mono, validate, checkbox, onDone } = props;
  const [value, setValue] = useState(initial);
  const [checked, setChecked] = useState(checkbox?.initial ?? false);
  const [touched, setTouched] = useState(false);
  const error = validate ? validate(value) : value.trim() ? null : "Value must not be empty";
  const submit = () => {
    setTouched(true);
    if (!error) onDone({ value: value.trim(), checked });
  };
  return (
    <Dialog
      open
      title={title}
      onClose={() => onDone(null)}
      width={420}
      buttons={[
        { label: okLabel, role: "default", disabled: !!error, onClick: submit },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {label && <label className={styles.fieldLabel}>{label}</label>}
        <Input
          data-autofocus
          aria-label={label ?? title}
          value={value}
          mono={mono}
          placeholder={placeholder}
          invalid={touched && !!error}
          onChange={(e) => {
            setTouched(true);
            setValue(e.target.value);
          }}
        />
        {touched && error && value && <div className={styles.error}>{error}</div>}
        {checkbox && <Checkbox checked={checked} onChange={setChecked} label={checkbox.label} />}
      </form>
    </Dialog>
  );
}

export interface ConfirmOptions {
  title: string;
  message: ReactNode;
  okLabel?: string;
  danger?: boolean;
}

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return confirm({
    title: opts.title,
    message: opts.message,
    ok: opts.okLabel ?? "OK",
    icon: opts.danger ? "warning" : "question",
  });
}

export interface ChooseManyOptions {
  title: string;
  /** Values offered as checkboxes. */
  options: readonly string[];
  initial: readonly string[];
  /** Label of a free-text field for values not in `options` (comma-separated). */
  customLabel?: string;
  okLabel?: string;
}

/** Splits a comma-separated list, trimming blanks. */
export function splitList(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Multi-select chooser (Log Branch / User filters › Select…); null when cancelled. */
export function chooseMany(opts: ChooseManyOptions): Promise<string[] | null> {
  return new Promise((resolve) => {
    const close = openDialog(() => (
      <ChooseManyDialog
        {...opts}
        onDone={(r) => {
          close();
          resolve(r);
        }}
      />
    ));
  });
}

function ChooseManyDialog(props: ChooseManyOptions & { onDone: (r: string[] | null) => void }) {
  const { title, options, initial, customLabel, okLabel = "OK", onDone } = props;
  const [query, setQuery] = useState("");
  const [checked, setChecked] = useState(() => new Set(initial.filter((v) => options.includes(v))));
  const [custom, setCustom] = useState(() => initial.filter((v) => !options.includes(v)).join(", "));
  const q = query.trim().toLowerCase();
  const shown = q ? options.filter((o) => o.toLowerCase().includes(q)) : options;
  const submit = () => onDone([...options.filter((o) => checked.has(o)), ...(customLabel ? splitList(custom) : [])]);
  return (
    <Dialog
      open
      title={title}
      onClose={() => onDone(null)}
      width={420}
      buttons={[
        { label: okLabel, role: "default", onClick: submit },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Input
          data-autofocus
          aria-label="Filter"
          placeholder="Filter"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className={styles.choiceList} role="group" aria-label={title}>
          {shown.map((o) => (
            <div key={o} className={styles.fileRow}>
              <Checkbox
                checked={checked.has(o)}
                label={o}
                onChange={(v) =>
                  setChecked((s) => {
                    const n = new Set(s);
                    if (v) n.add(o);
                    else n.delete(o);
                    return n;
                  })
                }
              />
            </div>
          ))}
        </div>
        {customLabel && (
          <>
            <label className={styles.fieldLabel}>{customLabel}</label>
            <Input aria-label={customLabel} value={custom} onChange={(e) => setCustom(e.target.value)} />
          </>
        )}
      </form>
    </Dialog>
  );
}

/** Local date of an `<input type="date">` value (`2024-05-01`) as epoch ms at local midnight. */
export function parseDay(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

/** Date filter › Select…: `after` inclusive, `before` the day after the chosen "To" date. */
export function chooseDateRange(): Promise<{ after: number | null; before: number | null } | null> {
  return new Promise((resolve) => {
    const close = openDialog(() => (
      <DateRangeDialog
        onDone={(r) => {
          close();
          resolve(r);
        }}
      />
    ));
  });
}

function DateRangeDialog({ onDone }: { onDone: (r: { after: number | null; before: number | null } | null) => void }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const after = parseDay(from);
  const toDay = parseDay(to);
  const before = toDay == null ? null : new Date(toDay).setDate(new Date(toDay).getDate() + 1);
  const error =
    after == null && before == null
      ? "Choose a start or end date"
      : after != null && before != null && after >= before
        ? "The start date is after the end date"
        : null;
  const submit = () => {
    if (!error) onDone({ after, before });
  };
  return (
    <Dialog
      open
      title="Filter by Date"
      onClose={() => onDone(null)}
      width={360}
      buttons={[
        { label: "OK", role: "default", disabled: !!error, onClick: submit },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className={styles.fieldLabel}>
          <T>From:</T>
        </label>
        <Input data-autofocus type="date" aria-label="From" value={from} onChange={(e) => setFrom(e.target.value)} />
        <label className={styles.fieldLabel}>
          <T>To:</T>
        </label>
        <Input type="date" aria-label="To" value={to} onChange={(e) => setTo(e.target.value)} />
        {(from || to) && error && <div className={styles.error}>{error}</div>}
      </form>
    </Dialog>
  );
}

export interface ChoosePathInTreeOptions {
  projectRoot: string | null;
  roots: readonly string[];
  initialPath: string | null;
  initialRoots: readonly string[];
}

export interface PathTreeChoice {
  path: string | null;
  roots: string[];
}

interface DirNode {
  path: string;
  name: string;
  children?: DirNode[];
}

/** Paths filter › Select in Tree…: folder tree chooser with checkboxes. */
export function choosePathInTree(opts: ChoosePathInTreeOptions): Promise<PathTreeChoice | null> {
  return new Promise((resolve) => {
    const close = openDialog(() => (
      <PathTreeDialog
        {...opts}
        onDone={(r) => {
          close();
          resolve(r);
        }}
      />
    ));
  });
}

function ancestorDirs(path: string, base: string | null): string[] {
  const out: string[] = [];
  let cur = stripSlash(path);
  while (cur) {
    out.push(cur);
    if (base && cur === base) break;
    const slash = cur.lastIndexOf("/");
    if (slash <= 0) break;
    cur = cur.slice(0, slash);
  }
  return out;
}

function buildDirTree(
  projectRoot: string | null,
  vcsRoots: readonly string[],
  childrenByDir: Readonly<Record<string, readonly string[]>>,
  extraPaths: readonly string[] = [],
): DirNode[] {
  const allKnown = new Set<string>();
  const base = projectRoot ? stripSlash(projectRoot) : null;
  const topRoots = base ? [base] : vcsRoots.map(stripSlash);
  for (const r of topRoots) allKnown.add(r);
  for (const r of vcsRoots) for (const a of ancestorDirs(r, base)) allKnown.add(a);
  for (const p of extraPaths) for (const a of ancestorDirs(p, base)) allKnown.add(a);
  for (const [dir, kids] of Object.entries(childrenByDir)) {
    allKnown.add(dir);
    for (const k of kids) allKnown.add(k);
  }

  const byParent = new Map<string, string[]>();
  for (const p of allKnown) {
    if (topRoots.includes(p)) continue;
    const slash = p.lastIndexOf("/");
    if (slash <= 0) continue;
    const parent = p.slice(0, slash);
    const list = byParent.get(parent) ?? [];
    if (!list.includes(p)) list.push(p);
    byParent.set(parent, list);
  }

  const makeNode = (path: string): DirNode => {
    const kids = (byParent.get(path) ?? []).sort((a, b) => a.localeCompare(b));
    const loaded = path in childrenByDir;
    return {
      path,
      name: baseName(path) || path,
      children: loaded || kids.length > 0 ? kids.map(makeNode) : undefined,
    };
  };
  return topRoots.map(makeNode);
}

function PathTreeDialog(props: ChoosePathInTreeOptions & { onDone: (r: PathTreeChoice | null) => void }) {
  const { projectRoot, roots, initialPath, initialRoots, onDone } = props;
  const base = projectRoot ? stripSlash(projectRoot) : null;
  const [checked, setChecked] = useState<Set<string>>(() => {
    const s = new Set<string>(initialRoots.map(stripSlash));
    if (initialPath) s.add(stripSlash(initialPath));
    return s;
  });
  const [treeSelected, setTreeSelected] = useState<Set<string>>(() => {
    const first = initialPath ? stripSlash(initialPath) : initialRoots[0] ? stripSlash(initialRoots[0]) : null;
    return first ? new Set([first]) : new Set();
  });
  const [childrenByDir, setChildrenByDir] = useState<Record<string, string[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const init = new Set<string>(base ? [base] : roots.map(stripSlash));
    if (initialPath) {
      for (const a of ancestorDirs(initialPath, base).slice(1)) init.add(a);
    }
    for (const r of initialRoots) {
      for (const a of ancestorDirs(r, base).slice(1)) init.add(a);
    }
    return init;
  });

  useEffect(() => {
    let alive = true;
    const toLoad = [...expanded].filter((dir) => !(dir in childrenByDir));
    if (!toLoad.length) return;
    void Promise.all(
      toLoad.map((dir) =>
        call(commands.fsReadDir(dir)).then(
          (entries) =>
            [
              dir,
              entries
                .filter((e) => (e.kind === "dir" || (e.kind === "symlink" && e.targetKind === "dir")) && !e.hidden)
                .map((e) => stripSlash(e.path)),
            ] as const,
          () => [dir, [] as string[]] as const,
        ),
      ),
    ).then((loaded) => {
      if (!alive) return;
      setChildrenByDir((prev) => ({ ...prev, ...Object.fromEntries(loaded) }));
    });
    return () => {
      alive = false;
    };
  }, [expanded, childrenByDir]);

  const extraPaths = initialPath ? [stripSlash(initialPath), ...initialRoots] : initialRoots;
  const tree = buildDirTree(projectRoot, roots, childrenByDir, extraPaths);
  const togglePath = (path: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  const submit = () => {
    const effective = checked.size ? checked : treeSelected;
    const list = [...effective];
    if (!list.length) return onDone({ path: null, roots: [] });
    const rootSet = new Set(roots.map(stripSlash));
    const chosenRoots = roots.filter((r) => effective.has(stripSlash(r)));
    const otherPaths = list.filter((p) => !rootSet.has(p));
    if (chosenRoots.length && !otherPaths.length) {
      onDone({ path: null, roots: chosenRoots.length >= roots.length && roots.length > 1 ? [] : chosenRoots });
    } else {
      onDone({ path: otherPaths[0] ?? chosenRoots[0] ?? null, roots: [] });
    }
  };

  return (
    <Dialog
      open
      title="Select Paths in Tree"
      onClose={() => onDone(null)}
      width={440}
      buttons={[
        { label: "OK", role: "default", onClick: submit },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div
        className={styles.choiceList}
        style={{ height: 280 }}
        onKeyDown={(e) => {
          if (e.key === " " && treeSelected.size) {
            e.preventDefault();
            for (const p of treeSelected) togglePath(p);
          }
        }}
      >
        <Tree<DirNode>
          roots={tree}
          getKey={(n) => n.path}
          getLabel={(n) => n.name}
          getChildren={(n) => n.children}
          isExpandable={(n) => n.children === undefined || n.children.length > 0}
          expanded={expanded}
          onExpandedChange={setExpanded}
          selected={treeSelected}
          onSelectionChange={(sel) => setTreeSelected(new Set(sel))}
          multiSelect={false}
          aria-label="Project folders"
          renderNode={(n) => (
            <span className={styles.fileRow}>
              <Checkbox checked={checked.has(n.path)} onChange={() => togglePath(n.path)} />
              <Icon name="folder" size={15} />
              <span>{n.name}</span>
            </span>
          )}
        />
      </div>
    </Dialog>
  );
}
