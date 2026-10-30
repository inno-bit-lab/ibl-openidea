import { describe, expect, it } from "vitest";
import { buildSuggestPrompt, cleanSuggestion, type SuggestInput } from "../commitSuggest";

const base: SuggestInput = {
  rules: "",
  branch: null,
  recent: [],
  files: [{ path: "src/a.ts", kind: "modified", diff: "@@ -1 +1 @@\n-a\n+b" }],
  subjectLimit: null,
};

describe("buildSuggestPrompt", () => {
  it("passes the user's rules as written, and falls back to default ones", () => {
    const rules = "Format: [TICKET-123][TYPE] - text\nNever mention tools.";
    expect(buildSuggestPrompt({ ...base, rules })).toContain(
      `Rules (they win over anything else in this prompt):\n${rules}`,
    );
    expect(buildSuggestPrompt({ ...base, rules: "  " })).toContain("imperative mood");
  });

  it("gives the agent the branch, the recent subjects, the files and their diffs", () => {
    const prompt = buildSuggestPrompt({
      ...base,
      branch: "feature/CDXCALL-1-x",
      recent: ["[CDXCALL-1][FIX] - one", "[CDXCALL-1][FIX] - two"],
      subjectLimit: 72,
    });
    expect(prompt).toContain("Current branch: feature/CDXCALL-1-x");
    expect(prompt).toContain("- [CDXCALL-1][FIX] - one\n- [CDXCALL-1][FIX] - two");
    expect(prompt).toContain("must not exceed 72 characters");
    expect(prompt).toContain("Files in this commit:\nmodified: src/a.ts");
    expect(prompt).toContain("### src/a.ts\n@@ -1 +1 @@\n-a\n+b");
    expect(prompt).toContain("Do not use tools");
  });

  it("omits what it does not have", () => {
    const prompt = buildSuggestPrompt({ ...base, files: [{ path: "bin.png", kind: "added", diff: "" }] });
    expect(prompt).not.toContain("Current branch");
    expect(prompt).not.toContain("latest commits");
    expect(prompt).not.toContain("Changes:");
    expect(prompt).toContain("added: bin.png");
  });

  it("cuts a long diff at a line and says how much is missing", () => {
    const diff = Array.from({ length: 2000 }, (_, i) => `+line ${i}`).join("\n");
    const prompt = buildSuggestPrompt({ ...base, files: [{ path: "big.txt", kind: "added", diff }] });
    expect(prompt).toMatch(/\n… \d+ more lines not shown/);
    expect(prompt.length).toBeLessThan(8_000);
    expect(prompt).not.toContain("+line 1999");
  });

  it("leaves out the diffs that no longer fit the total budget", () => {
    const diff = Array.from({ length: 600 }, (_, i) => `+line ${i}`).join("\n");
    const files = Array.from({ length: 12 }, (_, i) => ({ path: `f${i}.txt`, kind: "added", diff }));
    const prompt = buildSuggestPrompt({ ...base, files });
    expect(prompt).toContain("### f0.txt\n+line 0");
    expect(prompt).toContain("### f11.txt\n(diff left out: size limit)");
  });
});

describe("cleanSuggestion", () => {
  it("leaves a plain message alone", () => {
    expect(cleanSuggestion("fix: handle empty list\n\nThe loop assumed a first element.")).toBe(
      "fix: handle empty list\n\nThe loop assumed a first element.",
    );
  });

  it("removes a code fence, a label and quotation marks", () => {
    expect(cleanSuggestion("```text\nfix: a\n\nbody\n```")).toBe("fix: a\n\nbody");
    expect(cleanSuggestion("```\nfix: a\n```")).toBe("fix: a");
    expect(cleanSuggestion("Commit message: fix: a")).toBe("fix: a");
    expect(cleanSuggestion('"fix: a"')).toBe("fix: a");
    expect(cleanSuggestion("`fix: a`")).toBe("fix: a");
  });

  it("keeps quotes that belong to the text, and tidies blank lines and line ends", () => {
    expect(cleanSuggestion('"a" and "b"')).toBe('"a" and "b"');
    expect(cleanSuggestion("fix: a\r\n\r\n\r\n\r\nbody\r\n")).toBe("fix: a\n\nbody");
  });
});

describe("buildSuggestConfig", () => {
  it("builds model and thought_level choices when configured and omits empty ones", async () => {
    const { buildSuggestConfig } = await import("../commitSuggest");
    expect(buildSuggestConfig()).toEqual([]);
    expect(buildSuggestConfig("  ", "")).toEqual([]);
    expect(buildSuggestConfig("gpt-5.4", "")).toEqual([{ id: "model", value: "gpt-5.4" }]);
    expect(buildSuggestConfig("claude-opus-4-7", "high")).toEqual([
      { id: "model", value: "claude-opus-4-7" },
      { id: "thought_level", value: "high" },
    ]);
  });
});
