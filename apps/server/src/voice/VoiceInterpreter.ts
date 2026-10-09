import { VoiceError, type VoiceInterpretInput, type VoiceOrder } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as ServerSettings from "../serverSettings.ts";
import {
  instantVoiceOrder,
  VOICE_INSTRUCTIONS,
  type VoiceProvider,
  voiceOrderFromModelAnswer,
  voiceProviderForKey,
  voiceRecordingFileName,
} from "./voiceRules.ts";

const REQUEST_TIMEOUT = Duration.seconds(20);
const isVoiceError = Schema.is(VoiceError);

const Transcription = Schema.Struct({ text: Schema.String });
const Completion = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({ message: Schema.Struct({ content: Schema.NullOr(Schema.String) }) }),
  ),
});

/**
 * Turns a recording of a spoken order into the actions it asks for, with the
 * provider the environment's voice key belongs to. Nothing is kept: the audio
 * and the text go to the provider and the order goes back to the client.
 */
export class VoiceInterpreter extends Context.Service<
  VoiceInterpreter,
  {
    readonly interpret: (input: VoiceInterpretInput) => Effect.Effect<VoiceOrder, VoiceError>;
  }
>()("t3/voice/VoiceInterpreter") {}

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;

  /** The provider's answer, once it is one worth reading. */
  const post = Effect.fnUntraced(function* (
    url: string,
    key: string,
    body: (request: HttpClientRequest.HttpClientRequest) => HttpClientRequest.HttpClientRequest,
  ) {
    const response = yield* httpClient.execute(
      body(
        HttpClientRequest.post(url).pipe(
          HttpClientRequest.setHeader("authorization", `Bearer ${key}`),
        ),
      ),
    );
    if (response.status === 401 || response.status === 403) {
      return yield* new VoiceError({ reason: "key-rejected" });
    }
    if (response.status === 429) return yield* new VoiceError({ reason: "rate-limited" });
    return yield* HttpClientResponse.filterStatusOk(response);
  });

  const answered = <Answer, Failure, Services>(
    request: Effect.Effect<Answer, Failure, Services>,
  ): Effect.Effect<Answer, VoiceError, Services> =>
    request.pipe(
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.mapError((error) =>
        isVoiceError(error) ? error : new VoiceError({ reason: "unreachable" }),
      ),
    );

  const hear = (provider: VoiceProvider, key: string, input: VoiceInterpretInput) =>
    answered(
      post(
        `${provider.origin}/audio/transcriptions`,
        key,
        // No language: the provider tells English from Spanish by itself.
        HttpClientRequest.bodyFormDataRecord({
          model: provider.hearingModel,
          file: new File(
            [Buffer.from(input.audioBase64, "base64")],
            voiceRecordingFileName(input.mimeType),
            { type: input.mimeType },
          ),
        }),
      ).pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(Transcription))),
    ).pipe(Effect.map((transcription) => transcription.text.trim()));

  const ask = (provider: VoiceProvider, key: string, model: string, heard: string) =>
    answered(
      post(
        `${provider.origin}/chat/completions`,
        key,
        HttpClientRequest.bodyJsonUnsafe({
          ...provider.understandingOptions,
          model,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: VOICE_INSTRUCTIONS },
            { role: "user", content: heard },
          ],
        }),
      ).pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(Completion))),
    ).pipe(Effect.map((completion) => completion.choices[0]?.message.content ?? ""));

  /** The next model answers when the one before it is over its limit. */
  const understand = (
    provider: VoiceProvider,
    key: string,
    heard: string,
    models = provider.understandingModels,
  ): Effect.Effect<string, VoiceError> => {
    const [model, ...rest] = models;
    if (model === undefined) return Effect.fail(new VoiceError({ reason: "rate-limited" }));
    return ask(provider, key, model, heard).pipe(
      Effect.catchTags({
        VoiceError: (error) =>
          error.reason === "rate-limited"
            ? understand(provider, key, heard, rest)
            : Effect.fail(error),
      }),
    );
  };

  const interpret: VoiceInterpreter["Service"]["interpret"] = Effect.fn(
    "VoiceInterpreter.interpret",
  )(function* (input) {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.map((settings) => settings.voice),
      Effect.orElseSucceed(() => ({ apiKey: "", localWhisper: false })),
    );
    if (settings.localWhisper) {
      const heard = yield* httpClient
        .execute(
          HttpClientRequest.post("http://127.0.0.1:8798/transcribe").pipe(
            HttpClientRequest.bodyJsonUnsafe(input),
          ),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Transcription)),
          Effect.timeout(REQUEST_TIMEOUT),
          Effect.mapError(() => new VoiceError({ reason: "local-unavailable" })),
          Effect.map((reply) => reply.text.trim()),
        );
      // Local navigation never sends speech or text to a cloud model.
      return instantVoiceOrder(heard) ?? { heard, says: "", understood: false, actions: [] };
    }
    const key = settings.apiKey;
    if (key.length === 0) return yield* new VoiceError({ reason: "not-configured" });
    const provider = voiceProviderForKey(key);
    const heard = yield* hear(provider, key, input);
    if (heard.length === 0) return { heard, says: "", understood: false, actions: [] };
    return (
      instantVoiceOrder(heard) ??
      voiceOrderFromModelAnswer(heard, yield* understand(provider, key, heard))
    );
  });

  return VoiceInterpreter.of({ interpret });
});

export const layer = Layer.effect(VoiceInterpreter, make);
