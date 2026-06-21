#!/usr/bin/env node
import fsp from "node:fs/promises";
import path from "node:path";
import { buildReport } from "./report.js";
import { buildHtml } from "./html.js";
import { loadGraph, collectSummaries, type Scope } from "./scope.js";
import { find, fileInfo, recent, digest, explain, deps, notes } from "./query.js";
import { memories, stale, cost } from "./insights.js";
import { clearCache } from "./cache.js";

interface Options extends Scope {
  out: string;
  limit?: number;
  terms: string[];
  write?: boolean;
  memory?: boolean;
  json?: boolean;
  promote?: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    all: false,
    out: "claude-graph-out",
    includeSubagents: false,
    terms: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") opts.all = true;
    else if (a === "--include-subagents") opts.includeSubagents = true;
    else if (a === "--no-overlay") opts.noOverlay = true;
    else if (a === "--no-cache") opts.noCache = true;
    else if (a === "--all-files") opts.allFiles = true;
    else if (a === "--write") opts.write = true;
    else if (a === "--memory") opts.memory = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--promote") opts.promote = true;
    else if (a === "--project") opts.project = argv[++i];
    else if (a === "--out" || a === "-o") opts.out = argv[++i];
    else if (a === "--limit" || a === "-n") opts.limit = Number(argv[++i]);
    else if (a.startsWith("--project=")) opts.project = a.slice("--project=".length);
    else if (a.startsWith("--out=")) opts.out = a.slice("--out=".length);
    else if (a.startsWith("--limit=")) opts.limit = Number(a.slice("--limit=".length));
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else opts.terms.push(a);
  }
  return opts;
}

function printHelp(): void {
  console.log(`claude-graph — index & query what you've worked on with Claude Code

Usage:
  claude-graph <command> [terms…] [options]

Query commands (terse output, for finding things fast):
  find <terms…>      Files, sessions & tasks matching the terms (ranked)
  file <terms…>      Deep history of the best-matching file + co-edited + imports
  deps <name>        What a file imports and what imports it (code structure)
  explain <a> <b>    How two files/topics connect (shared sessions + shortest path)
  notes [terms…]     Decisions & rationale ("why") from matching sessions
  recent [n]         Most recent sessions and the files they touched
  digest             Compact project overview (hub files + recent sessions)

Memory & upkeep (terse output, for curating context):
  memories [terms…]  Mine durable decisions into ready-to-save memory stubs
                     (--write stages them under <memory>/candidates/;
                      --promote <slug|all> moves staged stubs into memory + MEMORY.md)
  stale              Worked-on files no longer on disk (--memory checks memory too)
  cost               Costliest files to re-read (≈ tokens) + heaviest sessions

Build & maintenance:
  build              Write graph.html, GRAPH_REPORT.md, graph.json (the viz)
  reindex            Clear & rebuild the transcript cache

Scope (any command):
  (default)              Current project, matched by cwd
  --all                  Every project under ~/.claude/projects
  --project <substr>     Projects whose folder name contains <substr>
  --include-subagents    Include subagent sidechain transcripts
  --no-overlay           Skip the codebase (imports) overlay
  --no-cache             Don't read/write the parsed-transcript cache
  --all-files            Keep every read-once / dependency file (full firehose)
  --write                (memories) Stage candidate stubs as files for review
  --promote <slug|all>   (memories) Move staged stubs into memory + MEMORY.md
  --memory               (stale) Also check memory [[links]] & referenced paths
  --json                 (memories/stale/cost) Machine-readable output

Options:
  -n, --limit <n>        Cap results (query commands)
  -o, --out <dir>        Output directory for 'build' (default: claude-graph-out)
  -h, --help             Show help

Examples:
  claude-graph find auth --all
  claude-graph file ZulipContext
  claude-graph deps query.ts
  claude-graph explain ZulipContext SignIn
  claude-graph recent 8
  claude-graph digest`);
}

