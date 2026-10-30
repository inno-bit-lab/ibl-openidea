/** VCS actions (ids match keymaps/intellij-macos.ts where bound). */
import { executeAction, registerActions, type Action } from "@/platform/actions";
import { getContext } from "@/platform/context";
import { activeEditor, editorsFor } from "@/editor/api";
import { Menu, type MenuItem } from "@/ui";
import { editorService, maybeEditorService, notifications, toolWindowService } from "@/workbench/contributions";
import { annotationsShown, toggleAnnotations } from "./blame";
import { showBranchesPopup } from "./BranchWidget";
import { checkoutRevision, newBranch, newBranchInRepos } from "./branchOps";
import {
  addToVcs,
  commitChanges,
  isNestedRepoEntry,
  rollbackCandidates,
  showRollbackDialog,
  stashChanges,
  showUnstashDialog,
} from "./changeOps";
import { setAmend, useCommit } from "./commitStore";
import { gotoConflict, resolveAtCaret, showConflictsDialog } from "./conflictsUi";
import { focusedDiffNavigator } from "./diffNavigator";
import { openDiff, workingDiffData } from "./diffInput";
import { openDialog } from "./dialogs";
import { gotoChange, rollbackSelectedLines } from "./gutter";
import { openLocalHistory } from "./localHistoryKind";
import { revealCommit, setLogFilters, useGitLog, emptyFilters } from "./logStore";
import { allRepos, runRemote } from "./ops";
import { showPushDialog, updateProject, type PushTarget } from "./remoteUi";
import { chooseRevision } from "./RevisionChooser";
import { showCloneDialog } from "./clone";
import {
  showManageRemotes,
  showMergeDialog,
  showNewWorktree,
  showPullDialog,
  showRebaseDialog,
  showWorktrees,
} from "./gitMenuDialogs";
import { stripSlash } from "./model";
import { focusRepo, refreshNow, repoName, repoOf, useVcs } from "./store";
import { tx } from "@/platform/i18n";

const VCS = "vcsAvailable";
const IN_COMMIT_WINDOW = "vcsAvailable && activeToolWindow == commit";

function argPath(arg: unknown): string | undefined {
  if (typeof arg === "string") return arg;
  if (arg && typeof arg === "object" && "path" in arg && typeof (arg as { path: unknown }).path === "string")
    return (arg as { path: string }).path;
  return undefined;
}

function argPaths(arg: unknown): string[] | undefined {
  if (Array.isArray(arg)) return arg.filter((x): x is string => typeof x === "string");
  const p = argPath(arg);
  return p ? [p] : undefined;
}

/** Resolves repository root(s) from an action argument (`{ repo }`, `{ repos }`, or file/folder path(s)). */
export function argRepos(arg: unknown): string[] | undefined {
  if (arg && typeof arg === "object") {
    if ("repos" in arg && Array.isArray((arg as { repos: unknown }).repos)) {
      const list = (arg as { repos: unknown[] }).repos.filter((x): x is string => typeof x === "string");
      if (list.length) return list;
    }
    if ("repo" in arg && typeof (arg as { repo: unknown }).repo === "string") {
      return [(arg as { repo: string }).repo];
    }
  }
  const paths = argPaths(arg);
  const roots = useVcs.getState().roots;
  if (!paths?.length || roots.length <= 1) return undefined;
  const matched = new Set<string>();
  for (const raw of paths) {
    const p = stripSlash(raw);
    let direct = false;
    for (const r of roots) {
      if (r === p || r.startsWith(`${p}/`)) {
        matched.add(r);
        direct = true;
      }
    }
    if (!direct) {
      const enclosing = repoOf(p, roots);
      if (enclosing) matched.add(enclosing);
    }
  }
  return matched.size ? [...matched] : undefined;
}

export function argRepo(arg: unknown): string | undefined {
  return argRepos(arg)?.[0];
}

const commitWindowFocused = () => getContext().activeToolWindow === "commit";

/** Files the current context refers to: argument, commit view selection, or the active file. */
function contextPaths(arg: unknown): string[] {
  const explicit = argPaths(arg);
  if (explicit?.length) return explicit;
  const sel = useCommit.getState().selection;
  if (commitWindowFocused() && sel.length) return sel;
  const active = maybeEditorService()?.activePath();
  return active ? [active] : [];
}

function showCommitWindow(tab: "changes" | "stashes" = "changes") {
  useCommit.setState((s) => ({ tab, focusTick: tab === "changes" ? s.focusTick + 1 : s.focusTick }));
  toolWindowService().show("commit", true);
}

function showGitWindow() {
  toolWindowService().show("git", true);
}

