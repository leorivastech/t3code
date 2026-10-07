import {
  type ModAsk,
  type ModLogLine,
  type ModOperation,
  type ModRequestResult,
  type ModSnapshot,
  type ModToast,
  EMPTY_MOD_SNAPSHOT,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createModSurface } from "./modSurface";

const CLIENT = "t3-test";
const band = { type: "Box", children: [{ type: "Text", children: ["hello"] }] };

/** A snapshot in which this window is attached to the session, unless `patch` says otherwise. */
const snapshot = (patch: Partial<ModSnapshot>): ModSnapshot => ({
  ...EMPTY_MOD_SNAPSHOT,
  clients: patch.session == null ? [] : [CLIENT],
  ...patch,
});

/** Lets every pending promise callback run. */
const settle = async () => {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
};

/** A surface over a fake session that records what it is asked and answers from `answer`. */
function harness(
  answer: (operation: ModOperation) => unknown = (operation) =>
    operation.op === "render"
      ? { tree: band, props: operation.props, rewritten: false, hooked: true }
      : {},
) {
  const sent: Array<{ session: string; operation: ModOperation }> = [];
  const toasts: Array<ModToast | ModLogLine> = [];
  const asks: ModAsk[] = [];
  let held: Array<() => void> | null = null;
  const retries: Array<{ retry: () => void; delayMs: number }> = [];
  const failing = new Set<ModOperation["op"]>();
  const surface = createModSurface({
    clientId: CLIENT,
    schedule: (retry, delayMs) => retries.push({ retry, delayMs }),
    send: (session, operation) => {
      sent.push({ session, operation });
      const result: ModRequestResult = failing.has(operation.op)
        ? { status: "failed" }
        : { status: "ok", response: answer(operation) };
      if (held === null) return Promise.resolve(result);
      const queue = held;
      return new Promise((resolve) => queue.push(() => resolve(result)));
    },
    onNotice: (notice) => toasts.push(notice),
    onAsk: async (ask) => {
      asks.push(ask);
      return { copied: true };
    },
  });
  return {
    surface,
    sent,
    toasts,
    asks,
    retries,
    /** Makes operations of this kind fail until removed. */
    failing,
    ops: () => sent.map((entry) => entry.operation.op),
    renders: () => sent.filter((entry) => entry.operation.op === "render").length,
    /** Makes sends wait until `release` is called. */
    hold: () => {
      held = [];
    },
    release: () => {
      const queue = held ?? [];
      held = null;
      for (const resolve of queue) resolve();
    },
  };
}

