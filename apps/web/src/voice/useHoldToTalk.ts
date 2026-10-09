import { useEffect, useEffectEvent, useState } from "react";

import type { VoiceHold } from "./voiceQueue";

const MIN_HOLD_MS = 350;
const MAX_HOLD_MS = 60_000;
const AUDIO_BITS_PER_SECOND = 24_000;
const PAUSE_MS = 650;
const MAX_PHRASE_MS = 8_000;

interface Take extends VoiceHold {
  readonly startedAt: number;
  finish?: (keep: boolean) => void;
}

/** Segment navigation phrases, retaining the whole take for other orders on release. */
export function recordVoiceHold(
  stream: MediaStream,
  spoken: (recording: Blob, live: boolean, tail?: Blob) => void,
): (keep: boolean) => void {
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  void context.resume().catch(() => {});
  const samples = new Float32Array(analyser.fftSize);
  let active = true;
  let speechStarted: number | null = null;
  let lastSpeech = 0;
  let lastPhrase: Blob | undefined;
  let lastPhraseDone: Promise<Blob> | undefined;
  const wholeChunks: Array<Blob> = [];
  const whole = new MediaRecorder(stream, { audioBitsPerSecond: AUDIO_BITS_PER_SECOND });
  let keepWhole = false;
  whole.addEventListener("dataavailable", (event) => wholeChunks.push(event.data));
  let wholeStopped!: () => void;
  const wholeDone = new Promise<void>((resolve) => {
    wholeStopped = resolve;
  });
  whole.addEventListener("stop", wholeStopped);
  whole.start();

  const startPhrase = () => {
    const recorder = new MediaRecorder(stream, { audioBitsPerSecond: AUDIO_BITS_PER_SECOND });
    const chunks: Array<Blob> = [];
    let deliver = false;
    let stopped!: (blob: Blob) => void;
    const done = new Promise<Blob>((resolve) => {
      stopped = resolve;
    });
    recorder.addEventListener("dataavailable", (event) => chunks.push(event.data));
    recorder.addEventListener("stop", () => {
      const blob = new Blob(chunks, { type: recorder.mimeType });
      if (deliver) {
        lastPhrase = blob;
        if (active) spoken(blob, true);
      }
      stopped(blob);
    });
    recorder.start();
    return (keep: boolean) => {
      deliver = keep;
      if (recorder.state !== "inactive") recorder.stop();
      return done;
    };
  };
  let finishPhrase = startPhrase();
  const timer = window.setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    const rms = Math.sqrt(
      samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length,
    );
    const now = performance.now();
    if (rms >= 0.015) {
      speechStarted ??= now;
      lastSpeech = now;
    }
    if (
      speechStarted !== null &&
      (now - lastSpeech >= PAUSE_MS || now - speechStarted >= MAX_PHRASE_MS)
    ) {
      lastPhraseDone = finishPhrase(lastSpeech - speechStarted >= 100);
      finishPhrase = startPhrase();
      speechStarted = null;
    }
  }, 30);

  return (keep) => {
    active = false;
    window.clearInterval(timer);
    const hasTail = speechStarted !== null;
    const tail = finishPhrase(false);
    keepWhole = keep;
    if (whole.state !== "inactive") whole.stop();
    void Promise.all([wholeDone, tail, lastPhraseDone]).then(([, tailBlob]) => {
      if (keepWhole)
        spoken(
          new Blob(wholeChunks, { type: whole.mimeType }),
          false,
          hasTail ? tailBlob : lastPhrase,
        );
    });
    source.disconnect();
    void context.close().catch(() => {});
    stream.getTracks().forEach((track) => track.stop());
  };
}

/** CTRL opens the microphone; pauses can navigate, release submits the complete order. */
export function useHoldToTalk(input: {
  readonly holdKey: string;
  readonly enabled: boolean;
  readonly scopeKey: string;
  readonly onSpoken: (recording: Blob, hold: VoiceHold, live: boolean, tail?: Blob) => void;
  readonly onMicrophoneError: () => void;
}): boolean {
  const { holdKey, enabled, scopeKey } = input;
  const [listening, setListening] = useState(false);
  const onSpoken = useEffectEvent(input.onSpoken);
  const onMicrophoneError = useEffectEvent(input.onMicrophoneError);

  useEffect(() => {
    if (!enabled || !scopeKey) return;
    let take: Take | null = null;
    let limit: number | undefined;
    const end = (keep: boolean) => {
      if (take === null) return;
      const current = take;
      current.released = true;
      current.cancelled = !keep || performance.now() - current.startedAt < MIN_HOLD_MS;
      current.finish?.(!current.cancelled);
      window.clearTimeout(limit);
      take = null;
      setListening(false);
    };

    const start = () => {
      const current: Take = {
        startedAt: performance.now(),
        released: false,
        cancelled: false,
        executed: [],
      };
      take = current;
      setListening(true);
      limit = window.setTimeout(() => end(false), MAX_HOLD_MS);
      void navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then((stream) => {
          if (current.released) {
            stream.getTracks().forEach((track) => track.stop());
            return;
          }
          try {
            current.finish = recordVoiceHold(stream, (recording, live, tail) =>
              onSpoken(recording, current, live, tail),
            );
          } catch (cause) {
            stream.getTracks().forEach((track) => track.stop());
            throw cause;
          }
        })
        .catch(() => {
          if (take === current) {
            end(false);
            onMicrophoneError();
          }
        });
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.isTrusted) return;
      if (event.code !== holdKey) return end(false);
      event.preventDefault();
      if (take === null && !event.repeat) start();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === holdKey) end(true);
    };
    const onBlur = () => end(false);
    const onVisibility = () => {
      if (document.hidden) end(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
      end(false);
    };
  }, [enabled, holdKey, scopeKey]);

  return listening;
}
