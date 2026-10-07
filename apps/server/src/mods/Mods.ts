// @effect-diagnostics nodeBuiltinImport:off
/**
 * Mods — runs the user's mods for each thread a window shows and relays what
 * they draw.
 *
 * A mod is a folder under the mods directory with a `mod.json` and a module
 * of event hooks. `@t3tools/mod-engine` runs them, one session per thread: it
 * starts when a window first subscribes to the thread and stops a while after
 * the last one leaves. Mods belong to no provider. They draw the same way
 * whichever agent the thread talks to, and run with none at all.
 *
 * Mods are other people's code, so the engine runs in a process of its own.
 * One that loops forever freezes that process; it is killed and the threads'
 * mods start again, while the server never stops.
 *
 * Clients subscribe to the per-thread snapshot of what the mods pushed and
 * send their own operations through `request`, each window under its own id.
 * A failure here is logged and leaves the thread without mods; it never
 * affects a turn.
 */
import {
  EMPTY_MOD_SNAPSHOT,
  type ModAsk,
  type ModCommand,
  type ModOperation,
  type ModRequestInput,
  type ModRequestResult,
  type ModSnapshot,
  type ModSubscribeInput,
  type ThreadId,
} from "@t3tools/contracts";
import {
  createModEngineHost,
  findModsIn,
  MOD_GUIDE,
  type ModAgentEvent,
  type ModAsk as EngineAsk,
  type ModEngineEvent,
  type ModSession,
} from "@t3tools/mod-engine";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";

const MAX_TOASTS = 20;
const MAX_LOG_LINES = 50;
const MAX_STALE_INSTANCES = 256;
const MAX_SITE_COMMANDS = 32;
const MAX_LINE_LENGTH = 2000;
/** A mod's ask of a window (copy, read the composer) waits this long. */
const ASK_TIMEOUT = "5 seconds";
/** A thread's mods keep running this long after its last window leaves. */
const IDLE_SHUTDOWN = "5 minutes";
/** A second freeze this soon after one means a mod freezes on its own: stop restarting. */
const REPEATED_FREEZE_MS = 60_000;

interface Session {
  readonly id: string;
  /** The thread's mods in the engine process, once they loaded. */
  readonly engine: Promise<ModSession>;
  /** Windows attached on this session. */
  readonly clients: Set<string>;
  /** Pending asks; only the window one names may answer it. */
  readonly asks: Map<
    string,
    { readonly clientId: string; readonly answer: Deferred.Deferred<Record<string, unknown>> }
  >;
  seq: number;
}

interface ThreadEntry {
  session: Session | undefined;
  snapshot: ModSnapshot;
  /** Held while the thread's engine loads, so two windows start one. */
  starting: Deferred.Deferred<void> | undefined;
  idle: Fiber.Fiber<void> | undefined;
  /** The thread's folder as last asked for, to start its mods again after a freeze. */
  cwd: Effect.Effect<string> | undefined;
  /** Set when the engine process stopped while this thread's mods were still loading. */
  retry: boolean;
}

export interface ModInfo {
  readonly name: string;
  readonly path: string;
  readonly error?: string;
  readonly commands: ReadonlyArray<Omit<ModCommand, "plugin">>;
}

export class Mods extends Context.Service<
  Mods,
  {
    /**
     * `owner` names the authenticated caller, `cwd` the thread's project
     * folder. A subscription that carries a `clientId` leases that window's id
     * to its owner: only the owner may act as it, and the window is detached
     * when its last subscription ends.
     */
    readonly subscribe: (
      input: ModSubscribeInput,
      owner: string,
      cwd: Effect.Effect<string>,
    ) => Stream.Stream<ModSnapshot>;
    /** Refused as `unavailable` unless `owner` holds the lease on `input.clientId`. */
    readonly request: (input: ModRequestInput, owner: string) => Effect.Effect<ModRequestResult>;
    /** Tells a thread's running mods what its agent did. A thread nobody shows has none to tell. */
    readonly notify: (threadId: ThreadId, event: ModAgentEvent) => Effect.Effect<void>;
    /** Where mods live and how to write one, for an agent asked to. */
    readonly guide: Effect.Effect<{ readonly modsDir: string; readonly guide: string }>;
    /** The installed mods and the commands they offer in a thread, for an agent to read. */
    readonly list: (
      threadId: ThreadId,
      cwd: Effect.Effect<string>,
    ) => Effect.Effect<ReadonlyArray<ModInfo>>;
    /** Runs a mod's command in a thread, as typing `/name args` in its composer does. */
    readonly runCommand: (
      threadId: ThreadId,
      cwd: Effect.Effect<string>,
      name: string,
      args: string,
    ) => Effect.Effect<{ readonly handled: boolean; readonly text?: string }>;
  }
