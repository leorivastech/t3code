// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalFetch:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";

import { transform } from "sucrase";

/**
 * Finds mods and evaluates their code. A mod is a folder with a `mod.json`
 * and a module that exports `register(on)`. The module runs in a context of
 * its own, with no DOM and no Node: everything outside it is reached through
 * the `$` its hooks are handed.
 */

export interface ModManifest {
  readonly name: string;
  readonly description: string;
  readonly root: string;
  /** Absolute path of the module that exports `register`. */
  readonly module: string;
}

const MODULE_EXTENSIONS = [".tsx", ".ts", ".jsx", ".mjs", ".js"];
const TEXT_EXTENSIONS = [".html", ".css", ".svg", ".txt", ".md"];
const MAX_MODULE_BYTES = 1024 * 1024;

const readJson = (path: string): unknown => JSON.parse(NodeFS.readFileSync(path, "utf8"));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const MAIN_NAMES = ["mod.tsx", "mod.ts", "mod.jsx", "mod.mjs", "mod.js"];

/**
 * Reads a mod folder's `mod.json`. Throws with a message fit to show the
 * person when the folder is not a mod.
 */
export function readModManifest(root: string): ModManifest {
  const manifestPath = NodePath.join(root, "mod.json");
  if (!NodeFS.existsSync(manifestPath)) throw new Error("no mod.json");
  const manifest = readJson(manifestPath);
  const name = isRecord(manifest) && typeof manifest.name === "string" ? manifest.name : "";
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) throw new Error("mod.json has no valid name");
  const description =
    isRecord(manifest) && typeof manifest.description === "string" ? manifest.description : "";
  const named = isRecord(manifest) && typeof manifest.main === "string" ? manifest.main : undefined;
  const main = named ?? MAIN_NAMES.find((file) => NodeFS.existsSync(NodePath.join(root, file)));
  if (main === undefined) throw new Error('no mod.tsx (or a "main" in mod.json)');
  const module = NodePath.resolve(root, main);
  if (!module.startsWith(root + NodePath.sep)) throw new Error('"main" lies outside the mod');
  if (!NodeFS.existsSync(module)) throw new Error(`${main} is missing`);
  return { name, description, root, module };
}

/** Compiles a hooks module, TypeScript and JSX included, to CommonJS against `h`. */
function compile(path: string, source: string): string {
  const isTypeScript = path.endsWith(".ts") || path.endsWith(".tsx");
  return transform(source, {
    transforms: ["imports", "jsx", ...(isTypeScript ? (["typescript"] as const) : [])],
    jsxPragma: "h",
    jsxFragmentPragma: "Fragment",
    production: true,
    filePath: path,
  }).code;
}

function resolveModule(root: string, from: string, specifier: string): string {
  const base = NodePath.resolve(NodePath.dirname(from), specifier);
  const candidates = [
    base,
    ...MODULE_EXTENSIONS.map((extension) => base + extension),
    ...MODULE_EXTENSIONS.map((extension) => NodePath.join(base, `index${extension}`)),
  ];
  const found = candidates.find(
    (candidate) => NodeFS.existsSync(candidate) && NodeFS.statSync(candidate).isFile(),
  );
  // A module that only declares types leaves nothing to load.
  if (found === undefined) {
    if (NodeFS.existsSync(`${base}.d.ts`) || NodeFS.existsSync(NodePath.join(base, "index.d.ts"))) {
      return "";
    }
    throw new Error(`cannot find "${specifier}" from ${NodePath.relative(root, from)}`);
  }
  if (!found.startsWith(root + NodePath.sep)) {
    throw new Error(`"${specifier}" lies outside the mod`);
  }
  return found;
}

/** A module compiled once per version of its file, however many threads load it. */
const scripts = new Map<string, { readonly stamp: string; readonly script: NodeVM.Script }>();

