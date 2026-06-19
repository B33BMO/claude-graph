import type { Graph, GraphNode } from "./types.js";

// All query output is deliberately terse and capped: it's meant to be read by a
// model that just needs to *find* the right file/session, not a human admiring a
// report. Every function returns a compact string, a few hundred tokens at most.

interface Index {
  byId: Map<string, GraphNode>;
  // fileId -> [{ session, ops }]
  sessionsOfFile: Map<string, { session: GraphNode; ops: number }[]>;
  // fileId -> [{ file, weight }] (co-edited)
  coedited: Map<string, { file: GraphNode; weight: number }[]>;
  // sessionId -> fileNodes touched
  filesOfSession: Map<string, GraphNode[]>;
  // fileId -> files it imports / files that import it (from the code overlay)
  importsOut: Map<string, GraphNode[]>;
  importsIn: Map<string, GraphNode[]>;
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  (map.get(key) ?? map.set(key, []).get(key)!).push(value);
}

function buildIndex(graph: Graph): Index {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const sessionsOfFile = new Map<string, { session: GraphNode; ops: number }[]>();
  const coedited = new Map<string, { file: GraphNode; weight: number }[]>();
  const filesOfSession = new Map<string, GraphNode[]>();
  const importsOut = new Map<string, GraphNode[]>();
  const importsIn = new Map<string, GraphNode[]>();

  for (const e of graph.edges) {
    if (e.type === "imports") {
      const from = byId.get(e.source);
      const to = byId.get(e.target);
      if (from && to) {
        push(importsOut, from.id, to);
        push(importsIn, to.id, from);
      }
      continue;
    }
    if (e.type === "touched") {
      const session = byId.get(e.source);
      const file = byId.get(e.target);
      if (!session || !file) continue;
      (sessionsOfFile.get(file.id) ?? sessionsOfFile.set(file.id, []).get(file.id)!).push({
        session,
        ops: e.weight,
      });
      (filesOfSession.get(session.id) ?? filesOfSession.set(session.id, []).get(session.id)!).push(
        file,
      );
    } else if (e.type === "co-edited") {
      const a = byId.get(e.source);
      const b = byId.get(e.target);
      if (!a || !b) continue;
      (coedited.get(a.id) ?? coedited.set(a.id, []).get(a.id)!).push({ file: b, weight: e.weight });
      (coedited.get(b.id) ?? coedited.set(b.id, []).get(b.id)!).push({ file: a, weight: e.weight });
    }
  }
  return { byId, sessionsOfFile, coedited, filesOfSession, importsOut, importsIn };
}

function day(ts: unknown): string {
  if (typeof ts !== "string") return "????-??-??";
  const d = new Date(ts);
  return isNaN(d.getTime()) ? "????-??-??" : d.toISOString().slice(0, 10);
}

function has(node: GraphNode, term: string): boolean {
  const t = term.toLowerCase();
  if (node.label.toLowerCase().includes(t)) return true;
  const p = node.meta?.path;
  return typeof p === "string" && p.toLowerCase().includes(t);
}

function header(graph: Graph): string {
  return `# claude-graph · ${graph.scope}`;
}

/** Resolve a free-text term to the most relevant node (file > session > task). */
function resolveNode(graph: Graph, term: string): GraphNode | null {
  const file = graph.nodes
    .filter((n) => n.type === "file" && has(n, term))
    .sort((a, b) => b.weight - a.weight)[0];
  if (file) return file;
  const session = graph.nodes
    .filter((n) => n.type === "session" && has(n, term))
    .sort((a, b) => String(b.meta.lastTs).localeCompare(String(a.meta.lastTs)))[0];
  if (session) return session;
  return graph.nodes.find((n) => n.type === "task" && has(n, term)) ?? null;
}

/** Cross-type search: files, sessions, tasks matching `term`. */
export function find(graph: Graph, term: string, limit = 10): string {
  const idx = buildIndex(graph);
  const out: string[] = [header(graph), `query: "${term}"`, ""];

  const files = graph.nodes
    .filter((n) => n.type === "file" && has(n, term))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit);
  if (files.length) {
    out.push(`## files (${files.length})`);
    for (const f of files) {
      const sess = idx.sessionsOfFile.get(f.id)?.length ?? 0;
      out.push(
        `- ${f.label}  [${f.meta.edits ?? 0}e/${f.meta.writes ?? 0}w/${f.meta.reads ?? 0}r · ${sess} sess]`,
      );
    }
    out.push("");
  }

  const sessions = graph.nodes
    .filter((n) => n.type === "session" && has(n, term))
    .sort((a, b) => String(b.meta.lastTs).localeCompare(String(a.meta.lastTs)))
    .slice(0, limit);
  if (sessions.length) {
    out.push(`## sessions (${sessions.length})`);
    for (const s of sessions) {
      out.push(`- ${day(s.meta.lastTs)} · ${s.meta.project ?? "?"} · ${s.label}`);
    }
    out.push("");
  }

  const tasks = graph.nodes
    .filter((n) => n.type === "task" && has(n, term))
    .slice(0, limit);
  if (tasks.length) {
    out.push(`## tasks (${tasks.length})`);
    for (const t of tasks) out.push(`- ${t.label}`);
    out.push("");
  }

  if (!files.length && !sessions.length && !tasks.length) {
    out.push(`No matches. Try a broader term, --all, or 'recent'.`);
  }
  return out.join("\n").trimEnd() + "\n";
}