async function annotate(arg: unknown) {
  const path = argPath(arg);
  let handle = activeEditor();
  if (path && handle?.ctx.path !== path) {
    await editorService().openFile(path, { focus: true });
    handle = editorsFor(path)[0] ?? activeEditor();
  }
  if (!handle) {
    notifications().notify({ group: "vcs", level: "info", title: "Open a file to annotate it" });
    return;
  }
  await toggleAnnotations(handle.view, handle.ctx.path);
}

const OPERATIONS: MenuItem[] = [
  { kind: "header", label: "Git" },
  { kind: "action", action: "vcs.commit" },
  { kind: "action", action: "vcs.push" },
  { kind: "action", action: "vcs.update" },
  { kind: "action", action: "vcs.pull" },
  { kind: "action", action: "vcs.fetch" },
  { kind: "separator" },
  { kind: "action", action: "vcs.rollback" },
  { kind: "action", action: "vcs.showDiff" },
  { kind: "action", action: "vcs.compareWithBranch" },
  { kind: "action", action: "vcs.addToVcs" },
  { kind: "separator" },
  { kind: "action", action: "vcs.annotate" },
  { kind: "action", action: "vcs.showHistory" },
  { kind: "action", action: "vcs.localHistory" },
  { kind: "separator" },
  { kind: "action", action: "vcs.branches" },
  { kind: "action", action: "vcs.newBranch" },
  { kind: "action", action: "vcs.stash" },
  { kind: "action", action: "vcs.unstash" },
  { kind: "action", action: "vcs.resolveConflicts" },
  { kind: "action", action: "vcs.manageRemotes" },
];

function showOperations() {
  openDialog((close) => (
    <Menu
      open
      onClose={close}
      anchor={{ x: Math.max(16, window.innerWidth / 2 - 140), y: Math.round(window.innerHeight * 0.18) }}
      items={OPERATIONS}
      aria-label="VCS Operations"
    />
  ));
}