>()("t3/mods/Mods") {}

const line = (text: string) =>
  text.length > MAX_LINE_LENGTH ? `${text.slice(0, MAX_LINE_LENGTH)}…` : text;

/** Keeps the newest `max` entries. */
const bounded = <T>(entries: ReadonlyArray<T>, max: number): ReadonlyArray<T> =>
  entries.length > max ? entries.slice(entries.length - max) : entries;

/** Builds the service over one mods folder; exported for tests. */
export const make = (options: {
  readonly modsDir: string;
  readonly storeDir: string;
  /** The command that runs the engine process. */
  readonly command: ReadonlyArray<string>;
  /** How long the engine process may stay silent before it counts as frozen. */
  readonly unresponsiveAfterMs?: number;
}) =>
  Effect.gen(function* () {
    const threads = new Map<ThreadId, ThreadEntry>();
    // Each subscriber's one-slot "changed" signal. A subscriber reads the
    // current snapshot when signalled, so a slow client holds one pending
    // signal, never a backlog of snapshots.
    const watchers = new Map<ThreadId, Set<Queue.Queue<void>>>();
    // Who holds each window id of a thread, and through how many live
    // subscriptions; the last one to end detaches the window.
    const leases = new Map<string, { readonly owner: string; count: number }>();
    const leaseKey = (threadId: ThreadId, clientId: string) => `${threadId}\u0000${clientId}`;
    // Session ids must differ across server restarts, or a reconnecting client
    // would keep drawing trees whose handles died with the old process.
    const bootedAt = yield* Clock.currentTimeMillis;
    const context = yield* Effect.context<never>();
    const runFork = Effect.runForkWith(context);
    const runPromise = Effect.runPromiseWith(context);
    let sessionCount = 0;
    let askCount = 0;
    let frozenAt = Number.NEGATIVE_INFINITY;
    const host = createModEngineHost({
      command: options.command,
      onStopped: (reason) => runFork(recover(reason)),
      ...(options.unresponsiveAfterMs === undefined
        ? {}
        : { unresponsiveAfterMs: options.unresponsiveAfterMs }),
    });

    /**
     * Whether any mod is installed. With none, opening a thread starts no
     * engine process, so the feature costs nothing until someone uses it.
     */
    const hasMods = () => findModsIn(options.modsDir).length > 0;

    const entryFor = (threadId: ThreadId): ThreadEntry => {
      let entry = threads.get(threadId);
      if (entry === undefined) {
        entry = {
          session: undefined,
          snapshot: EMPTY_MOD_SNAPSHOT,
          starting: undefined,
          idle: undefined,
          cwd: undefined,
          retry: false,
        };
        threads.set(threadId, entry);
      }
      return entry;
    };

    /** Applies `next` to the thread's snapshot and signals its subscribers when it changed. */
    const update = (threadId: ThreadId, next: (snapshot: ModSnapshot) => ModSnapshot) =>
      Effect.suspend(() => {
        const entry = entryFor(threadId);
        const snapshot = next(entry.snapshot);
        if (snapshot === entry.snapshot) return Effect.void;
        entry.snapshot = snapshot;
        return Effect.forEach(
          watchers.get(threadId) ?? [],
          (signal) => Queue.offer(signal, undefined),
          { discard: true },
        );
      });

    /** Folds one thing the engine said into the thread's snapshot. */
    const ingest = (threadId: ThreadId, session: Session, event: ModEngineEvent) => {
      if (threads.get(threadId)?.session !== session) return Effect.void;
      switch (event.type) {
        case "status":
          return update(threadId, (snapshot) => {
            const others = snapshot.statuses.filter((status) => status.plugin !== event.plugin);
            const text = event.text === null || event.text === "" ? null : line(event.text);
            if (text === null && others.length === snapshot.statuses.length) return snapshot;
            return {
              ...snapshot,
              statuses: text === null ? others : [...others, { plugin: event.plugin, text }],
            };
          });
        case "toast":
          return update(threadId, (snapshot) => ({
            ...snapshot,
            toasts: bounded(
              [
                ...snapshot.toasts,
                {
                  seq: ++session.seq,
                  plugin: event.plugin,
                  text: line(event.text),
                  timeoutMs: event.timeoutMs,
                },
              ],
              MAX_TOASTS,
            ),
          }));
        case "log":
          return DateTime.now.pipe(
            Effect.flatMap((now) =>
              update(threadId, (snapshot) => ({
                ...snapshot,
                logs: bounded(
                  [
                    ...snapshot.logs,
                    {
                      seq: ++session.seq,
                      plugin: event.plugin,
                      text: line(event.text),
                      at: DateTime.formatIso(now),
                    },
                  ],
                  MAX_LOG_LINES,
                ),
              })),
            ),
          );
        case "panes":
          return update(threadId, (snapshot) => ({
            ...snapshot,
            panes: { ...event.roster, panes: [...event.roster.panes] },
          }));
        case "commands":
          return update(threadId, (snapshot) => ({
            ...snapshot,
            slashCommandsRevision: snapshot.slashCommandsRevision + 1,
          }));
        case "invalidate":
          return update(threadId, (snapshot) => {
            if (event.instances === undefined) {
              return { ...snapshot, renderEpoch: snapshot.renderEpoch + 1, stale: [] };
            }
            const all = [
              ...snapshot.stale,
              ...event.instances.map((instance) => ({ seq: ++session.seq, ...instance })),
            ];
            // Past the bound a client could miss one, so everything goes stale instead.
            return all.length > MAX_STALE_INSTANCES
              ? { ...snapshot, renderEpoch: snapshot.renderEpoch + 1, stale: [] }
              : { ...snapshot, stale: all };
          });
        case "post":
          return update(threadId, (snapshot) => ({
            ...snapshot,
            commands: bounded(
              [
                ...snapshot.commands,
                {
                  kind: "post" as const,
                  seq: ++session.seq,
                  clientId: event.clientId,
                  component: event.component,
                  instanceId: event.instanceId,
                  plugin: event.plugin,
                  key: event.key,
                  data: event.data,
                },
              ],
              MAX_SITE_COMMANDS,
            ),
          }));
        case "scroll":
          return update(threadId, (snapshot) => ({
            ...snapshot,
            commands: bounded(
              [
                ...snapshot.commands,
                {
                  kind: "scroll" as const,
                  seq: ++session.seq,
                  clientId: event.clientId,
                  component: event.component,
                  instanceId: event.instanceId,
                  offset: event.offset,
                  ...(event.followEnd === true ? { followEnd: true } : {}),
                },
              ],
              MAX_SITE_COMMANDS,
            ),
          }));
      }
    };

    /** Publishes a mod's ask to the window it names and waits for the answer. */
    const awaitAnswer = (threadId: ThreadId, session: Session, clientId: string, ask: EngineAsk) =>
      Effect.gen(function* () {
        if (!session.clients.has(clientId)) return undefined;
        const askId = `ask-${++askCount}`;
        const pending: ModAsk = { ...ask, askId, clientId };
        const answer = yield* Deferred.make<Record<string, unknown>>();
        session.asks.set(askId, { clientId, answer });
        yield* update(threadId, (snapshot) => ({ ...snapshot, asks: [...snapshot.asks, pending] }));
        return yield* Deferred.await(answer).pipe(
          Effect.timeoutOption(ASK_TIMEOUT),
          Effect.map((result) => (result._tag === "Some" ? result.value : undefined)),
          Effect.ensuring(
            Effect.suspend(() => {
              session.asks.delete(askId);
              return threads.get(threadId)?.session === session
                ? update(threadId, (snapshot) => ({
                    ...snapshot,
                    asks: snapshot.asks.filter((entry) => entry.askId !== askId),
                  }))
                : Effect.void;
            }),
          ),
        );
      });

    /** Ends a thread's session: nothing of it is drawn or answered any more. */
    const forget = (
      threadId: ThreadId,
      entry: ThreadEntry,
      session: Session,
      left: ModSnapshot,
    ) => {
      entry.session = undefined;
      void session.engine.then(
        (engine) => engine.dispose(),
        () => {},
      );
      return Effect.forEach(
        session.asks.values(),
        (pending) => Deferred.succeed(pending.answer, {}),
        { discard: true },
      ).pipe(Effect.andThen(update(threadId, () => left)));
    };

    /** Stops a thread's engine and clears what it drew. */
    const stop = (threadId: ThreadId) =>
      Effect.suspend(() => {
        const entry = threads.get(threadId);
        const session = entry?.session;
        if (entry === undefined || session === undefined) return Effect.void;
        return forget(threadId, entry, session, EMPTY_MOD_SNAPSHOT).pipe(
          Effect.andThen(Effect.sync(() => threads.delete(threadId))),
        );
      });

    /** Opens a session for the thread in the engine process; undefined when its mods did not load. */
    const open = (threadId: ThreadId, entry: ThreadEntry, directory: string) =>
      Effect.gen(function* () {
        const id = `${bootedAt.toString(36)}-${(++sessionCount).toString(36)}`;
        const session: Session = {
          id,
          engine: host.open(id, {
            modsDir: options.modsDir,
            cwd: directory,
            storeDir: options.storeDir,
            watch: true,
            emit: (event) => runFork(ingest(threadId, session, event)),
            ask: (clientId, ask) => runPromise(awaitAnswer(threadId, session, clientId, ask)),
          }),
          clients: new Set(),
          asks: new Map(),
          seq: 0,
        };
        entry.session = session;
        yield* update(threadId, () => ({ ...EMPTY_MOD_SNAPSHOT, session: id }));
        const opened = yield* Effect.tryPromise(() => session.engine).pipe(
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("mods.start-failed", { threadId, cause }).pipe(Effect.as(false)),
          ),
        );
        if (opened) return session;
        // When the process froze while these loaded, `recover` already ended the session.
        if (entry.session === session) {
          yield* forget(threadId, entry, session, EMPTY_MOD_SNAPSHOT);
        }
        return undefined;
      });

    /** Starts the thread's mods unless they run already. */
    const ensure = (
      threadId: ThreadId,
      cwd: Effect.Effect<string>,
    ): Effect.Effect<Session | undefined> =>
      Effect.gen(function* () {
        const entry = entryFor(threadId);
        entry.cwd = cwd;
        const running = entry.session;
        if (running !== undefined && entry.starting === undefined) {
          const directory = yield* cwd;
          void running.engine.then(
            (engine) => engine.setCwd(directory),
            () => {},
          );
          return running;
        }
        if (entry.starting !== undefined) {
          yield* Deferred.await(entry.starting);
          return entry.session;
        }
        const starting = yield* Deferred.make<void>();
        entry.starting = starting;
        const directory = yield* cwd;
        let session = yield* open(threadId, entry, directory);
        // The process froze while the mods loaded, and `recover` asked for one more try.
        if (session === undefined && entry.retry) {
          entry.retry = false;
          session = yield* open(threadId, entry, directory);
        }
        entry.retry = false;
        entry.starting = undefined;
        yield* Deferred.succeed(starting, undefined);
        return session;
      });

    /**
     * The engine process died or froze, and every session went with it. Threads
     * a window still shows get their mods again, unless a mod just froze the
     * process before: then one freezes by itself and starting over would loop.
     */
    const recover = (reason: "exited" | "unresponsive") =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const isRepeat = reason === "unresponsive" && now - frozenAt < REPEATED_FREEZE_MS;
        if (reason === "unresponsive") frozenAt = now;
        yield* Effect.logWarning("mods.engine-stopped", { reason, isRepeat });
        const at = DateTime.formatIso(yield* DateTime.now);
        const stopped = (): ModSnapshot => ({
          ...EMPTY_MOD_SNAPSHOT,
          // A session nothing answers for, so the windows can say why mods are gone.
          session: `stopped-${(++sessionCount).toString(36)}`,
          logs: [
            {
              seq: 1,
              plugin: "mods",
              text: "A mod keeps freezing, so mods are off here. Fix or remove it, then reopen the thread.",
              at,
            },
          ],
        });
        for (const [threadId, entry] of threads) {
          const session = entry.session;
          if (session === undefined) continue;
          const isWatched = watchers.has(threadId) && entry.cwd !== undefined;
          if (entry.starting !== undefined) {
            // `ensure` still waits on the session that just died; it starts once more itself.
            entry.retry = isWatched && !isRepeat;
            yield* forget(threadId, entry, session, isRepeat ? stopped() : EMPTY_MOD_SNAPSHOT);
            continue;
          }
          if (isRepeat || !isWatched || entry.cwd === undefined) {
            yield* forget(threadId, entry, session, isRepeat ? stopped() : EMPTY_MOD_SNAPSHOT);
            continue;
          }
          yield* forget(threadId, entry, session, EMPTY_MOD_SNAPSHOT);
          const restarted = yield* ensure(threadId, entry.cwd);
          if (restarted !== undefined && reason === "unresponsive") {
            yield* ingest(threadId, restarted, {
              type: "log",
              plugin: "mods",
              text: "A mod stopped responding, so this thread's mods were restarted.",
            });
          }
        }
      });

    const publishClients = (threadId: ThreadId, session: Session) =>
      update(threadId, (snapshot) =>
        snapshot.clients.length === session.clients.size &&
        snapshot.clients.every((clientId) => session.clients.has(clientId))
          ? snapshot
          : { ...snapshot, clients: [...session.clients] },
      );

    /** Drops a window once its last subscription ends; an unwatched thread stops after a while. */
    const release = (threadId: ThreadId, clientId: string | undefined, isLeased: boolean) =>
      Effect.gen(function* () {
        const entry = threads.get(threadId);
        if (clientId !== undefined && isLeased) {
          const key = leaseKey(threadId, clientId);
          const lease = leases.get(key);
          if (lease !== undefined && --lease.count <= 0) {
            leases.delete(key);
            const session = entry?.session;
            if (session?.clients.delete(clientId) === true) {
              void session.engine.then(
                (engine) => engine.detach(clientId),
                () => {},
              );
              yield* publishClients(threadId, session);
            }
          }
        }
        if (entry === undefined || watchers.has(threadId) || entry.idle !== undefined) return;
        entry.idle = runFork(
          Effect.sleep(IDLE_SHUTDOWN).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                entry.idle = undefined;
                return watchers.has(threadId) ? Effect.void : stop(threadId);
              }),
            ),
          ),
        );
      });

    /** A thread someone looks at again is no longer about to stop. */
    const keep = (threadId: ThreadId) =>
      Effect.suspend(() => {
        const entry = threads.get(threadId);
        const idle = entry?.idle;
        if (entry === undefined || idle === undefined) return Effect.void;
        entry.idle = undefined;
        return Fiber.interrupt(idle);
      });

    const subscribe: Mods["Service"]["subscribe"] = ({ threadId, clientId }, owner, cwd) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const signal = yield* Queue.sliding<void>(1);
          let signals = watchers.get(threadId);
          if (signals === undefined) {
            signals = new Set();
            watchers.set(threadId, signals);
          }
          const own = signals;
          own.add(signal);
          // A window id another caller already holds is not taken over.
          let isLeased = false;
          if (clientId !== undefined) {
            const key = leaseKey(threadId, clientId);
            const lease = leases.get(key);
            if (lease === undefined) {
              leases.set(key, { owner, count: 1 });
              isLeased = true;
            } else if (lease.owner === owner) {
              lease.count += 1;
              isLeased = true;
            }
          }
          yield* Effect.addFinalizer(() =>
            Effect.suspend(() => {
              own.delete(signal);
              if (own.size === 0 && watchers.get(threadId) === own) watchers.delete(threadId);
              return release(threadId, clientId, isLeased);
            }),
          );
          // The entry exists before the engine loads, so a window that leaves
          // meanwhile still schedules the thread's shutdown.
          entryFor(threadId).cwd = cwd;
          yield* keep(threadId);
          if (hasMods()) yield* ensure(threadId, cwd).pipe(Effect.forkDetach);
          // What is addressed to one window (a mod's copy text, a draft to
          // fill, a scroll) is sent to that window alone.
          const current = () => {
            const snapshot = threads.get(threadId)?.snapshot ?? EMPTY_MOD_SNAPSHOT;
            if (snapshot.asks.length === 0 && snapshot.commands.length === 0) return snapshot;
            const mine = isLeased ? clientId : undefined;
            return {
              ...snapshot,
              asks: snapshot.asks.filter((entry) => entry.clientId === mine),
              commands: snapshot.commands.filter((command) => command.clientId === mine),
            };
          };
          return Stream.concat(
            Stream.make(current()),
            Stream.fromQueue(signal).pipe(Stream.map(() => current())),
          );
        }),
      );

    /** Runs one window's operation on the thread's mods. */
    const operate = async (
      session: Session,
      clientId: string,
      operation: Exclude<ModOperation, { op: "answer" }>,
    ): Promise<unknown> => {
      const engine = await session.engine;
      const address = { clientId };
      switch (operation.op) {
        case "attach":
          return engine.attach(clientId, {
            surface: operation.surface ?? "desktop",
            ...(operation.viewport === undefined ? {} : { viewport: operation.viewport }),
          });
        case "detach":
          return engine.detach(clientId);
        case "slashCommands":
          return engine.commands();
        case "render":
          return engine.render({ ...address, ...operation });
        case "press":
          return engine.press({ ...address, ...operation });
        case "input":
          return engine.input({ ...address, ...operation });
        case "select":
          return engine.select({ ...address, ...operation });
        case "message":
          return engine.message({ ...address, ...operation });
        case "panes":
          return engine.panes();
        case "paneShow":
          return engine.paneShow(operation.id);
        case "paneFocus":
          return engine.paneFocus(operation.id);
        case "close":
          return engine.close(operation.id);
        case "scroll":
          return engine.scroll({ ...address, ...operation });
        case "command":
          return engine.runCommand(operation.name, operation.args ?? "");
      }
    };

    const request: Mods["Service"]["request"] = (input, owner) =>
      Effect.suspend((): Effect.Effect<ModRequestResult> => {
        const { threadId, clientId, operation } = input;
        const session = threads.get(threadId)?.session;
        // No mod, no session: the composer hears at once that no command is a mod's.
        if (session === undefined && operation.op === "slashCommands" && !hasMods()) {
          return Effect.succeed({ status: "ok", response: [] });
        }
        if (
          session === undefined ||
          session.id !== input.session ||
          leases.get(leaseKey(threadId, clientId))?.owner !== owner
        ) {
          return Effect.succeed({ status: "unavailable" });
        }
        if (operation.op === "answer") {
          const pending = session.asks.get(operation.askId);
          return pending === undefined || pending.clientId !== clientId
            ? Effect.succeed({ status: "unavailable" })
            : Deferred.succeed(pending.answer, operation.result).pipe(
                Effect.as({ status: "ok", response: null } as const),
              );
        }
        if (operation.op === "attach") session.clients.add(clientId);
        if (operation.op === "detach") session.clients.delete(clientId);
        return Effect.tryPromise(() => operate(session, clientId, operation)).pipe(
          Effect.tap(() =>
            operation.op === "attach" || operation.op === "detach"
              ? publishClients(threadId, session)
              : Effect.void,
          ),
          Effect.map((response) => ({ status: "ok", response: response ?? null }) as const),
          Effect.catchCause((cause) =>
            Effect.logDebug("mods.request-failed", {
              threadId,
              operation: operation.op,
              cause,
            }).pipe(Effect.as({ status: "failed" } as const)),
          ),
        );
      });

    /** Runs `use` on the thread's engine, started for the call when no window shows the thread. */
    const withEngine = <A>(
      threadId: ThreadId,
      cwd: Effect.Effect<string>,
      fallback: A,
      use: (engine: ModSession) => Promise<A>,
    ) =>
      keep(threadId).pipe(
        Effect.andThen(ensure(threadId, cwd)),
        Effect.flatMap((session) =>
          session === undefined
            ? Effect.succeed(fallback)
            : Effect.tryPromise(async () => use(await session.engine)).pipe(
                Effect.catchCause(() => Effect.succeed(fallback)),
              ),
        ),
        Effect.ensuring(release(threadId, undefined, false)),
      );

    const list: Mods["Service"]["list"] = (threadId, cwd) =>
      Effect.suspend(() =>
        hasMods() ? listInstalled(threadId, cwd) : Effect.succeed([] as ReadonlyArray<ModInfo>),
      );
    const listInstalled = (threadId: ThreadId, cwd: Effect.Effect<string>) =>
      withEngine(threadId, cwd, [] as ReadonlyArray<ModInfo>, async (engine) => {
        const commands = await engine.commands();
        return (await engine.plugins()).map((plugin) => ({
          name: plugin.name,
          path: plugin.path,
          ...(plugin.error === undefined ? {} : { error: plugin.error }),
          commands: commands
            .filter((command) => command.plugin === plugin.name)
            .map(({ plugin: _mod, ...command }) => command),
        }));
      });

    const runCommand: Mods["Service"]["runCommand"] = (threadId, cwd, name, args) =>
      Effect.suspend(() =>
        hasMods()
          ? runInstalled(threadId, cwd, name, args)
          : Effect.succeed({ handled: false } as { handled: boolean; text?: string }),
      );
    const runInstalled = (
      threadId: ThreadId,
      cwd: Effect.Effect<string>,
      name: string,
      args: string,
    ) =>
      withEngine(
        threadId,
        cwd,
        { handled: false } as { handled: boolean; text?: string },
        async (engine) => {
          const result = await engine.runCommand(name.replace(/^\//, ""), args);
          return result.text === undefined
            ? { handled: result.handled }
            : { handled: result.handled, text: result.text };
        },
      );

    yield* Effect.addFinalizer(() =>
      // A pending shutdown timer would hold the process open for minutes after the server stops.
      Effect.forEach(
        [...threads.values()].flatMap((entry) => (entry.idle === undefined ? [] : [entry.idle])),
        (idle) => Fiber.interrupt(idle),
        { discard: true },
      ).pipe(
        Effect.andThen(
          Effect.sync(() => {
            threads.clear();
            host.dispose();
          }),
        ),
      ),
    );

    // The first mod installed while threads are open starts their mods.
    const startWaiting = Effect.suspend(() =>
      hasMods()
        ? Effect.forEach(
            [...watchers.keys()],
            (threadId) => {
              const entry = threads.get(threadId);
              return entry?.cwd === undefined ||
                entry.session !== undefined ||
                entry.starting !== undefined
                ? Effect.void
                : ensure(threadId, entry.cwd).pipe(Effect.asVoid);
            },
            { discard: true },
          )
        : Effect.void,
    );
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        try {
          return NodeFS.watch(options.modsDir, { recursive: true }, () => runFork(startWaiting));
        } catch {
          return undefined;
        }
      }),
      (watching) => Effect.sync(() => watching?.close()),
    );

    const notify: Mods["Service"]["notify"] = (threadId, event) =>
      Effect.suspend(() => {
        const session = threads.get(threadId)?.session;
        return session === undefined
          ? Effect.void
          : Effect.tryPromise(async () => (await session.engine).notify(event)).pipe(Effect.ignore);
      });

    const guide = Effect.succeed({ modsDir: options.modsDir, guide: MOD_GUIDE });

    return Mods.of({ subscribe, request, notify, guide, list, runCommand });
  });

/**
 * The engine's live heap is a few megabytes. Left at the default limit, V8 puts
 * off collecting closed sessions and the process grows to hundreds.
 */
const ENGINE_HEAP_MB = 64;

/**
 * How to run the engine process: this same program again, as `__mod-engine`.
 * A single-executable build has no script to name, only itself, and takes no
 * runtime flag.
 */
const engineCommand = (): ReadonlyArray<string> => {
  const script = process.argv[1];
  return script !== undefined && script !== process.execPath && NodeFS.existsSync(script)
    ? [process.execPath, `--max-old-space-size=${ENGINE_HEAP_MB}`, script, "__mod-engine"]
    : [process.execPath, "__mod-engine"];
};

/**
 * Mods live in `~/.agents/mods`, one folder each, so any editor can run the
 * same ones; what they store goes under this server's state directory.
 */
export const layer = Layer.effect(
  Mods,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const modsDir = NodePath.join(NodeOS.homedir(), ".agents", "mods");
    yield* Effect.sync(() => NodeFS.mkdirSync(modsDir, { recursive: true })).pipe(Effect.ignore);
    return yield* make({
      modsDir,
      storeDir: NodePath.join(config.stateDir, "mods"),
      command: engineCommand(),
    });
  }),
);