/** Everything about the file best matching `term`: history + co-edited neighbors. */
export function fileInfo(graph: Graph, term: string, limit = 12): string {
  const idx = buildIndex(graph);
  const candidates = graph.nodes
    .filter((n) => n.type === "file" && has(n, term))
    .sort((a, b) => b.weight - a.weight);
  if (!candidates.length) return `${header(graph)}\nNo file matches "${term}".\n`;

  const f = candidates[0];
  const out: string[] = [header(graph), `file: ${f.label}`];
  if (typeof f.meta.path === "string" && f.meta.path !== f.label) out.push(`path: ${f.meta.path}`);
  out.push(
    `activity: ${f.meta.edits ?? 0} edits · ${f.meta.writes ?? 0} writes · ${f.meta.reads ?? 0} reads · ${f.meta.sessions ?? 0} sessions`,
  );
  if (candidates.length > 1) {
    out.push(`(${candidates.length - 1} other files also matched; showing top hit)`);
  }
  out.push("");

  const sess = (idx.sessionsOfFile.get(f.id) ?? [])
    .sort((a, b) => String(b.session.meta.lastTs).localeCompare(String(a.session.meta.lastTs)))
    .slice(0, limit);
  if (sess.length) {
    out.push(`## worked on in`);
    for (const { session, ops } of sess) {
      out.push(`- ${day(session.meta.lastTs)} · ${session.label}  [${ops} ops]`);
    }
    out.push("");
  }

  const neighbors = (idx.coedited.get(f.id) ?? [])
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit);
  if (neighbors.length) {
    out.push(`## co-edited with`);
    for (const { file, weight } of neighbors) {
      out.push(`- ${file.label}  [${weight}x together]`);
    }
    out.push("");
  }

  const imports = (idx.importsOut.get(f.id) ?? []).slice(0, limit);
  if (imports.length) {
    out.push(`## imports (code)`);
    for (const t of imports) out.push(`- ${t.label}`);
    out.push("");
  }
  const importedBy = (idx.importsIn.get(f.id) ?? []).slice(0, limit);
  if (importedBy.length) {
    out.push(`## imported by (code)`);
    for (const t of importedBy) out.push(`- ${t.label}`);
  }
  return out.join("\n").trimEnd() + "\n";
}

/** Code-structure view of a file: what it imports and what imports it. */
export function deps(graph: Graph, term: string, limit = 20): string {
  const idx = buildIndex(graph);
  const f = graph.nodes
    .filter((n) => n.type === "file" && has(n, term))
    .sort((a, b) => b.weight - a.weight)[0];
  if (!f) return `${header(graph)}\nNo file matches "${term}".\n`;

  const out: string[] = [header(graph), `deps: ${f.label}`];
  const imports = (idx.importsOut.get(f.id) ?? []).slice(0, limit);
  const importedBy = (idx.importsIn.get(f.id) ?? []).slice(0, limit);
  if (!imports.length && !importedBy.length) {
    out.push("");
    out.push(
      `No code imports found. (Overlay covers JS/TS & Python in a single ` +
        `project; run without --all, or the file may have no resolved imports.)`,
    );
    return out.join("\n") + "\n";
  }
  out.push(`imports ${imports.length} · imported by ${importedBy.length}`, "");
  if (imports.length) {
    out.push(`## imports`);
    for (const t of imports) out.push(`- ${t.label}`);
    out.push("");
  }
  if (importedBy.length) {
    out.push(`## imported by`);
    for (const t of importedBy) out.push(`- ${t.label}`);
  }
  return out.join("\n").trimEnd() + "\n";
}

/** Most recent sessions, newest first. */
export function recent(graph: Graph, n = 10): string {
  const idx = buildIndex(graph);
  const sessions = graph.nodes
    .filter((s) => s.type === "session")
    .sort((a, b) => String(b.meta.lastTs).localeCompare(String(a.meta.lastTs)))
    .slice(0, n);
  const out: string[] = [header(graph), `recent ${sessions.length} sessions`, ""];
  for (const s of sessions) {
    const files = (idx.filesOfSession.get(s.id) ?? [])
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 4)
      .map((f) => f.label);
    out.push(`- ${day(s.meta.lastTs)} · ${s.meta.project ?? "?"} · ${s.label}`);
    if (files.length) out.push(`    files: ${files.join(", ")}`);
  }
  return out.join("\n").trimEnd() + "\n";
}

