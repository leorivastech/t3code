import { describe, expect, it } from "vite-plus/test";

import {
  instantVoiceOrder,
  voiceOrderFromModelAnswer,
  voiceProviderForKey,
  voiceRecordingFileName,
} from "./voiceRules.ts";

describe("instantVoiceOrder", () => {
  it.each([
    ["Dale más para arriba", "up"],
    ["dale para abajo", "down"],
    ["Dale   más para abajo.", "down"],
    ["Up again", "up"],
  ] as const)("understands repeated scrolling: %s", (heard, to) => {
    expect(instantVoiceOrder(heard)?.actions).toEqual([{ op: "scroll", to, pages: 1 }]);
  });

  it.each([
    ["Tres.", 3],
    ["3.", 3],
    ["five", 5],
    ["El cuatro.", 4],
    ["Número siete", 7],
    ["Thread number two.", 2],
  ])("takes %s as a thread number", (heard, n) => {
    expect(instantVoiceOrder(heard)?.actions).toEqual([{ op: "jump", n }]);
  });

  it.each([
    ["Sube.", "up"],
    ["Scroll down", "down"],
    ["Abajo.", "down"],
  ])("takes %s as a scroll", (heard, to) => {
    expect(instantVoiceOrder(heard)?.actions).toEqual([{ op: "scroll", to, pages: 1 }]);
  });

  it("leaves everything else to the model", () => {
    expect(instantVoiceOrder("Abre el tres y dile que corra las pruebas")).toBeNull();
    expect(instantVoiceOrder("Sube el esfuerzo")).toBeNull();
    expect(instantVoiceOrder("Twelve.")).toBeNull();
    expect(instantVoiceOrder("")).toBeNull();
  });
});

describe("voiceOrderFromModelAnswer", () => {
  it("reads the actions and fills in what the model left out", () => {
    expect(
      voiceOrderFromModelAnswer(
        "open three and tell it to run the tests, then go up",
        JSON.stringify({
          ok: true,
          actions: [
            { op: "jump", n: 3 },
            { op: "write", text: "Run the tests", send: true },
            { op: "write", text: "A note" },
            { op: "scroll", to: "up" },
          ],
        }),
      ),
    ).toEqual({
      heard: "open three and tell it to run the tests, then go up",
      says: "Thread 3 · Send: Run the tests · Write: A note · Scroll up",
      understood: true,
      actions: [
        { op: "jump", n: 3 },
        { op: "write", text: "Run the tests", send: true },
        { op: "write", text: "A note", send: false },
        { op: "scroll", to: "up", pages: 1 },
      ],
    });
  });

  it("says a cancelled order was one, and shortens a long message in the label", () => {
    expect(voiceOrderFromModelAnswer("never mind", '{"ok":true,"actions":[]}').says).toBe(
      "Cancelled",
    );
    const text = "Check why the login test fails and tell me which commit broke it, please.";
    expect(
      voiceOrderFromModelAnswer("x", JSON.stringify({ ok: true, actions: [{ op: "write", text }] }))
        .says,
    ).toBe("Write: Check why the login test fails and tell me which commit bro…");
  });

  it("runs nothing when the model said no, or answered something else", () => {
    const nothing = { heard: "hm", says: "", understood: false, actions: [] };
    expect(voiceOrderFromModelAnswer("hm", '{"ok":false,"actions":[{"op":"stop"}]}')).toEqual(
      nothing,
    );
    expect(voiceOrderFromModelAnswer("hm", "not json")).toEqual(nothing);
    // One action this build does not know makes the whole order unsafe to run in part.
    expect(
      voiceOrderFromModelAnswer(
        "hm",
        '{"ok":true,"actions":[{"op":"jump","n":3},{"op":"format-disk"}]}',
      ),
    ).toEqual(nothing);
    expect(voiceOrderFromModelAnswer("hm", '{"ok":true,"actions":[{"op":"jump","n":12}]}')).toEqual(
      nothing,
    );
  });
});

describe("voiceProviderForKey", () => {
  it("tells a Groq key from an OpenAI one", () => {
    expect(voiceProviderForKey("gsk_abc").origin).toBe("https://api.groq.com/openai/v1");
    expect(voiceProviderForKey("sk-proj-abc").origin).toBe("https://api.openai.com/v1");
  });
});

describe("voiceRecordingFileName", () => {
  it("names the recording after its format", () => {
    expect(voiceRecordingFileName("audio/webm;codecs=opus")).toBe("order.webm");
    expect(voiceRecordingFileName("audio/mp4")).toBe("order.mp4");
    expect(voiceRecordingFileName("application/octet-stream")).toBe("order.webm");
  });
});
