// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalFetch:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  type DraftElement,
  elementsFor,
  engineNode,
  exportTree,
  Fragment,
  h,
  type HeldElement,
} from "./elements.ts";
import { library } from "./library.ts";
import { createModContext, evaluateMod, findModsIn, readModManifest } from "./loader.ts";
import type {
  ModAgentEvent,
  ModAsk,
  ModCommand,
  ModElementAddress,
  ModEngineEvent,
  ModPane,
  ModPaneRoster,
  ModPluginInfo,
  ModRenderInput,
  ModRenderResult,
  ModScrollReport,
  ModSurface,
  ModViewport,
} from "./protocol.ts";

/**
 * Runs mods: folders with a `mod.json` and a module that registers event
 * hooks. The engine loads them, runs their hooks, keeps their state, timers
 * and panes, and speaks the host protocol in `protocol.ts`. It needs no agent
 * and no vendor's program: an editor embeds it, draws the trees it answers
 * and reports what the person does.
 */

export interface ModEngineOptions {
  /** The folder of mods, one child folder each; they load in name order. */
  readonly modsDir: string;
  /** The project directory mods see as `$.session.cwd()`. */
  readonly cwd: string;
  /** Where `$.store` keeps each mod's values across sessions. */
  readonly storeDir: string;
  readonly emit: (event: ModEngineEvent) => void;
  /** Puts a mod's request to one client's window; `undefined` when it went unanswered. */
  readonly ask: (clientId: string, ask: ModAsk) => Promise<Record<string, unknown> | undefined>;
  /** How long a mod's file may take to load before it counts as stuck. Five seconds by default. */
  readonly loadTimeoutMs?: number;
  /** Load the mods again when a file under `modsDir` changes. */
  readonly watch?: boolean;
}

type Next = (e?: unknown) => Promise<unknown>;
type HookFn = ($: unknown, e: unknown, next: Next) => unknown;

interface Hook {
  readonly plugin: string;
  readonly event: string;
  readonly matcher: Readonly<Record<string, unknown>> | undefined;
  readonly run: HookFn;
}

interface LoadedPlugin {
  readonly name: string;
  readonly root: string;
  readonly unsupported: Set<string>;
  readonly faults: Set<string>;
  api: unknown;
}

interface SiteLayout {
  bodyRows: number;
  contentRows: number;
  offset: number;
  keyed: ReadonlyArray<{ plugin: string; key: string; top: number; bottom: number }>;
}

const PANE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const HOOK_TIMEOUT_MS = 10_000;
const LOAD_TIMEOUT_MS = 5_000;
const FETCH_TIMEOUT_MS = 30_000;
/** What `command.run` answers when every hook passed the command on. */
const NOT_HANDLED = Symbol("not handled");
const INVALIDATE_FOLD_MS = 40;
const RELOAD_QUIET_MS = 250;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).split("\n")[0]?.slice(0, 300) ?? "";

/** Whether an event's input has every field a hook's matcher names. */
const matches = (matcher: unknown, e: unknown): boolean => {
  if (!isRecord(matcher)) return true;
  if (!isRecord(e)) return false;
  return Object.entries(matcher).every(([key, wanted]) =>
    isRecord(wanted) ? matches(wanted, e[key]) : e[key] === wanted,
  );
};

const instanceKey = (component: string, instanceId: string) => `${component}\u0000${instanceId}`;

export type ModEngine = ReturnType<typeof createModEngine>;

