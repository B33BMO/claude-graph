import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

// Codebase overlay: derive file->file "imports" edges from real source code,
// using dependency-free regex extraction. We only need import relationships, not
// full ASTs, so per-language regexes cover the common cases. Targets are resolved
// to absolute on-disk paths so they line up with session File node ids.

export interface ImportEdge {
  from: string; // absolute path of the importing file
  to: string; // absolute path of the imported file
}

export interface Overlay {
  root: string;
  edges: ImportEdge[];
  files: string[]; // all scanned source files (absolute)
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  "coverage",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  ".mypy_cache",
  ".pytest_cache",
  ".cache",
]);

const JS_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const RESOLVE_EXTS = [...JS_EXTS, ".json"];
const PY_EXTS = [".py"];
const CODE_EXTS = new Set([...JS_EXTS, ...PY_EXTS]);

const MAX_FILES = 8000;
const MAX_FILE_BYTES = 1_000_000;

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  async function recur(dir: string): Promise<void> {
    if (out.length >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      if (e.name.startsWith(".") && e.isDirectory() && !SKIP_DIRS.has(e.name)) {
        // allow dotfiles dirs only if not in skip list; most are noise, skip hidden dirs
        continue;
      }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        await recur(full);
      } else if (e.isFile() && CODE_EXTS.has(path.extname(e.name))) {
        out.push(full);
      }
    }
  }
  await recur(root);
  return out;
}

// ---- JS/TS ----

const JS_FROM = /(?:^|[^.\w])(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g;
const JS_BARE = /(?:^|[^.\w])import\s*['"]([^'"]+)['"]/g;
const JS_REQUIRE = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;
const JS_DYNAMIC = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

function jsSpecifiers(src: string): string[] {
  const specs: string[] = [];
  for (const re of [JS_FROM, JS_BARE, JS_REQUIRE, JS_DYNAMIC]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) specs.push(m[1]);
  }
  return specs;
}

function resolveJs(spec: string, fromFile: string, fileSet: Set<string>): string | null {
  if (!spec.startsWith(".") && !spec.startsWith("/")) return null; // external package
  const base = path.resolve(path.dirname(fromFile), spec);
  const cands: string[] = [base];
  // TS ESM commonly imports "./x.js" but the file is "./x.ts"
  const extMatch = base.match(/\.(js|jsx|mjs|cjs)$/);
  if (extMatch) {
    const noext = base.slice(0, -extMatch[0].length);
    for (const e of [".ts", ".tsx", ".js", ".jsx"]) cands.push(noext + e);
  }
  for (const e of RESOLVE_EXTS) cands.push(base + e);
  for (const e of JS_EXTS) cands.push(path.join(base, "index" + e));
  for (const c of cands) if (fileSet.has(c)) return c;
  return null;
}

// ---- Python ----

const PY_FROM = /^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import\b/gm;
const PY_IMPORT = /^[ \t]*import[ \t]+([\w.]+)/gm;

function resolvePy(
  dots: string,
  module: string,
  fromFile: string,
  root: string,
  fileSet: Set<string>,
): string | null {
  const segs = module ? module.split(".") : [];
  const bases: string[] = [];
  if (dots.length > 0) {
    // relative import: climb (dots-1) directories from the current file's dir
    let dir = path.dirname(fromFile);
    for (let i = 1; i < dots.length; i++) dir = path.dirname(dir);
    bases.push(path.join(dir, ...segs));
  } else {
    // absolute: try repo root and the file's own directory as package roots
    bases.push(path.join(root, ...segs));
    bases.push(path.join(path.dirname(fromFile), ...segs));
  }
  for (const b of bases) {
    const cands = [b + ".py", path.join(b, "__init__.py")];
    for (const c of cands) if (fileSet.has(c)) return c;
  }
  return null;
}

function pySpecifiers(src: string): { dots: string; module: string }[] {
  const out: { dots: string; module: string }[] = [];
  PY_FROM.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PY_FROM.exec(src))) out.push({ dots: m[1], module: m[2] });
  PY_IMPORT.lastIndex = 0;
  while ((m = PY_IMPORT.exec(src))) out.push({ dots: "", module: m[1] });
  return out;
}

/** Scan a project root for resolvable import edges between its source files. */
export async function buildOverlay(root: string): Promise<Overlay> {
  const files = await walk(root);
  const fileSet = new Set(files);
  const seen = new Set<string>();
  const edges: ImportEdge[] = [];

  for (const file of files) {
    let src: string;
    try {
      const stat = await fsp.stat(file);
      if (stat.size > MAX_FILE_BYTES) continue;
      src = await fsp.readFile(file, "utf8");
    } catch {
      continue;
    }
    const ext = path.extname(file);
    const targets = new Set<string>();

    if (JS_EXTS.includes(ext)) {
      for (const spec of jsSpecifiers(src)) {
        const to = resolveJs(spec, file, fileSet);
        if (to && to !== file) targets.add(to);
      }
    } else if (ext === ".py") {
      for (const { dots, module } of pySpecifiers(src)) {
        const to = resolvePy(dots, module, file, root, fileSet);
        if (to && to !== file) targets.add(to);
      }
    }

    for (const to of targets) {
      const key = file + "\0" + to;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: file, to });
    }
  }

  return { root, edges, files };
}
