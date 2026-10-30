import { describe, expect, it } from "vitest";
import type { Branch } from "@/bindings";
import {
  branchDetail,
  branchFolderKeys,
  buildBranchRows,
  buildBranchTree,
  buildMultiRepoBranchTree,
  currentBranchFolderKeys,
  filterBranchTree,
  isFavoriteBranch,
  pushRecent,
  type BranchRow,
  type BranchTreeNode,
} from "../branches";
import { commitWebUrl, remoteWebUrl } from "../model";

const b = (name: string, opts: Partial<Branch> = {}): Branch => ({
  name,
  remote: name.includes("/") && name.startsWith("origin/"),
  current: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  lastCommitMs: 0,
  commit: "",
  ...opts,
});

const branches = [
  b("feature/order-paging", { current: true, upstream: "origin/feature/order-paging", ahead: 2 }),
  b("zeta"),
  b("main"),
  b("bugfix"),
  b("origin/HEAD"),
  b("origin/main"),
  b("origin/feature/order-paging"),
];

const actions = [
  { id: "vcs.update", label: "Update Project…" },
  { id: "vcs.push", label: "Push…" },
];

const summary = (rows: BranchRow[]) =>
  rows.map((r) =>
    r.type === "section"
      ? `# ${r.label}`
      : r.type === "action"
        ? `> ${r.action.label}`
        : r.type === "tag"
          ? `tag:${r.tag}`
          : `${r.group}:${r.branch.name}${r.favorite ? " ★" : ""}`,
  );

describe("buildBranchRows", () => {
  it("groups actions, recent, local (current first, favourites next) and remote", () => {
    expect(summary(buildBranchRows(branches, ["bugfix", "feature/order-paging", "gone"], "", actions))).toEqual([
      "> Update Project…",
      "> Push…",
      "# Recent",
      "recent:bugfix",
      "# Local",
      "local:feature/order-paging",
      "local:main ★",
      "local:bugfix",
      "local:zeta",
      "# Remote",
      "remote:origin/main ★",
      "remote:origin/feature/order-paging",
    ]);
  });

  it("filters branches and actions by fuzzy query and drops the Recent group", () => {
    const rows = buildBranchRows(branches, ["main"], "main", actions);
    expect(summary(rows)).toEqual(["# Local", "local:main ★", "# Remote", "remote:origin/main ★"]);
    const hit = rows[1]!;
    expect(hit.type === "branch" && hit.matches).toEqual([0, 1, 2, 3]);
    expect(summary(buildBranchRows(branches, [], "push", actions))).toEqual(["> Push…"]);
  });

  it("omits empty groups", () => {
    expect(summary(buildBranchRows([b("main", { current: true })], [], "", []))).toEqual(["# Local", "local:main ★"]);
  });

  it("puts the user's favorites right after the current branch", () => {
    const rows = buildBranchRows(branches, [], "", [], ["zeta", "origin/feature/order-paging"]);
    expect(summary(rows)).toEqual([
      "# Local",
      "local:feature/order-paging",
      "local:zeta ★",
      "local:bugfix",
      "local:main",
      "# Remote",
      "remote:origin/feature/order-paging ★",
      "remote:origin/main",
    ]);
  });

  it("lists tags last, newest version first, and filters them by the query", () => {
    const tags = ["v1.2", "v1.10", "release"];
    expect(summary(buildBranchRows([], [], "", [], null, tags))).toEqual([
      "# Tags",
      "tag:v1.10",
      "tag:v1.2",
      "tag:release",
    ]);
    expect(summary(buildBranchRows(branches, [], "v1.1", [], null, tags))).toEqual(["# Tags", "tag:v1.10"]);
  });
});

