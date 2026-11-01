import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";

/** What the next search does: never finish, reject the pattern, or report files with these match counts. */
type Mode =
  | { kind: "pending" }
  | { kind: "invalid"; message: string }
  | { kind: "files"; counts: number[]; limitHit: boolean };
let mode: Mode = { kind: "files", counts: [], limitHit: false };

vi.mock("../find/windowStore", async (orig) => ({
  ...(await orig<typeof import("../find/windowStore")>()),
  ipcFindDeps: () => ({
    validate: async () => {
      if (mode.kind === "invalid") throw { message: mode.message };
    },
    start: (_id: number, _q: unknown, onFile: (f: unknown) => void) => {
      if (mode.kind !== "files") return new Promise(() => {});
      const { counts, limitHit } = mode;
      counts.forEach((count, i) =>
        onFile({
          path: `/p/f${i}.kt`,
          relPath: `f${i}.kt`,
          matches: Array.from({ length: count }, (_, line) => ({
            line,
            text: "order",
            ranges: [[0, 5]],
            textOffset: 0,
          })),
        }),
      );
      const matches = counts.reduce((a, b) => a + b, 0);
      return Promise.resolve({ files: counts.length, matches, limitHit, cancelled: false, elapsedMs: 0 });
    },
    cancel: () => {},
    nextRequestId: () => 1,
  }),
}));

const { FindInFilesOverlay } = await import("../find/FindInFiles");
const { hideFindPopup, rememberFindString, runFindPopupCommand, showFindPopup, useFindPopup } =
  await import("../find/store");
const { setLocale } = await import("@/platform/i18n");

const settle = () => act(() => new Promise((r) => setTimeout(r, 250)));

/** Opens Find in Files on `query` (none: an empty field) and waits for the search to settle. */
async function find(query?: string) {
  render(<FindInFilesOverlay />);
  act(() => showFindPopup(false, query === undefined ? undefined : { query }));
  await settle();
}

beforeEach(() => {
  localStorage.clear();
  mode = { kind: "files", counts: [], limitHit: false };
  // The popup keeps the last search text: each test starts from an empty field.
  useFindPopup.setState({ pattern: "", pinned: false, maskEnabled: false, context: "any", replacement: "" });
});

afterEach(() => {
  act(() => hideFindPopup());
});

/** One and other for both the matches and the files, and the `+` of a search that hit its limit. */
const SUMMARIES: { counts: number[]; limitHit: boolean; english: string; italian: string }[] = [
  { counts: [1], limitHit: false, english: "1 match in 1 file", italian: "1 corrispondenza in 1 file" },
  { counts: [2], limitHit: false, english: "2 matches in 1 file", italian: "2 corrispondenze in 1 file" },
  { counts: [1, 0], limitHit: false, english: "1 match in 2 files", italian: "1 corrispondenza in 2 file" },
  { counts: [2, 1], limitHit: false, english: "3 matches in 2 files", italian: "3 corrispondenze in 2 file" },
  { counts: [2, 1], limitHit: true, english: "3+ matches in 2+ files", italian: "3+ corrispondenze in 2+ file" },
];

describe("Find in Files text in English", () => {
  it.each(SUMMARIES)("summarizes $counts (limit hit: $limitHit) as $english", async ({ counts, limitHit, english }) => {
    mode = { kind: "files", counts, limitHit };
    await find("order");
    expect(screen.getByText(english)).toBeInTheDocument();
  });
});

describe("Find in Files text in Italian", () => {
  beforeAll(async () => {
    await setLocale("it");
  });
  afterAll(async () => {
    await setLocale("en");
  });

  it("asks for text while the field is empty", async () => {
    await find();
    expect(screen.getByText("Digita il testo da cercare nel progetto")).toBeInTheDocument();
    expect(screen.queryByText("Type text to search the project")).toBeNull();
  });

  it("shows a running search in the header and in the list", async () => {
    mode = { kind: "pending" };
    await find("order");
    expect(screen.getAllByText("Ricerca in corso…")).toHaveLength(2);
    expect(screen.queryByText("Searching…")).toBeNull();
  });

  it("names an invalid pattern and keeps the error of the search engine as written", async () => {
    mode = { kind: "invalid", message: "Unclosed group near index 1" };
    await find("(order");
    expect(screen.getByText("Modello non valido")).toBeInTheDocument();
    expect(screen.queryByText("Invalid pattern")).toBeNull();
    expect(screen.getAllByText("Unclosed group near index 1").length).toBeGreaterThan(0);
  });

  it("says when nothing was found", async () => {
    await find("order");
    expect(screen.getByText("Nessuna corrispondenza")).toBeInTheDocument();
    expect(screen.getByText("Nessun elemento trovato")).toBeInTheDocument();
  });

  it.each(SUMMARIES)("summarizes $counts (limit hit: $limitHit) as $italian", async ({ counts, limitHit, italian }) => {
    mode = { kind: "files", counts, limitHit };
    await find("order");
    expect(screen.getByText(italian)).toBeInTheDocument();
  });

  it("gives the dialog, the matches and its menus Italian names", async () => {
    rememberFindString("find", "older");
    mode = { kind: "files", counts: [1], limitHit: false };
    await find("order");
    const dialog = screen.getByRole("dialog", { name: "Trova nei file" });
    expect(within(dialog).getByRole("listbox", { name: "Corrispondenze" })).toBeInTheDocument();
    act(() => void runFindPopupCommand("recentSearches"));
    expect(await screen.findByRole("menu", { name: "Ricerche recenti" })).toBeInTheDocument();
    act(() => within(dialog).getByRole("button", { name: "Contesto di ricerca" }).click());
    expect(await screen.findByRole("menu", { name: "Contesto di ricerca" })).toBeInTheDocument();
  });
});
