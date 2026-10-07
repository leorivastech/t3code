// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDate:off
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";

import type {
  ModAgentEvent,
  ModAsk,
  ModCommand,
  ModElementAddress,
  ModEngineEvent,
  ModPaneRoster,
  ModPluginInfo,
  ModRenderInput,
  ModRenderResult,
  ModScrollReport,
  ModSurface,
  ModViewport,
} from "./protocol.ts";

/**
 * Runs the engine in a process of its own and talks to it over the JSON-lines
 * protocol in `stdio.ts`. Mods are other people's code: one that loops forever
 * freezes that process, which this notices and kills, and the editor goes on.
 * One process holds every session; it starts with the first and exits with the last.
 */

export interface ModEngineHostOptions {
  /** The command that runs `serveModEngine` on its stdio, such as `["node", "mod-engine.mjs"]`. */
  readonly command: ReadonlyArray<string>;
  readonly env?: NodeJS.ProcessEnv;
  /** The process died or stopped answering. Every session it held is gone; open them again. */
  readonly onStopped: (reason: "exited" | "unresponsive") => void;
  /** How long the process may stay silent before it counts as frozen. */
  readonly unresponsiveAfterMs?: number;
}

export interface ModSessionOptions {
  readonly modsDir: string;
  readonly cwd: string;
  readonly storeDir: string;
  readonly watch?: boolean;
  readonly emit: (event: ModEngineEvent) => void;
  readonly ask: (clientId: string, ask: ModAsk) => Promise<Record<string, unknown> | undefined>;
}

/** One conversation's mods, running in the host process. */
export interface ModSession {
  readonly attach: (
    clientId: string,
    client: { readonly surface: ModSurface; readonly viewport?: ModViewport },
  ) => void;
  readonly detach: (clientId: string) => void;
  readonly setCwd: (cwd: string) => void;
  readonly render: (input: ModRenderInput) => Promise<ModRenderResult>;
  readonly press: (address: ModElementAddress & { readonly href?: string }) => Promise<unknown>;
  readonly input: (
    address: ModElementAddress & { readonly kind: "change" | "submit"; readonly value: string },
  ) => Promise<unknown>;
  readonly select: (address: ModElementAddress & { readonly value: string }) => Promise<unknown>;
  readonly message: (address: ModElementAddress & { readonly data: unknown }) => Promise<unknown>;
  readonly panes: () => Promise<ModPaneRoster>;
  readonly paneShow: (id: string) => Promise<unknown>;
  readonly paneFocus: (id: string | null) => Promise<unknown>;
  readonly close: (id: string) => Promise<unknown>;
  readonly scroll: (report: ModScrollReport) => Promise<unknown>;
  readonly commands: () => Promise<ReadonlyArray<ModCommand>>;
  readonly runCommand: (
    name: string,
    args?: string,
  ) => Promise<{ readonly handled: boolean; readonly text?: string }>;
  readonly notify: (event: ModAgentEvent) => Promise<void>;
  readonly plugins: () => Promise<ReadonlyArray<ModPluginInfo>>;
  /** Stops this session's mods; the process exits when no session is left. */
  readonly dispose: () => void;
}

export type ModEngineHost = ReturnType<typeof createModEngineHost>;

