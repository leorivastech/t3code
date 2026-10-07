// @effect-diagnostics nodeBuiltinImport:off
import * as NodeReadline from "node:readline";

import { createModEngine, type ModEngine } from "./engine.ts";
import { MOD_GUIDE } from "./guide.ts";

/**
 * The engine as a process, for an editor that is not written in JavaScript or
 * wants mods out of its own process (a mod that loops forever then freezes
 * this process, not the editor). One JSON object per line each way:
 *
 *   host → engine   { "id": 1, "session": "a", "method": "render", "params": { ... } }
 *   engine → host   { "id": 1, "result": { ... } }   or   { "id": 1, "error": "..." }
 *   engine → host   { "session": "a", "event": { "type": "panes", ... } }
 *   engine → host   { "session": "a", "ask": { "id": 7, "clientId": "w1", "kind": "copy", ... } }
 *   host → engine   { "method": "answer", "params": { "id": 7, "result": { "copied": true } } }
 *
 * A session is one conversation's mods. `start` opens it with
 * `{ modsDir, cwd, storeDir, watch? }` and `stop` closes it; every other
 * method is the engine method of that name, taking its one argument object.
 * `ping` answers at once, so a host can tell a frozen process from a busy one.
 * When the input ends the sessions stop, so the process outlives no host.
 */
export function serveModEngine(
  input: NodeJS.ReadableStream,
  write: (line: string) => void,
  /** The host hung up: nothing is left to serve. */
  onClose: () => void = () => {},
): void {
  // Each session's mods load before anything else of that session is answered.
  const sessions = new Map<string, { engine: ModEngine; started: Promise<void> }>();
  let askCount = 0;
  const asks = new Map<number, (result: Record<string, unknown> | undefined) => void>();
  const send = (message: unknown) => write(`${JSON.stringify(message)}\n`);

  const call = async (
    method: string,
    session: string,
    params: Readonly<Record<string, unknown>>,
  ) => {
    switch (method) {
      case "ping":
        return "pong";
      case "guide":
        return MOD_GUIDE;
      case "answer": {
        const id = Number(params.id);
        asks.get(id)?.(params.result as Record<string, unknown> | undefined);
        asks.delete(id);
        return null;
      }
      case "start": {
        sessions.get(session)?.engine.dispose();
        const engine = createModEngine({
          modsDir: String(params.modsDir),
          cwd: String(params.cwd),
          storeDir: String(params.storeDir),
          watch: params.watch === true,
          emit: (event) => send({ session, event }),
          ask: (clientId, ask) =>
            new Promise((resolve) => {
              const id = ++askCount;
              asks.set(id, resolve);
              send({ session, ask: { id, clientId, ...ask } });
            }),
        });
        const started = engine.start();
        sessions.set(session, { engine, started });
        return started;
      }
      case "stop":
        sessions.get(session)?.engine.dispose();
        sessions.delete(session);
        return null;
    }
    const open = sessions.get(session);
    if (open === undefined) throw new Error("start comes first");
    await open.started;
    const { engine } = open;
    switch (method) {
      case "attach":
        return engine.attach(String(params.clientId), params as never);
      case "detach":
        return engine.detach(String(params.clientId));
      case "setCwd":
        return engine.setCwd(String(params.cwd));
      case "paneShow":
        return engine.paneShow(String(params.id));
      case "paneFocus":
        return engine.paneFocus(typeof params.id === "string" ? params.id : null);
      case "close":
        return engine.close(String(params.id));
      case "runCommand":
        return engine.runCommand(String(params.name), String(params.args ?? ""));
      case "render":
      case "press":
      case "input":
      case "select":
      case "message":
      case "scroll":
      case "notify":
        return engine[method](params as never);
      case "panes":
      case "commands":
      case "plugins":
      case "reload":
        return engine[method]();
      default:
        throw new Error(`no method ${method}`);
    }
  };

  const lines = NodeReadline.createInterface({ input });
  lines.on("close", () => {
    for (const { engine } of sessions.values()) engine.dispose();
    sessions.clear();
    onClose();
  });
  lines.on("line", (line) => {
    if (line.trim() === "") return;
    let id: unknown;
    void Promise.resolve()
      .then(() => {
        const message = JSON.parse(line) as {
          id?: unknown;
          session?: string;
          method: string;
          params?: Readonly<Record<string, unknown>>;
        };
        id = message.id;
        return call(message.method, message.session ?? "", message.params ?? {});
      })
      .then(
        (result) => id !== undefined && send({ id, result: result ?? null }),
        (error: unknown) =>
          send({ id: id ?? null, error: error instanceof Error ? error.message : String(error) }),
      );
  });
}
