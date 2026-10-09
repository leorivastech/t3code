import type { VoiceAction, VoiceOrder } from "@t3tools/contracts";

export interface VoiceHold {
  released: boolean;
  cancelled: boolean;
  executed: Array<VoiceAction>;
  releaseOnly?: boolean;
  lastLiveAudio?: Blob;
}

export const isLiveVoiceOrder = (order: VoiceOrder): boolean =>
  order.understood &&
  order.actions.length > 0 &&
  order.actions.every((action) => ["jump", "next", "prev", "scroll"].includes(action.op));

/** Remove only the already executed prefix from the complete order on release. */
export function remainingVoiceOrder(order: VoiceOrder, hold: VoiceHold): VoiceOrder | null {
  if (hold.executed.length === 0) return order;
  const matches = hold.executed.every(
    (action, index) => JSON.stringify(action) === JSON.stringify(order.actions[index]),
  );
  // A different interpretation must not replay navigation or send into a different thread.
  if (!matches) return null;
  const actions = order.actions.slice(hold.executed.length);
  return actions.length === 0 ? null : { ...order, actions };
}

interface Recording {
  readonly audio: Blob;
  readonly hold: VoiceHold;
  readonly live: boolean;
  readonly tail?: Blob;
}

/** One request at a time and only the latest live phrase waiting behind it. */
export function createVoiceQueue(input: {
  readonly interpret: (audio: Blob) => Promise<VoiceOrder>;
  readonly run: (order: VoiceOrder) => Promise<void>;
  readonly failed: (cause: unknown) => void;
}) {
  const pending: Array<Recording> = [];
  let running = false;

  const drain = async () => {
    if (running) return;
    running = true;
    try {
      for (let recording = pending.shift(); recording; recording = pending.shift()) {
        const { hold, live } = recording;
        if (hold.cancelled || (live && hold.released)) continue;
        try {
          const tailOnly = !live && hold.executed.length > 0 && !hold.releaseOnly;
          if (tailOnly && (!recording.tail || recording.tail === hold.lastLiveAudio)) continue;
          const order = await input.interpret(tailOnly ? recording.tail! : recording.audio);
          if (hold.cancelled || (live && hold.released)) continue;
          if (live) {
            if (!order.understood) continue;
            if (!isLiveVoiceOrder(order)) {
              hold.releaseOnly = true;
              continue;
            }
            if (hold.releaseOnly) continue;
            await input.run(order);
            hold.executed.push(...order.actions);
            hold.lastLiveAudio = recording.audio;
          } else {
            const remaining = tailOnly ? order : remainingVoiceOrder(order, hold);
            if (remaining) await input.run(remaining);
          }
        } catch (cause) {
          if (!hold.cancelled) input.failed(cause);
        }
      }
    } finally {
      running = false;
    }
  };

  return {
    submit(audio: Blob, hold: VoiceHold, live: boolean, tail?: Blob): Promise<void> {
      // Releasing supersedes unfinished live phrases with the complete recording.
      for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i]?.live && pending[i]?.hold === hold) pending.splice(i, 1);
      }
      pending.push({ audio, hold, live, ...(tail ? { tail } : {}) });
      return drain();
    },
  };
}
