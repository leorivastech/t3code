// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createModEngine, type ModEngine } from "./engine.ts";
import { MOD_GUIDE } from "./guide.ts";
import { createModEngineHost, type ModEngineHost } from "./host.ts";
import { serveModEngine } from "./stdio.ts";
import type { ModElement, ModEngineEvent } from "./protocol.ts";

const COUNTER = `
import { atom, read, update } from "mods"

const count = atom({ plugin: "counter", key: "count" }, 0)

export function register(on) {
  on("session.start", async ($, e, next) => {
    await $.command.register({ name: "count", description: "Open the counter" })
    return next(e)
  })
  on("command.run", { command: "count" }, async ($, e) => {
    await $.ui.open({ id: "counter", title: "Counter" })
    return { text: "opened " + e.args }
  })
  on("ui.close", async ($, e, next) => {
    if (e.id === "counter" && (await read($, count)) === 0) return
    return next(e)
  })
  on("ui.render", { component: "Pane", requestId: "counter" }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text>count {await read($, count)}</Text>
        <Button key="add" label="Add" onPress={() => update($, count, (n) => n + 1)} />
      </Box>
    )
  })
}
`;

const engines: ModEngine[] = [];

afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
  vi.useRealTimers();
});

async function start(mods: Readonly<Record<string, string>>) {
  const modsDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mods-"));
  for (const [name, source] of Object.entries(mods)) {
    NodeFS.mkdirSync(NodePath.join(modsDir, name));
    NodeFS.writeFileSync(NodePath.join(modsDir, name, "mod.json"), JSON.stringify({ name }));
    NodeFS.writeFileSync(NodePath.join(modsDir, name, "mod.tsx"), source);
  }
  const events: ModEngineEvent[] = [];
  const engine = createModEngine({
    modsDir,
    cwd: modsDir,
    storeDir: NodePath.join(modsDir, ".store"),
    loadTimeoutMs: 300,
    emit: (event) => events.push(event),
    ask: async (_clientId, ask) => (ask.kind === "promptRead" ? { text: "draft", cursor: 5 } : {}),
  });
  engines.push(engine);
  engine.attach("window", { surface: "desktop" });
  await engine.start();
  return { engine, events, modsDir };
}

const drawPane = (engine: ModEngine, id: string) =>
  engine.render({ clientId: "window", component: "Pane", instanceId: id, props: {} });

const find = (node: ModElement, type: string): ModElement | undefined => {
  if (node.type === type) return node;
  for (const child of node.children ?? []) {
    const found = typeof child === "string" ? undefined : find(child, type);
    if (found !== undefined) return found;
  }
  return undefined;
};

const textOf = (node: ModElement): string =>
  (node.children ?? [])
    .map((child) => (typeof child === "string" ? child : textOf(child)))
    .join("");