async function runBuild(opts: Options): Promise<void> {
  const { graph } = await loadGraph(opts);
  if (!graph.nodes.length) {
    console.error("No sessions matched. Try --all or --project <name>.");
    process.exit(1);
  }

  await fsp.mkdir(opts.out, { recursive: true });
  await Promise.all([
    fsp.writeFile(path.join(opts.out, "graph.json"), JSON.stringify(graph, null, 2)),
    fsp.writeFile(path.join(opts.out, "GRAPH_REPORT.md"), buildReport(graph)),
    fsp.writeFile(
      path.join(opts.out, "graph.html"),
      buildHtml(graph, `Claude Graph — ${graph.scope}`),
    ),
  ]);

  const { sessions, files, projects, tasks, imports, edges } = graph.stats;
  console.log(
    `Graph: ${sessions} sessions · ${files} files · ${projects} projects · ` +
      `${tasks} tasks · ${imports ?? 0} imports · ${edges} edges`,
  );
  console.log(`Wrote ${path.join(opts.out, "graph.html")} (+ GRAPH_REPORT.md, graph.json)`);
}

async function runQuery(command: string, opts: Options): Promise<void> {
  const term = opts.terms.join(" ").trim();
  const { graph } = await loadGraph(opts);
  if (!graph.nodes.length) {
    console.error("No sessions in scope. Try --all or --project <name>.");
    process.exit(1);
  }

  switch (command) {
    case "find":
      if (!term) return void console.error("Usage: claude-graph find <terms…>");
      process.stdout.write(find(graph, term, opts.limit ?? 10));
      break;
    case "file":
      if (!term) return void console.error("Usage: claude-graph file <terms…>");
      process.stdout.write(fileInfo(graph, term, opts.limit ?? 12));
      break;
    case "deps":
      if (!term) return void console.error("Usage: claude-graph deps <name>");
      process.stdout.write(deps(graph, term, opts.limit ?? 20));
      break;
    case "explain":
      if (opts.terms.length < 2)
        return void console.error("Usage: claude-graph explain <a> <b>");
      process.stdout.write(explain(graph, opts.terms[0], opts.terms[1]));
      break;
    case "notes":
      process.stdout.write(notes(graph, term, opts.limit ?? 5));
      break;
    case "recent":
      process.stdout.write(recent(graph, opts.limit ?? (term ? Number(term) || 10 : 10)));
      break;
    case "digest":
      process.stdout.write(digest(graph, opts.limit ?? 12));
      break;
  }
}

async function runInsights(command: string, opts: Options): Promise<void> {
  const { graph, overlayRoot } = await loadGraph(opts);
  if (!graph.nodes.length) {
    console.error("No sessions in scope. Try --all or --project <name>.");
    process.exit(1);
  }
  // Insights touch the real project (memory dir, files on disk), so they need a
  // single concrete root. Fall back to cwd for the default (current-project) scope.
  const root = overlayRoot ?? (!opts.all && !opts.project ? process.cwd() : null);
  const io = {
    limit: opts.limit,
    write: opts.write,
    memory: opts.memory,
    json: opts.json,
    promote: opts.promote,
    root,
  };
  const term = opts.terms.join(" ").trim();

  switch (command) {
    case "memories":
      process.stdout.write(memories(graph, term, io));
      break;
    case "stale":
      process.stdout.write(stale(graph, io));
      break;
    case "cost":
      process.stdout.write(cost(graph, io));
      break;
  }
}

async function runReindex(opts: Options): Promise<void> {
  const p = await clearCache();
  // Warm the cache across every project so the next query is instant.
  const summaries = await collectSummaries({ ...opts, all: true, noCache: false });
  console.log(`Cleared cache (${p}) and re-indexed ${summaries.length} transcript(s).`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : "digest";
  const rest = command === argv[0] ? argv.slice(1) : argv;
  const opts = parseArgs(rest);

  if (command === "build") return runBuild(opts);
  if (command === "reindex") return runReindex(opts);
  if (["memories", "stale", "cost"].includes(command)) return runInsights(command, opts);
  if (["find", "file", "deps", "explain", "notes", "recent", "digest"].includes(command))
    return runQuery(command, opts);

  console.error(`Unknown command "${command}".\n`);
  printHelp();
  process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
