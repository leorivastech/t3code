import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  TelegramSendError,
  type TelegramSendResult,
  type TelegramSendTestResult,
  type TelegramSettings,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as TelegramMessages from "../persistence/TelegramMessages.ts";
import * as Project from "../project/ProjectService.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TelegramBotApi from "./TelegramBotApi.ts";
import {
  classifyIncomingMessage,
  decodeIncomingMessage,
  type IncomingMessage,
  joinedGroupChatId,
  TELEGRAM_CAPTION_MAX_CHARS,
  TELEGRAM_FILE_MAX_BYTES,
  TELEGRAM_HELP,
  TELEGRAM_TEXT_MAX_CHARS,
  TELEGRAM_TEXT_ONLY,
  telegramBotId,
  telegramChatName,
  telegramChatsNamed,
  telegramFileKind,
  telegramFileMimeType,
  telegramIntroduction,
  telegramReplyAddress,
  telegramThreadLine,
  telegramThreadMessage,
  telegramThreadTitle,
} from "./telegramRules.ts";

/** How long an answer to a message can still find its thread. */
const MESSAGE_RETENTION_DAYS = 30;
/** How many threads `/threads` lists, most recent first. Each is a message of its own. */
const LISTED_THREADS = 8;
const RETRY_MIN_SECONDS = 5;
const RETRY_MAX_SECONDS = 300;
/** Reads of the same update that may fail before it is dropped, so one cannot hold up the rest. */
const UPDATE_ATTEMPTS = 5;

export interface TelegramSendInput {
  /**
   * The thread the message is from. An answer to it in Telegram is delivered to this thread;
   * a message from no thread cannot be answered.
   */
  readonly threadId: ThreadId | undefined;
  /** The message, or the caption when there is a file. */
  readonly text?: string | undefined;
  /** A file to upload. A relative path is read from the thread's workspace. */
  readonly path?: string | undefined;
  /** An explicit destination; otherwise the current Telegram sender, or the first configured chat. */
  readonly chatId?: number | undefined;
  /** A configured chat by name, as the user said it: "the team group". `chatId` wins over it. */
  readonly chat?: string | undefined;
  /**
   * Whether `path` may leave the thread's workspace. Only a caller with full access gets this:
   * the tool is not one a supervised agent is asked about, so it must not read past the
   * workspace on its own.
   */
  readonly hostFiles?: boolean | undefined;
}

class TelegramReceiveError extends Schema.TaggedError<TelegramReceiveError>()(
  "TelegramReceiveError",
  {
    cause: Schema.Defect(),
  },
) {}

/**
 * The environment's Telegram bot: agents send through it, and the people allowed to answer
 * reach their threads through it.
 */
