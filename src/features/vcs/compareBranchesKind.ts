/** Compare Branches tab input; kept apart from `CompareBranches` so registering the tab does not load it (nor the Git log). */
import { tx } from "@/platform/i18n";
import type { EditorInput } from "@/workbench/contributions";
import { currentRepo } from "./store";

export const COMPARE_BRANCHES_KIND = "vcs.compareBranches";

export interface CompareBranchesData {
  branch: string;
  /** The current branch's name, for titles; each repository compares with its own `HEAD`. */
  current: string;
  repo: string | null;
  /** Several repositories (a branch common to them); otherwise `repo` alone. */
  repos?: readonly string[];
}

export function compareBranchesTitle(data: CompareBranchesData): string {
  return tx`Compare: ${data.branch} and ${data.current}`;
}

export function compareBranchesInput(
  branch: string,
  current: string,
  repo: string | null = currentRepo(),
  repos?: readonly string[],
): EditorInput {
  const repoKey = repos && repos.length > 1 ? repos.join("|") : (repo ?? "");
  const data: CompareBranchesData = { branch, current, repo, repos };
  return { kind: COMPARE_BRANCHES_KIND, key: `compareBranches:${repoKey}:${branch}:${current}`, path: "", data };
}
