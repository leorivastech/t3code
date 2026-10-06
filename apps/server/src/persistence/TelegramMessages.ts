import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { TelegramId, ThreadId } from "@t3tools/contracts";

import {
  PersistenceDecodeError,
  PersistenceSqlError,
  type TelegramMessageRepositoryError,
} from "./Errors.ts";

/** A message as one bot sees it. Its id is only unique within that bot's view of that chat. */
const TelegramMessageKey = Schema.Struct({
  botId: Schema.String,
  chatId: TelegramId,
  messageId: Schema.Int,
});
type TelegramMessageKey = typeof TelegramMessageKey.Type;

const TelegramMessageThread = Schema.Struct({ threadId: ThreadId });

interface RecordTelegramMessageInput extends TelegramMessageKey {
  readonly threadId: ThreadId;
  /** When the bot sent it, as an ISO instant. */
  readonly sentAt: string;
  /** Rows sent before this ISO instant are dropped in the same write. */
  readonly dropBefore: string;
}

/**
 * Which thread each message the bot sent belongs to, so an answer to that message can be
 * delivered to it. Rows expire: nobody answers a months-old message, and a row that outlives
 * its thread is only ever a lookup that finds nothing to deliver to.
 */
export class TelegramMessageRepository extends Context.Service<
  TelegramMessageRepository,
  {
    readonly record: (
      input: RecordTelegramMessageInput,
    ) => Effect.Effect<void, TelegramMessageRepositoryError>;
    readonly threadFor: (
      input: TelegramMessageKey,
    ) => Effect.Effect<Option.Option<ThreadId>, TelegramMessageRepositoryError>;
  }
>()("t3/persistence/TelegramMessages/TelegramMessageRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findThread = SqlSchema.findOneOption({
    Request: TelegramMessageKey,
    Result: TelegramMessageThread,
    execute: ({ botId, chatId, messageId }) =>
      sql`
        SELECT thread_id AS "threadId"
        FROM telegram_messages
        WHERE bot_id = ${botId}
          AND chat_id = ${chatId}
          AND message_id = ${messageId}
      `,
  });

  return TelegramMessageRepository.of({
    record: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM telegram_messages WHERE sent_at < ${input.dropBefore}`;
            yield* sql`
              INSERT INTO telegram_messages (bot_id, chat_id, message_id, thread_id, sent_at)
              VALUES (
                ${input.botId},
                ${input.chatId},
                ${input.messageId},
                ${input.threadId},
                ${input.sentAt}
              )
              ON CONFLICT (bot_id, chat_id, message_id)
              DO UPDATE SET thread_id = excluded.thread_id, sent_at = excluded.sent_at
            `;
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) => new PersistenceSqlError({ operation: "recordTelegramMessage", cause }),
          ),
        ),

    threadFor: (input) =>
      findThread(input).pipe(
        Effect.map(Option.map((row) => row.threadId)),
        Effect.mapError((cause) =>
          Schema.isSchemaError(cause)
            ? PersistenceDecodeError.fromSchemaError("TelegramMessageThread", cause)
            : new PersistenceSqlError({ operation: "findTelegramMessageThread", cause }),
        ),
      ),
  });
});

export const layer = Layer.effect(TelegramMessageRepository, make);
