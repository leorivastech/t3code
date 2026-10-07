// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { type ModOperation, type ModSnapshot, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Mods from "./Mods.ts";

type Service = Mods.Mods["Service"];

const threadId = ThreadId.make("thread-mods");
const owner = "owner-1";
const cwd = Effect.succeed("/tmp");

const NOTES = `
export function register(on) {
  on("session.start", async ($, e, next) => {
    await $.command.register({ name: "notes", description: "Open the notes pane" })
    await $.command.register({ name: "draft", description: "Say what the composer holds" })
    $.ui.status("notes ready")
    return next(e)
  })
  on("command.run", { command: "notes" }, async ($, e) => {
    await $.ui.open({ id: "notes", title: "Notes" })
    $.ui.toast("opened")
    return { text: "notes for " + (await $.session.cwd()) }
  })
  on("command.run", { command: "draft" }, async ($) => ({ text: (await $.prompt.read()).text }))
  on("ui.render", { component: "Pane", requestId: "notes" }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>nothing yet</Text>
  })
}
`;

const writeMod = (modsDir: string, name: string, source: string) => {
  NodeFS.mkdirSync(NodePath.join(modsDir, name));
  NodeFS.writeFileSync(NodePath.join(modsDir, name, "mod.tsx"), source);
  NodeFS.writeFileSync(NodePath.join(modsDir, name, "mod.json"), `{"name":"${name}"}`);
};

const makeServiceIn = (modsDir: string) =>
  Mods.make({
    unresponsiveAfterMs: 300,
    modsDir,
    storeDir: NodePath.join(modsDir, ".store"),
    command: [process.execPath, NodePath.join(import.meta.dirname, "..", "bin.ts"), "__mod-engine"],
  });

/** A service over a fresh mods folder holding one mod. */
const makeServiceWith = (name: string, source: string) =>
  Effect.gen(function* () {
    const modsDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-mods-"));
    writeMod(modsDir, name, source);
    return yield* makeServiceIn(modsDir);
  });

const makeService = makeServiceWith("notes", NOTES);

/** The first snapshot `clientId` is sent, current or upcoming, that satisfies `predicate`. */
const awaitSnapshot = (
  service: Service,
  predicate: (snapshot: ModSnapshot) => boolean,
  clientId?: string,
) =>
  service
    .subscribe(clientId === undefined ? { threadId } : { threadId, clientId }, owner, cwd)
    .pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow));

const isLoaded = (snapshot: ModSnapshot) =>
  snapshot.session !== null && snapshot.statuses.length > 0;

/** `owner` showing the thread as window `clientId`, attached once its mods loaded. */
const openWindow = (service: Service, clientId = "window-1") =>
  Effect.gen(function* () {
    const loaded = yield* Deferred.make<string>();
    const subscription = yield* service.subscribe({ threadId, clientId }, owner, cwd).pipe(
      Stream.runForEach((snapshot) =>
        isLoaded(snapshot) ? Deferred.succeed(loaded, snapshot.session ?? "") : Effect.void,
      ),
      Effect.forkChild,
    );
    const session = yield* Deferred.await(loaded);
    const run = (operation: ModOperation, as: { owner?: string; session?: string } = {}) =>
      service.request(
        { threadId, clientId, session: as.session ?? session, operation },
        as.owner ?? owner,
      );
    yield* run({ op: "attach" });
    return { subscription, session, run };
  });