export function registerVcsActions(): () => void {
  const actions: Action[] = [
    {
      id: "vcs.operations",
      title: "VCS Operations…",
      category: "Git",
      icon: "branch",
      when: "projectOpen",
      keywords: ["git", "quick list"],
      run: showOperations,
    },
    {
      id: "vcs.commit",
      title: "Commit…",
      category: "Git",
      icon: "commit",
      when: VCS,
      run: () => showCommitWindow(),
    },
    {
      id: "vcs.commitAndPush",
      title: "Commit and Push…",
      category: "Git",
      icon: "git-push",
      when: VCS,
      run: async () => {
        const { message, amend } = useCommit.getState();
        // Nothing to commit with yet: IDEA shows the commit window with the message field focused.
        if (!message.trim() && !amend) return showCommitWindow();
        const id = await commitChanges();
        if (id !== undefined) void executeAction("vcs.push");
      },
    },
    {
      id: "vcs.toggleAmend",
      title: "Amend Commit",
      category: "Git",
      when: VCS,
      keyWhen: IN_COMMIT_WINDOW,
      toggled: () => useCommit.getState().amend,
      run: () => void setAmend(!useCommit.getState().amend),
    },
    {
      id: "vcs.showMessageHistory",
      title: "Show Commit Message History",
      category: "Git",
      icon: "history",
      when: VCS,
      keyWhen: IN_COMMIT_WINDOW,
      run: () => useCommit.setState((s) => ({ historyTick: s.historyTick + 1 })),
    },
    {
      id: "vcs.clone",
      title: "Get from Version Control…",
      category: "Git",
      icon: "git-pull",
      keywords: ["clone", "checkout", "git"],
      run: (c) => showCloneDialog(typeof c.arg === "string" ? c.arg : ""),
    },
    {
      id: "vcs.push",
      title: "Push…",
      category: "Git",
      icon: "git-push",
      when: VCS,
      run: ({ arg }) => {
        const target: PushTarget =
          arg &&
          typeof arg === "object" &&
          !Array.isArray(arg) &&
          ("branch" in arg || "revision" in arg || "repo" in arg || "repos" in arg)
            ? (arg as PushTarget)
            : { repos: argRepos(arg) };
        void showPushDialog(target);
      },
    },
    {
      id: "vcs.update",
      title: "Update Project…",
      category: "Git",
      icon: "git-pull",
      when: VCS,
      keywords: ["pull", "update project"],
      run: ({ arg }) => void updateProject({ repos: argRepos(arg) }),
    },
    {
      id: "vcs.pull",
      title: "Pull…",
      category: "Git",
      icon: "git-pull",
      when: VCS,
      run: ({ arg }) => showPullDialog(argRepo(arg)),
    },
    {
      id: "vcs.merge",
      title: "Merge…",
      category: "Git",
      when: VCS,
      keywords: ["merge branch"],
      run: ({ arg }) => showMergeDialog(argRepo(arg)),
    },
    {
      id: "vcs.rebase",
      title: "Rebase…",
      category: "Git",
      when: VCS,
      keywords: ["rebase branch"],
      run: ({ arg }) => showRebaseDialog(argRepo(arg)),
    },
    {
      id: "vcs.manageRemotes",
      title: "Manage Remotes…",
      category: "Git",
      when: VCS,
      keywords: ["remote", "origin", "url"],
      run: ({ arg }) => showManageRemotes(argRepo(arg)),
    },
    {
      id: "vcs.newWorktree",
      title: "New Worktree…",
      category: "Git",
      when: VCS,
      keywords: ["worktree"],
      run: ({ arg }) => showNewWorktree(undefined, argRepo(arg)),
    },
    {
      id: "vcs.worktrees",
      title: "Worktrees…",
      category: "Git",
      when: VCS,
      keywords: ["worktree"],
      run: ({ arg }) => showWorktrees(argRepo(arg)),
    },
    {
      id: "vcs.fetch",
      title: "Fetch",
      category: "Git",
      icon: "git-fetch",
      when: VCS,
      run: ({ arg }) => {
        const repos = argRepos(arg) ?? allRepos();
        const detail =
          repos.length > 1
            ? `${repos.length} repositories`
            : repos[0] && useVcs.getState().roots.length > 1
              ? repoName(repos[0])
              : undefined;
        void runRemote({ op: "fetch" }, detail, repos);
      },
    },
    {
      id: "vcs.refresh",
      title: "Refresh VCS Status",
      category: "Git",
      icon: "refresh",
      when: VCS,
      run: () => void refreshNow(),
    },
    {
      id: "vcs.rollback",
      title: "Rollback…",
      category: "Git",
      icon: "undo",
      when: VCS,
      keywords: ["revert", "discard"],
      run: ({ arg }) => {
        const explicit = argPaths(arg);
        // IDEA: in the editor, with the caret on changed lines, ⌥⌘Z is Rollback Lines.
        const ed = activeEditor();
        if (!explicit?.length && ed?.view.hasFocus && rollbackSelectedLines(ed.view)) return;
        const sel = useCommit.getState().selection;
        const paths = explicit?.length ? explicit : commitWindowFocused() && sel.length ? sel : undefined;
        if (paths) {
          const candidates = rollbackCandidates(paths);
          const submodule = paths.find((p) => isNestedRepoEntry(p));
          if (!candidates.length && submodule)
            return notifications().notify({
              group: "vcs",
              level: "info",
              title: "Submodule changes cannot be rolled back here",
              body: tx`${repoName(submodule)} points to another commit. Check out the recorded commit in the submodule (git submodule update) to revert it.`,
            });
          return showRollbackDialog(candidates);
        }
        const active = maybeEditorService()?.activePath();
        const activeChanged = active ? rollbackCandidates([active]) : [];
        showRollbackDialog(activeChanged.length ? activeChanged : rollbackCandidates());
      },
    },
    {
      id: "vcs.showDiff",
      title: "Show Diff",
      category: "Git",
      icon: "diff",
      when: VCS,
      // ⌘D duplicates the line inside a text editor; Git › Show Diff still works there.
      keyWhen: "!editorTextFocus",
      run: async ({ arg }) => {
        const line =
          arg && typeof arg === "object" && "line" in arg ? Number((arg as { line: unknown }).line) : undefined;
        const paths = contextPaths(arg).filter((p) => !p.endsWith("/"));
        if (!paths.length) {
          notifications().notify({ group: "vcs", level: "info", title: "Select a changed file to show its diff" });
          return;
        }
        for (const p of paths.slice(0, 5)) await openDiff(workingDiffData(p, line), { preview: paths.length === 1 });
      },
    },
    {
      id: "vcs.compareWithBranch",
      title: "Compare with Branch or Revision…",
      category: "Git",
      icon: "diff",
      when: VCS,
      run: async ({ arg }) => {
        const path = contextPaths(arg)[0];
        if (!path) {
          notifications().notify({ group: "vcs", level: "info", title: "Open or select a file to compare" });
          return;
        }
        const rev = await chooseRevision("Compare with Branch or Revision");
        if (!rev) return;
        await openDiff({ path, left: { type: "rev", rev, label: rev }, right: { type: "worktree" } });
      },
    },
    {
      id: "vcs.nextChange",
      title: "Next Change",
      category: "Git",
      icon: "arrow-down",
      when: VCS,
      run: () => {
        const diff = focusedDiffNavigator();
        if (diff) return diff.next();
        const ed = activeEditor();
        if (ed) gotoChange(ed.view, 1);
      },
    },
    {
      id: "vcs.prevChange",
      title: "Previous Change",
      category: "Git",
      icon: "arrow-up",
      when: VCS,
      run: () => {
        const diff = focusedDiffNavigator();
        if (diff) return diff.prev();
        const ed = activeEditor();
        if (ed) gotoChange(ed.view, -1);
      },
    },
    {
      id: "vcs.annotate",
      title: "Annotate with Git Blame",
      category: "Git",
      icon: "history",
      when: VCS,
      keywords: ["blame", "annotations"],
      toggled: () => {
        const ed = activeEditor();
        return !!ed && annotationsShown(ed.view);
      },
      run: ({ arg }) => annotate(arg),
    },
    {
      id: "vcs.localHistory",
      title: "Show Local History",
      category: "Git",
      icon: "clock",
      when: "projectOpen",
      run: ({ arg }) => {
        const path = argPath(arg) ?? maybeEditorService()?.activePath();
        if (!path) {
          notifications().notify({ group: "vcs", level: "info", title: "Open a file to show its local history" });
          return;
        }
        openLocalHistory(path);
      },
    },
    {
      id: "vcs.branches",
      title: "Branches…",
      category: "Git",
      icon: "branch",
      when: VCS,
      keywords: ["checkout", "git branches"],
      run: showBranchesPopup,
    },
    {
      id: "vcs.newBranch",
      title: "New Branch…",
      category: "Git",
      icon: "plus",
      when: VCS,
      // `{ repos }` (Branches popup with several repositories): in each of them.
      run: ({ arg }) => {
        const repos = argRepos(arg);
        if (repos && repos.length > 1) return void newBranchInRepos(repos);
        if (repos?.length === 1) return void focusRepo(repos[0]!).then(() => newBranch());
        void newBranch();
      },
    },
    {
      id: "vcs.checkoutRevision",
      title: "Checkout Tag or Revision…",
      category: "Git",
      when: VCS,
      run: () => void checkoutRevision(),
    },
    {
      id: "vcs.showLog",
      title: "Show Git Log",
      category: "Git",
      icon: "branch",
      when: VCS,
      run: ({ arg }) => {
        const a = (arg ?? {}) as { branch?: string; path?: string };
        useGitLog.setState({ tab: "log" });
        setLogFilters({ ...emptyFilters(), branches: a.branch ? [a.branch] : [], path: a.path ?? null });
        showGitWindow();
      },
    },
    {
      id: "vcs.showHistory",
      title: "Show History for File",
      category: "Git",
      icon: "history",
      when: VCS,
      run: ({ arg }) => {
        const path = contextPaths(arg)[0];
        if (!path) return;
        useGitLog.setState({ tab: "log" });
        setLogFilters({ ...emptyFilters(), path });
        showGitWindow();
      },
    },
    {
      id: "vcs.showCommit",
      title: "Show Commit in Git Log",
      category: "Git",
      when: VCS,
      hidden: true,
      run: ({ arg }) => {
        if (typeof arg !== "string") return;
        showGitWindow();
        void revealCommit(arg);
      },
    },
    {
      id: "vcs.addToVcs",
      title: "Add to VCS",
      category: "Git",
      icon: "plus",
      when: VCS,
      keywords: ["git add", "stage"],
      run: ({ arg }) => {
        return addToVcs(contextPaths(arg));
      },
    },
    {
      id: "vcs.stash",
      title: "Stash Changes…",
      category: "Git",
      icon: "stash",
      when: VCS,
      run: ({ arg }) => void stashChanges(argRepo(arg)),
    },
    {
      id: "vcs.unstash",
      title: "Unstash Changes…",
      category: "Git",
      when: VCS,
      run: ({ arg }) => showUnstashDialog(0, argRepo(arg)),
    },
    {
      id: "vcs.resolveConflicts",
      title: "Resolve Conflicts…",
      category: "Git",
      when: VCS,
      keywords: ["merge"],
      run: showConflictsDialog,
    },
    {
      id: "vcs.acceptYours",
      title: "Accept Yours (Conflict at Caret)",
      category: "Git",
      when: "editorTextFocus",
      run: () => void resolveAtCaret("ours"),
    },
    {
      id: "vcs.acceptTheirs",
      title: "Accept Theirs (Conflict at Caret)",
      category: "Git",
      when: "editorTextFocus",
      run: () => void resolveAtCaret("theirs"),
    },
    {
      id: "vcs.acceptBoth",
      title: "Accept Both (Conflict at Caret)",
      category: "Git",
      when: "editorTextFocus",
      run: () => void resolveAtCaret("both"),
    },
    {
      id: "vcs.nextConflict",
      title: "Next Conflict Marker",
      category: "Git",
      when: "editorTextFocus",
      run: () => void gotoConflict(1),
    },
    {
      id: "vcs.prevConflict",
      title: "Previous Conflict Marker",
      category: "Git",
      when: "editorTextFocus",
      run: () => void gotoConflict(-1),
    },
  ];
  return registerActions(actions);
}
