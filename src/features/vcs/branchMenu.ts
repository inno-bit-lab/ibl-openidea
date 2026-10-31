/** Branch context menu shared by the Branches popup and the Git Log Branches pane (IDEA's Git.Branch actions). */
import type { Branch } from "@/bindings";
import { executeAction } from "@/platform/actions";
import type { MenuItem } from "@/ui";
import { isFavoriteBranch } from "./branches";
import {
  checkoutAndRebase,
  checkoutBranch,
  checkoutDetached,
  checkoutInRepos,
  deleteBranch,
  deleteBranches,
  deleteInRepos,
  deleteRemoteBranch,
  mergeInRepos,
  newBranchInRepos,
  rebaseInRepos,
  loadFavoriteBranches,
  mergeIntoCurrent,
  newBranch,
  rebaseOnto,
  renameBranch,
  toggleFavoriteBranch,
  updateBranch,
  updateBranches,
  useFavoriteBranches,
} from "./branchOps";
import { showDiffWithWorkingTree } from "./operations";
import type { CommonBranch } from "./repoBranches";
import { runRemote, saveAll } from "./ops";
import { showUpdateDialog } from "./remoteUi";
import { currentRepo, focusRepo, useVcs } from "./store";
import { tx } from "@/platform/i18n";

/** Compare with Current: the editor (and the Git log it reuses) loads when first asked for. */
const showCompareBranches = (branch: string, repo?: string | readonly string[]) =>
  import("./CompareBranches").then((m) => m.showCompareBranches(branch, repo));

/** `git pull <remote> <branch>` into the current branch (`origin/feat/x` → origin, feat/x). */
async function pullInto(remoteBranch: string, rebase: boolean) {
  const i = remoteBranch.indexOf("/");
  if (i <= 0) return;
  const current = useVcs.getState().branch?.head ?? "HEAD";
  await saveAll();
  await runRemote(
    { op: "pullFrom", remote: remoteBranch.slice(0, i), branches: [remoteBranch.slice(i + 1)], rebase, options: {} },
    `${current} ← ${remoteBranch}`,
  );
}

export function branchMenu(b: Branch, current: string | null, done: () => void = () => {}): MenuItem[] {
  const run = (fn: () => unknown) => () => {
    done();
    void fn();
  };
  const cur = current ?? "HEAD";
  loadFavoriteBranches();
  const favorite = isFavoriteBranch(b, useFavoriteBranches.getState().names);
  const favoriteItem: MenuItem = {
    label: favorite ? "Remove from Favorites" : "Add to Favorites",
    icon: "star",
    run: run(() => toggleFavoriteBranch(b)),
  };
  const history: MenuItem = {
    label: "Show History",
    icon: "history",
    run: run(() => executeAction("vcs.showLog", { branch: b.name })),
  };
  if (b.current) {
    // The selected repository's branch (`inRepo` selects it first): Update and Push act on that repository.
    return [
      { label: tx`New Branch from '${b.name}'…`, icon: "branch", run: run(() => newBranch()) },
      { kind: "separator" },
      { label: "Update", icon: "git-pull", run: run(() => showUpdateDialog({ repo: currentRepo() })) },
      { label: "Push…", icon: "git-push", run: run(() => executeAction("vcs.push", { repo: currentRepo() })) },
      { kind: "separator" },
      { label: "Rename…", run: run(() => renameBranch(b.name)) },
      favoriteItem,
      history,
    ];
  }
  const items: MenuItem[] = [
    { label: "Checkout", run: run(() => checkoutBranch(b.name)) },
    { label: tx`New Branch from '${b.name}'…`, icon: "branch", run: run(() => newBranch(b.name)) },
    ...(current ? [{ label: tx`Checkout and Rebase onto '${cur}'`, run: run(() => checkoutAndRebase(b.name)) }] : []),
    { kind: "separator" },
    { label: tx`Compare with '${cur}'`, icon: "diff", run: run(() => showCompareBranches(b.name)) },
    { label: "Show Diff with Working Tree", run: run(() => showDiffWithWorkingTree(b.name)) },
    history,
    { kind: "separator" },
    { label: tx`Rebase '${cur}' onto '${b.name}'`, run: run(() => rebaseOnto(b.name)) },
    { label: tx`Merge '${b.name}' into '${cur}'`, run: run(() => mergeIntoCurrent(b.name)) },
  ];
  if (b.remote)
    items.push(
      { label: tx`Pull into '${cur}' Using Rebase`, run: run(() => pullInto(b.name, true)) },
      { label: tx`Pull into '${cur}' Using Merge`, run: run(() => pullInto(b.name, false)) },
    );
  if (!b.remote)
    items.push(
      { kind: "separator" },
      { label: "Update", icon: "git-pull", disabled: !b.upstream, run: run(() => updateBranch(b.name)) },
      { label: "Push…", icon: "git-push", run: run(() => executeAction("vcs.push", { branch: b.name })) },
    );
  items.push(
    { kind: "separator" },
    ...(b.remote ? [] : [{ label: "Rename…", run: run(() => renameBranch(b.name)) }]),
    favoriteItem,
    {
      label: "Delete",
      danger: true,
      icon: "trash",
      run: run(() => (b.remote ? deleteRemoteBranch(b.name) : deleteBranch(b.name))),
    },
  );
  return items;
}

