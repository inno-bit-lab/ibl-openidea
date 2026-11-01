import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { setLocale, tx } from "@/platform/i18n";
import { ContextMenuHost, Menu, MenuList, hideContextMenu, showContextMenu, type MenuItem } from "./Menu";

const items: MenuItem[] = [{ id: "one", label: "Copy", run: () => {} }];

afterEach(() => {
  act(() => hideContextMenu());
});

describe("Menu names", () => {
  it("keep their English text in English", () => {
    render(<Menu open onClose={() => {}} anchor={{ x: 0, y: 0 }} items={items} aria-label="Recent searches" />);
    expect(screen.getByRole("menu", { name: "Recent searches" })).toBeInTheDocument();
  });

  describe("in Italian", () => {
    beforeAll(async () => {
      await setLocale("it");
    });
    afterAll(async () => {
      await setLocale("en");
    });

    it("translate the name of a dropdown menu", () => {
      render(<Menu open onClose={() => {}} anchor={{ x: 0, y: 0 }} items={items} aria-label="Recent searches" />);
      expect(screen.getByRole("menu", { name: "Ricerche recenti" })).toBeInTheDocument();
    });

    it("translate the name of the context menu", () => {
      render(<ContextMenuHost />);
      act(() => showContextMenu({ x: 0, y: 0 }, items));
      expect(screen.getByRole("menu", { name: "Menu contestuale" })).toBeInTheDocument();
    });

    it("keep a name the caller already translated, and text that is not in the catalog", () => {
      render(
        <>
          <MenuList items={items} onDone={() => {}} aria-label={tx("Search context")} />
          <MenuList items={items} onDone={() => {}} aria-label="feature/login-form" />
        </>,
      );
      expect(screen.getByRole("menu", { name: "Contesto di ricerca" })).toBeInTheDocument();
      expect(screen.getByRole("menu", { name: "feature/login-form" })).toBeInTheDocument();
    });
  });
});
