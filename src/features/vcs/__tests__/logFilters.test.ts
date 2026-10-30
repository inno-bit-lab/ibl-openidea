import { beforeEach, describe, expect, it, vi } from "vitest";

const vcsLog = vi.fn();
const vcsConfigGet = vi.fn();

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsLog: (repo: unknown, query: unknown) => vcsLog(repo, query),
      vcsConfigGet: (repo: unknown, key: string) => vcsConfigGet(repo, key),
    },
  };
});

import { parseDay, splitList } from "../dialogs";
import { unstashTitles } from "../changeOps";
import {
  ME,
  dateRangeLabel,
  emptyFilters,
  hasFilters,
  inDateRange,
  logRepoOf,
  pathsFilterLabel,
  reloadLog,
  resolveAuthors,
  resolveLogTargets,
  toggleRootFilter,
  useGitLog,
} from "../logStore";
import { useVcs } from "../store";

describe("Git Log filters", () => {
  it("resolves the 'me' user to the current Git user and drops duplicates", () => {
    expect(resolveAuthors([ME, "alice", " alice "], "me@corp.test")).toEqual(["me@corp.test", "alice"]);
    expect(resolveAuthors([ME], null)).toEqual([]);
  });

  it("matches a custom date range with an exclusive end", () => {
    const d = { after: 100, before: 200, label: "" };
    expect([99, 100, 199, 200].map((t) => inDateRange(t, d))).toEqual([false, true, true, false]);
    expect(inDateRange(5, { after: null, before: 10, label: "" })).toBe(true);
    expect(inDateRange(5, null)).toBe(true);
  });

  it("labels a date range by its first and last day", () => {
    const jan1 = parseDay("2024-01-01")!;
    const feb1 = parseDay("2024-02-01")!;
    expect(dateRangeLabel(jan1, feb1)).toBe("2024-01-01 – 2024-01-31");
    expect(dateRangeLabel(jan1, null)).toBe("after 2024-01-01");
    expect(dateRangeLabel(null, feb1)).toBe("until 2024-01-31");
    expect(parseDay("nope")).toBeNull();
  });

  it("counts multi-value filters and root filters as filters", () => {
    expect(hasFilters(emptyFilters())).toBe(false);
    expect(hasFilters({ ...emptyFilters(), branches: ["main", "dev"] })).toBe(true);
    expect(hasFilters({ ...emptyFilters(), authors: [ME] })).toBe(true);
    expect(hasFilters({ ...emptyFilters(), roots: ["/w/repo-a"] })).toBe(true);
  });

  it("splits comma-separated custom values", () => {
    expect(splitList(" a, ,b ,")).toEqual(["a", "b"]);
  });

  it("resolves paths and repository roots for multi-repo projects", () => {
    const roots = ["/w/alpha", "/w/beta", "/w/beta/nested"];
    expect(logRepoOf("/w/beta", roots)).toBe("/w/beta");
    expect(logRepoOf("/w/beta/nested", roots)).toBe("/w/beta/nested");
    expect(logRepoOf("/w/beta/nested/src/a.ts", roots)).toBe("/w/beta/nested");
    expect(logRepoOf("/w/beta/src/b.ts", roots)).toBe("/w/beta");

    // All roots active by default in a multi-repo project
    expect(resolveLogTargets(roots, "/w/alpha", emptyFilters())).toEqual([
      { repo: "/w/alpha", path: null },
      { repo: "/w/beta", path: null },
      { repo: "/w/beta/nested", path: null },
    ]);

    // Filtering by specific roots
    expect(resolveLogTargets(roots, "/w/alpha", { ...emptyFilters(), roots: ["/w/beta"] })).toEqual([
      { repo: "/w/beta", path: null },
    ]);

    // Filtering by path inside a sub-repo routes to that sub-repo
    expect(resolveLogTargets(roots, "/w/alpha", { ...emptyFilters(), path: "/w/beta/src/lib" })).toEqual([
      { repo: "/w/beta", path: "/w/beta/src/lib" },
    ]);
    // Filtering by the exact root path of a sub-repo routes to that sub-repo (and any nested repos inside it)
    expect(resolveLogTargets(roots, "/w/alpha", { ...emptyFilters(), path: "/w/alpha" })).toEqual([
      { repo: "/w/alpha", path: null },
    ]);
    expect(resolveLogTargets(roots, "/w/alpha", { ...emptyFilters(), path: "/w/beta" })).toEqual([
      { repo: "/w/beta", path: null },
      { repo: "/w/beta/nested", path: null },
    ]);
  });

  it("toggles repository roots and formats the Paths filter button label like IDEA", () => {
    const roots = ["/w/claude-howto", "/w/ecc", "/w/gstack"];
    // Unchecking one root when all are implicitly selected selects the remaining ones
    const afterUncheck = toggleRootFilter([], roots, "/w/ecc");
    expect(afterUncheck).toEqual(["/w/claude-howto", "/w/gstack"]);
    expect(pathsFilterLabel({ ...emptyFilters(), roots: afterUncheck }, "/w", roots)).toBe("claude-howto, gstack");

    // Re-checking that root restores "all selected" (empty filter)
    const afterRecheck = toggleRootFilter(afterUncheck, roots, "/w/ecc");
    expect(afterRecheck).toEqual([]);
    expect(pathsFilterLabel({ ...emptyFilters(), roots: afterRecheck }, "/w", roots)).toBeNull();

    // Single root label
    expect(pathsFilterLabel({ ...emptyFilters(), roots: ["/w/gstack"] }, "/w", roots)).toBe("gstack");
  });
});

