import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ServerSettings from "../serverSettings.ts";
import * as VoiceInterpreter from "./VoiceInterpreter.ts";

interface Call {
  readonly url: string;
  readonly authorization: string | undefined;
  readonly model: string;
  readonly fileName?: string;
}

/** A provider that hears `heard` and answers each chat model with the next scripted reply. */
const provider = (
  heard: string,
  chatReplies: ReadonlyArray<{ status: number; content?: string }>,
) => {
  const calls: Array<Call> = [];
  const pending = [...chatReplies];
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const authorization = request.headers["authorization"];
        let reply: { status: number; body: unknown };
        if (request.body._tag === "FormData") {
          const file = request.body.formData.get("file");
          calls.push({
            url: request.url,
            authorization,
            model: String(request.body.formData.get("model")),
            ...(file instanceof File ? { fileName: file.name } : {}),
          });
          reply = {
            status: authorization === "Bearer gsk_wrong" ? 401 : 200,
            body: { text: heard },
          };
        } else {
          const body =
            request.body._tag === "Uint8Array"
              ? (JSON.parse(new TextDecoder().decode(request.body.body)) as { model: string })
              : { model: "" };
          calls.push({ url: request.url, authorization, model: body.model });
          const next = pending.shift() ?? { status: 500 };
          reply = {
            status: next.status,
            body: { choices: [{ message: { content: next.content ?? null } }] },
          };
        }
        return HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(reply.body), {
            status: reply.status,
            headers: { "content-type": "application/json" },
          }),
        );
      }),
    ),
  );
  return { calls, layer };
};

const interpret = (apiKey: string, http: Layer.Layer<HttpClient.HttpClient>) =>
  Effect.gen(function* () {
    const voice = yield* VoiceInterpreter.VoiceInterpreter;
    return yield* voice.interpret({ audioBase64: "AAAA", mimeType: "audio/webm;codecs=opus" });
  }).pipe(
    Effect.provide(
      VoiceInterpreter.layer.pipe(
        // Test settings that cannot be built are a broken test, not an outcome to assert on.
        Layer.provide(Layer.orDie(ServerSettings.layerTest({ voice: { apiKey } }))),
        Layer.provide(http),
      ),
    ),
  );

describe("VoiceInterpreter", () => {
  it.effect("asks for a key before sending anything anywhere", () =>
    Effect.gen(function* () {
      const { calls, layer } = provider("three", []);
      const error = yield* Effect.flip(interpret("", layer));
      assert.strictEqual(error.reason, "not-configured");
      assert.deepStrictEqual(calls, []);
    }),
  );

  it.effect("opens a thread by its bare number without asking a model", () =>
    Effect.gen(function* () {
      const { calls, layer } = provider("Tres.", []);
      const order = yield* interpret("gsk_key", layer);
      assert.deepStrictEqual(order.actions, [{ op: "jump", n: 3 }]);
      assert.deepStrictEqual(calls, [
        {
          url: "https://api.groq.com/openai/v1/audio/transcriptions",
          authorization: "Bearer gsk_key",
          model: "whisper-large-v3-turbo",
          fileName: "order.webm",
        },
      ]);
    }),
  );

  it.effect("moves on to the next model when the first is over its limit", () =>
    Effect.gen(function* () {
      const { calls, layer } = provider("abre el dos y dile que siga", [
        { status: 429 },
        {
          status: 200,
          content: JSON.stringify({
            ok: true,
            actions: [
              { op: "jump", n: 2 },
              { op: "write", text: "Sigue", send: true },
            ],
          }),
        },
      ]);
      const order = yield* interpret("gsk_key", layer);
      assert.deepStrictEqual(order, {
        heard: "abre el dos y dile que siga",
        says: "Thread 2 · Send: Sigue",
        understood: true,
        actions: [
          { op: "jump", n: 2 },
          { op: "write", text: "Sigue", send: true },
        ],
      });
      assert.deepStrictEqual(
        calls.slice(1).map((call) => call.model),
        ["qwen/qwen3.8-27b", "openai/gpt-oss-120b"],
      );
    }),
  );

  it.effect("sends an OpenAI key to OpenAI and says when a key is refused", () =>
    Effect.gen(function* () {
      const openai = provider("cancel that", [
        { status: 200, content: '{"ok":true,"actions":[]}' },
      ]);
      const order = yield* interpret("sk-key", openai.layer);
      assert.deepStrictEqual(order.actions, []);
      assert.isTrue(order.understood);
      assert.deepStrictEqual(
        openai.calls.map((call) => call.url),
        [
          "https://api.openai.com/v1/audio/transcriptions",
          "https://api.openai.com/v1/chat/completions",
        ],
      );
      const refused = yield* Effect.flip(interpret("gsk_wrong", provider("x", []).layer));
      assert.strictEqual(refused.reason, "key-rejected");
    }),
  );
});

describe("local Whisper", () => {
  it.effect.each([
    ["tres", [{ op: "jump", n: 3 }]],
    ["send the message", []],
  ] as const)("keeps %s on the environment without cloud fallback", ([heard, actions]) =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const http = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          calls.push(request.url);
          assert.strictEqual(request.headers.authorization, undefined);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify({ text: heard }), {
                headers: { "content-type": "application/json" },
              }),
            ),
          );
        }),
      );
      const order = yield* Effect.flatMap(VoiceInterpreter.VoiceInterpreter, (voice) =>
        voice.interpret({ audioBase64: "AAAA", mimeType: "audio/webm" }),
      ).pipe(
        Effect.provide(
          VoiceInterpreter.layer.pipe(
            Layer.provide(
              Layer.orDie(
                ServerSettings.layerTest({ voice: { apiKey: "gsk_unused", localWhisper: true } }),
              ),
            ),
            Layer.provide(http),
          ),
        ),
      );
      assert.deepStrictEqual(order.actions, actions);
      assert.deepStrictEqual(calls, ["http://127.0.0.1:8798/transcribe"]);
    }),
  );
});
