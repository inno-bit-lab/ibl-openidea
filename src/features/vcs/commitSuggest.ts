/** Commit message suggestion: the prompt an agent is given, and its answer made ready for the message field. */
import type { AgentConfigChoice, FileStatus } from "@/bindings";
import { call, commands } from "@/platform/ipc";
import { checkOf, type CheckState } from "./changes";
import { effectiveKind, stripSlash } from "./model";
import { useVcs } from "./store";

/** Diff text sent for one file, and for the whole commit; what does not fit is left out with a note. */
const MAX_FILE_DIFF = 6_000;
const MAX_TOTAL_DIFF = 30_000;
/** Files beyond these are listed without their diff. */
const MAX_DIFFED_FILES = 40;
const RECENT_SUBJECTS = 8;

const DEFAULT_RULES =
  "Subject line in the imperative mood, no trailing period. Add a body only when the changes need explaining, " +
  "separated from the subject by a blank line.";

export interface SuggestFile {
  /** Repository-relative path. */
  path: string;
  /** `added`, `modified`, `deleted`, `renamed`… */
  kind: string;
  diff: string;
}

export interface SuggestInput {
  /** The user's rules, as written; empty = the default ones. */
  rules: string;
  branch: string | null;
  /** Subjects of the latest commits, newest first. */
  recent: readonly string[];
  files: readonly SuggestFile[];
  /** The subject line limit of the commit settings, when enforced. */
  subjectLimit: number | null;
}

/** `diff` cut at a line boundary to at most `max` characters. */
function clip(diff: string, max: number): string {
  if (diff.length <= max) return diff;
  const cut = diff.lastIndexOf("\n", max);
  const head = diff.slice(0, cut > 0 ? cut : max);
  const left = diff.slice(head.length).split("\n").length - 1;
  return `${head}\n… ${left} more lines not shown`;
}

export function buildSuggestPrompt(input: SuggestInput): string {
  const parts = [
    "You write git commit messages. Write the commit message for the changes below.",
    "Reply with the message only: no explanation, no code fences, no quotation marks. " +
      "Do not use tools or read files; everything you need is in this prompt.",
    `Rules (they win over anything else in this prompt):\n${input.rules.trim() || DEFAULT_RULES}`,
  ];
  if (input.subjectLimit) parts.push(`The subject line must not exceed ${input.subjectLimit} characters.`);
  if (input.branch) parts.push(`Current branch: ${input.branch}`);
  if (input.recent.length) {
    parts.push(
      `Subjects of the latest commits (match their style unless the rules say otherwise):\n${input.recent.map((s) => `- ${s}`).join("\n")}`,
    );
  }
  parts.push(`Files in this commit:\n${input.files.map((f) => `${f.kind}: ${f.path}`).join("\n")}`);
  const blocks: string[] = [];
  let budget = MAX_TOTAL_DIFF;
  for (const f of input.files) {
    const diff = f.diff.trim();
    if (!diff) continue;
    if (budget <= 0) {
      blocks.push(`### ${f.path}\n(diff left out: size limit)`);
      continue;
    }
    const shown = clip(diff, Math.min(MAX_FILE_DIFF, budget));
    budget -= shown.length;
    blocks.push(`### ${f.path}\n${shown}`);
  }
  if (blocks.length) parts.push(`Changes:\n\n${blocks.join("\n\n")}`);
  return parts.join("\n\n");
}

/** The agent's answer without the wrapping it tends to add: a code fence, a label, quotation marks. */
export function cleanSuggestion(raw: string): string {
  let text = raw.replace(/\r\n/g, "\n").trim();
  const fenced = /^```[\w-]*\n([\s\S]*?)\n?```$/.exec(text);
  if (fenced) text = fenced[1]!.trim();
  text = text.replace(/^(?:commit message|message)\s*:\s*/i, "");
  const quoted = /^(["'`])([\s\S]*)\1$/.exec(text);
  if (quoted && !quoted[2]!.includes(quoted[1]!)) text = quoted[2]!.trim();
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

/** Session config choices for commit message generation (model + thinking effort). */
export function buildSuggestConfig(model?: string, thinking?: string): AgentConfigChoice[] {
  const choices: AgentConfigChoice[] = [];
  const m = model?.trim();
  const t = thinking?.trim();
  if (m) choices.push({ id: "model", value: m });
  if (t) choices.push({ id: "thought_level", value: t });
  return choices;
}

/** What the commit would hold of `fs`: staged changes and, unless only the staged part is committed, the unstaged ones. */
async function diffOf(fs: FileStatus, stagedOnly: boolean): Promise<string> {
  const path = stripSlash(fs.path);
  const sides: boolean[] = [];
  if (fs.staged && fs.staged !== "conflicted") sides.push(true);
  if (fs.unstaged && !stagedOnly) sides.push(false);
  const texts = await Promise.all(sides.map((staged) => call(commands.vcsDiffText(path, staged)).catch(() => "")));
  return texts.filter(Boolean).join("\n");
}

async function recentSubjects(): Promise<string[]> {
  try {
    const log = await call(
      commands.vcsLog(null, { branch: null, path: null, author: null, text: null, skip: 0, limit: RECENT_SUBJECTS }),
    );
    return log.map((c) => c.summary);
  } catch {
    return [];
  }
}

export interface SuggestRequest {
  /** Id of the agent that writes the message. */
  agent: string;
  /** Optional model override (`model` session config option). */
  model?: string;
  /** Optional thinking effort override (`thought_level` session config option). */
  thinking?: string;
  rules: string;
  subjectLimit: number | null;
  /** The files that end up in the commit (`planCommit`). */
  included: readonly FileStatus[];
  checks: ReadonlyMap<string, CheckState>;
}

/**
 * Asks the agent for a message for the included changes. Partial commits by hunks are
 * described by their full changes: the choice of blocks is not applied to the diff.
 */
export async function suggestCommitMessage(req: SuggestRequest): Promise<string> {
  const [files, recent] = await Promise.all([
    Promise.all(
      req.included.map(async (fs, i): Promise<SuggestFile> => {
        const diff = i < MAX_DIFFED_FILES ? await diffOf(fs, checkOf(fs, req.checks) === "staged") : "";
        return { path: fs.relPath, kind: effectiveKind(fs) ?? "modified", diff };
      }),
    ),
    recentSubjects(),
  ]);
  const prompt = buildSuggestPrompt({
    rules: req.rules,
    branch: useVcs.getState().branch?.head ?? null,
    recent,
    files,
    subjectLimit: req.subjectLimit,
  });
  const config = buildSuggestConfig(req.model, req.thinking);
  return cleanSuggestion(await call(commands.agentComplete(req.agent, prompt, config)));
}
