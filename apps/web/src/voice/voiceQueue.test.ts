import { describe, expect, it } from "vite-plus/test";
import type { VoiceAction, VoiceOrder } from "@t3tools/contracts";
import {
  createVoiceQueue,
  isLiveVoiceOrder,
  remainingVoiceOrder,
  type VoiceHold,
} from "./voiceQueue";

const hold = (): VoiceHold => ({ released: false, cancelled: false, executed: [] });
const order = (...actions: Array<VoiceAction>): VoiceOrder => ({
  heard: "test",
  says: "test",
  understood: true,
  actions,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("voice while CTRL is held", () => {
  it("allows navigation and scroll, but no mixed send, stop, photo or model orders", () => {
    expect(
      isLiveVoiceOrder(order({ op: "jump", n: 1 }, { op: "scroll", to: "up", pages: 1 })),
    ).toBe(true);
    for (const action of [
      { op: "send" },
      { op: "stop" },
      { op: "photo" },
      { op: "model", query: "opus" },
    ] as Array<VoiceAction>) {
      expect(isLiveVoiceOrder(order({ op: "jump", n: 1 }, action))).toBe(false);
    }
    expect(isLiveVoiceOrder(order())).toBe(false);
  });

  it("runs the latest pending phrase instead of a backlog", async () => {
    const first = deferred<VoiceOrder>();
    const interpreted: Array<Blob> = [];
    const ran: Array<VoiceOrder> = [];
    const queue = createVoiceQueue({
      interpret: (blob) => {
        interpreted.push(blob);
        return interpreted.length === 1
          ? first.promise
          : Promise.resolve(order({ op: "jump", n: 3 }));
      },
      run: async (value) => {
        ran.push(value);
      },
      failed: () => {},
    });
    const take = hold();
    const one = new Blob(["one"]),
      two = new Blob(["two"]),
      three = new Blob(["three"]);
    const done = queue.submit(one, take, true);
    void queue.submit(two, take, true);
    void queue.submit(three, take, true);
    first.resolve(order({ op: "jump", n: 1 }));
    await done;
    expect(interpreted).toEqual([one, three]);
    expect(ran.map((value) => value.actions)).toEqual([
      [{ op: "jump", n: 1 }],
      [{ op: "jump", n: 3 }],
    ]);
  });

  it("holds a complete non-navigation phrase until release", async () => {
    const ran: Array<VoiceOrder> = [];
    const value = order({ op: "write", text: "check this", send: false }, { op: "send" });
    const queue = createVoiceQueue({
      interpret: async () => value,
      run: async (o) => {
        ran.push(o);
      },
      failed: () => {},
    });
    const take = hold();
    await queue.submit(new Blob(), take, true);
    expect(ran).toEqual([]);
    take.released = true;
    await queue.submit(new Blob(), take, false);
    expect(ran).toEqual([value]);
  });

  it("drops a late result after cancellation", async () => {
    const first = deferred<VoiceOrder>();
    const ran: Array<VoiceOrder> = [];
    const queue = createVoiceQueue({
      interpret: () => first.promise,
      run: async (o) => {
        ran.push(o);
      },
      failed: () => {},
    });
    const take = hold();
    const done = queue.submit(new Blob(), take, true);
    take.cancelled = true;
    first.resolve(order({ op: "jump", n: 1 }));
    await done;
    expect(ran).toEqual([]);
  });

  it("continues after a failed request", async () => {
    let calls = 0;
    const ran: Array<VoiceOrder> = [],
      failures: Array<unknown> = [];
    const queue = createVoiceQueue({
      interpret: async () => {
        if (++calls === 1) throw new Error("offline");
        return order({ op: "next" });
      },
      run: async (o) => {
        ran.push(o);
      },
      failed: (e) => {
        failures.push(e);
      },
    });
    await queue.submit(new Blob(), hold(), true);
    await queue.submit(new Blob(), hold(), true);
    expect(failures).toHaveLength(1);
    expect(ran).toHaveLength(1);
  });

  it("on release hears the trailing phrase, without replaying completed scrolls", async () => {
    const audio = new Blob(["up, down"]),
      tail = new Blob(["down"]);
    const heard: Array<Blob> = [],
      ran: Array<VoiceOrder> = [];
    const queue = createVoiceQueue({
      interpret: async (blob) => {
        heard.push(blob);
        return order({ op: "scroll", to: "down", pages: 1 });
      },
      run: async (o) => {
        ran.push(o);
      },
      failed: () => {},
    });
    const take = hold();
    take.released = true;
    take.executed.push({ op: "scroll", to: "up", pages: 1 });
    await queue.submit(audio, take, false, tail);
    expect(heard).toEqual([tail]);
    expect(ran).toHaveLength(1);
    await queue.submit(audio, take, false);
    expect(heard).toHaveLength(1);
  });

  it("does not replay the last completed phrase when releasing during silence", async () => {
    const ran: Array<VoiceOrder> = [];
    const value = order({ op: "scroll", to: "up", pages: 1 });
    const queue = createVoiceQueue({
      interpret: async () => value,
      run: async (o) => {
        ran.push(o);
      },
      failed: () => {},
    });
    const take = hold(),
      phrase = new Blob(["up"]);
    await queue.submit(phrase, take, true);
    take.released = true;
    await queue.submit(new Blob(["whole"]), take, false, phrase);
    expect(ran).toHaveLength(1);
  });

  it("on release still executes the last phrase that was waiting behind a slow one", async () => {
    const pending = deferred<VoiceOrder>(),
      ran: Array<VoiceOrder> = [];
    let calls = 0;
    const queue = createVoiceQueue({
      interpret: () =>
        ++calls === 1
          ? Promise.resolve(order({ op: "jump", n: 1 }))
          : calls === 2
            ? pending.promise
            : Promise.resolve(order({ op: "jump", n: 3 })),
      run: async (o) => {
        ran.push(o);
      },
      failed: () => {},
    });
    const take = hold(),
      phrase = new Blob(["three"]);
    await queue.submit(new Blob(["one"]), take, true);
    const done = queue.submit(new Blob(["two"]), take, true);
    void queue.submit(phrase, take, true);
    take.released = true;
    void queue.submit(new Blob(["whole"]), take, false, phrase);
    pending.resolve(order({ op: "jump", n: 2 }));
    await done;
    expect(ran.map((o) => o.actions)).toEqual([[{ op: "jump", n: 1 }], [{ op: "jump", n: 3 }]]);
  });

  it("supersedes an in-flight phrase on release with the full recording", async () => {
    const first = deferred<VoiceOrder>(),
      ran: Array<VoiceOrder> = [];
    let calls = 0;
    const queue = createVoiceQueue({
      interpret: () =>
        ++calls === 1 ? first.promise : Promise.resolve(order({ op: "jump", n: 2 })),
      run: async (o) => {
        ran.push(o);
      },
      failed: () => {},
    });
    const take = hold();
    const done = queue.submit(new Blob(), take, true);
    take.released = true;
    void queue.submit(new Blob(), take, false);
    first.resolve(order({ op: "jump", n: 1 }));
    await done;
    expect(ran.map((o) => o.actions)).toEqual([[{ op: "jump", n: 2 }]]);
  });

  it("removes an exact executed prefix and rejects contradictory interpretations", () => {
    const take = hold();
    take.executed.push({ op: "jump", n: 2 });
    expect(
      remainingVoiceOrder(
        order({ op: "jump", n: 2 }, { op: "write", text: "hello", send: false }),
        take,
      )?.actions,
    ).toEqual([{ op: "write", text: "hello", send: false }]);
    expect(remainingVoiceOrder(order({ op: "jump", n: 3 }, { op: "send" }), take)).toBeNull();
  });
});
