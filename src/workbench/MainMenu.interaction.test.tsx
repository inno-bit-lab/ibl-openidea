import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands, type Settings } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { registerActions } from "@/platform/actions";
import { setLocale } from "@/platform/i18n";
import { MainMenu } from "./MainMenu";

let available = 500;
let resize: () => void;
const savedProject = useProject.getState();
let dispose: () => void;
const setStyle = (style: string) =>
  useProject.setState({ settings: { appearance: { mainMenuStyle: style } } as Settings });
const alt = () => {
  fireEvent.keyDown(window, { key: "Alt", altKey: true });
  fireEvent.keyUp(window, { key: "Alt" });
};

beforeEach(() => {
  available = 500;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: () => void) {}
      observe(element: HTMLElement) {
        if (element.className.includes("mainMenuSlot")) resize = this.callback;
      }
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => available);
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(300);
  vi.spyOn(commands, "menuModel").mockResolvedValue([
    {
      kind: "submenu",
      id: "file",
      label: "File",
      children: [{ kind: "action", id: "test.open", label: "Open", hint: null, arg: null }],
    },
    {
      kind: "submenu",
      id: "edit",
      label: "Edit",
      children: [{ kind: "action", id: "test.undo", label: "Undo", hint: null, arg: null }],
    },
  ]);
  dispose = registerActions([
    { id: "test.open", title: "Open", category: "Test", run: vi.fn() },
    { id: "test.undo", title: "Undo", category: "Test", run: vi.fn() },
  ]);
  setStyle("hamburger");
});
afterEach(() => {
  dispose();
  useProject.setState(savedProject);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const titles = () => within(screen.getByRole("menubar"));

describe("main menu presentation", () => {
  it("keeps the hamburger default, expanding on click and collapsing on Escape", async () => {
    const expanded = vi.fn();
    render(<MainMenu onExpandedChange={expanded} />);
    expect(screen.queryByRole("menubar")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Main Menu" }));
    expect(await screen.findByRole("menu", { name: "File" })).toBeInTheDocument();
    expect(expanded).toHaveBeenLastCalledWith(true);
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(await screen.findByRole("menu", { name: "Edit" })).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menubar")).toBeNull();
    expect(screen.getByRole("button", { name: "Main Menu" })).toBeInTheDocument();
    expect(expanded).toHaveBeenLastCalledWith(false);
    alt();
    expect(await screen.findByRole("menu", { name: "File" })).toBeInTheDocument();
  });

  it("shows merged titles, switches menus with arrows, and retains titles after dismissal or an action", async () => {
    setStyle("merged");
    const expanded = vi.fn();
    render(
      <>
        <MainMenu onExpandedChange={expanded} />
        <button>Toolbar control</button>
      </>,
    );
    await screen.findByRole("menubar");
    expect(screen.queryByRole("button", { name: "Main Menu" })).toBeNull();
    fireEvent.click(titles().getByRole("menuitem", { name: "File" }));
    expect(await screen.findByRole("menu", { name: "File" })).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(await screen.findByRole("menu", { name: "Edit" })).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(await screen.findByRole("menu", { name: "File" })).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("menubar")).toBeInTheDocument();
    fireEvent.click(titles().getByRole("menuitem", { name: "Edit" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Undo" }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("menubar")).toBeInTheDocument();
    fireEvent.click(titles().getByRole("menuitem", { name: "File" }));
    fireEvent.pointerDown(screen.getByRole("button", { name: "Toolbar control" }));
    await act(() => new Promise((resolve) => setTimeout(resolve)));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(expanded).not.toHaveBeenCalledWith(true);
  });

  it.each(["hamburger", "merged"])(
    "%s switches on title clicks without an outside dismissal, then closes for toolbar clicks",
    async (style) => {
      setStyle(style);
      render(
        <>
          <MainMenu />
          <button>Toolbar control</button>
        </>,
      );
      if (style === "hamburger") fireEvent.click(screen.getByRole("button", { name: "Main Menu" }));
      await screen.findByRole("menubar");
      if (style === "merged") fireEvent.click(titles().getByRole("menuitem", { name: "File" }));
      const edit = titles().getByRole("menuitem", { name: "Edit" });
      fireEvent.pointerDown(edit);
      fireEvent.click(edit);
      await act(() => new Promise((resolve) => setTimeout(resolve)));
      expect(screen.getByRole("menu", { name: "Edit" })).toBeInTheDocument();
      fireEvent.pointerDown(screen.getByRole("button", { name: "Toolbar control" }));
      await act(() => new Promise((resolve) => setTimeout(resolve)));
      expect(screen.queryByRole("menu")).toBeNull();
    },
  );

  it("focuses the merged titles with lone Alt and navigates before opening", async () => {
    setStyle("merged");
    render(
      <>
        <button>Editor</button>
        <MainMenu />
      </>,
    );
    await screen.findByRole("menubar");
    const editor = screen.getByRole("button", { name: "Editor" });
    editor.focus();
    alt();
    expect(titles().getByRole("menuitem", { name: "File" })).toHaveFocus();
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(titles().getByRole("menuitem", { name: "Edit" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(await screen.findByRole("menu", { name: "Edit" })).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(titles().getByRole("menuitem", { name: "Edit" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(editor).toHaveFocus();
  });

  it("returns focus on a second lone Alt", async () => {
    setStyle("merged");
    render(
      <>
        <button>Editor</button>
        <MainMenu />
      </>,
    );
    await screen.findByRole("menubar");
    const editor = screen.getByRole("button", { name: "Editor" });
    editor.focus();
    alt();
    expect(titles().getByRole("menuitem", { name: "File" })).toHaveFocus();
    alt();
    expect(editor).toHaveFocus();
    alt();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(editor).toHaveFocus();
  });

  it("does not reopen a title's menu after the titles collapse and return", async () => {
    setStyle("merged");
    render(<MainMenu />);
    await screen.findByRole("menubar");
    fireEvent.click(titles().getByRole("menuitem", { name: "Edit" }));
    expect(await screen.findByRole("menu", { name: "Edit" })).toBeInTheDocument();
    act(() => {
      available = 100;
      resize();
    });
    expect(screen.queryByRole("menu")).toBeNull();
    act(() => {
      available = 500;
      resize();
    });
    expect(screen.getByRole("menubar")).toBeInTheDocument();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("falls back to a hamburger popup when narrow and restores titles when space returns", async () => {
    available = 100;
    setStyle("merged");
    const expanded = vi.fn();
    render(<MainMenu onExpandedChange={expanded} />);
    await act(async () => {});
    expect(screen.queryByRole("menubar")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Main Menu" }));
    const root = await screen.findByRole("menu", { name: "Main Menu" });
    fireEvent.click(within(root).getByRole("menuitem", { name: /File/ }));
    expect(await screen.findByRole("menuitem", { name: "Open" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Open" }));
    expect(screen.getByRole("button", { name: "Main Menu" })).toBeInTheDocument();
    expect(expanded).not.toHaveBeenCalledWith(true);
    act(() => {
      available = 500;
      resize();
    });
    expect(screen.getByRole("menubar")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Main Menu" })).toBeNull();
    act(() => {
      available = 100;
      resize();
    });
    expect(screen.queryByRole("menubar")).toBeNull();
    expect(screen.getByRole("button", { name: "Main Menu" })).toBeInTheDocument();
  });

  it("applies the setting immediately and restores toolbar visibility when switching from an expanded hamburger", async () => {
    const expanded = vi.fn();
    render(<MainMenu onExpandedChange={expanded} />);
    fireEvent.click(screen.getByRole("button", { name: "Main Menu" }));
    await screen.findByRole("menu");
    expect(expanded).toHaveBeenLastCalledWith(true);
    act(() => setStyle("merged"));
    await screen.findByRole("menubar");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(expanded).toHaveBeenLastCalledWith(false);
    act(() => setStyle("hamburger"));
    expect(screen.queryByRole("menubar")).toBeNull();
    expect(screen.getByRole("button", { name: "Main Menu" })).toBeInTheDocument();
  });

  // From rev-codex's PR #21 review witness: focus must not fall to the body when the presentation switches.
  it.each(["title", "submenu", "fallback"])("keeps focus across a presentation switch from %s", async (from) => {
    available = from === "fallback" ? 100 : 500;
    setStyle("merged");
    render(
      <>
        <button>Editor</button>
        <MainMenu />
      </>,
    );
    await act(async () => {});
    const editor = screen.getByRole("button", { name: "Editor" });
    editor.focus();
    alt();
    if (from === "submenu") {
      fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
      await screen.findByRole("menu", { name: "File" });
      expect(screen.getByRole("menuitem", { name: "Open" })).toHaveFocus();
    } else if (from === "fallback") {
      await screen.findByRole("menu", { name: "Main Menu" });
      expect(document.activeElement).not.toBe(document.body);
    } else {
      expect(titles().getByRole("menuitem", { name: "File" })).toHaveFocus();
    }
    act(() => {
      available = from === "fallback" ? 500 : 100;
      resize();
    });
    expect(screen.queryByRole("menu")).toBeNull();
    const targets =
      from === "fallback"
        ? [editor, ...titles().getAllByRole("menuitem")]
        : [editor, screen.getByRole("button", { name: "Main Menu" })];
    expect(targets).toContain(document.activeElement);
  });

  it("moves focus from a collapsing title to the hamburger when no earlier focus is known", async () => {
    setStyle("merged");
    render(<MainMenu />);
    await screen.findByRole("menubar");
    titles().getByRole("menuitem", { name: "Edit" }).focus();
    act(() => {
      available = 100;
      resize();
    });
    expect(screen.getByRole("button", { name: "Main Menu" })).toHaveFocus();
  });

  it("leaves focus on an outside control when the titles collapse", async () => {
    setStyle("merged");
    render(
      <>
        <button>Editor</button>
        <MainMenu />
      </>,
    );
    await screen.findByRole("menubar");
    const editor = screen.getByRole("button", { name: "Editor" });
    editor.focus();
    act(() => {
      available = 100;
      resize();
    });
    expect(editor).toHaveFocus();
    expect(screen.getByRole("button", { name: "Main Menu" })).not.toHaveFocus();
  });
});

describe("main menu names in Italian", () => {
  beforeEach(async () => {
    await act(async () => {
      await setLocale("it");
    });
  });
  afterEach(async () => {
    await act(async () => {
      await setLocale("en");
    });
  });

  it("names an open menu by its visible title, never translating it twice", async () => {
    vi.spyOn(commands, "menuModel").mockResolvedValue([
      {
        kind: "submenu",
        id: "build",
        label: "Build",
        children: [{ kind: "action", id: "test.open", label: "Open", hint: null, arg: null }],
      },
    ]);
    setStyle("merged");
    render(<MainMenu />);
    await screen.findByRole("menubar");
    // The glossary keeps Build as the menu name; the text catalog's "Build" is the action, "Compila".
    fireEvent.click(titles().getByRole("menuitem", { name: "Build" }));
    expect(await screen.findByRole("menu", { name: "Build" })).toBeInTheDocument();
    expect(screen.queryByRole("menu", { name: "Compila" })).toBeNull();
  });
});
