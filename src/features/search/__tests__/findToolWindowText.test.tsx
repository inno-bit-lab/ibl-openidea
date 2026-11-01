import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { setLocale } from "@/platform/i18n";
import type { FileMatches, SearchQuery } from "@/platform/ipc";
import { FindToolWindow } from "../find/FindToolWindow";
import type { FindDeps } from "../find/session";
import { disposeFindWindow, openInFindWindow } from "../find/windowStore";

const query: SearchQuery = {
  pattern: "order",
  isRegex: false,
  wholeWord: false,
  caseSensitive: false,
  include: [],
  exclude: [],
  scope: { kind: "files", paths: ["/p/f0.kt"] },
  maxMatches: 0,
};

/** A search that reports files with these match counts, or one that never finishes. */
function deps(counts: number[] | "pending", limitHit = false): FindDeps {
  return {
    validate: async () => {},
    start: (_id, _q, onFile) => {
      if (counts === "pending") return new Promise(() => {});
      counts.forEach((count, i) => {
        const file: FileMatches = {
          path: `/p/f${i}.kt`,
          relPath: `f${i}.kt`,
          matches: Array.from({ length: count }, (_, line) => ({
            line,
            text: "order",
            ranges: [[0, 5]],
            textOffset: 0,
          })),
        };
        onFile(file);
      });
      const matches = counts.reduce((a, b) => a + b, 0);
      return Promise.resolve({ files: counts.length, matches, limitHit, cancelled: false, elapsedMs: 0 });
    },
    cancel: () => {},
    nextRequestId: () => 1,
  };
}

async function show(d: FindDeps) {
  act(() => void openInFindWindow(query, "Find 'order'", null, d));
  render(<FindToolWindow />);
  await act(() => new Promise((r) => setTimeout(r, 50)));
}

afterEach(disposeFindWindow);

/** One and other for both the matches and the files; a search that hit its limit marks the matches only. */
const SUMMARIES: { counts: number[]; limitHit: boolean; english: string; italian: string }[] = [
  { counts: [1], limitHit: false, english: "1 match in 1 file", italian: "1 corrispondenza in 1 file" },
  { counts: [2], limitHit: false, english: "2 matches in 1 file", italian: "2 corrispondenze in 1 file" },
  { counts: [1, 0], limitHit: false, english: "1 match in 2 files", italian: "1 corrispondenza in 2 file" },
  { counts: [2, 1], limitHit: false, english: "3 matches in 2 files", italian: "3 corrispondenze in 2 file" },
  { counts: [2, 1], limitHit: true, english: "3+ matches in 2 files", italian: "3+ corrispondenze in 2 file" },
];

describe("Find tool window text in English", () => {
  it.each(SUMMARIES)("summarizes $counts (limit hit: $limitHit) as $english", async ({ counts, limitHit, english }) => {
    await show(deps(counts, limitHit));
    expect(screen.getByText(english)).toBeInTheDocument();
  });
});

describe("Find tool window text in Italian", () => {
  beforeAll(async () => {
    await setLocale("it");
  });
  afterAll(async () => {
    await setLocale("en");
  });

  it.each(SUMMARIES)("summarizes $counts (limit hit: $limitHit) as $italian", async ({ counts, limitHit, italian }) => {
    await show(deps(counts, limitHit));
    expect(screen.getByText(italian)).toBeInTheDocument();
  });

  it("shows a running search in the empty results", async () => {
    await show(deps("pending"));
    expect(screen.getByText("Ricerca in corso…")).toBeInTheDocument();
    expect(screen.queryByText("Searching…")).toBeNull();
  });

  it("says when nothing matched", async () => {
    await show(deps([]));
    expect(screen.getByText("Nessuna corrispondenza")).toBeInTheDocument();
    expect(screen.queryByText("No matches")).toBeNull();
  });
});