describe("mod engine as a process", () => {
  const hosts: ModEngineHost[] = [];
  afterEach(() => {
    for (const host of hosts.splice(0)) host.dispose();
  });

  /** A host over the real process entry, and a promise of the first time it stops. */
  const startHost = () => {
    let reportStopped: (reason: string) => void = () => {};
    const stopped = new Promise<string>((resolve) => {
      reportStopped = resolve;
    });
    const host = createModEngineHost({
      command: [process.execPath, NodePath.join(import.meta.dirname, "bin.ts")],
      unresponsiveAfterMs: 400,
      onStopped: reportStopped,
    });
    hosts.push(host);
    return { host, stopped };
  };

  const modsFolder = (mods: Readonly<Record<string, string>>) => {
    const modsDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mods-"));
    for (const [name, source] of Object.entries(mods)) {
      NodeFS.mkdirSync(NodePath.join(modsDir, name));
      NodeFS.writeFileSync(NodePath.join(modsDir, name, "mod.json"), JSON.stringify({ name }));
      NodeFS.writeFileSync(NodePath.join(modsDir, name, "mod.tsx"), source);
    }
    return { modsDir, cwd: modsDir, storeDir: NodePath.join(modsDir, ".store") };
  };

  it("runs two conversations' mods in one process, each with its own state", async () => {
    const { host } = startHost();
    const folder = modsFolder({ counter: COUNTER });
    const events: ModEngineEvent[] = [];
    const open = (id: string) =>
      host.open(id, { ...folder, emit: (event) => events.push(event), ask: async () => undefined });
    const [first, second] = await Promise.all([open("a"), open("b")]);

    expect(await first.runCommand("count", "x")).toMatchObject({ text: "opened x" });
    const drawn = await first.render({
      clientId: "w",
      component: "Pane",
      instanceId: "counter",
      props: {},
    });
    await first.press({ clientId: "w", ...find(drawn.tree, "Button")!.press! });

    const again = { clientId: "w", component: "Pane", instanceId: "counter", props: {} } as const;
    expect(textOf((await first.render(again)).tree)).toBe("count 1");
    expect((await second.panes()).panes).toEqual([]);
    expect(events).toContainEqual({
      type: "commands",
      commands: [expect.objectContaining({ name: "count" })],
    });
  });

  it("kills a process a mod froze, says so, and runs mods again when asked", async () => {
    const frozen = `export function register(on) {
      on("session.start", async ($, e, next) => {
        await $.command.register({ name: "freeze", description: "" })
        return next(e)
      })
      on("command.run", { command: "freeze" }, () => { for (;;) {} })
    }`;
    const { host, stopped } = startHost();
    const folder = modsFolder({ frozen, counter: COUNTER });
    const session = { ...folder, emit: () => {}, ask: async () => undefined };
    const first = await host.open("a", session);

    const run = first.runCommand("freeze");
    expect(await stopped).toBe("unresponsive");
    await expect(run).rejects.toThrow("the mod engine stopped");

    const second = await host.open("a", session);
    expect(await second.runCommand("count", "y")).toMatchObject({ text: "opened y" });
  });

  it("answers a host's JSON lines in order, loading the mods first", async () => {
    const { modsDir } = await start({ counter: COUNTER });
    const input = new NodeStream.PassThrough();
    const lines: Array<Record<string, unknown>> = [];
    const answered = new Promise<void>((resolve) => {
      serveModEngine(input, (line) => {
        const message = JSON.parse(line) as Record<string, unknown>;
        lines.push(message);
        if (message.id === 3) resolve();
      });
    });

    const say = (message: unknown) => input.write(`${JSON.stringify(message)}\n`);
    say({
      id: 1,
      session: "s",
      method: "start",
      params: { modsDir, cwd: modsDir, storeDir: modsDir },
    });
    say({ id: 2, session: "s", method: "runCommand", params: { name: "count", args: "x" } });
    say({
      id: 3,
      session: "s",
      method: "render",
      params: { clientId: "w", component: "Pane", instanceId: "counter", props: {} },
    });
    await answered;
    input.end();

    expect(lines.find((line) => line.id === 2)?.result).toMatchObject({ text: "opened x" });
    expect(lines.find((line) => line.id === 3)?.result).toMatchObject({ hooked: true });
    expect(lines).toContainEqual({
      session: "s",
      event: { type: "commands", commands: [expect.objectContaining({ name: "count" })] },
    });
  });
});

