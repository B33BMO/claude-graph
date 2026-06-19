import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parseTranscript } from "./parser.js";
import type { SessionSummary } from "./types.js";

// Transcript parsing is the expensive part of every query, and most transcripts
// never change once a session ends. We cache the parsed SessionSummary per
// transcript, keyed by file size + mtime, so repeated runs (especially --all)
// only re-parse what actually changed — e.g. the live session you're in.

const CACHE_VERSION = 2; // bumped: summaries now include prompts + decisions

interface SerializedSummary extends Omit<SessionSummary, "files"> {
  files: [string, SessionSummary["files"] extends Map<string, infer V> ? V : never][];
}

interface Entry {
  mtimeMs: number;
  size: number;
  summary: SerializedSummary;
}

interface CacheData {
  version: number;
  entries: Record<string, Entry>;
}

function cacheDir(): string {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(base, "claude-graph");
}

function cacheFilePath(): string {
  return path.join(cacheDir(), "summaries.json");
}

function serialize(s: SessionSummary): SerializedSummary {
  return { ...s, files: [...s.files.entries()] };
}

function deserialize(o: SerializedSummary): SessionSummary {
  return { ...o, files: new Map(o.files) };
}

async function loadCache(): Promise<CacheData> {
  try {
    const raw = await fsp.readFile(cacheFilePath(), "utf8");
    const data = JSON.parse(raw) as CacheData;
    if (data.version !== CACHE_VERSION || typeof data.entries !== "object") {
      return { version: CACHE_VERSION, entries: {} };
    }
    return data;
  } catch {
    return { version: CACHE_VERSION, entries: {} };
  }
}

async function saveCache(data: CacheData): Promise<void> {
  try {
    await fsp.mkdir(cacheDir(), { recursive: true });
    await fsp.writeFile(cacheFilePath(), JSON.stringify(data));
  } catch {
    // A cache write failure must never break a query.
  }
}

export interface ParseResult {
  summaries: SessionSummary[];
  hits: number;
  misses: number;
}

/**
 * Parse all transcripts, reusing cached results where size+mtime are unchanged.
 * Live/changed transcripts (and brand-new ones) are re-parsed and re-cached.
 * Entries are pruned lazily: kept across scoped runs, never deleted here (use
 * `clearCache` / the `reindex` command for a full reset).
 */
export async function parseAll(files: string[], useCache: boolean): Promise<ParseResult> {
  if (!useCache) {
    const summaries: SessionSummary[] = [];
    for (const f of files) {
      try {
        const s = await parseTranscript(f);
        if (s) summaries.push(s);
      } catch {
        /* skip corrupt */
      }
    }
    return { summaries, hits: 0, misses: summaries.length };
  }

  const cache = await loadCache();
  const summaries: SessionSummary[] = [];
  let hits = 0;
  let misses = 0;
  let dirty = false;

  for (const f of files) {
    let stat;
    try {
      stat = await fsp.stat(f);
    } catch {
      continue;
    }
    const entry = cache.entries[f];
    if (entry && entry.mtimeMs === stat.mtimeMs && entry.size === stat.size) {
      summaries.push(deserialize(entry.summary));
      hits++;
      continue;
    }
    try {
      const s = await parseTranscript(f);
      misses++;
      if (s) {
        summaries.push(s);
        cache.entries[f] = { mtimeMs: stat.mtimeMs, size: stat.size, summary: serialize(s) };
        dirty = true;
      }
    } catch {
      /* skip corrupt */
    }
  }

  if (dirty) await saveCache(cache);
  return { summaries, hits, misses };
}

/** Delete the on-disk cache entirely. */
export async function clearCache(): Promise<string> {
  const p = cacheFilePath();
  try {
    await fsp.rm(p, { force: true });
  } catch {
    /* ignore */
  }
  return p;
}
