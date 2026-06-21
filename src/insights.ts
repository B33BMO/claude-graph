import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Graph, GraphNode } from "./types.js";

// fs-touching companions to query.ts. Same contract — terse string out, a few
// hundred tokens — but these look at the real world too: the memory directory,
// whether tracked files still exist on disk, and how big they are. Kept separate
// so query.ts stays a pure graph→string transform.

const PROJECTS_ROOT = path.join(os.homedir(), ".claude", "projects");

function header(graph: Graph): string {
  return `# claude-graph · ${graph.scope}`;
}

function day(ts: unknown): string {
  if (typeof ts !== "string") return "????-??-??";
  const d = new Date(ts);
  return isNaN(d.getTime()) ? "????-??-??" : d.toISOString().slice(0, 10);
}

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? (v as string[]) : [];
}
function decisionsOf(node: GraphNode): string[] {
  return strArr(node.meta?.decisions);
}
function promptsOf(node: GraphNode): string[] {
  return strArr(node.meta?.prompts);
}
function sessionsOnly(graph: Graph): GraphNode[] {
  return graph.nodes.filter((n) => n.type === "session");
}
function filesOnly(graph: Graph): GraphNode[] {
  return graph.nodes.filter((n) => n.type === "file");
}

/** ~chars→tokens. The usual back-of-envelope: 4 chars ≈ 1 token. */
function tokens(bytes: number): number {
  return Math.round(bytes / 4);
}
function ktok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

/** The memory dir Claude Code uses for a given project cwd. */
export function memoryDir(cwd: string): string {
  const enc = cwd.replace(/[^A-Za-z0-9]/g, "-");
  return path.join(PROJECTS_ROOT, enc, "memory");
}

// ---------------------------------------------------------------------------
// memories — mine durable facts/decisions out of session history
// ---------------------------------------------------------------------------