describe("pushRecent", () => {
  it("moves a branch to the front without duplicates", () => {
    expect(pushRecent(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
    expect(pushRecent(["a", "b"], "c", 2)).toEqual(["c", "a"]);
  });
});

describe("buildBranchTree", () => {
  const outline = (nodes: readonly BranchTreeNode[], depth = 0): string[] =>
    nodes.flatMap((n) => [
      `${"  ".repeat(depth)}${n.favorite ? "*" : ""}${n.label}`,
      ...outline(n.children ?? [], depth + 1),
    ]);

  it("groups names into folders with favorites first", () => {
    const tree = buildBranchTree(
      [
        b("zeta"),
        b("feat/b"),
        b("feat/a"),
        b("main"),
        b("fix/deep/x"),
        b("dev", { current: true }),
        b("origin/main"),
        b("origin/feat/a"),
        b("origin/HEAD"),
      ],
      null,
    );
    expect(outline(tree)).toEqual([
      "HEAD (Current Branch)",
      "Local",
      "  dev",
      "  *main",
      "  feat",
      "    a",
      "    b",
      "  fix",
      "    deep",
      "      x",
      "  zeta",
      "Remote",
      "  origin",
      "    *main",
      "    feat",
      "      a",
    ]);
    expect(branchFolderKeys(tree, "fix/deep/x")).toEqual(["g:local", "f:local/fix", "f:local/fix/deep"]);
    expect(branchFolderKeys(tree, "nope")).toEqual([]);
  });

  it("filters by branch name, keeping the folders of matches", () => {
    const tree = buildBranchTree([b("main"), b("feat/login"), b("fix/login-crash"), b("origin/feat/login")], null);
    expect(outline(filterBranchTree(tree, "LOGIN"))).toEqual([
      "Local",
      "  feat",
      "    login",
      "  fix",
      "    login-crash",
      "Remote",
      "  origin",
      "    feat",
      "      login",
    ]);
    expect(filterBranchTree(tree, "nothing")).toEqual([]);
  });

  it("uses the stored favorites once the user edits them", () => {
    expect(isFavoriteBranch(b("main"), null)).toBe(true);
    expect(isFavoriteBranch(b("origin/master"), null)).toBe(true);
    expect(isFavoriteBranch(b("main"), ["dev"])).toBe(false);
    expect(isFavoriteBranch(b("dev"), ["dev"])).toBe(true);
  });

  it("aggregates multi-repo branches like IDEA: checked-out repos on current branches, existing repos and sync on others", () => {
    const tree = buildMultiRepoBranchTree([
      {
        root: "/p/appcall-iac",
        name: "appcall-iac",
        head: "main",
        branches: [b("main", { current: true }), b("origin/main")],
      },
      {
        root: "/p/ecs-iac",
        name: "ecs-iac",
        head: "master",
        branches: [b("master", { current: true }), b("origin/master")],
      },
      {
        root: "/p/ngtp-sr",
        name: "ngtp-sr",
        head: "release/2026-PI2-2",
        branches: [b("release/2026-PI2-2", { current: true }), b("release/2026-PI5")],
      },
      {
        root: "/p/chb-iac",
        name: "chb-iac",
        head: "release/2026-PI5",
        branches: [
          b("main"),
          b("release/2026-PI5", { current: true }),
          b("release/2026-PI2-1", { behind: 1 }),
          b("sprint/2026-PI5-S4"),
        ],
      },
      {
        root: "/p/xcs",
        name: "xcs",
        head: "release/2026-PI5",
        branches: [
          b("release/2026-PI5", { current: true }),
          b("release/2026-PI2-1", { behind: 3 }),
          b("release/2026-PI4-2", { behind: 16 }),
        ],
      },
    ]);

    const detailedOutline = (nodes: readonly BranchTreeNode[], depth = 0): string[] =>
      nodes.flatMap((n) => {
        const cur = n.branch?.current ? "@" : "";
        const det = branchDetail(n);
        return [
          `${"  ".repeat(depth)}${cur}${n.label}${det ? ` ${det}` : ""}`,
          ...detailedOutline(n.children ?? [], depth + 1),
        ];
      });

    expect(detailedOutline(tree)).toEqual([
      "HEAD (Current Branch)",
      "Local",
      "  @main (appcall-iac)",
      "  @master (ecs-iac)",
      "  release",
      "    @2026-PI2-2 (ngtp-sr)",
      "    @2026-PI5 (chb-iac, xcs)",
      "    2026-PI2-1 (chb-iac, xcs)  ↓4",
      "    2026-PI4-2 (xcs)  ↓16",
      "  sprint",
      "    2026-PI5-S4 (chb-iac)",
      "Remote",
      "  origin",
      "    main (appcall-iac)",
      "    master (ecs-iac)",
    ]);
    expect(currentBranchFolderKeys(tree)).toEqual(["f:local/release", "g:local"]);
  });

  it("handles detached HEAD and empty repository lists in buildMultiRepoBranchTree", () => {
    expect(buildMultiRepoBranchTree([])).toEqual([
      { key: "head", label: "HEAD (Current Branch)", kind: "head", ref: "HEAD" },
    ]);
    const detached = buildMultiRepoBranchTree([
      {
        root: "/p/a",
        name: "a",
        head: null,
        branches: [b("main", { current: true, ahead: 2 })],
      },
    ]);
    const localMain = detached[1]?.children?.[0];
    expect(localMain?.branch?.current).toBe(false);
    expect(branchDetail(localMain!)).toBe("(a)  ↑2");
  });
});

describe("remote web URLs", () => {
  it("maps ssh, scp-like and https remotes to their web page", () => {
    expect(remoteWebUrl("git@github.com:acme/app.git")).toBe("https://github.com/acme/app");
    expect(remoteWebUrl("ssh://git@gitlab.example.com:2222/group/sub/app.git")).toBe(
      "https://gitlab.example.com/group/sub/app",
    );
    expect(remoteWebUrl("https://user:token@github.com/o/r.git/")).toBe("https://github.com/o/r");
    expect(remoteWebUrl("/srv/git/app.git")).toBeNull();
    expect(commitWebUrl("git@github.com:o/r.git", "abc")).toBe("https://github.com/o/r/commit/abc");
    expect(commitWebUrl("git@bitbucket.org:o/r.git", "abc")).toBe("https://bitbucket.org/o/r/commits/abc");
  });
});