/** How two things (files/sessions/tasks) connect: shared sessions + shortest path. */
export function explain(graph: Graph, termA: string, termB: string): string {
  const a = resolveNode(graph, termA);
  const b = resolveNode(graph, termB);
  const out: string[] = [header(graph), `explain: "${termA}" ↔ "${termB}"`, ""];
  if (!a) return `${out.join("\n")}\nNo node matches "${termA}".\n`;
  if (!b) return `${out.join("\n")}\nNo node matches "${termB}".\n`;
  out.push(`A: ${a.type} · ${a.label}`);
  out.push(`B: ${b.type} · ${b.label}`);
  out.push("");
  if (a.id === b.id) return `${out.join("\n")}Same node.\n`;

  const idx = buildIndex(graph);
  let shown = false;

  // If both are files, the strongest signal is sessions that touched both.
  if (a.type === "file" && b.type === "file") {
    const sa = new Map((idx.sessionsOfFile.get(a.id) ?? []).map((x) => [x.session.id, x.session]));
    const shared = (idx.sessionsOfFile.get(b.id) ?? [])
      .filter((x) => sa.has(x.session.id))
      .map((x) => x.session)
      .sort((s1, s2) => String(s2.meta.lastTs).localeCompare(String(s1.meta.lastTs)));
    if (shared.length) {
      shown = true;
      out.push(`## worked on together in ${shared.length} session(s)`);
      for (const s of shared.slice(0, 8)) out.push(`- ${day(s.meta.lastTs)} · ${s.label}`);
      out.push("");
    }
    const cow = (idx.coedited.get(a.id) ?? []).find((c) => c.file.id === b.id);
    if (cow) {
      shown = true;
      out.push(`Co-edited ${cow.weight}x in the same session.`, "");
    }
  }

  // Shortest path through the whole graph (any node types).
  const path = shortestPath(graph, a.id, b.id);
  if (path) {
    out.push(`## connection`);
    out.push(path.map((n) => labelFor(n)).join("  →  "));
  } else if (!shown) {
    out.push(`No connection found in scope (likely different projects, never touched together).`);
  }
  return out.join("\n").trimEnd() + "\n";
}

function labelFor(n: GraphNode): string {
  const short = n.label.length > 32 ? n.label.slice(0, 31) + "…" : n.label;
  return `[${n.type}] ${short}`;
}

/** Undirected BFS over all edges. Returns the node chain, or null. */
function shortestPath(graph: Graph, fromId: string, toId: string): GraphNode[] | null {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const adj = new Map<string, Set<string>>();
  for (const e of graph.edges) {
    (adj.get(e.source) ?? adj.set(e.source, new Set()).get(e.source)!).add(e.target);
    (adj.get(e.target) ?? adj.set(e.target, new Set()).get(e.target)!).add(e.source);
  }
  const prev = new Map<string, string | null>([[fromId, null]]);
  const queue = [fromId];
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === toId) break;
    for (const next of adj.get(cur) ?? []) {
      if (!prev.has(next)) {
        prev.set(next, cur);
        queue.push(next);
      }
    }
  }
  if (!prev.has(toId)) return null;
  const chain: GraphNode[] = [];
  for (let at: string | null = toId; at; at = prev.get(at) ?? null) {
    const node = byId.get(at);
    if (node) chain.unshift(node);
  }
  return chain;
}

/** Compact project overview — load this instead of exploring. */
export function digest(graph: Graph, limit = 12): string {
  const idx = buildIndex(graph);
  const out: string[] = [header(graph)];
  out.push(
    `${graph.stats.sessions} sessions · ${graph.stats.files} files · ${graph.stats.projects} projects · ${graph.stats.tasks} tasks`,
  );
  out.push("");

  const topFiles = graph.nodes
    .filter((n) => n.type === "file")
    .sort(
      (a, b) =>
        (Number(b.meta.sessions) || 0) - (Number(a.meta.sessions) || 0) || b.weight - a.weight,
    )
    .slice(0, limit);
  if (topFiles.length) {
    out.push(`## hub files (most-worked)`);
    for (const f of topFiles) {
      out.push(`- ${f.label}  [${f.meta.sessions ?? 0} sess · ${f.meta.edits ?? 0}e]`);
    }
    out.push("");
  }

  const sessions = graph.nodes
    .filter((s) => s.type === "session")
    .sort((a, b) => String(b.meta.lastTs).localeCompare(String(a.meta.lastTs)))
    .slice(0, Math.min(limit, 8));
  if (sessions.length) {
    out.push(`## recent sessions`);
    for (const s of sessions) {
      out.push(`- ${day(s.meta.lastTs)} · ${s.label}`);
    }
  }
  return out.join("\n").trimEnd() + "\n";
}
