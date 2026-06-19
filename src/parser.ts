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
  };

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
      if (!summary.title) {
        const txt = userText(rec.message?.content);
        if (txt && looksLikeHumanPrompt(txt)) summary.title = truncate(txt);
      }
    } else if (rec.type === "assistant") {
      summary.assistantTurns++;
    }

    // Tool uses live in assistant message content blocks.
    const content = rec.message?.content;
    if (Array.isArray(content)) {
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
