import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { recordVoiceHold } from "./useHoldToTalk";

describe("held microphone recording", () => {
  let level = 0;
  let now = 0;
  let tick: () => void;
  let stream: MediaStream;
  let stopTrack: ReturnType<typeof vi.fn>;
  let closeContext: ReturnType<typeof vi.fn>;
  let finished: ((keep: boolean) => void) | undefined;
  beforeEach(() => {
    level = 0;
    now = 0;
    stopTrack = vi.fn();
    closeContext = vi.fn(async () => {});
    stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
    vi.stubGlobal("window", {
      setInterval: (fn: () => void) => {
        tick = fn;
        return 1;
      },
      clearInterval: vi.fn(),
    });
    vi.stubGlobal("performance", { now: () => now });
    vi.stubGlobal(
      "AudioContext",
      class {
        createMediaStreamSource() {
          return { connect() {}, disconnect() {} };
        }
        createAnalyser() {
          return {
            fftSize: 1024,
            getFloatTimeDomainData: (samples: Float32Array) => samples.fill(level),
          };
        }
        resume = async () => {};
        close = closeContext;
      },
    );
    vi.stubGlobal(
      "MediaRecorder",
      class extends EventTarget {
        state = "inactive";
        mimeType = "audio/webm";
        start() {
          this.state = "recording";
        }
        stop() {
          this.state = "inactive";
          const event = new Event("dataavailable");
          Object.assign(event, { data: new Blob(["audio"]) });
          this.dispatchEvent(event);
          this.dispatchEvent(new Event("stop"));
        }
      },
    );
  });
  afterEach(() => {
    finished?.(false);
    finished = undefined;
    vi.unstubAllGlobals();
  });
  const sample = (ms: number, amplitude: number) => {
    now += ms;
    level = amplitude;
    tick();
  };

  it("emits repeated utterances without release, and does not emit pure silence", async () => {
    let released!: () => void;
    const releaseDone = new Promise<void>((resolve) => {
      released = resolve;
    });
    const spoken = vi.fn((_recording: Blob, live: boolean, _tail?: Blob) => {
      if (!live) released();
    });
    finished = recordVoiceHold(stream, spoken);
    sample(1000, 0);
    expect(spoken).not.toHaveBeenCalled();
    sample(30, 0.1);
    sample(200, 0.1);
    sample(660, 0);
    expect(spoken).toHaveBeenCalledTimes(1);
    expect(spoken.mock.calls[0]?.[1]).toBe(true);
    expect(stopTrack).not.toHaveBeenCalled();
    sample(30, 0.1);
    sample(200, 0.1);
    sample(660, 0);
    expect(spoken).toHaveBeenCalledTimes(2);
    finished(true);
    finished = undefined;
    await releaseDone;
    expect(spoken.mock.calls[2]?.[1]).toBe(false);
    expect(spoken.mock.calls[2]?.[2]).toBe(spoken.mock.calls[1]?.[0]);
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(closeContext).toHaveBeenCalledOnce();
  });

  it("retains a trailing phrase on release and shuts down the microphone", async () => {
    let released!: () => void;
    const releaseDone = new Promise<void>((resolve) => {
      released = resolve;
    });
    const spoken = vi.fn((_recording: Blob, live: boolean, _tail?: Blob) => {
      if (!live) released();
    });
    finished = recordVoiceHold(stream, spoken);
    sample(30, 0.1);
    sample(200, 0.1);
    finished(true);
    finished = undefined;
    await releaseDone;
    expect(spoken).toHaveBeenCalledOnce();
    expect(spoken.mock.calls[0]?.[1]).toBe(false);
    expect(spoken.mock.calls[0]?.[2]).toBeInstanceOf(Blob);
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it("cancellation does not submit a final recording", async () => {
    const spoken = vi.fn();
    finished = recordVoiceHold(stream, spoken);
    sample(30, 0.1);
    sample(200, 0.1);
    finished(false);
    finished = undefined;
    await Promise.resolve();
    expect(spoken).not.toHaveBeenCalled();
    expect(stopTrack).toHaveBeenCalledOnce();
  });
});
