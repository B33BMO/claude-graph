import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import os from "node:os";
import type {
  RawRecord,
  ContentBlock,
  SessionSummary,
  FileOps,
} from "./types.js";

const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"]);

function emptyOps(): FileOps {
  return { reads: 0, writes: 0, edits: 0 };
}

/** Human-friendly label for a cwd, e.g. ".../projects/claude-graph" -> "claude-graph". */
export function projectLabel(cwd?: string): string {
  if (!cwd) return "(unknown)";
  return path.basename(cwd) || cwd;
}

/** Make an absolute file_path readable: relative to cwd when possible, else ~/… */
export function displayPath(file: string, cwd?: string): string {
  let p = file;
  if (cwd && p.startsWith(cwd + path.sep)) p = p.slice(cwd.length + 1);
  else {
    const home = os.homedir();
    if (p.startsWith(home + path.sep)) p = "~/" + p.slice(home.length + 1);
  }
  return p;
}

/** Pull plain text out of a user record's content (string or block array). */
function userText(content: string | ContentBlock[] | undefined): string | null {
  if (typeof content === "string") return content.trim() || null;
  if (Array.isArray(content)) {
    const parts = content
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text!.trim())
      .filter(Boolean);
    if (parts.length) return parts.join(" ");
  }
  return null;
}

// Wrapped/system prompts we don't want to treat as the session's title.
function looksLikeHumanPrompt(text: string): boolean {
  const t = text.trimStart();
  if (!t) return false;
  if (t.startsWith("<")) return false; // <system-reminder>, <command-name>, etc.
  if (t.startsWith("[Request interrupted")) return false;
  if (t.startsWith("Caveat:")) return false;
  return true;
}

function truncate(s: string, n = 80): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > n ? clean.slice(0, n - 1) + "…" : clean;
}

const MAX_PROMPTS = 25;
const MAX_DECISIONS = 8;

// Lines that look like a choice or a rationale — used to surface "why" later.
// Heuristic by design: it favors recall over precision, so output is labeled.
const DECISION_RE =
  /\b(i'?ll|i'?m going to|let me|let'?s|i should|we should|decided to|going with|go with|instead of|because|root cause|the (?:issue|problem|fix|bug|culprit) (?:is|was)|the plan|the approach|turns out|key (?:insight|point)|the reason|better to)\b/i;

/** Pull short decision/rationale lines out of a text or thinking block. */
function extractDecisions(text: string): string[] {
  const out: string[] = [];
  const chunks = text.split(/\n+|(?<=[.!])\s+/);
  for (const raw of chunks) {
    const s = raw.replace(/\s+/g, " ").trim().replace(/^[-*>#\s]+/, "");
    if (s.length < 15 || s.length > 180) continue;
    if (s.endsWith("?")) continue;
    if (DECISION_RE.test(s)) out.push(s);
  }
  return out;
}

/** Parse one transcript file into a SessionSummary. */
export async function parseTranscript(filePath: string): Promise<SessionSummary | null> {
  const summary: SessionSummary = {
    sessionId: path.basename(filePath, ".jsonl"),
    filePath,
    isSidechain: false,
    title: "",
    userTurns: 0,
    assistantTurns: 0,
    toolCounts: {},
    files: new Map(),
    tasks: [],
    prompts: [],
    decisions: [],
  };
  const seenPrompts = new Set<string>();
  const seenDecisions = new Set<string>();

  let sawAny = false;
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let rec: RawRecord;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    sawAny = true;

    if (rec.sessionId) summary.sessionId = rec.sessionId;
    if (rec.cwd && !summary.cwd) {
      summary.cwd = rec.cwd;
      summary.project = projectLabel(rec.cwd);
    }
    if (rec.gitBranch && !summary.gitBranch) summary.gitBranch = rec.gitBranch;
    if (rec.version) summary.version = rec.version;
    if (rec.isSidechain) summary.isSidechain = true;
    if (rec.timestamp) {
      if (!summary.firstTs) summary.firstTs = rec.timestamp;
      summary.lastTs = rec.timestamp;
    }

    if (rec.type === "user") {
      summary.userTurns++;
      const txt = userText(rec.message?.content);
      if (txt && looksLikeHumanPrompt(txt)) {
        if (!summary.title) summary.title = truncate(txt);
        const p = truncate(txt, 140);
        if (summary.prompts.length < MAX_PROMPTS && !seenPrompts.has(p)) {
          seenPrompts.add(p);
          summary.prompts.push(p);
        }
      }
    } else if (rec.type === "assistant") {
      summary.assistantTurns++;
    }

    const content = rec.message?.content;
    if (Array.isArray(content)) {
      // Decisions/rationale from assistant prose and reasoning.
      for (const b of content) {
        if (summary.decisions.length >= MAX_DECISIONS) break;
        const prose = b.type === "text" ? b.text : b.type === "thinking" ? b.thinking : undefined;
        if (!prose) continue;
        for (const d of extractDecisions(prose)) {
          if (summary.decisions.length >= MAX_DECISIONS) break;
          if (seenDecisions.has(d)) continue;
          seenDecisions.add(d);
          summary.decisions.push(d);
        }
      }
      // Tool uses live in assistant message content blocks.
      for (const b of content) {
        if (b.type !== "tool_use" || !b.name) continue;
        const name = b.name;
        summary.toolCounts[name] = (summary.toolCounts[name] ?? 0) + 1;
        const input = (b.input ?? {}) as Record<string, unknown>;

        if (FILE_TOOLS.has(name) && typeof input.file_path === "string") {
          const fp = input.file_path;
          const ops = summary.files.get(fp) ?? emptyOps();
          if (name === "Read") ops.reads++;
          else if (name === "Write") ops.writes++;
          else ops.edits++;
          summary.files.set(fp, ops);
        } else if (name === "TaskCreate" && typeof input.subject === "string") {
          summary.tasks.push(input.subject.trim());
        }
      }
    }
  }

  if (!sawAny) return null;
  if (!summary.title) summary.title = `session ${summary.sessionId.slice(0, 8)}`;
  return summary;
}
