# claude-graph

A **queryable index of your Claude Code history**, so Claude can find the right
file, session, or past decision without re-reading transcripts or grepping your
whole repo — saving tokens and context.

It reads the transcripts Claude Code already keeps in
`~/.claude/projects/**/*.jsonl` and builds a graph of **projects → sessions →
files → tasks**. Then you (or Claude) query it for terse, ranked answers. An
interactive visualization is available too, but it's a side output — the point is
the index.

Inspired by [graphify](https://github.com/safishamsi/graphify), pointed at a
different source: your *working history*, not a static codebase.

## Why

A `file <name>` answer is a few hundred tokens and replaces opening a
thousand-line transcript. **Query first, then open only the files it points to.**

```
$ claude-graph file ZulipContext
file: src/app/context/ZulipContext.tsx
activity: 39 edits · 0 writes · 3 reads · 2 sessions

## worked on in
- 2026-06-15 · Please analyze this codebase and create a CLAUDE.md file…  [41 ops]

## co-edited with
- src/app/api/zulipApi.ts  [1x together]
- src/app/components/SignIn.tsx  [1x together]
- src/app/api/credentialStore.ts  [1x together]
  …
```

## Quick start

```bash
npm install && npm run build
npm link            # optional: puts `claude-graph` on your PATH

# Query (terse, token-cheap — this is the main use):
claude-graph digest                 # compact overview of the current project
claude-graph find auth              # files/sessions/tasks matching "auth"
claude-graph file ZulipContext      # one file's history + what changes with it
claude-graph deps zulipApi          # what a file imports / what imports it
claude-graph recent 8               # most recent sessions

# Build the interactive view (secondary):
claude-graph build                  # writes claude-graph-out/graph.html
```

`npm run dev -- <args>` runs from source without building.

## Commands

| Command | What it returns |
| --- | --- |
| `find <terms…>` | Files, sessions & tasks matching the terms, ranked. |
| `file <name>` | Best-matching file's activity, the sessions that touched it, files co-edited alongside it, and its imports. |
| `deps <name>` | A file's code dependencies: what it imports and what imports it (JS/TS & Python). |
| `explain <a> <b>` | How two files/topics connect: sessions that touched both + shortest path through the graph. |
| `recent [n]` | Most recent sessions and the files they touched. |
| `digest` | Compact project overview (hub files + recent sessions). The default command. |
| `build` | `graph.html` (interactive), `GRAPH_REPORT.md`, `graph.json`. |

**Scope (any command):** `--all` (every project), `--project <substr>`,
`--include-subagents`. Default = the current directory's project.
**Options:** `-n/--limit <n>`, `-o/--out <dir>` (build).

## Let Claude use it

`skill/claude-graph/SKILL.md` is a Claude Code skill telling Claude to query the
index before exploring. Install it:

```bash
ln -s "$PWD/skill/claude-graph" ~/.claude/skills/claude-graph
```

Then in any project Claude can run `claude-graph find/file/recent/digest` to
orient itself cheaply before reading files.

## Model

**Nodes:** Project (`cwd`) · Session (one conversation, labeled by first prompt) ·
File (real path touched via Read/Write/Edit) · Task (a `TaskCreate` subject).
**Edges:** project→session (contains) · session→file (touched, weighted by ops) ·
file↔file (co-edited in a session) · session→task · file→file (imports).

## Codebase overlay

Because File nodes are real paths, claude-graph overlays your **actual code
structure** onto the session graph. For a single-project scope it scans the repo
and adds `imports` edges between files (dependency-free regex extraction for
JS/TS and Python; relative imports resolved to on-disk files). This powers `deps`,
the import sections of `file`, and structural paths in `explain`. Code files that
exist in the repo but were never touched in a session are added as light nodes so
structure stays connected.

The overlay runs automatically for single-project scopes and is skipped under
`--all` (no single root) or `--no-overlay`. Sessions first, codebase next — now
both.

## Notes

- Zero runtime dependencies. Node ≥ 20. Re-parses on every query (always fresh).
- Everything runs locally; no transcript data leaves your machine.

## Roadmap

- [x] Codebase overlay: map File nodes onto repo structure (JS/TS & Python imports).
- [ ] More overlay languages (Go, Rust, Ruby) and symbol-level edges.
- [ ] Topic & decision extraction from prompts and `thinking` blocks.
- [ ] Optional cached index for very large `--all` scopes.
