<div align="center">

```
        _                 _                             _
   ___ | | __ _ _   _  __| | ___        __ _ _ __ __ _ | |_  _ __
  / __|| |/ _` | | | |/ _` |/ _ \  ___ / _` | '__/ _` || '_ \| '_ \
 | (__ | | (_| | |_| | (_| |  __/ |___| (_| | | | (_| || |_) | | | |
  \___||_|\__,_|\__,_|\__,_|\___|       \__, |_|  \__,_||_.__/|_| |_|
                                        |___/
```

**Your Claude Code history, as a graph Claude can actually query.**

Find the right file, session, or past decision in a few hundred tokens —
instead of re-reading thousand-line transcripts or grepping your whole repo.

![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![dependencies](https://img.shields.io/badge/runtime%20deps-0-success)
![local only](https://img.shields.io/badge/data-100%25%20local-blue)
![license](https://img.shields.io/badge/license-MIT-lightgrey)

</div>

---

## The idea

Claude Code already keeps a transcript of everything you do in
`~/.claude/projects/**/*.jsonl`. claude-graph reads it and builds a graph:

```
   ~/.claude/projects/**/*.jsonl
                │
                ▼
        ┌───────────────┐         project ──contains──▶ session
        │  claude-graph │         session ──touched───▶ file
        └───────────────┘         file    ◀─co-edited─▶ file
                │                  file    ──imports───▶ file   ← code overlay
        ┌───────┴────────┐         session ──worked-on─▶ task
        ▼                ▼
   terse queries     graph.html
   (for Claude)      (for you)
```

Then you — or **Claude itself**, via the bundled skill — query it for terse,
ranked answers. There's a pretty interactive graph too, but that's the side
dish. The index is the point.

> Inspired by [graphify](https://github.com/safishamsi/graphify), pointed at a
> different source: your *working history*, not a static codebase.

## Why it's worth it

A `file` answer is a few hundred tokens and replaces opening a thousand-line
transcript. **Query first, then open only the files it points to.**

```text
$ claude-graph file ZulipContext
file: src/app/context/ZulipContext.tsx
activity: 39 edits · 0 writes · 3 reads · 2 sessions

## worked on in
- 2026-06-15 · Please analyze this codebase and create a CLAUDE.md file…  [41 ops]

## co-edited with
- src/app/api/zulipApi.ts        [1x together]
- src/app/components/SignIn.tsx  [1x together]

## imports (code)
- src/app/api/types.ts
```

## Quick start

```bash
npm install && npm run build
npm link            # optional: puts `claude-graph` on your PATH
```

```bash
# query (terse, token-cheap — the main event)
claude-graph digest                 # compact overview of the current project
claude-graph find auth              # files/sessions/tasks matching "auth"
claude-graph file ZulipContext      # one file's history + what changes with it
claude-graph deps zulipApi          # what a file imports / what imports it
claude-graph explain api SignIn     # how two things connect
claude-graph recent 8               # most recent sessions

# curate context between sessions
claude-graph memories               # mine durable facts → save-ready memory stubs
claude-graph stale --memory         # files/memory refs that no longer exist on disk
claude-graph cost                   # costliest files to re-read (≈ tokens)

