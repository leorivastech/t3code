import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

const TELEGRAM_API_ORIGIN = "https://api.telegram.org";
const REQUEST_TIMEOUT = Duration.seconds(20);
/** An upload of the largest file Telegram takes, on a slow uplink. */
const UPLOAD_TIMEOUT = Duration.minutes(5);
/** How long Telegram holds a `getUpdates` request open when nothing is waiting. */
const LONG_POLL_SECONDS = 25;
const LONG_POLL_TIMEOUT = Duration.seconds(LONG_POLL_SECONDS + 15);

export type TelegramFileKind = "photo" | "video" | "document";

const FILE_METHOD = {
  photo: "sendPhoto",
  video: "sendVideo",
  document: "sendDocument",
} as const satisfies Record<TelegramFileKind, string>;

const reply = <Result extends Schema.Top>(result: Result) =>
  Schema.Struct({
    ok: Schema.Boolean,
    result: Schema.optional(result),
    error_code: Schema.optional(Schema.Int),
    description: Schema.optional(Schema.String),
    parameters: Schema.optional(Schema.Struct({ retry_after: Schema.optional(Schema.Int) })),
  });

/** A chat as Telegram describes it. A group has a title; a person has names. */
const TelegramChat = Schema.Struct({
  id: Schema.Int,
  type: Schema.String,
  title: Schema.optional(Schema.String),
  first_name: Schema.optional(Schema.String),
  last_name: Schema.optional(Schema.String),
  username: Schema.optional(Schema.String),
});
export type TelegramChat = typeof TelegramChat.Type;

const BotReply = reply(Schema.Struct({ username: Schema.String }));
const ChatReply = reply(TelegramChat);
const SentMessageReply = reply(
  Schema.Struct({ message_id: Schema.Int, chat: Schema.optional(TelegramChat) }),
);
// The payloads stay undecoded here: one update this build cannot read must not stop the
// ones after it from being acknowledged.
const UpdatesReply = reply(
  Schema.Array(
    Schema.Struct({
      update_id: Schema.Int,
      message: Schema.optional(Schema.Unknown),
      my_chat_member: Schema.optional(Schema.Unknown),
    }),
  ),
);

/**
 * A Bot API call that did not return a result. `rejected` carries Telegram's own answer;
 * `unreachable` never got one. There is no `cause`: the request URL holds the bot token, and
 * a transport error quotes that URL.
 */
export class TelegramApiError extends Schema.TaggedError<TelegramApiError>()("TelegramApiError", {
  method: Schema.String,
  reason: Schema.Literals(["rejected", "unreachable"]),
  errorCode: Schema.optionalKey(Schema.Int),
  description: Schema.optionalKey(Schema.String),
  retryAfterSeconds: Schema.optionalKey(Schema.Int),
}) {
  override get message(): string {
    return this.reason === "unreachable"
      ? `Telegram could not be reached for ${this.method}.`
      : `Telegram rejected ${this.method}: ${this.description ?? "no reason given"}.`;
  }
}

export interface TelegramTextMessage {
  readonly chatId: number;
  readonly text: string;
  readonly replyToMessageId?: number;
}

export interface TelegramFileMessage {
  readonly chatId: number;
  readonly kind: TelegramFileKind;
  readonly file: File;
  readonly caption: string;
}

/** The Bot API calls the Telegram channel makes. */
export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const call = <Result extends Schema.Top>(input: {
    readonly token: string;
    readonly method: string;
    readonly schema: Schema.Struct<{
      readonly ok: typeof Schema.Boolean;
      readonly result: Schema.optional<Result>;
      readonly error_code: Schema.optional<typeof Schema.Int>;
      readonly description: Schema.optional<typeof Schema.String>;
      readonly parameters: ReturnType<typeof reply<Result>>["fields"]["parameters"];
    }>;
    readonly body: (
      request: HttpClientRequest.HttpClientRequest,
    ) => HttpClientRequest.HttpClientRequest;
    readonly timeout: Duration.Duration;
  }) =>
    httpClient
      .execute(
        input.body(
          HttpClientRequest.post(`${TELEGRAM_API_ORIGIN}/bot${input.token}/${input.method}`),
        ),
      )
      .pipe(
        // Telegram answers a refused call with a non-2xx status and the same JSON envelope.
        Effect.flatMap(HttpClientResponse.schemaBodyJson(input.schema)),
        Effect.timeout(input.timeout),
        Effect.mapError(
          () => new TelegramApiError({ method: input.method, reason: "unreachable" }),
        ),
        Effect.flatMap((answer) =>
          answer.ok && answer.result !== undefined
            ? Effect.succeed(answer.result)
            : Effect.fail(
                new TelegramApiError({
                  method: input.method,
                  reason: "rejected",
                  ...(answer.error_code === undefined ? {} : { errorCode: answer.error_code }),
                  ...(answer.description === undefined ? {} : { description: answer.description }),
                  ...(answer.parameters?.retry_after === undefined
                    ? {}
                    : { retryAfterSeconds: answer.parameters.retry_after }),
                }),
              ),
        ),
        // The client's request span records the full URL, which holds the bot token.
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
      );

  return {
    /** The bot a token belongs to. The cheapest call that proves the token works. */
    getMe: (token: string) =>
      call({
        token,
        method: "getMe",
        schema: BotReply,
        body: (request) => request,
        timeout: REQUEST_TIMEOUT,
      }),

    /** A chat the bot can see, which is how a configured id gets its name. */
    getChat: (token: string, chatId: number) =>
      call({
        token,
        method: "getChat",
        schema: ChatReply,
        body: HttpClientRequest.bodyJsonUnsafe({ chat_id: chatId }),
        timeout: REQUEST_TIMEOUT,
      }),

    sendMessage: (token: string, message: TelegramTextMessage) =>
      call({
        token,
        method: "sendMessage",
        schema: SentMessageReply,
        body: HttpClientRequest.bodyJsonUnsafe({
          chat_id: message.chatId,
          text: message.text,
          ...(message.replyToMessageId === undefined
            ? {}
            : {
                // Still sent when the message it answers was deleted in the meantime.
                reply_parameters: {
                  message_id: message.replyToMessageId,
                  allow_sending_without_reply: true,
                },
              }),
        }),
        timeout: REQUEST_TIMEOUT,
      }),

    sendFile: (token: string, message: TelegramFileMessage) =>
      call({
        token,
        method: FILE_METHOD[message.kind],
        schema: SentMessageReply,
        body: HttpClientRequest.bodyFormDataRecord({
          chat_id: message.chatId,
          caption: message.caption.length > 0 ? message.caption : undefined,
          [message.kind]: message.file,
        }),
        timeout: UPLOAD_TIMEOUT,
      }),

    /**
     * Waits for messages sent to the bot. Passing the id after the last update seen is what
     * tells Telegram the earlier ones were handled; without it they are delivered again.
     */
    getUpdates: (token: string, offset: number | undefined) =>
      call({
        token,
        method: "getUpdates",
        schema: UpdatesReply,
        body: HttpClientRequest.bodyJsonUnsafe({
          timeout: LONG_POLL_SECONDS,
          // `my_chat_member` is how the bot learns it was added to a group.
          allowed_updates: ["message", "my_chat_member"],
          ...(offset === undefined ? {} : { offset }),
        }),
        timeout: LONG_POLL_TIMEOUT,
      }),
  };
});