function scriptFor(path: string): NodeVM.Script {
  const stat = NodeFS.statSync(path);
  const stamp = `${stat.mtimeMs}:${stat.size}`;
  const known = scripts.get(path);
  if (known?.stamp === stamp) return known.script;
  const script = new NodeVM.Script(
    `(function (exports, require, module) {${compile(path, NodeFS.readFileSync(path, "utf8"))}\n})`,
    { filename: path },
  );
  scripts.set(path, { stamp, script });
  return script;
}

/**
 * The context one loading of a session's mods runs in. Its mods share it,
 * each module in a scope of its own: a context apiece costs about a megabyte,
 * and every open thread loads every mod. `globals` are the names every module
 * sees (`h`, `Fragment`).
 */
export function createModContext(globals: Readonly<Record<string, unknown>>): NodeVM.Context {
  return NodeVM.createContext({ ...globals, console: quietConsole });
}

/**
 * Evaluates a mod's module in `context` and returns its exports. `library` is
 * what `import ... from "mods"` resolves to. `call` runs one of the mod's
 * functions the same way the module itself ran: under the timeout, so code
 * that never returns while loading is an error and not a hang.
 */
export function evaluateMod(
  manifest: ModManifest,
  library: Readonly<Record<string, unknown>>,
  context: NodeVM.Context,
  timeoutMs: number,
): {
  readonly exports: Record<string, unknown>;
  readonly call: (fn: unknown, ...args: ReadonlyArray<unknown>) => unknown;
} {
  const loaded = new Map<string, unknown>();
  const invoke = new NodeVM.Script("__invoke()");
  const call = (fn: unknown, ...args: ReadonlyArray<unknown>): unknown => {
    context.__invoke = () => (fn as (...values: ReadonlyArray<unknown>) => unknown)(...args);
    return invoke.runInContext(context, { timeout: timeoutMs });
  };

  // What `require` answers: a module's exports, or a data file's value, which the
  // compiled import then offers as its default.
  const load = (path: string): unknown => {
    if (loaded.has(path)) return loaded.get(path);
    if (path.endsWith(".json")) {
      const data = readJson(path);
      loaded.set(path, data);
      return data;
    }
    // A page for a Frame, a stylesheet, a drawing: imported as its text.
    if (TEXT_EXTENSIONS.some((extension) => path.endsWith(extension))) {
      const text = NodeFS.readFileSync(path, "utf8");
      loaded.set(path, text);
      return text;
    }
    if (NodeFS.statSync(path).size > MAX_MODULE_BYTES) {
      throw new Error(`${NodePath.relative(manifest.root, path)} is larger than 1 MiB`);
    }
    const module = { exports: {} as Record<string, unknown> };
    // Set before it runs, so two modules that import each other both finish.
    loaded.set(path, module.exports);
    const require = (specifier: string): unknown => {
      if (specifier === "mods") return library;
      if (!specifier.startsWith(".")) {
        throw new Error(`a mod cannot import "${specifier}": it reaches the outside through $`);
      }
      const resolved = resolveModule(manifest.root, path, specifier);
      return resolved === "" ? {} : load(resolved);
    };
    const wrapper = scriptFor(path).runInContext(context, { timeout: timeoutMs }) as (
      exports: unknown,
      require: unknown,
      module: unknown,
    ) => void;
    call(wrapper, module.exports, require, module);
    loaded.set(path, module.exports);
    return module.exports;
  };

  return { exports: load(manifest.module) as Record<string, unknown>, call };
}

const quietConsole = {
  log: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

/** The mod folders under a mods folder: each child that carries a `mod.json`. */
export function findModsIn(modsDir: string): ReadonlyArray<string> {
  if (!NodeFS.existsSync(modsDir)) return [];
  return NodeFS.readdirSync(modsDir, { withFileTypes: true })
    .map((entry) => NodePath.join(modsDir, entry.name))
    .filter((root) => NodeFS.existsSync(NodePath.join(root, "mod.json")))
    .toSorted();
}
