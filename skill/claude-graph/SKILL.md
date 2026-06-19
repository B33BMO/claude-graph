---
name: claude-graph
description: Find relevant files, past sessions, and prior decisions from your Claude Code history WITHOUT reading transcripts or grepping the whole repo. Use BEFORE exploring a codebase, when the user references earlier work ("the thing we did with auth", "that script from last week"), when you need to know which files relate to a topic, or to orient at the start of a task. Returns a terse ranked answer in a few hundred tokens.
---

# claude-graph

`claude-graph` indexes your Claude Code session transcripts
(`~/.claude/projects/**/*.jsonl`) into a graph of **projects → sessions → files →
tasks** and lets you query it. It re-parses on every run, so results are always
fresh. Output is intentionally compact — read it instead of opening transcripts
or doing broad `grep`/`Read` sweeps.

## When to use it

Reach for this **before** spending tokens on exploration when:

- You need to find which files relate to a topic → `find <topic>`.
- The user references past work and you need to locate it → `find <terms>` / `recent`.
- You're about to work on a file and want its history + what changes with it →
  `file <name>`.
- You need a file's code dependencies — what it imports / what imports it (impact
  of a change) → `deps <name>`.
- You want to know how two files/topics relate (do they get changed together, or
  connect through imports?) → `explain <a> <b>`.
- You're starting in a project and want fast orientation → `digest`.

It complements `grep`/`Read` — it tells you *where to look and what's connected*,
then you open only the specific files that matter.

## How to run

Run via Bash (the tool prints plain text to stdout):

```bash
claude-graph digest              # compact overview of the current project
claude-graph find <terms…>       # files/sessions/tasks matching terms (ranked)
claude-graph file <name>         # history of best-matching file + co-edited + imports
claude-graph deps <name>         # what a file imports and what imports it
claude-graph explain <a> <b>     # how two files/topics connect
claude-graph recent [n]          # most recent sessions and files they touched
```

Scope flags (any command): `--all` (every project), `--project <substr>`,
`-n <limit>`. Default scope is the current working directory's project.

The **codebase overlay** (imports/imported-by + symbol names) runs automatically
for a single project (JS/TS, Python, Go, Rust, Ruby). It's skipped under `--all`
or with `--no-overlay`, so `deps` and the import sections of `file`/`explain` need
a single-project scope. `find` also matches **symbol names** (functions, classes,
types), so you can locate a file by a definition you remember.

If `claude-graph` is not on PATH, run it from the repo with
`node /path/to/claude-graph/dist/cli.js <command>` or `npx claude-graph <command>`.

## Reading the output

- `find` groups hits by **files** / **sessions** / **tasks**. File rows show
  `[<edits>e/<writes>w/<reads>r · <n> sess]` — high session counts = hub files.
- `file` shows total activity, the dated sessions that touched it, and the files
  most often **co-edited** alongside it (a strong hint for "if I change X, also
  check these").
- `recent` / `digest` are for orientation; session labels are the first prompt of
  that session.

## Why it saves tokens

A single `file <name>` or `find <topic>` answer is a few hundred tokens and
replaces reading thousand-line transcripts or grepping a large tree. Query first,
then open only the specific files it points you to.