# build the interactive view (the side dish)
claude-graph build                  # → claude-graph-out/graph.html
```

`npm run dev -- <args>` runs straight from source, no build step.

## Commands

| Command | What you get |
| --- | --- |
| `digest` | Compact project overview — hub files + recent sessions. *(default)* |
| `find <terms…>` | Files, sessions & tasks matching the terms, ranked. |
| `file <name>` | A file's activity, the sessions that touched it, co-edits, and imports. |
| `deps <name>` | Code dependencies: what a file imports and what imports it. |
| `explain <a> <b>` | How two files/topics connect — shared sessions + shortest path. |
| `notes [terms…]` | Decisions & rationale ("why") from matching sessions' prose & reasoning. |
| `recent [n]` | Most recent sessions and the files they touched. |
| `memories [terms…]` | Mine durable facts/decisions into save-ready memory stubs; `--write` stages them under `<memory>/candidates/`, `--promote <slug\|all>` moves staged stubs into memory + `MEMORY.md`. Skips what existing memories already cover. |
| `stale` | Worked-on files no longer on disk (renamed/deleted); `--memory` also checks memory `[[links]]` & referenced paths. |
| `cost` | Costliest files to re-read (≈ tokens = size × opens) + the heaviest sessions. |
| `build` | `graph.html` (interactive), `GRAPH_REPORT.md`, `graph.json`. |

**Scope** *(any command)* — `--all` (every project) · `--project <substr>` ·
`--include-subagents` · `--no-overlay` · `--no-cache`. Default = the current
directory's project.
**Options** — `-n/--limit <n>` · `-o/--out <dir>` (build) · `--all-files` ·
`--json` (memories/stale/cost) · `--write`/`--promote` (memories) ·
`--memory` (stale).

### Signal over noise

By default a file becomes a node only if it's **meaningful** — you *edited or
wrote* it, or *read it across ≥2 sessions* — and it isn't in a dependency/build
dir (`node_modules`, `vendor`, `dist`, `target`, …). The codebase overlay is
likewise restricted to the **neighborhood of your work** (files connected by
imports to something you touched). This keeps a one-off "read the whole tree"
session from burying the graph in thousands of dependency dots. Pass
`--all-files` for the full firehose.

## Let Claude use it

The repo ships a Claude Code **skill** (`skill/claude-graph/SKILL.md`) that tells
Claude to query the index *before* exploring. Install it once:

```bash
npm link                                                          # CLI on PATH
ln -sfn "$PWD/skill/claude-graph" ~/.claude/skills/claude-graph   # skill discovered
```

New Claude Code sessions pick it up automatically. After that, Claude reaches for
`find` / `file` / `deps` / `explain` on its own — and you can invoke it by hand
with `/claude-graph digest`.

### Auto-orient every session (optional)

Add a `SessionStart` hook so each new/resumed session begins with the current
project's `digest` already in context — no turn spent orienting:

```json
// ~/.claude/settings.json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          { "type": "command", "command": "claude-graph digest 2>/dev/null || true", "timeout": 15 }
        ]
      }
    ]
  }
}
```

The `2>/dev/null || true` keeps it silent in projects with no history.

## Codebase overlay

File nodes are **real paths**, so claude-graph overlays your actual code
structure onto the session graph. For a single-project scope it scans the repo
and adds `imports` edges between files:

- Dependency-free, regex-based extraction across **JS/TS** (`import`/`export
  from`, `require`, dynamic `import()`), **Python** (`import` / `from … import`),
  **Go** (resolved via the `go.mod` module path), **Rust** (`mod` tree) and
  **Ruby** (`require_relative`).
- Relative/in-repo imports resolved to real on-disk files; externals ignored.
- Also extracts **top-level symbol names** per file (functions, classes, types…)
  so `find <SymbolName>` locates the defining file even by a name you never typed
  into a path.
- Powers `deps`, the import & `defines:` sections of `file`, and structural paths
  in `explain`.

Runs automatically for single-project scopes; skipped under `--all` or
`--no-overlay`. *Sessions first, codebase next — now both.*

## The graph model

| Node | From |
| --- | --- |
| **Project** | a working directory (`cwd`) |
| **Session** | one conversation, labeled by its first prompt |
| **File** | a real path touched via Read / Write / Edit |
| **Task** | a `TaskCreate` subject |

**Edges:** `project → session` (contains) · `session → file` (touched, weighted
by ops) · `file ↔ file` (co-edited) · `file → file` (imports) · `session → task`.

## Good to know

- **Zero runtime dependencies.** Node ≥ 20.
- **100% local.** No transcript data ever leaves your machine.
- **Always fresh.** Queries re-parse transcripts on every run — no stale index.

## Roadmap

- [x] Codebase overlay — File nodes ↔ repo structure (JS/TS, Python, Go, Rust, Ruby)
- [x] Symbol extraction — `find` matches function/class/type names
- [x] Cached transcript index for fast repeated `--all` queries
- [x] Topic & decision extraction from prompts and `thinking` blocks (`notes`)
- [ ] More overlay languages (Java, C#, C/C++) + symbol-level reference edges

<div align="center">
<sub>Runs entirely on your machine</sub>
</div>