describe("mod engine", () => {
  const statusMod = `export function register(on) {
    on("tool.call", ($, e, next) => { $.ui.status(e.text); return next(e) })
  }`;
  const setStatus = (engine: ModEngine, text: string | null) =>
    engine.notify({ name: "tool.call", tool: "status", toolUseId: "s", input: { text } });

  it("sends isolated statuses immediately and folds each mod's latest status, including clears", async () => {
    const { engine, events } = await start({ a: statusMod, b: statusMod });
    vi.useFakeTimers();
    const lines = () => events.filter((event) => event.type === "status");

    await setStatus(engine, "first");
    expect(lines()).toEqual([
      { type: "status", plugin: "a", text: "first" },
      { type: "status", plugin: "b", text: "first" },
    ]);
    for (let i = 0; i < 100; i++) await setStatus(engine, String(i));
    await vi.advanceTimersByTimeAsync(39);
    expect(lines()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(lines().slice(-2)).toEqual([
      { type: "status", plugin: "a", text: "99" },
      { type: "status", plugin: "b", text: "99" },
    ]);

    await setStatus(engine, "superseded");
    await setStatus(engine, null);
    await vi.advanceTimersByTimeAsync(39);
    expect(lines()).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(lines().slice(-2)).toEqual([
      { type: "status", plugin: "a", text: null },
      { type: "status", plugin: "b", text: null },
    ]);
    await vi.advanceTimersByTimeAsync(40);
    await setStatus(engine, "isolated");
    expect(lines()).toHaveLength(8);
    expect(
      lines()
        .slice(-2)
        .map((event) => event.text),
    ).toEqual(["isolated", "isolated"]);
  });

  it("cancels pending statuses when disposed", async () => {
    const { engine, events } = await start({ lamp: statusMod });
    vi.useFakeTimers();
    await setStatus(engine, "first");
    await setStatus(engine, "pending");
    engine.dispose();
    const count = events.length;
    await vi.advanceTimersByTimeAsync(40);
    expect(events).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels old status folds on reload and clears a removed mod with a pending clear", async () => {
    const { engine, events, modsDir } = await start({ lamp: statusMod, kept: statusMod });
    vi.useFakeTimers();
    await setStatus(engine, "first");
    await setStatus(engine, null);
    NodeFS.rmSync(NodePath.join(modsDir, "lamp"), { recursive: true });
    await engine.reload();
    expect(events).toContainEqual({ type: "status", plugin: "lamp", text: null });
    await setStatus(engine, "new");
    expect(events).toContainEqual({ type: "status", plugin: "kept", text: "new" });
    const count = events.filter((event) => event.type === "status").length;
    await vi.advanceTimersByTimeAsync(40);
    expect(events.filter((event) => event.type === "status")).toHaveLength(count);
  });

  it("runs a mod's command, opens its pane and draws it", async () => {
    const { engine } = await start({ counter: COUNTER });

    expect(engine.commands()).toEqual([
      { name: "count", description: "Open the counter", plugin: "counter" },
    ]);
    expect(await engine.runCommand("count", "now")).toEqual({
      handled: true,
      plugin: "counter",
      text: "opened now",
    });
    expect(engine.panes()).toMatchObject({
      panes: [{ id: "counter", title: "Counter", plugin: "counter" }],
      shownId: "counter",
    });

    const drawn = await drawPane(engine, "counter");
    expect(drawn.hooked).toBe(true);
    expect(textOf(drawn.tree)).toBe("count 0");
    expect(find(drawn.tree, "Button")?.props).toEqual({ key: "add", label: "Add" });
  });

  it("answers a press with the mod's handler, whose state shows in the next drawing", async () => {
    const { engine } = await start({ counter: COUNTER });
    await engine.runCommand("count");
    const press = find((await drawPane(engine, "counter")).tree, "Button")?.press;

    expect(await engine.press({ clientId: "window", ...press! })).toEqual({
      handled: true,
      element: "add",
    });
    expect(textOf((await drawPane(engine, "counter")).tree)).toBe("count 1");
  });

  it("finds a pressed element by key after a redraw retired its handle", async () => {
    const { engine } = await start({ counter: COUNTER });
    await engine.runCommand("count");
    const press = find((await drawPane(engine, "counter")).tree, "Button")?.press;
    await drawPane(engine, "counter");
    await drawPane(engine, "counter");

    expect(await engine.press({ clientId: "window", ...press! })).toEqual({ handled: false });
    expect(
      await engine.press({
        clientId: "window",
        ...press!,
        key: "add",
        component: "Pane",
        instanceId: "counter",
      }),
    ).toEqual({ handled: true, element: "add" });
  });

  it("lets a mod's ui.close hook keep its pane open", async () => {
    const { engine } = await start({ counter: COUNTER });
    await engine.runCommand("count");

    expect(await engine.close("counter")).toEqual({ closed: false });

    const press = find((await drawPane(engine, "counter")).tree, "Button")?.press;
    await engine.press({ clientId: "window", ...press! });
    expect(await engine.close("counter")).toEqual({ closed: true });
    expect(engine.panes().panes).toEqual([]);
  });

  it("says a component no mod draws is unhooked, so a host stops asking", async () => {
    const { engine } = await start({ counter: COUNTER });

    const band = await engine.render({
      clientId: "window",
      component: "AbovePrompt",
      instanceId: "above-prompt",
      props: {},
    });

    expect(band).toMatchObject({ hooked: false, tree: { type: "engine", ref: 0 } });
  });

  it("runs hooks outermost first and lets an inner mod's answer pass through next", async () => {
    const outer = `export function register(on) {
      on("command.run", async ($, e, next) => {
        const inner = await next({ ...e, args: e.args + "!" })
        return { text: "outer(" + inner.text + ")" }
      })
    }`;
    const inner = `export function register(on) {
      on("session.start", async ($, e, next) => {
        await $.command.register({ name: "echo", description: "" })
        return next(e)
      })
      on("command.run", { command: "echo" }, async ($, e) => ({ text: e.args }))
    }`;
    const { engine } = await start({ a: outer, b: inner });

    expect(await engine.runCommand("echo", "hi")).toMatchObject({ text: "outer(hi!)" });
  });

  it("keeps running the other mods when one fails to load or a hook throws", async () => {
    const throwing = `export function register(on) {
      on("command.run", () => { throw new Error("boom") })
    }`;
    const { engine, events } = await start({
      a: "export const nothing = 1",
      b: throwing,
      counter: COUNTER,
    });

    expect(engine.plugins().find((plugin) => plugin.name === "a")?.error).toBe(
      "a mod must export register(on)",
    );
    expect(await engine.runCommand("count", "x")).toMatchObject({ text: "opened x" });
    expect(events).toContainEqual({
      type: "log",
      plugin: "b",
      text: "command.run failed: Error: boom",
    });
  });

  it("refuses what the host does not provide and remembers it per mod", async () => {
    const asking = `export function register(on) {
      on("session.start", async ($, e, next) => {
        await $.command.register({ name: "ask", description: "" })
        return next(e)
      })
      on("command.run", { command: "ask" }, async ($) => {
        try { await $.model.complete({ prompt: "hi" }) } catch (error) { return { text: error.message } }
      })
    }`;
    const { engine } = await start({ asking });

    expect(await engine.runCommand("ask")).toMatchObject({
      text: "$.model.complete is not available in this host",
    });
    expect(engine.plugins()[0]?.unsupported).toEqual(["$.model.complete"]);
  });

  it("reads the composer through the window that answers", async () => {
    const reader = `export function register(on) {
      on("session.start", async ($, e, next) => {
        await $.command.register({ name: "read", description: "" })
        return next(e)
      })
      on("command.run", { command: "read" }, async ($) => ({ text: (await $.prompt.read()).text }))
    }`;
    const { engine } = await start({ reader });

    expect(await engine.runCommand("read")).toMatchObject({ text: "draft" });
  });

  it("runs the example mod its own guide teaches", async () => {
    const example = /```tsx\n([\s\S]*?)```/.exec(MOD_GUIDE)?.[1] ?? "";
    const { engine } = await start({ todo: example });

    expect(engine.plugins()).toEqual([{ name: "todo", path: expect.any(String), unsupported: [] }]);
    expect(await engine.runCommand("todo", "buy milk")).toMatchObject({
      text: "Todo list opened.",
    });
    const drawn = await drawPane(engine, "todo");
    expect(textOf(find(drawn.tree, "Text")!)).toBe("1 to do");

    const input = find(drawn.tree, "Input")?.press;
    await engine.input({ clientId: "window", ...input!, kind: "submit", value: "call mom" });
    const done = find((await drawPane(engine, "todo")).tree, "Button")?.press;
    await engine.press({ clientId: "window", ...done! });
    const after = (await drawPane(engine, "todo")).tree;
    expect(textOf(find(after, "Text")!)).toBe("1 to do");
    expect(JSON.stringify(after)).toContain("call mom");
  });

  it("takes a removed mod's pane and status line away on reload", async () => {
    const lamp = `export function register(on) {
      on("session.start", async ($, e, next) => {
        $.ui.status("lamp on")
        await $.ui.open({ id: "lamp", title: "Lamp" })
        return next(e)
      })
    }`;
    const { engine, events, modsDir } = await start({ lamp, counter: COUNTER });
    expect(engine.panes().panes.map((pane) => pane.id)).toEqual(["lamp"]);

    NodeFS.rmSync(NodePath.join(modsDir, "lamp"), { recursive: true });
    await engine.reload();

    expect(engine.panes().panes).toEqual([]);
    expect(events).toContainEqual({ type: "status", plugin: "lamp", text: null });
    expect(engine.commands().map((command) => command.name)).toEqual(["count"]);
  });

  it("keeps what a mod puts in its store for the next time the editor opens", async () => {
    const list = `
      import { atom, read, update } from "mods"
      const items = atom({ plugin: "list", key: "items" }, [])
      export function register(on) {
        on("session.start", async ($, e, next) => {
          await $.command.register({ name: "add", description: "" })
          const saved = await $.store.get("items")
          if (saved !== undefined) await update($, items, () => saved)
          return next(e)
        })
        on("command.run", { command: "add" }, async ($, e) => {
          await $.store.set("items", await update($, items, (all) => [...all, e.args]))
          return { text: (await read($, items)).join(",") }
        })
      }`;
    const first = await start({ list });
    expect(await first.engine.runCommand("add", "milk")).toMatchObject({ text: "milk" });
    first.engine.dispose();

    const again = createModEngine({
      modsDir: first.modsDir,
      cwd: first.modsDir,
      storeDir: NodePath.join(first.modsDir, ".store"),
      emit: () => {},
      ask: async () => undefined,
    });
    engines.push(again);
    await again.start();

    expect(await again.runCommand("add", "eggs")).toMatchObject({ text: "milk,eggs" });
  });

  it("reports a mod that never finishes loading and still loads the others", async () => {
    const { engine } = await start({
      a: "while (true) {}",
      b: "export function register() { for (;;) {} }",
      counter: COUNTER,
    });

    expect(engine.plugins().map((plugin) => [plugin.name, plugin.error])).toEqual([
      ["counter", undefined],
      ["a", "Error: Script execution timed out after 300ms"],
      ["b", "Error: Script execution timed out after 300ms"],
    ]);
    expect(await engine.runCommand("count", "x")).toMatchObject({ text: "opened x" });
  });

  it("leaves no hook of a mod that failed halfway through registering", async () => {
    const half = `export function register(on) {
      on("command.run", () => ({ text: "from the broken mod" }))
      throw new Error("stopped halfway")
    }`;
    const { engine } = await start({ a: half, counter: COUNTER });

    expect(engine.plugins().find((plugin) => plugin.name === "a")?.error).toBe(
      "Error: stopped halfway",
    );
    expect(await engine.runCommand("count", "x")).toMatchObject({ text: "opened x" });
  });

  it("hands a command back when every hook passed it on, and keeps one name to one mod", async () => {
    const shy = `export function register(on) {
      on("session.start", async ($, e, next) => {
        await $.command.register({ name: "shy", description: "" })
        await $.command.register({ name: "count", description: "taken" }).catch((error) => $.ui.log(error.message))
        return next(e)
      })
      on("command.run", { command: "shy" }, ($, e, next) => next(e))
    }`;
    const { engine, events } = await start({ counter: COUNTER, shy });

    expect(await engine.runCommand("shy")).toEqual({ handled: false });
    expect(engine.commands().find((command) => command.name === "count")?.plugin).toBe("counter");
    expect(events).toContainEqual({
      type: "log",
      plugin: "shy",
      text: "/count already belongs to the mod counter",
    });
  });

  it("carries messages between a mod and the page in its frame", async () => {
    const game = `
      import { atom, read, update } from "mods"
      const score = atom({ plugin: "game", key: "score" }, 0)
      export function register(on) {
        on("session.start", async ($, e, next) => {
          await $.ui.open({ id: "game", title: "Game" })
          return next(e)
        })
        on("ui.render", { component: "Pane", requestId: "game" }, async ($, e) => {
          const { Box, Frame, Text } = $.ui.resolve(e)
          return (
            <Box flexDirection="column">
              <Text>score {await read($, score)}</Text>
              <Frame key="board" height={200} html="<canvas></canvas>" onMessage={async (data) => {
                await update($, score, () => data.score)
                $.ui.post({ key: "board", data: { saved: data.score } })
              }} />
            </Box>
          )
        })
      }`;
    const { engine, events } = await start({ game });
    const frame = find((await drawPane(engine, "game")).tree, "Frame");
    expect(frame?.props).toEqual({ key: "board", html: "<canvas></canvas>", height: 200 });

    expect(
      await engine.message({ clientId: "window", ...frame!.press!, data: { score: 7 } }),
    ).toEqual({ handled: true, element: "board" });

    expect(textOf(find((await drawPane(engine, "game")).tree, "Text")!)).toBe("score 7");
    expect(events).toContainEqual({
      type: "post",
      clientId: "window",
      component: "Pane",
      instanceId: "game",
      plugin: "game",
      key: "board",
      data: { saved: 7 },
    });
  });

  it("lets a mod import a page beside it as text", async () => {
    const { engine, modsDir } = await start({});
    NodeFS.mkdirSync(NodePath.join(modsDir, "paged"));
    NodeFS.writeFileSync(NodePath.join(modsDir, "paged", "mod.json"), '{"name":"paged"}');
    NodeFS.writeFileSync(NodePath.join(modsDir, "paged", "page.html"), "<canvas></canvas>");
    NodeFS.writeFileSync(
      NodePath.join(modsDir, "paged", "mod.tsx"),
      `import page from "./page.html"
       export function register(on) {
         on("session.start", async ($, e, next) => {
           await $.command.register({ name: "page", description: "" })
           return next(e)
         })
         on("command.run", { command: "page" }, () => ({ text: page }))
       }`,
    );
    await engine.reload();

    expect(await engine.runCommand("page")).toMatchObject({ text: "<canvas></canvas>" });
  });

  it("asks the host to bring a pane forward when a command opens it again", async () => {
    const { engine } = await start({ counter: COUNTER });
    expect(engine.panes().reveal).toBe(0);

    await engine.runCommand("count");
    const first = engine.panes().reveal;
    // The person put the panel away and typed the command again: same pane, shown again.
    await engine.runCommand("count");

    expect(first).toBe(1);
    expect(engine.panes().reveal).toBe(2);
  });

  it("tells mods what the agent did, whichever agent it was", async () => {
    const watcher = `export function register(on) {
      let tools = 0
      on("tool.call", ($, e, next) => { tools += 1; return next(e) })
      on("turn.complete", ($, e, next) => { $.ui.status(e.reason + " after " + tools + " tools"); return next(e) })
    }`;
    const { engine, events } = await start({ watcher });

    await engine.notify({
      name: "tool.call",
      tool: "shell",
      toolUseId: "1",
      input: { command: "ls" },
    });
    await engine.notify({ name: "turn.complete", turnId: "t1", reason: "answer" });

    expect(events).toContainEqual({
      type: "status",
      plugin: "watcher",
      text: "answer after 1 tools",
    });
  });

  it("loads an edited mod again and keeps the state it had", async () => {
    const { engine, modsDir } = await start({ counter: COUNTER });
    await engine.runCommand("count");
    const press = find((await drawPane(engine, "counter")).tree, "Button")?.press;
    await engine.press({ clientId: "window", ...press! });

    NodeFS.writeFileSync(
      NodePath.join(modsDir, "counter", "mod.tsx"),
      COUNTER.replace("<Text>count ", "<Text>total "),
    );
    await engine.reload();

    expect(textOf((await drawPane(engine, "counter")).tree)).toBe("total 1");
  });
});
