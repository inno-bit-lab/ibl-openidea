import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { setLocale } from "@/platform/i18n";
import type { FileMatches, SearchQuery } from "@/platform/ipc";
import { provideEditorService } from "@/workbench/contributions";
import { FindToolWindow } from "../find/FindToolWindow";
import type { FindDeps } from "../find/session";
import { disposeFindWindow, openInFindWindow, useFindViewOptions } from "../find/windowStore";

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

/** Excludes the first match row, then the whole file, and returns the summary after each step. */
async function excludeOneThenAll(excludeLabel: string): Promise<[string, string]> {
  provideEditorService({
    openFile: async () => {},
    openInput: async () => {},
    activePath: () => null,
    activeCursor: () => null,
    saveAll: async () => {},
  });
  useFindViewOptions.setState({ preview: false });
  await show(deps([3]));
  const summary = () => screen.getByText(/ · /).textContent ?? "";
  fireEvent.mouseDown(screen.getAllByRole("treeitem", { name: /order/ })[0]!, { button: 0 });
  fireEvent.click(screen.getByRole("button", { name: excludeLabel }));
  const one = summary();
  fireEvent.mouseDown(screen.getByRole("treeitem", { name: /f0\.kt/ }), { button: 0 });
  fireEvent.click(screen.getByRole("button", { name: excludeLabel }));
  return [one, summary()];
}

/** One and other for both the matches and the files; a search that hit its limit marks the matches only. */
const SUMMARIES: { counts: number[]; limitHit: boolean; english: string; italian: string }[] = [
  { counts: [1], limitHit: false, english: "1 match in 1 file", italian: "1 corrispondenza in 1 file" },
  { counts: [2], limitHit: false, english: "2 matches in 1 file", italian: "2 corrispondenze in 1 file" },
  { counts: [1, 0], limitHit: false, english: "1 match in 2 files", italian: "1 corrispondenza in 2 file" },
  { counts: [2, 1], limitHit: false, english: "3 matches in 2 files", italian: "3 corrispondenze in 2 file" },
  { counts: [2, 1], limitHit: true, english: "3+ matches in 2 files", italian: "3+ corrispondenze in 2 file" },
];

describe("Find tool window text in English", () => {
  it("counts excluded matches as before", async () => {
    expect(await excludeOneThenAll("Exclude")).toEqual([
      "3 matches in 1 file · 1 excluded",
      "3 matches in 1 file · 3 excluded",
    ]);
  });

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

  it("counts excluded matches with the singular and the plural", async () => {
    expect(await excludeOneThenAll("Escludi")).toEqual([
      "3 corrispondenze in 1 file · 1 escluso",
      "3 corrispondenze in 1 file · 3 esclusi",
    ]);
  });

  it("says when nothing matched", async () => {
    await show(deps([]));
    expect(screen.getByText("Nessuna corrispondenza")).toBeInTheDocument();
    expect(screen.queryByText("No matches")).toBeNull();
  });
});
