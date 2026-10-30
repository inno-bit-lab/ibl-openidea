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
  deleteInRepos,
  deleteRemoteBranch,
  deleteRemoteInRepos,
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
  updateInRepos,
  useFavoriteBranches,
} from "./branchOps";
import { showCompareBranches } from "./CompareBranches";
import { showDiffWithWorkingTree } from "./operations";
import type { CommonBranch } from "./repoBranches";
import { currentRepo, focusRepo } from "./store";
import { tx } from "@/platform/i18n";

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
    return [
      { label: tx`New Branch from '${b.name}'…`, icon: "branch", run: run(() => newBranch()) },
      { kind: "separator" },
      { label: "Update", icon: "git-pull", run: run(() => updateBranch(b.name)) },
      { label: "Push…", icon: "git-push", run: run(() => executeAction("vcs.push", { branch: b.name, repo: currentRepo() })) },
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
  if (!b.remote)
    items.push(
      { kind: "separator" },
      { label: "Update", icon: "git-pull", disabled: !b.upstream, run: run(() => updateBranch(b.name)) },
      { label: "Push…", icon: "git-push", run: run(() => executeAction("vcs.push", { branch: b.name, repo: currentRepo() })) },
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

/** Entries for a branch across multiple repositories: each acts in the relevant `roots`. */
export function commonBranchMenu(
  b: CommonBranch,
  roots: readonly string[],
  done: () => void = () => {},
  currentRoots: readonly string[] = b.current ? roots : [],
): MenuItem[] {
  const run = (fn: () => unknown) => () => {
    done();
    void fn();
  };
  loadFavoriteBranches();
  const favorite = isFavoriteBranch(b, useFavoriteBranches.getState().names);
  const favoriteItem: MenuItem = {
    label: favorite ? "Remove from Favorites" : "Add to Favorites",
    icon: "star",
    run: run(() =>
      toggleFavoriteBranch({
        name: b.name,
        remote: b.remote,
        current: b.current,
        upstream: null,
        ahead: 0,
        behind: 0,
        lastCommitMs: 0,
        commit: "",
      }),
    ),
  };
  const history: MenuItem = {
    label: "Show History",
    icon: "history",
    run: run(() => executeAction("vcs.showLog", { branch: b.name })),
  };
  const newFrom: MenuItem = {
    label: tx`New Branch from '${b.name}'…`,
    icon: "branch",
    run: run(() => newBranchInRepos(roots, b.name)),
  };
  const nonCurrentRoots = currentRoots.length ? roots.filter((r) => !currentRoots.includes(r)) : roots;
  const anyCurrent = b.current || currentRoots.length > 0;
  const pushRoots = currentRoots.length ? currentRoots : roots;
  if (b.current || !nonCurrentRoots.length)
    return [
      newFrom,
      { kind: "separator" },
      { label: "Update", icon: "git-pull", run: run(() => updateInRepos(b.name, roots, currentRoots.length ? currentRoots : roots)) },
      { label: "Push…", icon: "git-push", run: run(() => executeAction("vcs.push", { branch: b.name, repos: pushRoots })) },
      { kind: "separator" },
      favoriteItem,
      history,
    ];
  const items: MenuItem[] = [
    { label: "Checkout", run: run(() => checkoutInRepos(b.name, nonCurrentRoots)) },
    newFrom,
    ...(!b.remote
      ? [
          { kind: "separator" as const },
          { label: "Update", icon: "git-pull", run: run(() => updateInRepos(b.name, roots, currentRoots)) },
          { label: "Push…", icon: "git-push", run: run(() => executeAction("vcs.push", { branch: b.name, repos: pushRoots })) },
        ]
      : []),
    { kind: "separator" },
    { label: "Compare with Current", icon: "diff", run: run(() => showCompareBranches(b.name, roots)) },
    { label: "Show Diff with Working Tree", run: run(() => showDiffWithWorkingTree(b.name)) },
    history,
    { kind: "separator" },
    { label: tx`Rebase Current onto '${b.name}'`, run: run(() => rebaseInRepos(b.name, nonCurrentRoots)) },
    { label: tx`Merge '${b.name}' into Current`, run: run(() => mergeInRepos(b.name, nonCurrentRoots)) },
    { kind: "separator" },
    favoriteItem,
  ];
  if (!anyCurrent)
    items.push(
      { kind: "separator" },
      {
        label: "Delete",
        danger: true,
        icon: "trash",
        run: run(() => (b.remote ? deleteRemoteInRepos(b.name, nonCurrentRoots) : deleteInRepos(b.name, nonCurrentRoots))),
      },
    );
  return items;
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
        run: () => void focusRepo(root).then(() => executeAction(item.action, item.arg ?? { repo: root })),
      };
    const run = item.run;
    return {
      ...item,
      run: run && (() => void focusRepo(root).then(run)),
      submenu: item.submenu && inRepo(root, item.submenu),
    };
  });
}
