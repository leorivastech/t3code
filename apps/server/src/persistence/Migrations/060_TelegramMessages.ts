import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // One row per message the bot sent on behalf of a thread. Telegram only tells a bot which
  // message somebody answered, so this is what turns that answer into the thread it is for.
  // A message id is only unique within one bot's view of one chat, so a different bot's
  // messages in the same chat start over at the same numbers.
  yield* sql`
    CREATE TABLE IF NOT EXISTS telegram_messages (
      bot_id TEXT NOT NULL,
      chat_id INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      thread_id TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      PRIMARY KEY (bot_id, chat_id, message_id)
    ) WITHOUT ROWID
  `;
});