/** Tag entries of the Branches popup. */
export function tagMenu(tag: string, done: () => void = () => {}): MenuItem[] {
  const run = (fn: () => unknown) => () => {
    done();
    void fn();
  };
  return [
    { label: "Checkout", run: run(() => checkoutDetached(tag, tag)) },
    { label: tx`New Branch from '${tag}'…`, icon: "branch", run: run(() => newBranch(tag)) },
    { kind: "separator" },
    { label: "Compare with Current", icon: "diff", run: run(() => showCompareBranches(tag)) },
    { label: "Show Diff with Working Tree", run: run(() => showDiffWithWorkingTree(tag)) },
    { label: "Show History", icon: "history", run: run(() => executeAction("vcs.showLog", { branch: tag })) },
  ];
}

/** Entries for a branch common to all repositories: each acts in every one of `roots`. */
export function commonBranchMenu(b: CommonBranch, roots: readonly string[], done: () => void = () => {}): MenuItem[] {
  const run = (fn: () => unknown) => () => {
    done();
    void fn();
  };
  const newFrom: MenuItem = {
    label: tx`New Branch from '${b.name}'…`,
    icon: "branch",
    run: run(() => newBranchInRepos(roots, b.name)),
  };
  if (b.current)
    return [
      newFrom,
      { kind: "separator" },
      { label: "Update", icon: "git-pull", run: run(() => executeAction("vcs.update")) },
      { label: "Push…", icon: "git-push", run: run(() => executeAction("vcs.push")) },
    ];
  const items: MenuItem[] = [
    { label: "Checkout", run: run(() => checkoutInRepos(b.name, roots)) },
    newFrom,
    { kind: "separator" },
    { label: "Compare with Current", icon: "diff", run: run(() => showCompareBranches(b.name, roots)) },
    { kind: "separator" },
    { label: tx`Rebase Current onto '${b.name}'`, run: run(() => rebaseInRepos(b.name, roots)) },
    { label: tx`Merge '${b.name}' into Current`, run: run(() => mergeInRepos(b.name, roots)) },
  ];
  if (!b.remote)
    items.push(
      { kind: "separator" },
      { label: "Delete", danger: true, icon: "trash", run: run(() => deleteInRepos(b.name, roots)) },
    );
  return items;
}

/**
 * Entries for several branches selected in the Git Log's Branches pane, in one or more
 * repositories: each acts on every selected branch in its own repository.
 */
export function selectedBranchesMenu(
  targets: readonly { branch?: Branch; repo?: string }[],
  done: () => void = () => {},
): MenuItem[] {
  const run = (fn: () => unknown) => () => {
    done();
    void fn();
  };
  const list = targets.flatMap((t) => (t.branch ? [{ branch: t.branch, repo: t.repo }] : []));
  const repos = list.map((t) => t.repo ?? currentRepo());
  const name = list[0]?.branch.name ?? "";
  // The same branch, once in each of several repositories (as the Branches popup's common branches).
  const common = list.every((t) => t.branch.name === name) && new Set(repos).size === list.length;
  const roots = repos.filter((r): r is string => !!r);
  const allCurrent = list.every((t) => t.branch.current);
  return [
    ...(common && !list.some((t) => t.branch.current)
      ? [{ label: "Checkout", run: run(() => checkoutInRepos(name, roots)) }, { kind: "separator" as const }]
      : []),
    {
      label: "Update",
      icon: "git-pull",
      disabled: !list.some((t) => !t.branch.remote && (t.branch.current || t.branch.upstream)),
      run: run(() => updateBranches(list)),
    },
    {
      label: "Push…",
      icon: "git-push",
      disabled: !allCurrent,
      run: run(() => executeAction("vcs.push", { repos: roots })),
    },
    { kind: "separator" },
    ...(common && !allCurrent
      ? [{ label: "Compare with Current", icon: "diff", run: run(() => showCompareBranches(name, roots)) }]
      : []),
    {
      label: "Show Diff with Working Tree",
      run: run(() => list.forEach((t) => showDiffWithWorkingTree(t.branch.name, t.branch.name, t.repo ?? undefined))),
    },
    { kind: "separator" },
    {
      label: "Delete",
      danger: true,
      icon: "trash",
      disabled: allCurrent,
      run: run(() => deleteBranches(list)),
    },
  ];
}

/** `items` acting on repository `root`: it is selected (with its branches loaded) before each entry runs. */
export function inRepo(root: string, items: MenuItem[]): MenuItem[] {
  return items.map((item): MenuItem => {
    if (item.kind === "separator" || item.kind === "header") return item;
    if (item.kind === "action")
      return {
        label: item.label ?? item.action,
        icon: item.icon,
        disabled: item.disabled,
        run: () => void focusRepo(root).then(() => executeAction(item.action, item.arg)),
      };
    const run = item.run;
    return {
      ...item,
      run: run && (() => void focusRepo(root).then(run)),
      submenu: item.submenu && inRepo(root, item.submenu),
    };
  });
}
