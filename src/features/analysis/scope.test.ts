import { describe, expect, it, vi } from "vitest";
import type { FileStatus } from "@/bindings";

const vcsStatus = vi.fn<() => Promise<{ status: "ok"; data: FileStatus[] }>>();

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: {
      ...real.commands,
      vcsStatus: () => vcsStatus(),
    },
  };
});

import { changedFiles } from "./scope";

describe("analysis scope", () => {
  it("changedFiles returns the vcsStatus paths without deleted ones", async () => {
    vcsStatus.mockResolvedValueOnce({
      status: "ok",
      data: [
        {
          path: "/ws/src/modified.ts",
          relPath: "src/modified.ts",
          staged: null,
          unstaged: "modified",
          renamedFrom: null,
        },
        {
          path: "/ws/src/untracked.ts",
          relPath: "src/untracked.ts",
          staged: null,
          unstaged: "untracked",
          renamedFrom: null,
        },
        {
          path: "/ws/src/deleted-unstaged.ts",
          relPath: "src/deleted-unstaged.ts",
          staged: null,
          unstaged: "deleted",
          renamedFrom: null,
        },
        {
          path: "/ws/src/deleted-staged.ts",
          relPath: "src/deleted-staged.ts",
          staged: "deleted",
          unstaged: null,
          renamedFrom: null,
        },
      ],
    });

    await expect(changedFiles()).resolves.toEqual(["/ws/src/modified.ts", "/ws/src/untracked.ts"]);
    expect(vcsStatus).toHaveBeenCalledTimes(1);
  });
});