// Decisions worth *remembering* are the ones still true next session: prefs,
// conventions, standing choices. High-precision phrasing only — bare "always"
// matches "isn't always available", so we require it to be doing real work.
const DURABLE_RE =
  /\b(i (?:prefer|always|never|like to|want you to|usually)|we (?:use|prefer|always|never|don'?t|should)|prefer(?:s|red)? (?:to|that|using|not)|by default|from now on|going forward|make sure (?:to|you)|remember to|always (?:use|make|keep|run|prefer|include|avoid)|never (?:use|commit|push|do|run)|don'?t (?:ever|use|commit|push|forget)|the (?:convention|standard|rule|goal|plan) is|we'?re building|i'?m (?:building|working on|a )|my (?:stack|setup|role|environment|preference) is|should (?:always|never))\b/i;

// ...and drop the ones that were only true for one bug/turn.
const EPHEMERAL_RE =
  /\b(root cause|turns out|the (?:bug|issue|problem|culprit|error) (?:is|was)|the fix (?:is|was)|let me|let'?s (?:check|look|run|try|see))\b/i;

// Lines that open with an action verb are this-turn intent, not a standing fact.
const LEADING_ACTION_RE =
  /^(i'?ll|i'?m going to|i'?m gonna|let me|let'?s|i should|i need to|i'?ve|first|now|next|then|going to|gonna)\b/i;

function isDurable(text: string): boolean {
  const t = text.trim();
  if (LEADING_ACTION_RE.test(t)) return false;
  if (EPHEMERAL_RE.test(t)) return false;
  return DURABLE_RE.test(t);
}

const STOP = new Set(
  ("the a an to of for and or but in on at by we i you it is was be will should " +
    "going go with use using used instead because so that this these those our my " +
    "me your they them their make sure remember want wants need needs do don't")
    .split(/\s+/),
);

function slugify(text: string, max = 6): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
  return (words.slice(0, max).join("-") || "memory").slice(0, 60);
}

/** Coarse grouping key so near-identical decisions across sessions collapse. */
function normKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .slice(0, 6)
    .sort()
    .join(" ");
}

function guessType(text: string): "user" | "feedback" | "project" | "reference" {
  if (/\bhttps?:\/\//i.test(text)) return "reference";
  if (/\bi'?m (?:a |an )|my (?:role|name|stack|setup|environment)\b/i.test(text)) return "user";
  if (
    /\b(prefer|always|never|don'?t|should|make sure|remember to|want(?:s)? (?:me )?to|convention|standard|by default|from now on)\b/i.test(
      text,
    )
  )
    return "feedback";
  return "project";
}

interface MemCandidate {
  text: string;
  type: ReturnType<typeof guessType>;
  slug: string;
  sessions: { label: string; date: string }[];
  recurrence: number;
}

/** Tokens of an existing memory body, for overlap-based dedup. */
function memoryTokens(body: string): Set<string> {
  return new Set(
    body
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOP.has(w)),
  );
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const w of a) if (b.has(w)) hit++;
  return hit / Math.min(a.size, b.size);
}

/** Read existing memory files (excluding MEMORY.md / candidates) as token sets. */
function existingMemories(dir: string): Set<string>[] {
  const out: Set<string>[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (!name.endsWith(".md") || name === "MEMORY.md") continue;
    try {
      const body = fs.readFileSync(path.join(dir, name), "utf8");
      out.push(memoryTokens(body));
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

function renderStub(c: MemCandidate): string {
  const src = c.sessions
    .slice(0, 3)
    .map((s) => `${s.label} (${s.date})`)
    .join("; ");
  const extra =
    c.type === "feedback" || c.type === "project"
      ? `\n\n**Why:** _<fill in the rationale>_\n**How to apply:** _<fill in>_`
      : "";
  return [
    "```markdown",
    "---",
    `name: ${c.slug}`,
    `description: ${c.text.length > 90 ? c.text.slice(0, 89) + "…" : c.text}`,
    "metadata:",
    `  type: ${c.type}`,
    "---",
    "",
    c.text,
    extra,
    "",
    `Source session(s): ${src}${c.recurrence > 1 ? `  ·  recurred in ${c.recurrence} sessions` : ""}`,
    "```",
  ].join("\n");
}

export interface InsightOptions {
  limit?: number;
  write?: boolean;
  memory?: boolean;
  json?: boolean;
  promote?: boolean;
  root: string | null; // single resolved project cwd, or null if ambiguous
}

function asJson(data: unknown): string {
  return JSON.stringify(data, null, 2) + "\n";
}

/** Pull `name` and `description` out of a candidate/memory file's frontmatter. */
function frontmatter(body: string): { name: string; description: string } {
  const name = /^name:\s*(.+)$/m.exec(body)?.[1]?.trim() ?? "";
  const description = /^description:\s*(.+)$/m.exec(body)?.[1]?.trim() ?? "";
  return { name, description };
}

/**
 * Promote reviewed candidate stubs into real memories: move
 * `<memory>/candidates/<slug>.md` up to `<memory>/<slug>.md` and add a
 * `MEMORY.md` index line. `term` is a space-separated slug list, or "all".
 */
function promoteCandidates(graph: Graph, root: string | null, term: string): string {
  if (!root)
    return header(graph) + "\n--promote needs a single project. Run without --all/--project.\n";
  const dir = memoryDir(root);
  const candDir = path.join(dir, "candidates");
  let staged: string[];
  try {
    staged = fs.readdirSync(candDir).filter((n) => n.endsWith(".md"));
  } catch {
    return (
      header(graph) +
      `\nNo candidates to promote. Run 'memories --write' first to stage some.\n`
    );
  }
  const want = term.trim().toLowerCase();
  const slugs = !want || want === "all" ? staged.map((n) => n.replace(/\.md$/, "")) : term.trim().split(/\s+/);
  if (!want)
    return (
      header(graph) +
      `\n${staged.length} candidate(s) staged. Run 'memories --promote all' or '--promote <slug>' to keep them:\n` +
      staged.map((n) => `- ${n.replace(/\.md$/, "")}`).join("\n") +
      "\n"
    );

  const out: string[] = [header(graph), "promote", ""];
  const promoted: string[] = [];
  const indexLines: string[] = [];
  for (const slug of slugs) {
    const src = path.join(candDir, `${slug}.md`);
    if (!fs.existsSync(src)) {
      out.push(`- ${slug}: no such candidate (skipped)`);
      continue;
    }
    const dest = path.join(dir, `${slug}.md`);
    if (fs.existsSync(dest)) {
      out.push(`- ${slug}: a memory with this name already exists (skipped)`);
      continue;
    }
    const body = fs.readFileSync(src, "utf8");
    fs.writeFileSync(dest, body);
    fs.rmSync(src);
    const { name, description } = frontmatter(body);
    indexLines.push(`- [${name || slug}](${slug}.md) — ${description}`);
    promoted.push(slug);
  }

  if (promoted.length) appendMemoryIndex(dir, indexLines);
  // Tidy: drop the candidates dir if we emptied it.
  try {
    if (!fs.readdirSync(candDir).length) fs.rmdirSync(candDir);
  } catch {
    /* leave it */
  }

  out.push(`Promoted ${promoted.length} memory(ies)${promoted.length ? ":" : "."}`);
  for (const s of promoted) out.push(`- ${s}.md  (+ MEMORY.md line)`);
  out.push("", "Open the new files and fill in any **Why:** / **How to apply:** blanks.");
  return out.join("\n").trimEnd() + "\n";
}

/** Create MEMORY.md if missing and append index lines that aren't already there. */
function appendMemoryIndex(dir: string, lines: string[]): void {
  const file = path.join(dir, "MEMORY.md");
  let current = "";
  try {
    current = fs.readFileSync(file, "utf8");
  } catch {
    current = "# Memory index\n\n";
  }
  if (!current.trim()) current = "# Memory index\n\n";
  const fresh = lines.filter((l) => !current.includes(l));
  if (!fresh.length) return;
  const sep = current.endsWith("\n") ? "" : "\n";
  fs.writeFileSync(file, current + sep + fresh.join("\n") + "\n");
}

export function memories(graph: Graph, term: string, opts: InsightOptions): string {
  if (opts.promote) return promoteCandidates(graph, opts.root, term);
  const limit = opts.limit ?? 8;
  const out: string[] = [header(graph), term ? `memories: "${term}"` : "memory candidates", ""];

  // Gather durable decisions with their originating session, newest first.
  let sessions = sessionsOnly(graph);
  if (term) {
    const t = term.toLowerCase();
    sessions = sessions.filter(
      (s) =>
        s.label.toLowerCase().includes(t) ||
        decisionsOf(s).some((d) => d.toLowerCase().includes(t)),
    );
  }
  sessions.sort((a, b) => String(b.meta.lastTs).localeCompare(String(a.meta.lastTs)));

  const byKey = new Map<string, MemCandidate>();
  const add = (text: string, label: string, date: string) => {
    if (!isDurable(text)) return;
    const key = normKey(text);
    if (!key) return;
    const existing = byKey.get(key);
    if (existing) {
      existing.recurrence++;
      if (!existing.sessions.some((x) => x.label === label))
        existing.sessions.push({ label, date });
    } else {
      byKey.set(key, {
        text,
        type: guessType(text),
        slug: slugify(text),
        sessions: [{ label, date }],
        recurrence: 1,
      });
    }
  };
  for (const s of sessions) {
    const date = day(s.meta.lastTs);
    // Claude's decisions ("we should…") and the user's own prompts ("I prefer…")
    // — the latter is where standing preferences actually live.
    for (const d of decisionsOf(s)) add(d, s.label, date);
    for (const p of promptsOf(s)) add(p, s.label, date);
  }

  let candidates = [...byKey.values()].sort(
    (a, b) =>
      b.recurrence - a.recurrence ||
      String(b.sessions[0].date).localeCompare(String(a.sessions[0].date)),
  );

  // Drop candidates already covered by an existing memory file.
  const dir = opts.root ? memoryDir(opts.root) : null;
  let skipped = 0;
  if (dir) {
    const have = existingMemories(dir);
    if (have.length) {
      candidates = candidates.filter((c) => {
        const ct = memoryTokens(c.text);
        const dup = have.some((h) => overlap(ct, h) > 0.6);
        if (dup) skipped++;
        return !dup;
      });
    }
  }

  candidates = candidates.slice(0, limit);

  if (opts.json) {
    return asJson({
      scope: graph.scope,
      count: candidates.length,
      skipped,
      candidates: candidates.map((c) => ({
        slug: c.slug,
        type: c.type,
        text: c.text,
        recurrence: c.recurrence,
        sessions: c.sessions,
      })),
    });
  }

  if (!candidates.length) {
    out.push(
      skipped
        ? `No new candidates (${skipped} already covered by existing memories).`
        : "No durable decisions found in scope. Try a broader scope (--all / --project) or different terms.",
    );
    out.push("", "_decisions are heuristic — extracted from prose & reasoning; you curate what's worth keeping._");
    return out.join("\n") + "\n";
  }

  // --write: stage stubs as files for review (never touches real memories).
  if (opts.write) {
    if (!dir)
      return (
        header(graph) +
        "\n--write needs a single project. Run without --all/--project (or cd into the project).\n"
      );
    const candDir = path.join(dir, "candidates");
    fs.mkdirSync(candDir, { recursive: true });
    const written: string[] = [];
    for (const c of candidates) {
      const file = path.join(candDir, `${c.slug}.md`);
      if (fs.existsSync(file)) continue; // don't clobber a prior review
      const stub = renderStub(c).replace(/^```markdown\n|\n```$/g, "");
      fs.writeFileSync(file, stub + "\n");
      written.push(path.relative(dir, file));
    }
    out.push(`Wrote ${written.length} candidate(s) to ${path.relative(os.homedir(), candDir)}/:`);
    for (const w of written) out.push(`- ${w}`);
    if (skipped) out.push("", `(skipped ${skipped} already covered by existing memories)`);
    out.push("", "Review them, then move the keepers up into the memory dir and add a MEMORY.md line each.");
    return out.join("\n") + "\n";
  }

  out.push(`${candidates.length} candidate(s)${skipped ? ` · ${skipped} already covered` : ""}. Review & save the keepers:`, "");
  for (const c of candidates) {
    out.push(renderStub(c), "");
  }
  out.push("_heuristic — extracted from prose & reasoning. Save the durable ones; drop the rest._");
  return out.join("\n").trimEnd() + "\n";
}

// ---------------------------------------------------------------------------
// stale — graph/memory facts that point at things no longer on disk
// ---------------------------------------------------------------------------

function significant(f: GraphNode): boolean {
  const edits = Number(f.meta.edits) || 0;
  const writes = Number(f.meta.writes) || 0;
  const sessions = Number(f.meta.sessions) || 0;
  return edits + writes > 0 || sessions >= 2;
}

interface MemoryStale {
  note?: string;
  files: number;
  danglingLinks: { file: string; target: string }[];
  danglingPaths: { file: string; ref: string }[];
}

export function stale(graph: Graph, opts: InsightOptions): string {
  const tracked = filesOnly(graph).filter((f) => typeof f.meta.path === "string" && significant(f));
  const missingNodes: GraphNode[] = [];
  let present = 0;
  for (const f of tracked) {
    if (fs.existsSync(f.meta.path as string)) present++;
    else missingNodes.push(f);
  }
  missingNodes.sort(
    (a, b) =>
      (Number(b.meta.edits) || 0) + (Number(b.meta.writes) || 0) -
      ((Number(a.meta.edits) || 0) + (Number(a.meta.writes) || 0)),
  );
  const missing = missingNodes.map((f) => ({
    label: f.label,
    path: f.meta.path as string,
    edits: Number(f.meta.edits) || 0,
    writes: Number(f.meta.writes) || 0,
    sessions: Number(f.meta.sessions) || 0,
  }));
  const mem = opts.memory ? memoryStaleData(opts.root) : undefined;

  if (opts.json) {
    return asJson({
      scope: graph.scope,
      tracked: tracked.length,
      present,
      missing,
      memory: mem,
    });
  }

  const out: string[] = [header(graph), "stale check", ""];
  if (missing.length) {
    out.push(`## missing files — worked on, not on disk now (${missing.length})`);
    for (const m of missing.slice(0, opts.limit ?? 20)) {
      out.push(`- ${m.label}  [${m.edits}e/${m.writes}w · ${m.sessions} sess]  → renamed or deleted?`);
    }
    out.push("");
  }
  out.push(`${present}/${tracked.length} tracked files still present.`);
  if (mem) out.push("", ...renderMemoryStale(mem));
  out.push("", "_missing files are usually renames/deletes — refresh any memory or note that still points at them._");
  return out.join("\n").trimEnd() + "\n";
}

/** Verify memory [[links]] resolve and referenced file paths still exist. */
function memoryStaleData(root: string | null): MemoryStale {
  const empty = { files: 0, danglingLinks: [], danglingPaths: [] };
  if (!root) return { ...empty, note: "no single project in scope — run without --all/--project" };
  const dir = memoryDir(root);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((n) => n.endsWith(".md") && n !== "MEMORY.md");
  } catch {
    return { ...empty, note: `no memory dir yet at ${path.relative(os.homedir(), dir)}` };
  }
  const names = new Set(files.map((n) => n.replace(/\.md$/, "")));
  const danglingLinks: { file: string; target: string }[] = [];
  const danglingPaths: { file: string; ref: string }[] = [];
  for (const name of files) {
    let body: string;
    try {
      body = fs.readFileSync(path.join(dir, name), "utf8");
    } catch {
      continue;
    }
    for (const m of body.matchAll(/\[\[([^\]]+)\]\]/g)) {
      const target = m[1].trim();
      if (!names.has(target)) danglingLinks.push({ file: name, target });
    }
    // Repo-relative or ~/absolute paths mentioned in the memory body.
    for (const m of body.matchAll(/(?:^|\s)(~?\/?[\w./-]+\.[a-z]{1,4})\b/gi)) {
      const ref = m[1];
      if (!ref.includes("/") || ref.endsWith(".md")) continue;
      const abs = ref.startsWith("~")
        ? path.join(os.homedir(), ref.slice(1))
        : ref.startsWith("/")
          ? ref
          : path.join(root, ref);
      if (!fs.existsSync(abs)) danglingPaths.push({ file: name, ref });
    }
  }
  return { files: files.length, danglingLinks, danglingPaths };
}

function renderMemoryStale(m: MemoryStale): string[] {
  if (m.note) return ["## memory", `(${m.note})`];
  const lines = [`## memory (${m.files} files)`];
  if (m.danglingLinks.length) {
    lines.push(`dangling [[links]] (${m.danglingLinks.length}):`);
    for (const d of m.danglingLinks.slice(0, 15)) lines.push(`- ${d.file} → [[${d.target}]]`);
  }
  if (m.danglingPaths.length) {
    lines.push(`referenced paths not found (${m.danglingPaths.length}):`);
    for (const d of m.danglingPaths.slice(0, 15)) lines.push(`- ${d.file} → ${d.ref}`);
  }
  if (!m.danglingLinks.length && !m.danglingPaths.length)
    lines.push("all links & referenced paths resolve. ✓");
  return lines;
}

// ---------------------------------------------------------------------------
// cost — where the query-don't-read discipline pays off
// ---------------------------------------------------------------------------

export function cost(graph: Graph, opts: InsightOptions): string {
  const limit = opts.limit ?? 12;
  const out: string[] = [header(graph), "context cost (≈ tokens, rough)", ""];

  const rows: { f: GraphNode; size: number; reads: number; reread: number }[] = [];
  for (const f of filesOnly(graph)) {
    const p = f.meta.path;
    if (typeof p !== "string") continue;
    let size = 0;
    try {
      size = fs.statSync(p).size;
    } catch {
      continue; // gone — that's `stale`'s job, not cost's
    }
    const reads = Number(f.meta.reads) || 0;
    const edits = Number(f.meta.edits) || 0;
    const writes = Number(f.meta.writes) || 0;
    const touches = reads + edits + writes;
    if (!touches) continue;
    rows.push({ f, size, reads: touches, reread: tokens(size) * touches });
  }

  rows.sort((a, b) => b.reread - a.reread);
  const top = rows.slice(0, limit);

  const heaviest = sessionsOnly(graph)
    .map((s) => {
      const tc = (s.meta.toolCounts ?? {}) as Record<string, number>;
      const ops = Object.values(tc).reduce((n, v) => n + (Number(v) || 0), 0);
      return { date: day(s.meta.lastTs), ops, label: s.label };
    })
    .sort((a, b) => b.ops - a.ops)
    .slice(0, Math.min(limit, 6));

  if (opts.json) {
    return asJson({
      scope: graph.scope,
      totalFiles: rows.length,
      totalTokens: rows.reduce((n, r) => n + r.reread, 0),
      files: top.map((r) => ({
        label: r.f.label,
        path: r.f.meta.path,
        sizeTokens: tokens(r.size),
        opens: r.reads,
        rereadTokens: r.reread,
      })),
      heaviestSessions: heaviest,
    });
  }

  if (top.length) {
    out.push("## costliest files (size × times opened)");
    for (const r of top) {
      out.push(
        `- ${r.f.label}  ~${ktok(tokens(r.size))} tok × ${r.reads} = ~${ktok(r.reread)} tok` +
          `  → 'file ${path.basename(r.f.label)}' before re-reading`,
      );
    }
    const total = rows.reduce((n, r) => n + r.reread, 0);
    out.push("", `Σ over ${rows.length} tracked files ≈ ${ktok(total)} tok of file-open traffic.`);
    out.push("");
  } else {
    out.push("No tracked files found on disk in scope.", "");
  }

  // Heaviest sessions by tool ops — long sessions worth resuming via `recent`.
  if (heaviest.length) {
    out.push("## heaviest sessions (tool ops)");
    for (const h of heaviest) out.push(`- ${h.date} · ${h.ops} ops · ${h.label}`);
  }
  out.push("", "_token figures are ≈ bytes/4. High re-read cost = open it once via 'file', then read only what you need._");
  return out.join("\n").trimEnd() + "\n";
}
