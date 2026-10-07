import * as Schema from "effect/Schema";

/** A Telegram chat or user id. Groups and channels are negative. */
export const TelegramId = Schema.Int.check(
  Schema.makeFilter((id) => id !== 0, { expected: "a non-zero Telegram id" }),
);
export type TelegramId = typeof TelegramId.Type;

const TELEGRAM_SEND_FAILURES = {
  "not-configured":
    "Telegram is not set up. Add a bot token and a chat under Settings → Integrations → Telegram.",
  "chat-not-allowed": "That chat is not one of the Telegram chats in Settings.",
  "chat-not-found": "No Telegram chat in Settings goes by that name.",
  "reply-unavailable":
    "The Telegram reply destination is no longer available. Check the bot and owner ids in Settings; the reply was not sent to another chat.",
  "context-unavailable": "The thread's Telegram reply destination could not be read. Try again.",
  empty: "There is nothing to send. Give a message, a file, or both.",
  "text-too-long":
    "The text is over Telegram's limit: 4096 characters for a message, 1024 next to a file.",
  "file-unreadable": "The file could not be read.",
  "file-outside-workspace":
    "That file is outside this thread's workspace. Only a thread with full access can send it.",
  "file-too-large": "The file is over Telegram's 50 MB upload limit.",
  rejected: "Telegram rejected the message.",
  unreachable:
    "Telegram did not answer. The message may or may not have been sent; check the chat before sending it again.",
} as const;

/** Why a message did not reach Telegram. */
export class TelegramSendError extends Schema.TaggedError<TelegramSendError>()(
  "TelegramSendError",
  {
    reason: Schema.Literals([
      "not-configured",
      "chat-not-allowed",
      "chat-not-found",
      "reply-unavailable",
      "context-unavailable",
      "empty",
      "text-too-long",
      "file-unreadable",
      "file-outside-workspace",
      "file-too-large",
      "rejected",
      "unreachable",
    ]),
    /** What Telegram answered, in its own words, when it rejected the request. */
    description: Schema.optionalKey(Schema.String),
  },
) {
  override get message(): string {
    const base = TELEGRAM_SEND_FAILURES[this.reason];
    return this.description === undefined ? base : `${base} ${this.description}`;
  }
}

export const TelegramSendResult = Schema.Struct({
  chatId: TelegramId,
  /** The group's title or the person's name, when Telegram gave one. */
  chatName: Schema.optionalKey(Schema.String),
  messageId: Schema.Int,
  /** Delivery and reply routing are separate: do not resend an already delivered file. */
  replyAvailable: Schema.Boolean,
  warning: Schema.optionalKey(Schema.String),
});
export type TelegramSendResult = typeof TelegramSendResult.Type;

export const TelegramSendTestResult = Schema.Struct({
  /** The bot the saved token belongs to, without the `@`. */
  botUsername: Schema.String,
  /** Every configured chat, by name, and why the test did not reach the ones it missed. */
  chats: Schema.Array(
    Schema.Struct({
      chatId: TelegramId,
      name: Schema.optionalKey(Schema.String),
      error: Schema.optionalKey(Schema.String),
    }),
  ),
});
export type TelegramSendTestResult = typeof TelegramSendTestResult.Type;