describe("createModSurface", () => {
  it("attaches to a new session, then draws what was mounted", async () => {
    const { surface, ops, sent } = harness();
    surface.setViewport({ columns: 100, rows: 40, isFullscreen: true });
    surface.mount("AbovePrompt", "above-prompt", () => ({ props: { isWorking: false } }));
    expect(ops()).toEqual([]);

    surface.applySnapshot(snapshot({ session: "s1" }));
    await settle();

    expect(ops()).toEqual(["attach", "render"]);
    expect(sent[0]?.operation).toMatchObject({
      op: "attach",
      viewport: { columns: 100, rows: 40, isFullscreen: true },
    });
    expect(surface.result("AbovePrompt", "above-prompt")?.tree).toEqual(band);
  });

  it("reports a resized viewport by attaching again", async () => {
    const { surface, sent } = harness();
    surface.setViewport({ columns: 100, rows: 40 });
    surface.applySnapshot(snapshot({ session: "s1" }));
    await settle();

    surface.setViewport({ columns: 80, rows: 40 });
    await settle();

    const attaches = sent.filter((entry) => entry.operation.op === "attach");
    expect(attaches).toHaveLength(2);
    expect(attaches[1]?.operation).toEqual({ op: "attach", viewport: { columns: 80, rows: 40 } });
  });

  it("stops asking for an instance no mod draws until everything goes stale", async () => {
    const { surface, renders } = harness((operation) =>
      operation.op === "render"
        ? { tree: { type: "engine", ref: 0 }, props: {}, rewritten: false, hooked: false }
        : {},
    );
    surface.applySnapshot(snapshot({ session: "s1" }));
    surface.mount("AbovePrompt", "above-prompt", () => ({ props: {} }));
    await settle();
    expect(renders()).toBe(1);

    surface.refresh("AbovePrompt", "above-prompt");
    await settle();
    expect(renders()).toBe(1);

    surface.applySnapshot(snapshot({ session: "s1", renderEpoch: 1 }));
    await settle();
    expect(renders()).toBe(2);
  });

  it("redraws only the instances a partial invalidate names", async () => {
    const { surface, sent } = harness();
    surface.applySnapshot(snapshot({ session: "s1" }));
    surface.mount("Pane", "one", () => ({ props: {} }));
    surface.mount("Pane", "two", () => ({ props: {} }));
    await settle();
    sent.length = 0;

    const stale = [{ seq: 1, component: "Pane", instanceId: "two" }];
    surface.applySnapshot(snapshot({ session: "s1", stale }));
    // The same list again, as every later snapshot resends it.
    surface.applySnapshot(snapshot({ session: "s1", stale, statuses: [] }));
    await settle();

    expect(sent.map((entry) => entry.operation)).toMatchObject([
      { op: "render", instanceId: "two" },
    ]);
  });

  it("folds asks that arrive while one is in flight into a single follow-up", async () => {
    const { surface, renders, hold, release } = harness();
    surface.applySnapshot(snapshot({ session: "s1" }));
    await settle();
    hold();
    surface.mount("Pane", "one", () => ({ props: {} }));
    surface.refresh("Pane", "one");
    surface.refresh("Pane", "one");
    surface.refresh("Pane", "one");
    expect(renders()).toBe(1);

    release();
    await settle();
    expect(renders()).toBe(2);
  });

  it("drops what it drew and attaches again when the session is replaced", async () => {
    const { surface, ops } = harness();
    let changes = 0;
    surface.subscribe("Pane", "one", () => {
      changes += 1;
    });
    surface.applySnapshot(snapshot({ session: "s1" }));
    surface.mount("Pane", "one", () => ({ props: {} }));
    await settle();
    expect(surface.result("Pane", "one")).not.toBeNull();

    surface.applySnapshot(snapshot({ session: null }));
    expect(surface.result("Pane", "one")).toBeNull();
    expect(changes).toBe(2);

    surface.applySnapshot(snapshot({ session: "s2" }));
    await settle();
    expect(ops().slice(-2)).toEqual(["attach", "render"]);
    expect(surface.result("Pane", "one")).not.toBeNull();
  });

  it("ignores an answer that lands after its session was replaced", async () => {
    const { surface, hold, release } = harness();
    surface.applySnapshot(snapshot({ session: "s1" }));
    await settle();
    hold();
    surface.mount("Pane", "one", () => ({ props: {} }));

    surface.applySnapshot(snapshot({ session: null }));
    release();
    await settle();

    expect(surface.result("Pane", "one")).toBeNull();
  });

  it("shows toasts once, and not the ones raised before the window opened", async () => {
    const { surface, toasts } = harness();
    const toast = (seq: number) => ({ seq, plugin: "lab", text: `toast ${seq}`, timeoutMs: 4000 });

    surface.applySnapshot(snapshot({ session: "s1", toasts: [toast(1), toast(2)] }));
    expect(toasts).toEqual([]);

    surface.applySnapshot(snapshot({ session: "s1", toasts: [toast(1), toast(2), toast(3)] }));
    surface.applySnapshot(snapshot({ session: "s1", toasts: [toast(2), toast(3), toast(4)] }));
    expect(toasts.map((entry) => entry.seq)).toEqual([3, 4]);
  });

  it("shows the toasts of a session that started while the window was open", () => {
    const { surface, toasts } = harness();
    surface.applySnapshot(snapshot({ session: null }));
    surface.applySnapshot(
      snapshot({
        session: "s1",
        toasts: [{ seq: 1, plugin: "lab", text: "ready", timeoutMs: 4000 }],
      }),
    );
    expect(toasts.map((entry) => entry.text)).toEqual(["ready"]);
  });

  it("shows a mod's log lines as it shows its toasts, each once and in order", () => {
    const { surface, toasts } = harness();
    const log = (seq: number) => ({ seq, plugin: "lab", text: `log ${seq}`, at: "" });
    surface.applySnapshot(snapshot({ session: "s1", logs: [log(1)] }));
    expect(toasts).toEqual([]);

    const next = {
      session: "s1",
      logs: [log(1), log(2), log(4)],
      toasts: [{ seq: 3, plugin: "lab", text: "toast 3", timeoutMs: 4000 }],
    };
    surface.applySnapshot(snapshot(next));
    surface.applySnapshot(snapshot(next));
    expect(toasts.map((entry) => entry.text)).toEqual(["log 2", "toast 3", "log 4"]);
  });

  it("holds notices while a pane asks to hold them, then releases them once in order", () => {
    const { surface, toasts } = harness();
    const toast = (seq: number) => ({ seq, plugin: "lab", text: `toast ${seq}`, timeoutMs: 4000 });
    const panes = {
      panes: [{ id: "lab", title: "Lab", plugin: "lab", holdToasts: true }],
      shownId: "lab",
      focusedId: null,
      focusRequestedId: null,
      reveal: 0,
    };
    surface.applySnapshot(snapshot({ session: "s1" }));
    surface.applySnapshot(snapshot({ session: "s1", panes, toasts: [toast(1)] }));
    surface.applySnapshot(snapshot({ session: "s1", panes, toasts: [toast(1), toast(2)] }));
    expect(toasts).toEqual([]);
    const closed = snapshot({ session: "s1", toasts: [toast(1), toast(2), toast(3)] });
    surface.applySnapshot(closed);
    surface.applySnapshot({ ...closed });
    expect(toasts.map((entry) => entry.seq)).toEqual([1, 2, 3]);
  });

  it("does not deliver a retired session's held notices on its replacement", () => {
    const { surface, toasts } = harness();
    surface.applySnapshot(snapshot({ session: "s1" }));
    surface.applySnapshot(
      snapshot({
        session: "s1",
        panes: {
          panes: [{ id: "lab", title: "Lab", plugin: "lab", holdToasts: true }],
          shownId: "lab",
          focusedId: null,
          focusRequestedId: null,
          reveal: 0,
        },
        toasts: [{ seq: 1, plugin: "lab", text: "old", timeoutMs: 4000 }],
      }),
    );
    surface.applySnapshot(snapshot({ session: "s2" }));
    expect(toasts).toEqual([]);
  });

  it("hands a mod's scroll to this window's sites only", async () => {
    const { surface } = harness();
    const seen: number[] = [];
    surface.onCommand((command) => {
      if (command.kind === "scroll") seen.push(command.offset);
    });
    surface.applySnapshot(snapshot({ session: "s1" }));
    await settle();
    const scroll = (seq: number, clientId: string, offset: number) =>
      ({
        kind: "scroll",
        seq,
        clientId,
        component: "Pane",
        instanceId: "one",
        offset,
      }) as const;

    surface.applySnapshot(
      snapshot({ session: "s1", commands: [scroll(1, "another-window", 5), scroll(2, CLIENT, 9)] }),
    );
    expect(seen).toEqual([9]);
  });

  it("answers what a mod asks of this window, once", async () => {
    const { surface, asks, sent } = harness();
    surface.applySnapshot(snapshot({ session: "s1" }));
    await settle();
    const ask = (askId: string, clientId: string) =>
      ({ kind: "copy", askId, clientId, plugin: "lab", text: "copied" }) as const;

    const pending = [ask("ask-1", CLIENT), ask("ask-2", "another-window")];
    surface.applySnapshot(snapshot({ session: "s1", asks: pending }));
    surface.applySnapshot(snapshot({ session: "s1", asks: pending, statuses: [] }));
    await settle();

    expect(asks.map((entry) => entry.askId)).toEqual(["ask-1"]);
    expect(sent.at(-1)?.operation).toEqual({
      op: "answer",
      askId: "ask-1",
      result: { copied: true },
    });
  });

  it("retries a refused attach a few times, later each time, then stops", async () => {
    const { surface, ops, retries, failing } = harness();
    failing.add("attach");
    surface.applySnapshot(snapshot({ session: "s1", clients: [] }));
    await settle();
    expect(ops()).toEqual(["attach"]);

    const delays: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const next = retries.shift();
      if (next === undefined) break;
      delays.push(next.delayMs);
      next.retry();
      await settle();
    }
    expect(delays).toHaveLength(3);
    expect(delays).toEqual([...delays].sort((left, right) => left - right));
    expect(ops()).toEqual(["attach", "attach", "attach", "attach"]);
  });

  it("attaches again when the server no longer lists this window", async () => {
    const { surface, ops } = harness();
    surface.applySnapshot(snapshot({ session: "s1", clients: [] }));
    surface.mount("Pane", "one", () => ({ props: {} }));
    await settle();
    expect(ops()).toEqual(["attach", "render"]);

    surface.applySnapshot(snapshot({ session: "s1" }));
    await settle();
    expect(ops()).toEqual(["attach", "render"]);

    // The connection dropped: the server released the client and says so.
    surface.applySnapshot(snapshot({ session: "s1", clients: [] }));
    await settle();
    expect(ops()).toEqual(["attach", "render", "attach", "render"]);
  });

  it("gives a sender that goes quiet once its session is replaced", async () => {
    const { surface, sent } = harness();
    surface.applySnapshot(snapshot({ session: "s1" }));
    await settle();
    const bound = surface.bind();
    surface.applySnapshot(snapshot({ session: "s2" }));
    await settle();
    sent.length = 0;

    expect(await bound({ op: "press", plugin: "lab", handle: 1 })).toBeUndefined();
    expect(sent).toEqual([]);
  });

  it("shows a remounted instance its last drawing while it asks again", async () => {
    const { surface, hold } = harness();
    surface.applySnapshot(snapshot({ session: "s1" }));
    const unmount = surface.mount("Pane", "one", () => ({ props: {} }));
    await settle();
    unmount();
    expect(surface.result("Pane", "one")).toBeNull();

    hold();
    surface.mount("Pane", "one", () => ({ props: {} }));
    expect(surface.result("Pane", "one")?.tree).toEqual(band);
  });

  it("asks again for a stale instance it had found unhooked", async () => {
    let isHooked = false;
    const { surface, renders } = harness((operation) =>
      operation.op === "render"
        ? {
            tree: isHooked ? band : { type: "engine", ref: 0 },
            props: {},
            rewritten: false,
            hooked: isHooked,
          }
        : {},
    );
    surface.applySnapshot(snapshot({ session: "s1" }));
    surface.mount("Pane", "one", () => ({ props: {} }));
    await settle();
    expect(renders()).toBe(1);

    isHooked = true;
    surface.applySnapshot(
      snapshot({ session: "s1", stale: [{ seq: 1, component: "Pane", instanceId: "one" }] }),
    );
    await settle();
    expect(renders()).toBe(2);
    expect(surface.result("Pane", "one")?.tree).toEqual(band);
  });

  it("draws one instance for two mounts and keeps it until the last unmounts", async () => {
    const { surface, renders } = harness();
    surface.applySnapshot(snapshot({ session: "s1" }));
    const first = surface.mount("Pane", "one", () => ({ props: {} }));
    const second = surface.mount("Pane", "one", () => ({ props: {} }));
    await settle();
    expect(renders()).toBe(1);

    first();
    expect(surface.result("Pane", "one")).not.toBeNull();
    second();
    surface.applySnapshot(snapshot({ session: "s1", renderEpoch: 1 }));
    await settle();
    expect(renders()).toBe(1);
  });

  it("does not keep asking for an unhooked instance whose props change while it is asked", async () => {
    const { surface, renders, hold, release } = harness((operation) =>
      operation.op === "render"
        ? { tree: { type: "engine", ref: 0 }, props: {}, rewritten: false, hooked: false }
        : {},
    );
    surface.applySnapshot(snapshot({ session: "s1" }));
    await settle();
    hold();
    surface.mount("AbovePrompt", "above-prompt", () => ({ props: {} }));
    // A turn starts and ends while the first ask is in flight.
    surface.refresh("AbovePrompt", "above-prompt");
    surface.refresh("AbovePrompt", "above-prompt");
    release();
    await settle();
    surface.refresh("AbovePrompt", "above-prompt");
    await settle();

    expect(renders()).toBe(1);
  });

  it("asks again for an instance marked stale while it is being asked", async () => {
    let isHooked = false;
    const { surface, renders, hold, release } = harness((operation) =>
      operation.op === "render"
        ? {
            tree: isHooked ? band : { type: "engine", ref: 0 },
            props: {},
            rewritten: false,
            hooked: isHooked,
          }
        : {},
    );
    surface.applySnapshot(snapshot({ session: "s1" }));
    await settle();
    hold();
    surface.mount("Pane", "one", () => ({ props: {} }));

    // A mod starts drawing the pane and says so before the first ask answers.
    isHooked = true;
    surface.applySnapshot(
      snapshot({ session: "s1", stale: [{ seq: 1, component: "Pane", instanceId: "one" }] }),
    );
    release();
    await settle();

    expect(renders()).toBe(2);
    expect(surface.result("Pane", "one")?.tree).toEqual(band);
  });

  it("asks again after an ask that failed, instead of reading the instance as unhooked", async () => {
    const { surface, renders, failing } = harness();
    surface.applySnapshot(snapshot({ session: "s1" }));
    await settle();
    failing.add("render");
    surface.mount("Pane", "one", () => ({ props: {} }));
    await settle();
    expect(surface.result("Pane", "one")).toBeNull();

    failing.delete("render");
    surface.refresh("Pane", "one");
    await settle();
    expect(renders()).toBe(2);
    expect(surface.result("Pane", "one")?.tree).toEqual(band);
  });

  it("leaves a newer attach alone when an older one answers late", async () => {
    const { surface, ops, hold, release } = harness();
    hold();
    surface.applySnapshot(snapshot({ session: "s1", clients: [] }));
    surface.applySnapshot(snapshot({ session: "s2", clients: [] }));
    // Both attaches are in flight; a new size must wait for the second one.
    surface.setViewport({ columns: 90, rows: 30 });
    expect(ops()).toEqual(["attach", "attach"]);

    release();
    await settle();
    expect(ops()).toEqual(["attach", "attach", "attach"]);
  });
});