export function createModEngine(options: ModEngineOptions) {
  let { cwd } = options;
  const plugins = new Map<string, LoadedPlugin>();
  const hooks: Hook[] = [];
  const commands = new Map<string, ModCommand>();
  /** Mod folders that did not load, for `plugins()` to say why. */
  const failed: ModPluginInfo[] = [];
  /** Programs mods started, stopped with the engine. */
  const children = new Set<NodeChildProcess.ChildProcess>();
  /** The drawing in flight for each instance: two windows asking at once take turns. */
  const rendering = new Map<string, Promise<unknown>>();
  const panes = new Map<string, ModPane>();
  const clients = new Map<string, { surface: ModSurface; viewport?: ModViewport }>();
  const states = new Map<string, { value: unknown; version: number }>();
  const layouts = new Map<string, SiteLayout>();
  const timers = new Set<() => void>();
  /** The mods showing a status line. */
  const statuses = new Set<string>();
  const statusFolds = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; pending: string | null | undefined }
  >();
  const watchers: NodeFS.FSWatcher[] = [];
  // Handles live for two drawings of their instance: a press may still name the one before.
  const held = new Map<number, { instance: string; element: HeldElement }>();
  const drawn = new Map<string, { current: number[]; previous: number[] }>();
  let handleCount = 0;
  let shownId: string | null = null;
  let focusedId: string | null = null;
  let focusRequestedId: string | null = null;
  let reveal = 0;
  /** Commands running now: a pane opened by one was asked for, and is shown. */
  let commandsRunning = 0;
  let lastRoster = "";
  let invalidateTimer: ReturnType<typeof setTimeout> | null = null;
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;
  let isDisposed = false;

  const emit = (event: ModEngineEvent) => {
    if (!isDisposed) options.emit(event);
  };

  /** Says once per plugin and place that something a mod did failed. */
  const fault = (plugin: string, where: string, error: unknown) => {
    const entry = plugins.get(plugin);
    if (entry === undefined || entry.faults.has(where)) return;
    entry.faults.add(where);
    emit({ type: "log", plugin, text: `${where} failed: ${errorText(error)}` });
  };

  const invalidate = () => {
    if (invalidateTimer !== null || isDisposed) return;
    invalidateTimer = setTimeout(() => {
      invalidateTimer = null;
      emit({ type: "invalidate" });
    }, INVALIDATE_FOLD_MS);
  };

  const emitStatus = (plugin: string, text: string | null) => {
    if (text === null) statuses.delete(plugin);
    else statuses.add(plugin);
    emit({ type: "status", plugin, text });
  };

  /** Sends the first status immediately, then the latest at most once per fold. */
  const status = (plugin: string, text: string | null) => {
    if (isDisposed) return;
    const folding = statusFolds.get(plugin);
    if (folding !== undefined) {
      folding.pending = text;
      return;
    }
    const flush = () => {
      const entry = statusFolds.get(plugin);
      if (entry === undefined) return;
      if (entry.pending === undefined) {
        statusFolds.delete(plugin);
        return;
      }
      const latest = entry.pending;
      entry.pending = undefined;
      entry.timer = setTimeout(flush, INVALIDATE_FOLD_MS);
      emitStatus(plugin, latest);
    };
    statusFolds.set(plugin, {
      timer: setTimeout(flush, INVALIDATE_FOLD_MS),
      pending: undefined,
    });
    emitStatus(plugin, text);
  };

  const stopStatusFolds = () => {
    for (const { timer } of statusFolds.values()) clearTimeout(timer);
    statusFolds.clear();
  };

  const roster = (): ModPaneRoster => ({
    panes: [...panes.values()],
    shownId,
    focusedId,
    focusRequestedId,
    reveal,
  });

  const emitPanes = () => {
    const next = roster();
    const serialized = JSON.stringify(next);
    if (serialized === lastRoster) return;
    lastRoster = serialized;
    emit({ type: "panes", roster: next });
  };

  /**
   * Runs an event through every hook on it, outermost first. A hook that
   * returns without calling `next` answers for itself; one that throws is
   * skipped, as if it had passed the event on.
   */
  const dispatch = (event: string, e: unknown, core: (e: unknown) => unknown): Promise<unknown> => {
    const chain = hooks.filter((hook) => hook.event === event && matches(hook.matcher, e));
    const step = (index: number, current: unknown): Promise<unknown> => {
      const hook = chain[index];
      if (hook === undefined) return Promise.resolve().then(() => core(current));
      let passed: Promise<unknown> | undefined;
      const next: Next = (rewritten) =>
        (passed ??= step(index + 1, rewritten === undefined ? current : rewritten));
      return Promise.resolve()
        .then(() => hook.run(plugins.get(hook.plugin)?.api, current, next))
        .catch((error: unknown) => {
          fault(hook.plugin, event, error);
          return passed ?? step(index + 1, current);
        });
    };
    return step(0, e);
  };

  const withTimeout = <T>(work: Promise<T>, fallback: T): Promise<T> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(fallback), HOOK_TIMEOUT_MS);
      void work.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        () => {
          clearTimeout(timer);
          resolve(fallback);
        },
      );
    });

  /** Puts a request to the first window that can answer it. */
  const ask = async (request: ModAsk) => {
    for (const clientId of clients.keys()) {
      const answer = await options.ask(clientId, request);
      if (answer !== undefined) return answer;
    }
    return undefined;
  };

  const closePane = async (id: string, kind: "plugin" | "person") => {
    if (!panes.has(id)) return true;
    await withTimeout(
      dispatch("ui.close", { id, origin: { kind } }, () => {
        panes.delete(id);
        layouts.delete(instanceKey("Pane", id));
        if (shownId === id) shownId = [...panes.keys()].at(-1) ?? null;
        if (focusedId === id) focusedId = null;
        if (focusRequestedId === id) focusRequestedId = null;
        return undefined;
      }),
      undefined,
    );
    emitPanes();
    return !panes.has(id);
  };

  /** Where a plugin's scroll lands in a site, from the layout its client last reported. */
  const scrollSite = (plugin: string, args: unknown) => {
    const to = isRecord(args) ? args.to : undefined;
    const requested = isRecord(args) && typeof args.in === "string" ? args.in : undefined;
    const site =
      requested ?? [...panes.values()].find((pane) => pane.plugin === plugin)?.id ?? "above-prompt";
    const component = site === "above-prompt" ? "AbovePrompt" : "Pane";
    const layout = layouts.get(instanceKey(component, site));
    if (layout === undefined) return { moved: false, offset: 0, deny: "no such site" };
    const last = Math.max(0, layout.contentRows - layout.bodyRows);
    let offset = layout.offset;
    if (to === "start") offset = 0;
    else if (to === "end") offset = last;
    else if (isRecord(to) && typeof to.key === "string") {
      const target = layout.keyed.find((entry) => entry.plugin === plugin && entry.key === to.key);
      if (target === undefined) return { moved: false, offset, deny: "no such element" };
      const block = isRecord(args) ? args.block : undefined;
      const isShown = target.top >= offset && target.bottom <= offset + layout.bodyRows;
      if (block === "start") offset = target.top;
      else if (block === "end") offset = target.bottom - layout.bodyRows;
      else if (block === "center") {
        offset = Math.round((target.top + target.bottom - layout.bodyRows) / 2);
      } else if (!isShown) {
        offset = target.top < offset ? target.top : target.bottom - layout.bodyRows;
      }
    }
    offset = Math.min(last, Math.max(0, offset));
    layout.offset = offset;
    for (const clientId of clients.keys()) {
      emit({
        type: "scroll",
        clientId,
        component,
        instanceId: site,
        offset,
        ...(to === "end" ? { followEnd: true as const } : {}),
      });
    }
    return { moved: true, offset };
  };

  const storePath = (plugin: string) => NodePath.join(options.storeDir, `${plugin}.json`);
  const readStore = (plugin: string): Record<string, unknown> => {
    try {
      const data: unknown = JSON.parse(NodeFS.readFileSync(storePath(plugin), "utf8"));
      return isRecord(data) ? data : {};
    } catch {
      return {};
    }
  };
  const writeStore = (plugin: string, data: Record<string, unknown>) => {
    NodeFS.mkdirSync(options.storeDir, { recursive: true });
    NodeFS.writeFileSync(storePath(plugin), JSON.stringify(data));
  };

  const resolvePath = (path: string) => NodePath.resolve(cwd, path);

  /** The `$` a plugin's hooks are handed. Anything it lacks rejects and is noted once. */
  const apiFor = (plugin: LoadedPlugin): unknown => {
    const name = plugin.name;
    const missing = (path: string) => () => {
      if (!plugin.unsupported.has(path)) {
        plugin.unsupported.add(path);
        emit({ type: "log", plugin: name, text: `${path} is not available in this host` });
      }
      return Promise.reject(new Error(`${path} is not available in this host`));
    };
    const noun = (label: string, methods: Record<string, unknown>) =>
      new Proxy(methods, {
        get: (target, property) =>
          typeof property !== "string" || property in target
            ? target[property as string]
            : property === "then"
              ? undefined
              : missing(`$.${label}.${property}`),
      });
    const stateKey = (ref: unknown) =>
      isRecord(ref)
        ? `${String(ref.plugin)}\u0000${String(ref.key)}\u0000${String(ref.id ?? "")}`
        : "";
    const schedule = (repeat: boolean) => (ms: number, run: () => unknown) => {
      const guarded = () => {
        void Promise.resolve()
          .then(run)
          .catch((error: unknown) => fault(name, "a timer", error));
      };
      const handle = repeat ? setInterval(guarded, ms) : setTimeout(guarded, ms);
      const cancel = () => (repeat ? clearInterval(handle) : clearTimeout(handle));
      timers.add(cancel);
      return {
        cancel: () => {
          timers.delete(cancel);
          cancel();
        },
      };
    };

    const nouns: Record<string, unknown> = {
      ui: noun("ui", {
        resolve: (e: unknown) =>
          elementsFor(
            isRecord(e) ? ((e.surface as ModSurface | undefined) ?? "desktop") : "desktop",
            name,
          ),
        invalidate: () => invalidate(),
        status: (text: unknown) => {
          const line = typeof text === "string" && text !== "" ? text : null;
          status(name, line);
        },
        toast: (text: unknown, toastOptions?: unknown) =>
          emit({
            type: "toast",
            plugin: name,
            text: String(text),
            timeoutMs:
              isRecord(toastOptions) && typeof toastOptions.timeoutMs === "number"
                ? toastOptions.timeoutMs
                : 4000,
          }),
        log: (text: unknown, logOptions?: unknown) => {
          if (isRecord(logOptions) && logOptions.to === "debug") return;
          emit({ type: "log", plugin: name, text: String(text) });
        },
        open: async (pane: unknown) => {
          if (!isRecord(pane) || typeof pane.id !== "string" || !PANE_ID.test(pane.id)) {
            throw new Error("$.ui.open needs an id of letters, digits, _ or -");
          }
          panes.set(pane.id, {
            id: pane.id,
            title:
              typeof pane.title === "string" ? pane.title : (panes.get(pane.id)?.title ?? pane.id),
            plugin: name,
            ...(pane.closeOnEscape === true ? { closeOnEscape: true as const } : {}),
            ...(pane.holdToasts === true ? { holdToasts: true as const } : {}),
            ...(typeof pane.rows === "number" ? { rows: pane.rows } : {}),
            ...(typeof pane.columns === "number" ? { columns: pane.columns } : {}),
          });
          shownId = pane.id;
          if (commandsRunning > 0) reveal += 1;
          if (pane.focus === true) focusRequestedId = pane.id;
          emitPanes();
          return clients.size > 0
            ? { isPlaced: true }
            : { isPlaced: false, reason: "no window is attached yet" };
        },
        close: async (pane: unknown) => {
          if (isRecord(pane) && typeof pane.id === "string") await closePane(pane.id, "plugin");
        },
        panes: async () =>
          [...panes.values()].map((pane) => ({
            id: pane.id,
            title: pane.title,
            isShown: pane.id === shownId,
            isFocused: pane.id === focusedId,
            isPlaced: clients.size > 0,
          })),
        scroll: async (args: unknown) => scrollSite(name, args),
        post: (args: unknown) => {
          if (!isRecord(args) || typeof args.key !== "string") {
            throw new Error("$.ui.post needs the key of a Frame");
          }
          const site =
            typeof args.in === "string"
              ? args.in
              : ([...panes.values()].find((pane) => pane.plugin === name)?.id ?? "above-prompt");
          for (const clientId of clients.keys()) {
            emit({
              type: "post",
              clientId,
              component: site === "above-prompt" ? "AbovePrompt" : "Pane",
              instanceId: site,
              plugin: name,
              key: args.key,
              data: args.data ?? null,
            });
          }
        },
        copy: async (args: unknown) => {
          const text = isRecord(args) && typeof args.text === "string" ? args.text : "";
          const answer = await ask({ kind: "copy", plugin: name, text });
          return answer?.copied === true
            ? { isCopied: true }
            : { isCopied: false, reason: clients.size === 0 ? "no-surface" : "no-clipboard" };
        },
        selection: async () => {
          const answer = await ask({ kind: "readSelection" });
          return typeof answer?.text === "string" && answer.text !== ""
            ? { text: answer.text }
            : undefined;
        },
      }),
      command: noun("command", {
        register: async (spec: unknown) => {
          if (!isRecord(spec) || typeof spec.name !== "string" || spec.name === "") {
            throw new Error("$.command.register needs a name");
          }
          const owner = commands.get(spec.name)?.plugin;
          if (owner !== undefined && owner !== name) {
            throw new Error(`/${spec.name} already belongs to the mod ${owner}`);
          }
          commands.set(spec.name, {
            name: spec.name,
            description: typeof spec.description === "string" ? spec.description : "",
            ...(typeof spec.argumentHint === "string" && spec.argumentHint !== ""
              ? { argumentHint: spec.argumentHint }
              : {}),
            plugin: name,
          });
          emit({ type: "commands", commands: [...commands.values()] });
          return { command: spec.name };
        },
        list: async () => [...commands.values()],
      }),
      state: noun("state", {
        get: async (ref: unknown) => {
          const entry = states.get(stateKey(ref));
          return { value: entry?.value, version: entry?.version ?? 0 };
        },
        set: async (ref: unknown, value: unknown, setOptions?: unknown) => {
          const key = stateKey(ref);
          const version = states.get(key)?.version ?? 0;
          if (isRecord(setOptions) && typeof setOptions.ifVersion === "number") {
            if (setOptions.ifVersion !== version) return { isSet: false, version };
          }
          states.set(key, { value, version: version + 1 });
          invalidate();
          return { isSet: true, version: version + 1 };
        },
      }),
      store: noun("store", {
        get: async (key: string) => readStore(name)[key],
        set: async (key: string, value: unknown) =>
          writeStore(name, { ...readStore(name), [key]: value }),
        delete: async (key: string) => {
          const { [key]: _removed, ...rest } = readStore(name);
          writeStore(name, rest);
        },
      }),
      clock: noun("clock", {
        now: async () => Date.now(),
        sleep: (ms: number) =>
          new Promise<void>((resolve) => {
            const handle = setTimeout(() => {
              timers.delete(cancel);
              resolve();
            }, ms);
            const cancel = () => clearTimeout(handle);
            timers.add(cancel);
          }),
        after: schedule(false),
        every: schedule(true),
      }),
      fs: noun("fs", {
        read: async (path: string, readOptions?: unknown) =>
          isRecord(readOptions) && readOptions.as === "bytes"
            ? { base64: (await NodeFS.promises.readFile(resolvePath(path))).toString("base64") }
            : NodeFS.promises.readFile(resolvePath(path), "utf8"),
        write: async (path: string, text: string) => {
          await NodeFS.promises.mkdir(NodePath.dirname(resolvePath(path)), { recursive: true });
          await NodeFS.promises.writeFile(resolvePath(path), text);
        },
        exists: async (path: string) => NodeFS.existsSync(resolvePath(path)),
        list: async (path: string) =>
          (await NodeFS.promises.readdir(resolvePath(path), { withFileTypes: true })).map(
            (entry) => ({
              name: entry.name,
              kind: entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other",
            }),
          ),
        stat: async (path: string) => {
          const stat = await NodeFS.promises.lstat(resolvePath(path));
          return {
            kind: stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other",
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            isLink: stat.isSymbolicLink(),
          };
        },
      }),
      process: noun("process", {
        run: (argv: ReadonlyArray<string>, init?: unknown) =>
          new Promise((resolve, reject) => {
            const [file, ...args] = argv;
            if (typeof file !== "string") {
              reject(new Error("$.process.run needs an argument vector"));
              return;
            }
            const settings = isRecord(init) ? init : {};
            const child = NodeChildProcess.execFile(
              file,
              args,
              {
                cwd: typeof settings.cwd === "string" ? resolvePath(settings.cwd) : cwd,
                env: {
                  ...process.env,
                  ...(isRecord(settings.env) ? (settings.env as NodeJS.ProcessEnv) : {}),
                },
                timeout: typeof settings.timeoutMs === "number" ? settings.timeoutMs : 30_000,
                maxBuffer: MAX_OUTPUT_BYTES,
                encoding: "utf8",
              },
              (error, stdout, stderr) => {
                const isTruncated = error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
                resolve({
                  exitCode: error === null ? 0 : typeof error.code === "number" ? error.code : 1,
                  stdout,
                  stderr,
                  isStdoutTruncated: isTruncated,
                  isStderrTruncated: isTruncated,
                });
              },
            );
            children.add(child);
            child.once("close", () => children.delete(child));
            if (typeof settings.stdin === "string") child.stdin?.end(settings.stdin);
          }),
      }),
      http: noun("http", {
        fetch: async (url: string, init?: unknown) => {
          if (!/^https?:\/\//.test(url)) throw new Error("$.http.fetch takes an http or https URL");
          const settings = isRecord(init) ? init : {};
          const response = await fetch(url, {
            method: typeof settings.method === "string" ? settings.method : "GET",
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            ...(isRecord(settings.headers)
              ? { headers: settings.headers as Record<string, string> }
              : {}),
            ...(typeof settings.body === "string" ? { body: settings.body } : {}),
          });
          return {
            status: response.status,
            ok: response.ok,
            headers: Object.fromEntries(response.headers.entries()),
            text: await response.text(),
          };
        },
      }),
      session: noun("session", {
        cwd: async () => cwd,
        surfaces: async () => [...new Set([...clients.values()].map((client) => client.surface))],
        version: async () => ({ version: "0.1.0", base: "0.1.0", builtAt: "" }),
      }),
      prompt: noun("prompt", {
        read: async () => {
          const answer = await ask({ kind: "promptRead" });
          return {
            text: typeof answer?.text === "string" ? answer.text : "",
            cursor: typeof answer?.cursor === "number" ? answer.cursor : 0,
          };
        },
        fill: async (input: unknown) => {
          const text = isRecord(input) && typeof input.text === "string" ? input.text : "";
          const mode = isRecord(input) ? input.mode : undefined;
          const answer = await ask({
            kind: "promptFill",
            text,
            mode: mode === "append" || mode === "insert" ? mode : "replace",
          });
          return answer?.filled === true
            ? { isFilled: true, text, cursor: text.length }
            : { isFilled: false, refusal: "no_composer", text: "", cursor: 0 };
        },
      }),
    };
    return new Proxy(nouns, {
      get: (target, property) =>
        typeof property !== "string" || property in target
          ? target[property as string]
          : property === "then"
            ? undefined
            : noun(property, {}),
    });
  };

  const loadPlugin = (root: string, context: ReturnType<typeof createModContext>) => {
    let name = NodePath.basename(root);
    const hooksBefore = hooks.length;
    let loaded: LoadedPlugin | undefined;
    try {
      const manifest = readModManifest(root);
      name = manifest.name;
      if (plugins.has(name)) throw new Error(`another mod is already named ${name}`);
      loaded = { name, root, unsupported: new Set(), faults: new Set(), api: null };
      loaded.api = apiFor(loaded);
      plugins.set(name, loaded);
      const on = (event: string, matcherOrHook: unknown, maybeHook?: unknown) => {
        const run = typeof matcherOrHook === "function" ? matcherOrHook : maybeHook;
        if (typeof event !== "string" || typeof run !== "function") {
          throw new Error("on(event, matcher?, hook) needs an event name and a hook");
        }
        hooks.push({
          plugin: name,
          event,
          matcher: isRecord(matcherOrHook) ? matcherOrHook : undefined,
          run: run as HookFn,
        });
      };
      const mod = evaluateMod(manifest, library, context, options.loadTimeoutMs ?? LOAD_TIMEOUT_MS);
      if (typeof mod.exports.register !== "function") {
        throw new Error("a mod must export register(on)");
      }
      mod.call(mod.exports.register, on);
    } catch (error) {
      // A mod that failed halfway leaves nothing behind: no hook of it runs.
      hooks.length = hooksBefore;
      if (loaded !== undefined) plugins.delete(name);
      const reason = errorText(error);
      failed.push({ name, path: root, error: reason, unsupported: [] });
      emit({ type: "log", plugin: name, text: `did not load: ${reason}` });
    }
  };

  const load = async () => {
    const context = createModContext({ h, Fragment });
    for (const root of findModsIn(options.modsDir)) loadPlugin(root, context);
    const surface = [...clients.values()][0]?.surface ?? null;
    await withTimeout(
      dispatch("session.start", { cwd: cwd, surface, isInteractive: true }, () => undefined),
      undefined,
    );
    emitPanes();
  };

  const stopTimers = () => {
    for (const cancel of timers) cancel();
    timers.clear();
  };

  const reloadOnce = async () => {
    stopTimers();
    stopStatusFolds();
    hooks.length = 0;
    plugins.clear();
    failed.length = 0;
    commands.clear();
    held.clear();
    drawn.clear();
    // Status lines are set again by the mods that still want one.
    for (const plugin of statuses) emit({ type: "status", plugin, text: null });
    statuses.clear();
    await load();
    // A mod that was removed takes its panes with it.
    for (const pane of panes.values()) {
      if (plugins.has(pane.plugin)) continue;
      panes.delete(pane.id);
      layouts.delete(instanceKey("Pane", pane.id));
      if (shownId === pane.id) shownId = [...panes.keys()].at(-1) ?? null;
      if (focusedId === pane.id) focusedId = null;
      if (focusRequestedId === pane.id) focusRequestedId = null;
    }
    emitPanes();
    emit({ type: "commands", commands: [...commands.values()] });
    emit({ type: "invalidate" });
  };

  // One load at a time: a file saved while the mods are still starting waits
  // its turn, or two loads would register every hook and command twice.
  let loading: Promise<void> | null = null;
  let isReloadWaiting = false;
  const exclusively = (work: () => Promise<void>): Promise<void> => {
    loading = work().finally(() => {
      loading = null;
      if (!isReloadWaiting || isDisposed) return;
      isReloadWaiting = false;
      return exclusively(reloadOnce);
    });
    return loading;
  };

  /** Loads the mods again after an edit: hooks, commands and timers anew, state and panes kept. */
  const reload = (): Promise<void> => {
    if (loading === null) return exclusively(reloadOnce);
    isReloadWaiting = true;
    return loading;
  };

  const resolveHeld = (address: ModElementAddress) => {
    const direct = held.get(address.handle);
    if (direct !== undefined && direct.element.plugin === address.plugin) return direct;
    // A redraw retired the handle: the element under the same key stands in for it.
    if (address.key === undefined || address.component === undefined) return undefined;
    const instance = instanceKey(address.component, address.instanceId ?? "");
    for (const handle of drawn.get(instance)?.current ?? []) {
      const entry = held.get(handle);
      if (entry?.element.plugin === address.plugin && entry.element.key === address.key)
        return entry;
    }
    return undefined;
  };

  const pressArgument = (
    address: ModElementAddress,
    entry: { instance: string; element: HeldElement },
  ) => {
    const [component = "", requestId = ""] = entry.instance.split("\u0000");
    return {
      plugin: entry.element.plugin,
      element: entry.element.key,
      component,
      requestId,
      surface: clients.get(address.clientId)?.surface ?? "desktop",
    };
  };

  const callHandler = async (plugin: string, where: string, run: () => unknown) => {
    try {
      await run();
    } catch (error) {
      fault(plugin, where, error);
    }
  };

  const renderOnce = async (
    input: ModRenderInput & {
      readonly contentRows?: number;
      readonly keyed?: SiteLayout["keyed"];
    },
  ): Promise<ModRenderResult> => {
    const { component, instanceId, props } = input;
    const isForComponent = (hook: Hook) =>
      hook.event === "ui.render" &&
      (hook.matcher?.component === undefined || hook.matcher.component === component);
    const e = {
      component,
      surface: clients.get(input.clientId)?.surface ?? "desktop",
      requestId: instanceId,
      props,
      ...(input.viewport === undefined ? {} : { viewport: input.viewport }),
    };
    const untouched = { tree: engineNode(0), props, rewritten: false };
    const first = hooks.find((hook) => hook.event === "ui.render" && matches(hook.matcher, e));
    if (first === undefined) return { ...untouched, hooked: hooks.some(isForComponent) };
    if (component === "Pane" || component === "AbovePrompt") {
      const scroll = isRecord(props.scroll) ? props.scroll : {};
      const key = instanceKey(component, instanceId);
      layouts.set(key, {
        bodyRows: typeof scroll.bodyRows === "number" ? scroll.bodyRows : 0,
        contentRows: input.contentRows ?? layouts.get(key)?.contentRows ?? 0,
        offset: typeof scroll.offset === "number" ? scroll.offset : 0,
        keyed: input.keyed ?? layouts.get(key)?.keyed ?? [],
      });
    }
    let reached: Record<string, unknown> | undefined;
    const result = await withTimeout(
      dispatch("ui.render", e, (passed) => {
        reached = isRecord(passed) && isRecord(passed.props) ? passed.props : props;
        return engineNode(1);
      }),
      undefined,
    );
    if (result === undefined || result === null) return { ...untouched, hooked: true };
    const instance = instanceKey(component, instanceId);
    const handles: number[] = [];
    try {
      const tree = exportTree(result as DraftElement, first.plugin, (element) => {
        handleCount += 1;
        held.set(handleCount, { instance, element });
        handles.push(handleCount);
        return handleCount;
      });
      const before = drawn.get(instance);
      for (const handle of before?.previous ?? []) held.delete(handle);
      drawn.set(instance, { current: handles, previous: before?.current ?? [] });
      return { tree, props: reached ?? props, rewritten: reached !== undefined, hooked: true };
    } catch (error) {
      for (const handle of handles) held.delete(handle);
      fault(first.plugin, `ui.render (${component})`, error);
      return { ...untouched, hooked: true };
    }
  };

  return {
    /** Loads the mods and runs their `session.start` hooks. */
    async start() {
      await exclusively(load);
      if (options.watch !== true) return;
      try {
        const watcher = NodeFS.watch(options.modsDir, { recursive: true }, () => {
          if (reloadTimer !== null) clearTimeout(reloadTimer);
          reloadTimer = setTimeout(() => {
            reloadTimer = null;
            if (!isDisposed) void reload();
          }, RELOAD_QUIET_MS);
        });
        watcher.on("error", () => {});
        watchers.push(watcher);
      } catch {
        // A folder that cannot be watched still runs; it just does not reload.
      }
    },

    reload,

    /** The project folder moved, as when a thread gets its own worktree. */
    setCwd(next: string) {
      cwd = next;
    },

    /** A window starts drawing for this session, or reports a new size. */
    attach(clientId: string, client: { surface: ModSurface; viewport?: ModViewport }) {
      clients.set(clientId, client);
      emit({ type: "panes", roster: roster() });
    },

    detach(clientId: string) {
      clients.delete(clientId);
    },

    /** Asks the mods to draw one component instance for a client. */
    render(
      input: ModRenderInput & {
        readonly contentRows?: number;
        readonly keyed?: SiteLayout["keyed"];
      },
    ): Promise<ModRenderResult> {
      const key = instanceKey(input.component, input.instanceId);
      const turn = (rendering.get(key) ?? Promise.resolve()).then(() => renderOnce(input));
      const settled = turn.then(
        () => {},
        () => {},
      );
      rendering.set(key, settled);
      void settled.then(() => {
        if (rendering.get(key) === settled) rendering.delete(key);
      });
      return turn;
    },

    /** Runs a command a mod registered. `handled` is false when no mod took it. */
    async runCommand(name: string, args = "") {
      if (!commands.has(name)) return { handled: false };
      commandsRunning += 1;
      const result = await withTimeout(
        dispatch(
          "command.run",
          {
            command: name,
            args,
            origin: { kind: "composer" },
            presentation: { isFullscreen: true },
          },
          () => NOT_HANDLED,
        ),
        undefined,
      ).finally(() => {
        commandsRunning -= 1;
      });
      if (result === NOT_HANDLED) return { handled: false };
      return {
        handled: true,
        plugin: commands.get(name)?.plugin ?? "",
        ...(isRecord(result) && typeof result.text === "string" ? { text: result.text } : {}),
      };
    },

    /** The person pressed a Button, or a link in a Markdown whose mod answers its links. */
    async press(address: ModElementAddress & { readonly href?: string }) {
      const entry = resolveHeld(address);
      if (entry === undefined) return { handled: false };
      const { element } = entry;
      const argument = {
        ...pressArgument(address, entry),
        ...(address.href === undefined ? {} : { link: { href: address.href } }),
      };
      await withTimeout(
        dispatch("ui.press", argument, (reached) =>
          callHandler(element.plugin, `ui.press (${element.key})`, () => {
            if (element.type === "Markdown") {
              return (
                element.props.onLinkPress as ((href: string, e: unknown) => unknown) | undefined
              )?.(address.href ?? "", reached);
            }
            return (element.props.onPress as ((e: unknown) => unknown) | undefined)?.(reached);
          }),
        ),
        undefined,
      );
      return { handled: true, element: element.key };
    },

    /** The person edited an Input, or pressed Enter in it. */
    async input(
      address: ModElementAddress & { readonly kind: "change" | "submit"; readonly value: string },
    ) {
      const entry = resolveHeld(address);
      if (entry === undefined || entry.element.type !== "Input") return { handled: false };
      const { element } = entry;
      const argument = {
        ...pressArgument(address, entry),
        kind: address.kind,
        value: address.value,
      };
      await withTimeout(
        dispatch("ui.input", argument, (reached) => {
          const value =
            isRecord(reached) && typeof reached.value === "string" ? reached.value : address.value;
          const handler =
            address.kind === "change" ? element.props.onInput : element.props.onSubmit;
          return callHandler(element.plugin, `ui.input (${element.key})`, () =>
            (handler as ((value: string, e: unknown) => unknown) | undefined)?.(value, reached),
          );
        }),
        undefined,
      );
      return { handled: true, element: element.key, value: address.value };
    },

    /** The person picked an option of a Select. */
    async select(address: ModElementAddress & { readonly value: string }) {
      const entry = resolveHeld(address);
      if (entry === undefined || entry.element.type !== "Select") return { handled: false };
      const { element } = entry;
      const options = Array.isArray(element.props.options) ? element.props.options : [];
      if (!options.some((option) => isRecord(option) && option.value === address.value)) {
        return { handled: false };
      }
      const argument = { ...pressArgument(address, entry), value: address.value };
      await withTimeout(
        dispatch("ui.select", argument, (reached) =>
          callHandler(element.plugin, `ui.select (${element.key})`, () =>
            (element.props.onSelect as ((value: string, e: unknown) => unknown) | undefined)?.(
              address.value,
              reached,
            ),
          ),
        ),
        undefined,
      );
      return { handled: true, element: element.key, value: address.value };
    },

    /** The page inside a Frame sent its mod something. */
    async message(address: ModElementAddress & { readonly data: unknown }) {
      const entry = resolveHeld(address);
      if (entry === undefined || entry.element.type !== "Frame") return { handled: false };
      const { element } = entry;
      const argument = { ...pressArgument(address, entry), data: address.data };
      await withTimeout(
        dispatch("ui.message", argument, (reached) =>
          callHandler(element.plugin, `ui.message (${element.key})`, () =>
            (element.props.onMessage as ((data: unknown, e: unknown) => unknown) | undefined)?.(
              address.data,
              reached,
            ),
          ),
        ),
        undefined,
      );
      return { handled: true, element: element.key };
    },

    panes: roster,

    /** The person chose which open pane shows. */
    paneShow(id: string) {
      if (panes.has(id)) shownId = id;
      emitPanes();
      return { shownId };
    },

    /** The keyboard moved into a pane, or back to the composer (`null`). */
    paneFocus(id: string | null) {
      focusedId = id !== null && panes.has(id) ? id : null;
      if (focusedId !== null) shownId = focusedId;
      focusRequestedId = null;
      emitPanes();
      return { focusedId };
    },

    /** The person closed a pane; a mod's `ui.close` hook may keep it open. */
    async close(id: string) {
      return { closed: await closePane(id, "person") };
    },

    /** The person scrolled a site: records its layout and answers where the window stays. */
    scroll(report: ModScrollReport) {
      const key = instanceKey(report.component, report.instanceId);
      if (report.component === "Pane" && !panes.has(report.instanceId)) {
        return { moved: false, offset: report.offset, deny: "no such site" };
      }
      const offset = Math.min(
        Math.max(0, report.contentRows - report.bodyRows),
        Math.max(0, report.offset),
      );
      layouts.set(key, {
        bodyRows: report.bodyRows,
        contentRows: report.contentRows,
        offset,
        keyed: report.keyed ?? layouts.get(key)?.keyed ?? [],
      });
      return { moved: true, offset };
    },

    commands: () => [...commands.values()],

    /** Tells the mods what the agent did. They observe; the turn does not wait on them. */
    async notify(event: ModAgentEvent) {
      const input =
        event.name === "tool.call"
          ? { ...event.input, tool: event.tool, tool_use_id: event.toolUseId }
          : event.name === "prompt.submit"
            ? { text: event.text, wait: false, origin: { kind: "composer" } }
            : event.name === "turn.start"
              ? { text: event.text, turnId: event.turnId }
              : { turnId: event.turnId, reason: event.reason };
      await withTimeout(
        dispatch(event.name, input, () => ({})),
        undefined,
      );
    },

    plugins: (): ReadonlyArray<ModPluginInfo> => [
      ...[...plugins.values()].map((plugin) => ({
        name: plugin.name,
        path: plugin.root,
        unsupported: [...plugin.unsupported],
      })),
      ...failed,
    ],

    /** Stops every timer, watcher and program a mod started; the engine tells its host nothing more. */
    dispose() {
      isDisposed = true;
      stopTimers();
      stopStatusFolds();
      for (const child of children) child.kill();
      for (const watcher of watchers) watcher.close();
      if (invalidateTimer !== null) clearTimeout(invalidateTimer);
      if (reloadTimer !== null) clearTimeout(reloadTimer);
    },
  };
}
