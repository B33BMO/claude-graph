import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

// Codebase overlay: derive file->file "imports" edges and per-file symbol names
// from real source code, using dependency-free regex extraction. We only need
// import relationships and top-level definition names — not full ASTs — so
// per-language regexes cover the common cases. Import targets are resolved to
// absolute on-disk paths so they line up with session File node ids.
//
// Reliable, file-resolvable relationships only:
//   JS/TS  import/export-from, require, dynamic import  (relative specifiers)
//   Python import / from-import                         (relative + in-repo absolute)
//   Ruby   require_relative                             (load-path requires can't resolve)
//   Rust   mod NAME;                                    (the module file tree)
//   Go     import "pkg"                                 (resolved via go.mod module path)

export interface ImportEdge {
  from: string; // absolute path of the importing file
  to: string; // absolute path of the imported file
}

export interface Overlay {
  root: string;
  edges: ImportEdge[];
  files: string[]; // all scanned source files (absolute)
  symbols: Map<string, string[]>; // abs path -> top-level definition names
}

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", "coverage", "vendor",
  "target", "__pycache__", ".venv", "venv", ".mypy_cache", ".pytest_cache", ".cache",
]);

const JS_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const RESOLVE_EXTS = [...JS_EXTS, ".json"];
const CODE_EXTS = new Set([...JS_EXTS, ".py", ".rb", ".rs", ".go"]);

const MAX_FILES = 8000;
const MAX_FILE_BYTES = 1_000_000;
const MAX_SYMBOLS = 50;

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
      if (e.name.startsWith(".") && e.isDirectory()) continue; // hidden dirs are noise
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

// ---- JS / TS ----

const JS_FROM = /(?:^|[^.\w])(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g;
const JS_BARE = /(?:^|[^.\w])import\s*['"]([^'"]+)['"]/g;
const JS_REQUIRE = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;
const JS_DYNAMIC = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

function collect(re: RegExp, src: string, into: string[]): void {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) into.push(m[1]);
}

function jsSpecifiers(src: string): string[] {
  const specs: string[] = [];
  for (const re of [JS_FROM, JS_BARE, JS_REQUIRE, JS_DYNAMIC]) collect(re, src, specs);
  return specs;
}

function resolveJs(spec: string, fromFile: string, fileSet: Set<string>): string | null {
  if (!spec.startsWith(".") && !spec.startsWith("/")) return null; // external package
  const base = path.resolve(path.dirname(fromFile), spec);
  const cands: string[] = [base];
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

function pySpecifiers(src: string): { dots: string; module: string }[] {
  const out: { dots: string; module: string }[] = [];
  PY_FROM.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PY_FROM.exec(src))) out.push({ dots: m[1], module: m[2] });
  PY_IMPORT.lastIndex = 0;
  while ((m = PY_IMPORT.exec(src))) out.push({ dots: "", module: m[1] });
  return out;
}

function resolvePy(
  dots: string, module: string, fromFile: string, root: string, fileSet: Set<string>,
): string | null {
  const segs = module ? module.split(".") : [];
  const bases: string[] = [];
  if (dots.length > 0) {
    let dir = path.dirname(fromFile);
    for (let i = 1; i < dots.length; i++) dir = path.dirname(dir);
    bases.push(path.join(dir, ...segs));
  } else {
    bases.push(path.join(root, ...segs));
    bases.push(path.join(path.dirname(fromFile), ...segs));
  }
  for (const b of bases) {
    for (const c of [b + ".py", path.join(b, "__init__.py")]) if (fileSet.has(c)) return c;
  }
  return null;
}

// ---- Ruby ----

const RB_REQUIRE_RELATIVE = /\brequire_relative\s+['"]([^'"]+)['"]/g;

function resolveRuby(spec: string, fromFile: string, fileSet: Set<string>): string | null {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const c of [base, base + ".rb"]) if (fileSet.has(c)) return c;
  return null;
}

// ---- Rust ----

const RS_MOD = /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/gm;

function resolveRust(name: string, fromFile: string, fileSet: Set<string>): string | null {
  const dir = path.dirname(fromFile);
  // `mod foo;` resolves to foo.rs or foo/mod.rs; for a mod.rs/lib.rs/main.rs the
  // submodule may also live in a sibling dir named after the parent module.
  const cands = [path.join(dir, name + ".rs"), path.join(dir, name, "mod.rs")];
  const stem = path.basename(fromFile, ".rs");
  if (!["mod", "lib", "main"].includes(stem)) {
    cands.push(path.join(dir, stem, name + ".rs"));
    cands.push(path.join(dir, stem, name, "mod.rs"));
  }
  for (const c of cands) if (fileSet.has(c)) return c;
  return null;
}

// ---- Go ----