export class TelegramChannel extends Context.Service<
  TelegramChannel,
  {
    readonly send: (
      input: TelegramSendInput,
    ) => Effect.Effect<TelegramSendResult, TelegramSendError>;
    /** Checks the saved token and says hello in every configured chat. */
    readonly sendTest: () => Effect.Effect<TelegramSendTestResult, TelegramSendError>;
    /** Handles the messages waiting for the bot, once. `start` keeps doing this. */
    readonly receive: Effect.Effect<void, TelegramBotApi.TelegramApiError | TelegramReceiveError>;
    /** Listens for as long as the scope lives, following the token in Settings. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/telegram/TelegramChannel") {}

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* Project.ProjectService;
  const messages = yield* TelegramMessages.TelegramMessageRepository;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const api = yield* TelegramBotApi.make;
  // Which update to ask for next, and the token that is true of. Kept in memory only: after a
  // restart Telegram resends what was never acknowledged, and delivery is keyed by the message,
  // so a thread does not receive it twice.
  const cursor = yield* Ref.make<{ readonly token: string; readonly offset: number } | null>(null);
  /** Failed reads in a row, which is what spaces out the retries. */
  const failures = yield* Ref.make(0);
  /** The update that last failed, and how many times, so a hopeless one is given up on. */
  const stuck = yield* Ref.make<{ readonly updateId: number; readonly attempts: number } | null>(
    null,
  );

  // Read on every use so a token saved in Settings applies without a restart.
  const currentSettings = settingsService.getSettings.pipe(
    Effect.map((settings) => settings.telegram),
    Effect.catch((error) =>
      // No cause: a settings decode error can quote a hand-edited token.
      Effect.logWarning("failed to read Telegram settings", { operation: error.operation }).pipe(
        Effect.as(DEFAULT_SERVER_SETTINGS.telegram),
      ),
    ),
  );

  /** Links a message the bot sent to a thread, so an answer to it has somewhere to go. */
  const remember = Effect.fn("TelegramChannel.remember")(function* (input: {
    readonly token: string;
    readonly chatId: number;
    readonly messageId: number;
    readonly threadId: ThreadId;
  }) {
    const now = yield* DateTime.now;
    yield* messages.record({
      botId: telegramBotId(input.token),
      chatId: input.chatId,
      messageId: input.messageId,
      threadId: input.threadId,
      sentAt: DateTime.formatIso(now),
      dropBefore: DateTime.formatIso(DateTime.subtract(now, { days: MESSAGE_RETENTION_DAYS })),
    });
  });

  // Use the durable input of the active run. A sticky per-thread destination could send a
  // later desktop request to the previous Telegram owner, and an in-memory map loses restarts.
  const replyAddress = Effect.fn("TelegramChannel.replyAddress")(function* (threadId: ThreadId) {
    const thread = yield* threads.getThreadShell(threadId);
    if (thread === null || thread.activeRunId === null) return null;
    const records = yield* threads.getThreadRecords(threadId, ["messages"], {
      messageRoles: ["user"],
      messageRunIds: [thread.activeRunId],
    });
    const latest = records.messages.at(-1);
    return latest?.creationSource === "server" ? telegramReplyAddress(latest.id) : null;
  });

  const workspaceOf = Effect.fn("TelegramChannel.workspaceOf")(function* (threadId: ThreadId) {
    const thread = yield* threads.getThreadShell(threadId);
    if (thread === null) return null;
    if (thread.worktreePath !== null) return thread.worktreePath;
    const project = yield* projects.getById(thread.projectId);
    return Option.isSome(project) ? project.value.workspaceRoot : null;
  });

  const readUpload = Effect.fn("TelegramChannel.readUpload")(function* (
    input: Pick<TelegramSendInput, "threadId" | "hostFiles">,
    requestedPath: string,
  ) {
    const unreadable = new TelegramSendError({ reason: "file-unreadable" });
    const outside = new TelegramSendError({ reason: "file-outside-workspace" });
    const realPath = (target: string) =>
      fileSystem.realPath(target).pipe(Effect.mapError(() => unreadable));
    // An absolute path is a host file read in place, such as a report an agent wrote to a temp
    // directory; anything else is read from the thread's workspace.
    const workspace =
      input.threadId === undefined
        ? null
        : yield* workspaceOf(input.threadId).pipe(Effect.mapError(() => unreadable));
    if (workspace === null && !path.isAbsolute(requestedPath)) return yield* unreadable;
    const filePath = yield* realPath(path.resolve(workspace ?? "", requestedPath));
    if (input.hostFiles !== true) {
      if (workspace === null) return yield* outside;
      // Compared after links are followed, so neither `..` nor a symlink leaves the workspace.
      const inside = path.relative(yield* realPath(workspace), filePath);
      if (inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
        return yield* outside;
      }
    }
    const info = yield* fileSystem.stat(filePath).pipe(Effect.mapError(() => unreadable));
    const sizeBytes = Number(info.size);
    if (info.type !== "File" || sizeBytes === 0) return yield* unreadable;
    if (sizeBytes > TELEGRAM_FILE_MAX_BYTES) {
      return yield* new TelegramSendError({ reason: "file-too-large" });
    }
    const bytes = yield* fileSystem.readFile(filePath).pipe(Effect.mapError(() => unreadable));
    const fileName = path.basename(requestedPath);
    return {
      kind: telegramFileKind(fileName, sizeBytes),
      file: new File([bytes], fileName, { type: telegramFileMimeType(fileName) }),
    };
  });

  /** Telegram said no and will say no again: not a rate limit, a server error or a lost call. */
  const refusedForGood = (error: TelegramBotApi.TelegramApiError) =>
    error.reason === "rejected" &&
    error.errorCode !== undefined &&
    error.errorCode >= 400 &&
    error.errorCode < 500 &&
    error.errorCode !== 429;

  const sendFailure = (error: TelegramBotApi.TelegramApiError) =>
    new TelegramSendError({
      reason: error.reason,
      ...(error.description === undefined ? {} : { description: error.description }),
    });

  /**
   * The configured chat a user named. Settings hold ids only, so the names are read from
   * Telegram; a chat the bot was removed from has none and cannot be picked this way.
   */
  const chatNamed = Effect.fn("TelegramChannel.chatNamed")(function* (
    settings: TelegramSettings,
    requested: string,
  ) {
    const chats = yield* Effect.forEach(settings.chatIds, (chatId) =>
      api.getChat(settings.botToken, chatId).pipe(
        Effect.map((chat) => ({ chatId, name: telegramChatName(chat) })),
        Effect.catchTags({
          // A chat the bot can no longer see has no name. A call that merely failed must not
          // drop a chat from the choice, or an ambiguous name would look like it fits one.
          TelegramApiError: (error) =>
            refusedForGood(error)
              ? Effect.succeed({ chatId, name: null })
              : Effect.fail(sendFailure(error)),
        }),
      ),
    );
    const fits = telegramChatsNamed(chats, requested);
    if (fits.length === 1 && fits[0] !== undefined) return fits[0].chatId;
    // With the ids, so the agent can ask which one and then send by `chatId`.
    const listed = (fits.length > 1 ? fits : chats)
      .flatMap((chat) => (chat.name === null ? [] : [`“${chat.name}” (${chat.chatId})`]))
      .join(", ");
    return yield* new TelegramSendError({
      reason: "chat-not-found",
      description:
        fits.length > 1
          ? `Several fit: ${listed}. Ask which one, then send with its chatId.`
          : listed.length > 0
            ? `The chats there are ${listed}.`
            : "None of the chats there has a name the bot can read.",
    });
  });

  const send: TelegramChannel["Service"]["send"] = Effect.fn("TelegramChannel.send")(
    function* (input) {
      const settings = yield* currentSettings;
      if (settings.botToken.length === 0) {
        return yield* new TelegramSendError({ reason: "not-configured" });
      }
      const requestedChat = input.chat?.trim() ?? "";
      const explicitChatId =
        input.chatId ??
        (requestedChat.length > 0 ? yield* chatNamed(settings, requestedChat) : undefined);
      const reply =
        input.threadId === undefined
          ? null
          : yield* replyAddress(input.threadId).pipe(
              Effect.mapError(() => new TelegramSendError({ reason: "context-unavailable" })),
            );
      const canReply =
        reply !== null &&
        reply.botId === telegramBotId(settings.botToken) &&
        settings.ownerIds.includes(reply.chatId);
      if (explicitChatId === undefined && reply !== null && !canReply) {
        return yield* new TelegramSendError({ reason: "reply-unavailable" });
      }
      const chatId = explicitChatId ?? reply?.chatId ?? settings.chatIds[0];
      if (chatId === undefined) return yield* new TelegramSendError({ reason: "not-configured" });
      // An owner can be answered without also being listed as a chat: they reach threads
      // through /threads, and the agent is told their id with every message they send.
      if (!settings.chatIds.includes(chatId) && !settings.ownerIds.includes(chatId)) {
        return yield* new TelegramSendError({ reason: "chat-not-allowed" });
      }
      const text = input.text?.trim() ?? "";
      const requestedPath = input.path?.trim() ?? "";
      const hasFile = requestedPath.length > 0;
      if (text.length === 0 && !hasFile) return yield* new TelegramSendError({ reason: "empty" });
      if (text.length > (hasFile ? TELEGRAM_CAPTION_MAX_CHARS : TELEGRAM_TEXT_MAX_CHARS)) {
        return yield* new TelegramSendError({ reason: "text-too-long" });
      }
      const request = hasFile
        ? api.sendFile(settings.botToken, {
            chatId,
            caption: text,
            ...(yield* readUpload(input, requestedPath)),
          })
        : api.sendMessage(settings.botToken, { chatId, text });
      const sent = yield* request.pipe(Effect.mapError(sendFailure));
      const chatName = sent.chat === undefined ? null : telegramChatName(sent.chat);
      const linked =
        input.threadId !== undefined &&
        (yield* remember({
          token: settings.botToken,
          chatId,
          messageId: sent.message_id,
          threadId: input.threadId,
        }).pipe(
          Effect.as(true),
          Effect.catch((cause) =>
            Effect.logWarning("failed to link a Telegram message to its thread", {
              threadId: input.threadId,
              cause,
            }).pipe(Effect.as(false)),
          ),
        ));
      const replyAvailable = linked && chatId > 0 && settings.ownerIds.includes(chatId);
      return {
        chatId,
        ...(chatName === null ? {} : { chatName }),
        messageId: sent.message_id,
        replyAvailable,
        ...(replyAvailable
          ? {}
          : {
              warning: linked
                ? "The message was delivered. Replies are enabled only in a configured owner's private chat. Use /threads there to select a thread."
                : "The message was delivered, but replies cannot reach this thread. Do not resend it. Use /threads in the bot's private chat to select a thread.",
            }),
      };
    },
  );

  const sendTest: TelegramChannel["Service"]["sendTest"] = Effect.fn("TelegramChannel.sendTest")(
    function* () {
      const settings = yield* currentSettings;
      if (settings.botToken.length === 0) {
        return yield* new TelegramSendError({ reason: "not-configured" });
      }
      const bot = yield* api.getMe(settings.botToken).pipe(Effect.mapError(sendFailure));
      // Every chat is tried, so one the bot was removed from does not hide the rest.
      const chats = yield* Effect.forEach(settings.chatIds, (chatId) =>
        api.sendMessage(settings.botToken, { chatId, text: "T3 Code can reach this chat." }).pipe(
          Effect.map((sent) => {
            const name = sent.chat === undefined ? null : telegramChatName(sent.chat);
            return { chatId, ...(name === null ? {} : { name }) };
          }),
          Effect.catchTags({
            TelegramApiError: (error) =>
              Effect.succeed({ chatId, error: error.description ?? "Telegram did not answer." }),
          }),
        ),
      );
      return { botUsername: bot.username, chats };
    },
  );

  /** Delivers an owner's answer to the thread it answers, and says in the chat how that went. */
  const deliver = Effect.fn("TelegramChannel.deliver")(function* (input: {
    readonly token: string;
    readonly message: IncomingMessage;
    readonly replyToMessageId: number;
    readonly text: string;
  }) {
    const botId = telegramBotId(input.token);
    const chatId = input.message.chat.id;
    const threadId = yield* messages.threadFor({
      botId,
      chatId,
      messageId: input.replyToMessageId,
    });
    if (Option.isNone(threadId)) {
      return {
        text: "I don't know which thread that message is from. Send /threads to pick one.",
        threadId: null,
      };
    }
    const thread = yield* threads.getThreadShell(threadId.value);
    if (thread === null || thread.deletedAt !== null) {
      return { text: "That thread no longer exists.", threadId: null };
    }
    // Keyed by the Telegram message, so one Telegram resends after a restart is not sent twice.
    const key = `${botId}:${chatId}:${input.message.message_id}`;
    const messageId = MessageId.make(`telegram-message:${key}`);
    const existing = yield* threads.getThreadRecords(thread.id, ["messages"], {
      messageIds: [messageId],
    });
    // A lost Telegram acknowledgement can replay this after the original run has finished.
    // Do not ask sendToThread to choose a new dispatch mode for an already accepted input.
    if (existing.messages.length > 0) {
      return {
        text: `Already sent to “${telegramThreadTitle(thread.title)}”.`,
        threadId: thread.id,
      };
    }
    const text = yield* threads
      .sendToThread({
        projectId: thread.projectId,
        threadId: thread.id,
        commandId: CommandId.make(`telegram:${key}`),
        messageId,
        text: telegramThreadMessage(input.text, chatId),
        attachments: [],
        mode: "auto",
        createdBy: "user",
        creationSource: "server",
      })
      .pipe(
        Effect.as(`Sent to “${telegramThreadTitle(thread.title)}”.`),
        Effect.catchTags({
          ThreadManagementThreadArchivedError: () =>
            Effect.succeed("That thread is archived. Unarchive it in T3 Code to message it."),
        }),
        // A thread that could not be read may be readable on the next try. Anything the thread
        // itself refused stays refused for this message, so the owner is told instead of
        // Telegram being asked for it again.
        Effect.catchIf(
          (error) =>
            error._tag !== "ThreadManagementProjectionLoadError" &&
            error._tag !== "ThreadManagementDurableRunProjectionError",
          (error) =>
            Effect.logWarning("a thread did not take a Telegram message", {
              threadId: thread.id,
              error: error._tag,
            }).pipe(
              Effect.as(`“${telegramThreadTitle(thread.title)}” could not take that message.`),
            ),
        ),
      );
    return { text, threadId: thread.id };
  });

  const listThreads = Effect.fn("TelegramChannel.listThreads")(function* () {
    const snapshot = yield* threads.getShellSnapshot({ location: "active" });
    return (
      snapshot.threads
        .filter(
          (thread) =>
            thread.deletedAt === null &&
            thread.archivedAt === null &&
            thread.lineage.relationshipToParent !== "subagent",
        )
        .toSorted(
          (left, right) =>
            DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
        )
        .slice(0, LISTED_THREADS)
        // Sent oldest first, so the most recent thread ends up nearest the keyboard.
        .toReversed()
    );
  });

  const handleMessage = Effect.fn("TelegramChannel.handleMessage")(function* (
    settings: TelegramSettings,
    message: IncomingMessage,
  ) {
    const token = settings.botToken;
    const chatId = message.chat.id;
    const action = classifyIncomingMessage(settings.ownerIds, message);
    const answer = (text: string) =>
      api.sendMessage(token, { chatId, text, replyToMessageId: message.message_id });
    switch (action.type) {
      case "ignore":
        return;
      case "introduce": {
        const introduced = answer(
          telegramIntroduction({
            chatId,
            privateChat: message.chat.type === "private",
            owner: action.owner,
          }),
        );
        // Anybody can send /start. If Telegram is slow to take the answer, an owner's
        // messages must not wait behind a stranger's.
        yield* action.owner
          ? introduced
          : introduced.pipe(Effect.catchTags({ TelegramApiError: () => Effect.void }));
        return;
      }
      case "help":
        yield* answer(TELEGRAM_HELP);
        return;
      case "text-only":
        yield* answer(TELEGRAM_TEXT_ONLY);
        return;
      case "list-threads": {
        const open = yield* listThreads();
        if (open.length === 0) {
          yield* answer("There are no open threads.");
          return;
        }
        // One message per thread: answering it is how that thread is picked.
        for (const thread of open) {
          const sent = yield* api.sendMessage(token, {
            chatId,
            text: telegramThreadLine({ title: thread.title, working: thread.activeRunId !== null }),
          });
          yield* remember({ token, chatId, messageId: sent.message_id, threadId: thread.id });
        }
        return;
      }
      case "deliver": {
        const outcome = yield* deliver({
          token,
          message,
          replyToMessageId: action.replyToMessageId,
          text: action.text,
        });
        const sent = yield* answer(outcome.text);
        if (outcome.threadId !== null) {
          // The confirmation can be answered too, which continues the same thread.
          yield* remember({
            token,
            chatId,
            messageId: sent.message_id,
            threadId: outcome.threadId,
          });
        }
        return;
      }
    }
  });

  const fetchUpdates = Effect.fn("TelegramChannel.fetchUpdates")(function* (token: string) {
    const seen = yield* Ref.get(cursor);
    return yield* api.getUpdates(token, seen?.token === token ? seen.offset : undefined);
  });

  const handleUpdates = Effect.fn("TelegramChannel.handleUpdates")(function* (
    settings: TelegramSettings,
    updates: ReadonlyArray<{
      readonly update_id: number;
      readonly message?: unknown;
      readonly my_chat_member?: unknown;
    }>,
  ) {
    // A blocked chat or deleted reply cannot recover by retrying. Transport errors, rate
    // limits, server errors and persistence failures leave this update unacknowledged.
    const refusedOrRetry = (error: TelegramBotApi.TelegramApiError) =>
      refusedForGood(error)
        ? Effect.logWarning("Telegram refused an incoming message response", {
            errorCode: error.errorCode,
          })
        : Effect.fail(error);
    for (const update of updates) {
      const current = yield* currentSettings;
      if (current.botToken !== settings.botToken) return;
      const joinedGroup = joinedGroupChatId(current.ownerIds, update.my_chat_member);
      const message = decodeIncomingMessage(update.message);
      const handled = Effect.gen(function* () {
        if (joinedGroup !== null) {
          // Says the group's id where it was added, so it can be copied into Settings.
          yield* api.sendMessage(current.botToken, {
            chatId: joinedGroup,
            text: telegramIntroduction({ chatId: joinedGroup, privateChat: false, owner: false }),
          });
        }
        if (Option.isSome(message)) yield* handleMessage(current, message.value);
      }).pipe(Effect.catchTags({ TelegramApiError: refusedOrRetry }));
      yield* handled.pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            const seen = yield* Ref.get(stuck);
            const attempts = seen?.updateId === update.update_id ? seen.attempts + 1 : 1;
            if (attempts < UPDATE_ATTEMPTS) {
              yield* Ref.set(stuck, { updateId: update.update_id, attempts });
              return yield* Effect.fail(error);
            }
            // Acknowledged below: one message that cannot be handled must not stop the rest.
            yield* Effect.logWarning("gave up on a Telegram update that kept failing", {
              updateId: update.update_id,
              error: error._tag,
            });
            const lost =
              Option.isSome(message) &&
              classifyIncomingMessage(current.ownerIds, message.value).type !== "ignore"
                ? message.value
                : null;
            if (lost !== null) {
              // Best effort: whatever broke the handling may break this too.
              yield* api
                .sendMessage(current.botToken, {
                  chatId: lost.chat.id,
                  text: "That message could not be handled. Send it again.",
                  replyToMessageId: lost.message_id,
                })
                .pipe(Effect.catchTags({ TelegramApiError: () => Effect.void }));
            }
          }),
        ),
      );
      yield* Ref.set(cursor, { token: settings.botToken, offset: update.update_id + 1 });
    }
  });

  const receive: TelegramChannel["Service"]["receive"] = Effect.gen(function* () {
    const settings = yield* currentSettings;
    if (settings.botToken.length === 0) return;
    yield* handleUpdates(settings, yield* fetchUpdates(settings.botToken));
  }).pipe(
    Effect.mapError((cause) =>
      cause._tag === "TelegramApiError" ? cause : new TelegramReceiveError({ cause }),
    ),
    Effect.withSpan("TelegramChannel.receive"),
  );

  /**
   * One wait for messages. The wait ends early when Settings change, so a new token is picked
   * up at once rather than when the request Telegram is holding open runs out. Messages already
   * read are handled to the end: a save must not cut a `/threads` list in half.
   */
  const listenOnce = Effect.gen(function* () {
    // Subscribed before the read, so a save that lands in between is not missed.
    const changes = yield* settingsService.subscribeChanges;
    // A stream that ends without a change is not a change: treating it as one would end every
    // wait at once and turn this into a busy loop.
    const settingsChanged = changes.pipe(
      Stream.runHead,
      Effect.flatMap((change) => (Option.isSome(change) ? Effect.void : Effect.never)),
    );
    const settings = yield* currentSettings;
    if (settings.botToken.length === 0) {
      yield* settingsChanged;
      return;
    }
    const failed = yield* Ref.get(failures);
    yield* fetchUpdates(settings.botToken).pipe(
      Effect.raceFirst(settingsChanged.pipe(Effect.as(null))),
      Effect.flatMap((updates) =>
        updates === null ? Effect.void : handleUpdates(settings, updates),
      ),
      Effect.mapError((cause) =>
        cause._tag === "TelegramApiError" ? cause : new TelegramReceiveError({ cause }),
      ),
      Effect.withSpan("TelegramChannel.receive"),
      Effect.andThen(Ref.set(failures, 0)),
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* Ref.set(failures, failed + 1);
          yield* Effect.logWarning("Telegram will retry receiving messages", {
            error: error._tag,
            // Never a Bot API error, which is the only one that could quote the token's URL.
            ...(error._tag === "TelegramApiError"
              ? { errorCode: error.errorCode }
              : { cause: error.cause }),
          });
          const backoff = Math.min(RETRY_MAX_SECONDS, RETRY_MIN_SECONDS * 2 ** failed);
          const retryAfter = error._tag === "TelegramApiError" ? (error.retryAfterSeconds ?? 0) : 0;
          // The wait Telegram asks for is not ours to cut short; the rest of it is.
          yield* Effect.sleep(Duration.seconds(retryAfter));
          yield* Effect.sleep(Duration.seconds(Math.max(0, backoff - retryAfter))).pipe(
            Effect.raceFirst(settingsChanged),
          );
        }),
      ),
    );
  }).pipe(Effect.scoped);

  const start: TelegramChannel["Service"]["start"] = () =>
    forkParked(
      Effect.forever(
        listenOnce.pipe(
          Effect.catchCause((cause) =>
            Effect.logError("the Telegram listener failed and will start again", { cause }).pipe(
              Effect.andThen(Effect.sleep(Duration.seconds(RETRY_MIN_SECONDS))),
            ),
          ),
        ),
      ),
    );

  return TelegramChannel.of({ send, sendTest, receive, start });
});

export const layer = Layer.effect(TelegramChannel, make);
