import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildGraph, applyOverlay } from "./graph.js";
import { buildOverlay } from "./overlay.js";
import { parseAll } from "./cache.js";
import type { Graph, SessionSummary } from "./types.js";

export interface Scope {
  all: boolean;
  project?: string;
  includeSubagents: boolean;
  noOverlay?: boolean;
  noCache?: boolean;
}

export const PROJECTS_ROOT = path.join(os.homedir(), ".claude", "projects");

async function listTranscripts(dir: string, includeSub: boolean): Promise<string[]> {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!includeSub && e.name === "subagents") continue;
      out.push(...(await listTranscripts(full, includeSub)));
    } else if (e.isFile() && e.name.endsWith(".jsonl")) {
      out.push(full);
    }
  }
  return out;
}

async function projectDirs(scope: Scope): Promise<{ dirs: string[]; cwdFilter?: string }> {
  let entries: string[];
  try {
    entries = (await fsp.readdir(PROJECTS_ROOT, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    throw new Error(`No Claude projects found at ${PROJECTS_ROOT}`);
  }

  if (scope.all) return { dirs: entries.map((e) => path.join(PROJECTS_ROOT, e)) };

  if (scope.project) {
    const matched = entries.filter((e) => e.includes(scope.project!));
    if (!matched.length) throw new Error(`No project folder matched "${scope.project}".`);
    return { dirs: matched.map((e) => path.join(PROJECTS_ROOT, e)) };
  }

  // Default: current project. Try the encoded dir name; fall back to scanning
  // everything and filtering by cwd (robust against encoding differences).
  const cwd = process.cwd();
  const enc = cwd.replace(/[^A-Za-z0-9]/g, "-");
  if (entries.includes(enc)) return { dirs: [path.join(PROJECTS_ROOT, enc)] };
  return { dirs: entries.map((e) => path.join(PROJECTS_ROOT, e)), cwdFilter: cwd };
}

/** Parse every in-scope transcript into session summaries. */
export async function collectSummaries(scope: Scope): Promise<SessionSummary[]> {
  const { dirs, cwdFilter } = await projectDirs(scope);
  const files: string[] = [];
  for (const d of dirs) files.push(...(await listTranscripts(d, scope.includeSubagents)));

  const { summaries } = await parseAll(files, !scope.noCache);
  return cwdFilter ? summaries.filter((s) => s.cwd === cwdFilter) : summaries;
}

export function scopeLabel(scope: Scope, summaries: SessionSummary[]): string {
  if (scope.all) return "all projects";
  if (scope.project) return `project ~"${scope.project}"`;
  return summaries.find((s) => s.project)?.project ?? "current project";
}

/**
 * The single repo root for this scope, or null if ambiguous (e.g. --all, or a
 * --project substring that matched multiple projects). Used for the code overlay.
 */
function overlayRoot(scope: Scope, summaries: SessionSummary[]): string | null {
  if (scope.all || scope.noOverlay) return null;
  const cwds = [...new Set(summaries.map((s) => s.cwd).filter((c): c is string => !!c))];
  if (cwds.length === 1) return cwds[0];
  // Default scope already targets one project; prefer the actual cwd if present.
  if (!scope.project && cwds.includes(process.cwd())) return process.cwd();
  return null;
}

/** Parse + build the graph for a scope, in memory. Always fresh. */
export async function loadGraph(scope: Scope): Promise<{
  graph: Graph;
  summaries: SessionSummary[];
  overlayRoot: string | null;
}> {
  const summaries = await collectSummaries(scope);
  const label = scopeLabel(scope, summaries);
  let graph = buildGraph(summaries, label, new Date().toISOString());

  const root = overlayRoot(scope, summaries);
  if (root) {
    try {
      const overlay = await buildOverlay(root);
      if (overlay.edges.length) graph = applyOverlay(graph, overlay);
    } catch {
      // Overlay is best-effort; a parse failure shouldn't break queries.
    }
  }
  return { graph, summaries, overlayRoot: root };
}