describe("Mods", () => {
  it.effect("starts nothing while no mod is installed, and the thread's mods once one is", () =>
    Effect.gen(function* () {
      const modsDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-mods-"));
      const service = yield* makeServiceIn(modsDir);
      const loaded = yield* Deferred.make<ModSnapshot>();
      yield* service.subscribe({ threadId, clientId: "window-1" }, owner, cwd).pipe(
        Stream.runForEach((snapshot) =>
          isLoaded(snapshot) ? Deferred.succeed(loaded, snapshot) : Effect.void,
        ),
        Effect.forkChild,
      );

      assert.deepStrictEqual(yield* service.list(threadId, cwd), []);
      assert.deepStrictEqual(yield* service.runCommand(threadId, cwd, "notes", ""), {
        handled: false,
      });
      // The composer learns at once that no slash command is a mod's.
      assert.deepStrictEqual(
        yield* service.request(
          { threadId, clientId: "window-1", session: "", operation: { op: "slashCommands" } },
          owner,
        ),
        { status: "ok", response: [] },
      );

      writeMod(modsDir, "notes", NOTES);
      assert.deepStrictEqual((yield* Deferred.await(loaded)).statuses, [
        { plugin: "notes", text: "notes ready" },
      ]);
    }),
  );

  it.effect("runs the mods for a thread a window shows, whatever provider it talks to", () =>
    Effect.gen(function* () {
      const service = yield* makeService;
      const { run } = yield* openWindow(service);

      assert.deepStrictEqual(yield* run({ op: "slashCommands" }), {
        status: "ok",
        response: [
          { name: "notes", description: "Open the notes pane", plugin: "notes" },
          { name: "draft", description: "Say what the composer holds", plugin: "notes" },
        ],
      });
      assert.deepStrictEqual(yield* run({ op: "command", name: "notes" }), {
        status: "ok",
        response: { handled: true, plugin: "notes", text: "notes for /tmp" },
      });

      const snapshot = yield* awaitSnapshot(service, (next) => next.toasts.length > 0);
      assert.deepStrictEqual(snapshot.panes.panes, [
        { id: "notes", title: "Notes", plugin: "notes" },
      ]);
      assert.deepStrictEqual(snapshot.statuses, [{ plugin: "notes", text: "notes ready" }]);
      assert.strictEqual(snapshot.toasts[0]?.text, "opened");

      const drawn = yield* run({ op: "render", component: "Pane", instanceId: "notes", props: {} });
      assert.deepStrictEqual(drawn, {
        status: "ok",
        response: {
          tree: { type: "Text", children: ["nothing yet"] },
          props: {},
          rewritten: false,
          hooked: true,
        },
      });
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a caller that does not hold the window, and a session that was replaced", () =>
    Effect.gen(function* () {
      const service = yield* makeService;
      const { run } = yield* openWindow(service);

      assert.deepStrictEqual(yield* run({ op: "panes" }, { owner: "someone-else" }), {
        status: "unavailable",
      });
      assert.deepStrictEqual(yield* run({ op: "panes" }, { session: "an-older-session" }), {
        status: "unavailable",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("puts a mod's ask to the window it names and hands the answer back to the mod", () =>
    Effect.gen(function* () {
      const service = yield* makeService;
      const { run } = yield* openWindow(service);

      const reply = yield* run({ op: "command", name: "draft" }).pipe(Effect.forkChild);
      const asked = yield* awaitSnapshot(service, (next) => next.asks.length > 0, "window-1");
      const ask = asked.asks[0] ?? assert.fail("no ask reached the window");
      assert.strictEqual(ask.kind, "promptRead");
      // A watcher that is not the window is never shown the ask.
      assert.deepStrictEqual((yield* awaitSnapshot(service, isLoaded)).asks, []);

      yield* run({ op: "answer", askId: ask.askId, result: { text: "half a thought", cursor: 4 } });

      assert.deepStrictEqual(yield* Fiber.join(reply), {
        status: "ok",
        response: { handled: true, plugin: "notes", text: "half a thought" },
      });
    }).pipe(Effect.scoped),
  );

  it.effect("runs a mod's command for an agent while no window shows the thread", () =>
    Effect.gen(function* () {
      const service = yield* makeService;

      assert.deepStrictEqual(yield* service.runCommand(threadId, cwd, "/notes", ""), {
        handled: true,
        text: "notes for /tmp",
      });
      assert.deepStrictEqual(yield* service.runCommand(threadId, cwd, "missing", ""), {
        handled: false,
      });
      const listed = yield* service.list(threadId, cwd);
      assert.deepStrictEqual(
        listed.map((mod) => [mod.name, mod.commands.map((command) => command.name)]),
        [["notes", ["notes", "draft"]]],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("restarts the mods of a thread after one froze, and the server goes on", () =>
    Effect.gen(function* () {
      const service = yield* makeServiceWith(
        "frozen",
        `export function register(on) {
          on("session.start", async ($, e, next) => {
            await $.command.register({ name: "freeze", description: "" })
            $.ui.status("ready")
            return next(e)
          })
          on("command.run", { command: "freeze" }, () => { for (;;) {} })
        }`,
      );
      const { run, session } = yield* openWindow(service);

      assert.deepStrictEqual(yield* run({ op: "command", name: "freeze" }), { status: "failed" });

      const restarted = yield* awaitSnapshot(
        service,
        (next) => next.session !== session && next.logs.length > 0,
        "window-1",
      );
      assert.strictEqual(
        restarted.logs[0]?.text,
        "A mod stopped responding, so this thread's mods were restarted.",
      );
      assert.deepStrictEqual(restarted.statuses, [{ plugin: "frozen", text: "ready" }]);
    }).pipe(Effect.scoped),
  );

  it.effect("turns mods off in a thread whose mod freezes every time it starts", () =>
    Effect.gen(function* () {
      const service = yield* makeServiceWith(
        "stuck",
        `export function register(on) { on("session.start", () => { for (;;) {} }) }`,
      );

      const off = yield* awaitSnapshot(service, (next) => next.logs.length > 0, "window-1");

      assert.strictEqual(
        off.logs[0]?.text,
        "A mod keeps freezing, so mods are off here. Fix or remove it, then reopen the thread.",
      );
      assert.strictEqual((yield* service.guide).guide.startsWith("# Writing a mod"), true);
    }).pipe(Effect.scoped),
  );

  it.effect("stops a thread's mods a while after its last window leaves", () =>
    Effect.gen(function* () {
      const service = yield* makeService;
      const { subscription } = yield* openWindow(service);

      yield* Fiber.interrupt(subscription);
      yield* TestClock.adjust("4 minutes");
      assert.isTrue(isLoaded(yield* awaitSnapshot(service, () => true)));

      yield* TestClock.adjust("6 minutes");
      assert.strictEqual((yield* awaitSnapshot(service, () => true)).statuses.length, 0);
    }).pipe(Effect.scoped),
  );
});