export function createModEngineHost(options: ModEngineHostOptions) {
  const unresponsiveAfterMs = options.unresponsiveAfterMs ?? 5000;
  const sessions = new Map<string, ModSessionOptions>();
  const pending = new Map<
    number,
    { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }
  >();
  let child: NodeChildProcess.ChildProcessWithoutNullStreams | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let heardAt = 0;
  let requestCount = 0;

  /** Forgets the process and fails whatever still waited on it. */
  const release = (stopped: NodeChildProcess.ChildProcess) => {
    if (child !== stopped) return false;
    child = undefined;
    if (heartbeat !== undefined) clearInterval(heartbeat);
    heartbeat = undefined;
    for (const waiting of pending.values()) waiting.reject(new Error("the mod engine stopped"));
    pending.clear();
    return true;
  };

  const stopped = (process: NodeChildProcess.ChildProcess, reason: "exited" | "unresponsive") => {
    if (!release(process)) return;
    const hadSessions = sessions.size > 0;
    sessions.clear();
    if (hadSessions) options.onStopped(reason);
  };

  const spawn = () => {
    const [file = "", ...args] = options.command;
    // Its own process group, so the programs its mods started die with it.
    const started = NodeChildProcess.spawn(file, args, {
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    child = started;
    heardAt = Date.now();
    started.stderr.resume();
    started.stdin.on("error", () => {});
    started.on("error", () => stopped(started, "exited"));
    started.on("exit", () => stopped(started, "exited"));
    NodeReadline.createInterface({ input: started.stdout }).on("line", (line) => {
      heardAt = Date.now();
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      const session = sessions.get(String(message.session));
      if (message.event !== undefined) {
        session?.emit(message.event as ModEngineEvent);
      } else if (message.ask !== undefined) {
        const { id, clientId, ...ask } = message.ask as { id: number; clientId: string };
        void Promise.resolve(session?.ask(clientId, ask as ModAsk))
          .catch(() => undefined)
          .then((result) => send({ method: "answer", params: { id, result } }));
      } else if (typeof message.id === "number") {
        const waiting = pending.get(message.id);
        pending.delete(message.id);
        if (typeof message.error === "string") waiting?.reject(new Error(message.error));
        else waiting?.resolve(message.result);
      }
    });
    // A busy process still answers a ping between two hooks; a frozen one never does.
    heartbeat = setInterval(
      () => {
        if (Date.now() - heardAt > unresponsiveAfterMs) {
          kill(started);
          stopped(started, "unresponsive");
          return;
        }
        send({ id: ++requestCount, method: "ping" });
        pending.set(requestCount, { resolve: () => {}, reject: () => {} });
      },
      Math.min(1000, unresponsiveAfterMs / 2),
    );
    heartbeat.unref();
  };

  /** Stops the engine and whatever its mods left running. */
  const kill = (running: NodeChildProcess.ChildProcess) => {
    try {
      if (running.pid !== undefined) process.kill(-running.pid, "SIGKILL");
    } catch {
      running.kill("SIGKILL");
    }
  };

  const send = (message: unknown) => {
    child?.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const call = (session: string, method: string, params: unknown = {}): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (child === undefined) {
        reject(new Error("the mod engine is not running"));
        return;
      }
      const id = ++requestCount;
      pending.set(id, { resolve, reject });
      send({ id, session, method, params });
    });

  return {
    /** Starts a conversation's mods; resolves once they loaded. */
    async open(id: string, session: ModSessionOptions): Promise<ModSession> {
      if (child === undefined) spawn();
      sessions.set(id, session);
      const { emit: _emit, ask: _ask, ...start } = session;
      await call(id, "start", start);
      const ask = <T>(method: string, params?: unknown) => call(id, method, params) as Promise<T>;
      const tell = (method: string, params?: unknown) => {
        void call(id, method, params).catch(() => {});
      };
      return {
        attach: (clientId, client) => tell("attach", { clientId, ...client }),
        detach: (clientId) => tell("detach", { clientId }),
        setCwd: (cwd) => tell("setCwd", { cwd }),
        render: (input) => ask("render", input),
        press: (address) => ask("press", address),
        input: (address) => ask("input", address),
        select: (address) => ask("select", address),
        message: (address) => ask("message", address),
        panes: () => ask("panes"),
        paneShow: (pane) => ask("paneShow", { id: pane }),
        paneFocus: (pane) => ask("paneFocus", { id: pane }),
        close: (pane) => ask("close", { id: pane }),
        scroll: (report) => ask("scroll", report),
        commands: () => ask("commands"),
        runCommand: (name, args = "") => ask("runCommand", { name, args }),
        notify: (event) => ask("notify", event),
        plugins: () => ask("plugins"),
        dispose: () => {
          if (!sessions.delete(id)) return;
          tell("stop");
          if (sessions.size === 0 && child !== undefined) {
            const last = child;
            release(last);
            kill(last);
          }
        },
      };
    },

    /** Stops the process and every session in it. */
    dispose() {
      sessions.clear();
      const running = child;
      if (running === undefined) return;
      release(running);
      kill(running);
    },
  };
}
