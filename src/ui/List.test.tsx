import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { setLocale, tx } from "@/platform/i18n";
import { HighlightedText } from "./HighlightedText";
import { List, listNavigate } from "./List";
import { fuzzyMatch, indexRuns } from "./match";

type Row = { section: string } | { name: string; hits: number[] };
const items: Row[] = [
  { section: "Classes" },
  { name: "OrderController", hits: [0, 1, 2, 5, 6, 7] },
  { name: "OrderControllerTest", hits: [0, 1, 2] },
  { section: "Actions" },
  { name: "Optimize Imports", hits: [] },
];
const isSection = (r: Row) => "section" in r;

describe("HighlightedText", () => {
  it("wraps matched runs in <mark>", () => {
    const { container } = render(<HighlightedText text="OrderController" indices={[0, 1, 2, 5, 6, 7]} />);
    expect([...container.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["Ord", "Con"]);
    expect(container.textContent).toBe("OrderController");
  });

  it("indexRuns groups consecutive indices", () => {
    expect(indexRuns([0, 1, 2, 5, 7, 8])).toEqual([
      [0, 3],
      [5, 6],
      [7, 9],
    ]);
  });

  it("fuzzyMatch prefers substrings, then camel humps", () => {
    expect(fuzzyMatch("OrderController", "con")).toEqual([5, 6, 7]);
    expect(fuzzyMatch("OrderController", "oc")).toEqual([0, 5]);
    expect(fuzzyMatch("OrderController", "xyz")).toBeNull();
  });
});

describe("List", () => {
  const renderList = (onActivate = vi.fn()) =>
    render(
      <List<Row>
        aria-label="Results"
        items={items}
        getKey={(r, i) => ("section" in r ? `s${i}` : r.name)}
        isSection={isSection}
        renderSection={(r) => ("section" in r ? r.section : null)}
        onActivate={onActivate}
        renderItem={(r, { active }) =>
          "name" in r ? <HighlightedText text={r.name} indices={r.hits} tone={active ? "accent" : "strong"} /> : null
        }
      />,
    );

  it("renders section headers that are skipped by keyboard navigation", () => {
    const onActivate = vi.fn();
    renderList(onActivate);
    const list = screen.getByRole("listbox");
    expect(screen.getByText("Classes")).toBeInTheDocument();
    const options = () => screen.getAllByRole("option");
    expect(options()).toHaveLength(3);
    expect(options()[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(options()[2]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(list, { key: "Enter" });
    expect(onActivate).toHaveBeenCalledWith(items[4], 4, expect.anything());
    fireEvent.keyDown(list, { key: "Home" });
    expect(options()[0]).toHaveAttribute("aria-selected", "true");
  });

  it("highlights matched characters in rows", () => {
    renderList();
    const first = screen.getAllByRole("option")[0]!;
    expect([...first.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["Ord", "Con"]);
  });

  it("keeps its English name in English", () => {
    renderList();
    expect(screen.getByRole("listbox", { name: "Results" })).toBeInTheDocument();
  });

  describe("in Italian", () => {
    beforeAll(async () => {
      await setLocale("it");
    });
    afterAll(async () => {
      await setLocale("en");
    });

    it("translates its name", () => {
      renderList();
      expect(screen.getByRole("listbox", { name: "Risultati" })).toBeInTheDocument();
    });

    it("keeps a name the caller already translated, and text that is not in the catalog", () => {
      render(
        <>
          <List<string> aria-label={tx("Results")} items={["a"]} getKey={(s) => s} renderItem={(s) => s} />
          <List<string> aria-label="README.md" items={["b"]} getKey={(s) => s} renderItem={(s) => s} />
        </>,
      );
      expect(screen.getByRole("listbox", { name: "Risultati" })).toBeInTheDocument();
      expect(screen.getByRole("listbox", { name: "README.md" })).toBeInTheDocument();
    });
  });

  it("listNavigate skips sections and clamps at the ends", () => {
    expect(listNavigate("ArrowDown", { items, active: 2, isSection })).toBe(4);
    expect(listNavigate("ArrowUp", { items, active: 1, isSection })).toBe(1);
    expect(listNavigate("ArrowUp", { items, active: 1, isSection, wrap: true })).toBe(4);
    expect(listNavigate("x", { items, active: 1, isSection })).toBeNull();
  });
});