const GO_IMPORT_BLOCK = /\bimport\s*\(([^)]*)\)/g;
const GO_IMPORT_SINGLE = /\bimport\s+(?:[\w.]+\s+)?"([^"]+)"/g;
const GO_QUOTED = /"([^"]+)"/g;

async function goModule(root: string): Promise<string | null> {
  try {
    const txt = await fsp.readFile(path.join(root, "go.mod"), "utf8");
    const m = txt.match(/^\s*module\s+(\S+)/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function goSpecifiers(src: string): string[] {
  const specs: string[] = [];
  GO_IMPORT_BLOCK.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = GO_IMPORT_BLOCK.exec(src))) collect(GO_QUOTED, m[1], specs);
  collect(GO_IMPORT_SINGLE, src, specs);
  return specs;
}

// ---- Symbols (top-level definition names) ----

const SYMBOL_RES: Record<string, RegExp[]> = {
  js: [
    /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)/gm,
    /^\s*export\s+(?:abstract\s+)?class\s+(\w+)/gm,
    /^\s*export\s+(?:const|let|var)\s+(\w+)/gm,
    /^\s*export\s+(?:interface|type|enum)\s+(\w+)/gm,
    /^\s*(?:async\s+)?function\s+(\w+)/gm,
    /^\s*class\s+(\w+)/gm,
  ],
  py: [/^(?:async\s+)?def\s+(\w+)/gm, /^class\s+(\w+)/gm],
  go: [/^func\s+(?:\([^)]*\)\s*)?(\w+)/gm, /^type\s+(\w+)/gm],
  rs: [
    /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/gm,
    /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+(\w+)/gm,
  ],
  rb: [/^\s*def\s+(?:self\.)?(\w+)/gm, /^\s*(?:class|module)\s+(\w+)/gm],
};

function symbolGroup(ext: string): string | null {
  if (JS_EXTS.includes(ext)) return "js";
  if (ext === ".py") return "py";
  if (ext === ".go") return "go";
  if (ext === ".rs") return "rs";
  if (ext === ".rb") return "rb";
  return null;
}

function extractSymbols(ext: string, src: string): string[] {
  const group = symbolGroup(ext);
  if (!group) return [];
  const names: string[] = [];
  for (const re of SYMBOL_RES[group]) collect(re, src, names);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    if (n === "_" || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (out.length >= MAX_SYMBOLS) break;
  }
  return out;
}

/** Scan a project root for resolvable import edges and per-file symbol names. */
export async function buildOverlay(root: string): Promise<Overlay> {
  const files = await walk(root);
  const fileSet = new Set(files);
  const seen = new Set<string>();
  const edges: ImportEdge[] = [];
  const symbols = new Map<string, string[]>();

  const goMod = files.some((f) => path.extname(f) === ".go") ? await goModule(root) : null;
  // dir -> non-test .go files in it, for resolving Go package imports.
  const goDirFiles = new Map<string, string[]>();
  if (goMod) {
    for (const f of files) {
      if (path.extname(f) !== ".go" || f.endsWith("_test.go")) continue;
      const d = path.dirname(f);
      (goDirFiles.get(d) ?? goDirFiles.set(d, []).get(d)!).push(f);
    }
  }

  const addEdge = (from: string, to: string) => {
    if (to === from) return;
    const key = from + "\0" + to;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to });
  };

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

    const syms = extractSymbols(ext, src);
    if (syms.length) symbols.set(file, syms);

    if (JS_EXTS.includes(ext)) {
      for (const spec of jsSpecifiers(src)) {
        const to = resolveJs(spec, file, fileSet);
        if (to) addEdge(file, to);
      }
    } else if (ext === ".py") {
      for (const { dots, module } of pySpecifiers(src)) {
        const to = resolvePy(dots, module, file, root, fileSet);
        if (to) addEdge(file, to);
      }
    } else if (ext === ".rb") {
      const specs: string[] = [];
      collect(RB_REQUIRE_RELATIVE, src, specs);
      for (const spec of specs) {
        const to = resolveRuby(spec, file, fileSet);
        if (to) addEdge(file, to);
      }
    } else if (ext === ".rs") {
      const mods: string[] = [];
      collect(RS_MOD, src, mods);
      for (const name of mods) {
        const to = resolveRust(name, file, fileSet);
        if (to) addEdge(file, to);
      }
    } else if (ext === ".go" && goMod) {
      for (const spec of goSpecifiers(src)) {
        let dir: string | null = null;
        if (spec === goMod) dir = root;
        else if (spec.startsWith(goMod + "/")) dir = path.join(root, spec.slice(goMod.length + 1));
        if (!dir) continue;
        for (const to of goDirFiles.get(dir) ?? []) addEdge(file, to);
      }
    }
  }

  return { root, edges, files, symbols };
}