describe("loading the log", () => {
  beforeEach(() => {
    useVcs.setState({ root: "/w", roots: [], repo: null });
    useGitLog.setState({ filters: emptyFilters(), commits: [], rows: [] });
    vcsLog.mockReset().mockResolvedValue({ status: "ok", data: [] });
    vcsConfigGet.mockReset().mockImplementation(async (_repo: unknown, key: string) => ({
      status: "ok",
      data: key === "user.email" ? "me@corp.test" : null,
    }));
  });

  it("sends every selected branch and user, with 'me' resolved", async () => {
    useGitLog.setState({ filters: { ...emptyFilters(), branches: ["main", "dev"], authors: [ME, "bob"] } });
    await reloadLog();
    const queries = vcsLog.mock.calls.map((c) => c[1] as { branches?: string[]; authors?: string[]; range: unknown });
    const page = queries.find((q) => q.range === null)!;
    expect(page.branches).toEqual(["main", "dev"]);
    expect(page.authors).toEqual(["me@corp.test", "bob"]);
  });

  it("fetches and merges commits newest-first across all repositories in a multi-repo project", async () => {
    const roots = ["/w/repo-a", "/w/repo-b"];
    useVcs.setState({ root: "/w", roots, repo: "/w/repo-a" });
    vcsLog.mockImplementation(async (repo: string | null) => ({
      status: "ok",
      data:
        repo === "/w/repo-a"
          ? [
              {
                id: "a1".repeat(20),
                shortId: "a1a1a1a1",
                parents: [],
                author: "Alice",
                email: "a@test",
                timeMs: 1000,
                commitTimeMs: 1000,
                summary: "Commit in A",
                message: "Commit in A",
                refs: ["HEAD -> main"],
              },
            ]
          : [
              {
                id: "b1".repeat(20),
                shortId: "b1b1b1b1",
                parents: [],
                author: "Bob",
                email: "b@test",
                timeMs: 2000,
                commitTimeMs: 2000,
                summary: "Commit in B",
                message: "Commit in B",
                refs: ["HEAD -> main"],
              },
            ],
    }));

    await reloadLog();
    const commits = useGitLog.getState().commits;
    expect(commits.map((c) => ({ summary: c.summary, repo: c.repo }))).toEqual([
      { summary: "Commit in B", repo: "/w/repo-b" },
      { summary: "Commit in A", repo: "/w/repo-a" },
    ]);
  });
});

describe("unstash", () => {
  it("names the operation after what it does", () => {
    const base = { index: 2, pop: false, reinstateIndex: true, branch: null };
    expect(unstashTitles(base).title).toBe("Apply stash@{2}");
    expect(unstashTitles({ ...base, pop: true }).success).toBe("Unstashed stash@{2}");
    expect(unstashTitles({ ...base, branch: "fix" }).title).toBe("Unstash stash@{2} as branch fix");
  });
});

