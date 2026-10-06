import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProjectId,
  RunId,
  ThreadId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ThreadShell,
  type TelegramSettings,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import type { ProjectionRecords } from "../orchestration-v2/ProjectionStore.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as TelegramMessages from "../persistence/TelegramMessages.ts";
import * as Project from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TelegramChannel from "./TelegramChannel.ts";

const BOT_TOKEN = "123:secret";
const OWNER = 42;
const STRANGER = 77;
const GROUP = -1001;
/** How the stub's Telegram describes the chats the tests use. */
const CHATS: Record<number, Record<string, unknown>> = {
  [OWNER]: { id: OWNER, type: "private", first_name: "Olivia", last_name: "Owner" },
  [GROUP]: { id: GROUP, type: "supergroup", title: "Team" },
  [-1002]: { id: -1002, type: "supergroup", title: "Team leads" },
};
const PROJECT_ID = ProjectId.make("telegram-project");

const JsonRecord = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeJsonRecord = Schema.decodeUnknownSync(JsonRecord);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

interface BotCall {
  /** The Bot API method, such as `sendMessage`. */
  readonly method: string;
  /** The JSON body, or the text fields of a multipart upload. */
  readonly body: Record<string, unknown>;
  readonly file?: File;
  /** The id the stub gave the message it sent, if it sent one. */
  readonly messageId?: number;
}

interface BotReply {
  readonly status: number;
  readonly body: unknown;
}

/**
 * Stands in for api.telegram.org. Sent messages get increasing ids, `getUpdates` hands out the
 * queued batches in order, and a scripted reply for a method is used once, before the default.
 */
const makeTestBot = (blockEmptyPolls = false) => {
  const calls: Array<BotCall> = [];
  const updateBatches: Array<ReadonlyArray<unknown>> = [];
  const scripted = new Map<string, BotReply>();
  let nextMessageId = 1000;

  const answer = (
    method: string,
    body: Record<string, unknown>,
  ): { readonly reply: BotReply; readonly messageId?: number } => {
    const chat = CHATS[Number(body.chat_id)];
    const reply = scripted.get(method);
    if (reply !== undefined) {
      scripted.delete(method);
      return { reply };
    }
    if (method === "getMe") {
      return { reply: { status: 200, body: { ok: true, result: { username: "t3_test_bot" } } } };
    }
    if (method === "getUpdates") {
      return { reply: { status: 200, body: { ok: true, result: updateBatches.shift() ?? [] } } };
    }
    if (method === "getChat") {
      return chat === undefined
        ? {
            reply: {
              status: 400,
              body: { ok: false, error_code: 400, description: "Bad Request: chat not found" },
            },
          }
        : { reply: { status: 200, body: { ok: true, result: chat } } };
    }
    const messageId = nextMessageId++;
    return {
      reply: {
        status: 200,
        body: {
          ok: true,
          result: { message_id: messageId, ...(chat === undefined ? {} : { chat }) },
        },
      },
      messageId,
    };
  };

  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.suspend(() => {
        const method = request.url.slice(request.url.lastIndexOf("/") + 1);
        if (
          method === "getUpdates" &&
          blockEmptyPolls &&
          updateBatches.length === 0 &&
          !scripted.has(method)
        )
          return Effect.never;
        const body: Record<string, unknown> = {};
        let file: File | undefined;
        if (request.body._tag === "Uint8Array") {
          Object.assign(body, decodeJsonRecord(new TextDecoder().decode(request.body.body)));
        } else if (request.body._tag === "FormData") {
          for (const [key, value] of request.body.formData.entries()) {
            if (typeof value === "string") body[key] = value;
            else file = value;
          }
        }
        const { reply, messageId } = answer(method, body);
        calls.push({
          method,
          body,
          ...(file === undefined ? {} : { file }),
          ...(messageId === undefined ? {} : { messageId }),
        });
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(encodeJson(reply.body), {
              status: reply.status,
              headers: { "content-type": "application/json" },
            }),
          ),
        );
      }),
    ),
  );

  return {
    calls,
    layer,
    queueUpdates: (batch: ReadonlyArray<unknown>) => {
      updateBatches.push(batch);
    },
    script: (method: string, reply: BotReply) => {
      scripted.set(method, reply);
    },
    /** Everything the bot sent, leaving out its reads of the update queue. */
    sent: () => calls.filter((call) => call.method !== "getUpdates"),
  };
};

const thread = (input: {
  readonly id: string;
  readonly title: string;
  readonly updatedAtMillis?: number;
  readonly worktreePath?: string;
  readonly archived?: boolean;
  readonly deleted?: boolean;
  readonly subagent?: boolean;
}) =>
  ({
    id: ThreadId.make(input.id),
    projectId: PROJECT_ID,
    title: input.title,
    worktreePath: input.worktreePath ?? null,
    activeRunId: null,
    archivedAt: input.archived === true ? DateTime.makeUnsafe(1) : null,
    deletedAt: input.deleted === true ? DateTime.makeUnsafe(1) : null,
    updatedAt: DateTime.makeUnsafe(input.updatedAtMillis ?? 1),
    lineage: {
      parentThreadId: input.subagent === true ? ThreadId.make("parent") : null,
      relationshipToParent: input.subagent === true ? "subagent" : null,
      rootThreadId: ThreadId.make(input.id),
    },
  }) as unknown as OrchestrationV2ThreadShell;

/** An update carrying a text message from `from`, in their private chat unless `chatId` says. */
const textUpdate = (input: {
  readonly updateId: number;
  readonly messageId: number;
  readonly from: number;
  readonly chatId?: number;
  readonly text: string;
  readonly replyTo?: number;
}) => {
  const chatId = input.chatId ?? input.from;
  return {
    update_id: input.updateId,
    message: {
      message_id: input.messageId,
      from: { id: input.from, is_bot: false, first_name: "Someone" },
      chat: { id: chatId, type: chatId < 0 ? "supergroup" : "private" },
      date: 1,
      text: input.text,
      ...(input.replyTo === undefined ? {} : { reply_to_message: { message_id: input.replyTo } }),
    },
  };
};

const makeHarness = (input: {
  readonly telegram?: Partial<TelegramSettings>;
  readonly threads?: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly failDeliveries?: number;
  /** The thread refuses every message, which no retry can change. */
  readonly rejectDeliveries?: boolean;
  readonly failRecording?: boolean;
  readonly blockEmptyPolls?: boolean;
  readonly onDelivered?: Effect.Effect<void>;
  readonly onDeliveryFailed?: Effect.Effect<void>;
}) => {
  const bot = makeTestBot(input.blockEmptyPolls);
  const threads = [...(input.threads ?? [])];
  const delivered: Array<ThreadManagement.ThreadManagementSendInput> = [];
  const stored: Array<OrchestrationV2ConversationMessage> = [];
  let failuresLeft = input.failDeliveries ?? 0;
  const repository = input.failRecording
    ? Layer.mock(TelegramMessages.TelegramMessageRepository)({
        record: () =>
          Effect.fail(
            new PersistenceSqlError({
              operation: "recordTelegramMessage",
              cause: new Error("disk unavailable"),
            }),
          ),
      })
    : TelegramMessages.layer.pipe(Layer.provide(SqlitePersistence.layerMemory));
  const layer = TelegramChannel.layer.pipe(
    Layer.provide(repository),
    Layer.provideMerge(
      ServerSettings.layerTest({
        telegram: { botToken: BOT_TOKEN, chatIds: [OWNER], ownerIds: [OWNER], ...input.telegram },
      }),
    ),
    Layer.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (threadId) =>
          Effect.succeed(threads.find((candidate) => candidate.id === threadId) ?? null),
        getShellSnapshot: () =>
          Effect.succeed({ schemaVersion: 1, snapshotSequence: 0, threads, archivedThreads: [] }),
        getThreadRecords: (threadId, fields, filter) =>
          Effect.succeed({
            thread: threads.find((candidate) => candidate.id === threadId),
            messages: stored.filter(
              (message) =>
                message.threadId === threadId &&
                (filter?.messageIds === undefined || filter.messageIds.includes(message.id)) &&
                (filter?.messageRunIds === undefined ||
                  (message.runId !== null && filter.messageRunIds.includes(message.runId))) &&
                (filter?.messageRoles === undefined || filter.messageRoles.includes(message.role)),
            ),
          } as unknown as ProjectionRecords<(typeof fields)[number]>),
        sendToThread: (send) =>
          Effect.suspend(
            (): ReturnType<ThreadManagement.ThreadManagementServiceShape["sendToThread"]> => {
              if (input.rejectDeliveries === true) {
                return Effect.fail(
                  new ThreadManagement.ThreadManagementNoSteerableRunError({
                    threadId: send.threadId,
                    mode: "steer",
                  }),
                );
              }
              if (failuresLeft-- > 0)
                return (input.onDeliveryFailed ?? Effect.void).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new ThreadManagement.ThreadManagementProjectionLoadError({
                        projectId: send.projectId,
                        threadId: send.threadId,
                        cause: new Error("temporary database failure"),
                      }),
                    ),
                  ),
                );
              delivered.push(send);
              const index = threads.findIndex((candidate) => candidate.id === send.threadId);
              const runId = threads[index]?.activeRunId ?? RunId.make(`run:${send.threadId}`);
              threads[index] = { ...threads[index]!, activeRunId: runId };
              stored.push({
                ...send,
                id: send.messageId,
                runId,
                nodeId: null,
                role: "user",
                streaming: false,
                createdAt: DateTime.makeUnsafe(delivered.length),
                updatedAt: DateTime.makeUnsafe(delivered.length),
              });
              return (input.onDelivered ?? Effect.void).pipe(
                Effect.as({} as ThreadManagement.ThreadManagementSendResult),
              );
            },
          ),
      }),
    ),
    Layer.provide(Layer.mock(Project.ProjectService)({})),
    Layer.provide(bot.layer),
    Layer.provide(NodeServices.layer),
  );
  return { bot, delivered, threads, layer };
};

const FIX_LOGIN = thread({ id: "thread-fix-login", title: "Fix login" });

describe("TelegramChannel", () => {
  it.effect("returns each owner's replies privately even with a group as the default", () => {
    const secondOwner = 88;
    const { bot, delivered, layer } = makeHarness({
      telegram: { chatIds: [GROUP], ownerIds: [OWNER, secondOwner] },
      threads: [FIX_LOGIN],
    });
    return Effect.gen(function* () {
      const channel = yield* TelegramChannel.TelegramChannel;
      for (const [index, owner] of [OWNER, secondOwner].entries()) {
        bot.queueUpdates([
          textUpdate({
            updateId: index * 2 + 1,
            messageId: index * 2 + 1,
            from: owner,
            text: "/threads",
          }),
        ]);
        yield* channel.receive;
        const listed = bot.sent().at(-1)!;
        bot.queueUpdates([
          textUpdate({
            updateId: index * 2 + 2,
            messageId: index * 2 + 2,
            from: owner,
            text: "Explain the result",
            replyTo: listed.messageId!,
          }),
        ]);
        yield* channel.receive;
        const sent = yield* channel.send({ threadId: FIX_LOGIN.id, text: "The result" });
        assert.equal(sent.chatId, owner);
        assert.isTrue(sent.replyAvailable);
        assert.include(delivered.at(-1)!.text, `chatId ${owner}`);
      }
      const explicit = yield* channel.send({
        threadId: FIX_LOGIN.id,
        text: "Requested group update",
        chatId: GROUP,
      });
      assert.equal(explicit.chatId, GROUP);
      assert.isFalse(explicit.replyAvailable);
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not carry a Telegram destination into a later desktop run", () => {
    const { bot, threads, layer } = makeHarness({
      telegram: { chatIds: [GROUP, OWNER] },
      threads: [FIX_LOGIN],
    });
    return Effect.gen(function* () {
      const channel = yield* TelegramChannel.TelegramChannel;
      const sent = yield* channel.send({ threadId: FIX_LOGIN.id, chatId: OWNER, text: "Ready" });
      bot.queueUpdates([
        textUpdate({
          updateId: 1,
          messageId: 2,
          from: OWNER,
          text: "Continue",
          replyTo: sent.messageId,
        }),
      ]);
      yield* channel.receive;
      threads[0] = { ...threads[0]!, activeRunId: RunId.make("later-desktop-run") };
      assert.equal(
        (yield* channel.send({ threadId: FIX_LOGIN.id, text: "New desktop request" })).chatId,
        GROUP,
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "refuses a removed owner's reply destination instead of falling back to a group",
    () => {
      const { bot, layer } = makeHarness({
        telegram: { chatIds: [GROUP, OWNER] },
        threads: [FIX_LOGIN],
      });
      return Effect.gen(function* () {
        const channel = yield* TelegramChannel.TelegramChannel;
        const settings = yield* ServerSettings.ServerSettingsService;
        const sent = yield* channel.send({ threadId: FIX_LOGIN.id, chatId: OWNER, text: "Ready" });
        bot.queueUpdates([
          textUpdate({
            updateId: 1,
            messageId: 2,
            from: OWNER,
            text: "Continue",
            replyTo: sent.messageId,
          }),
        ]);
        yield* channel.receive;
        yield* settings.updateSettings({ telegram: { ownerIds: [] } });
        const before = bot.sent().length;
        const error = yield* channel
          .send({ threadId: FIX_LOGIN.id, text: "Private answer" })
          .pipe(Effect.flip);
        assert.equal(error.reason, "reply-unavailable");
        assert.equal(bot.sent().length, before);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "reports delivery without a reply link when recording fails, without uploading twice",
    () => {
      const { bot, layer } = makeHarness({ threads: [FIX_LOGIN], failRecording: true });
      return Effect.gen(function* () {
        const channel = yield* TelegramChannel.TelegramChannel;
        const sent = yield* channel.send({ threadId: FIX_LOGIN.id, text: "Report ready" });
        assert.equal(sent.messageId, 1000);
        assert.isFalse(sent.replyAvailable);
        assert.include(sent.warning!, "Do not resend");
        assert.equal(bot.sent().length, 1);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("keeps a failed delivery unacknowledged and accepts it on the next read", () => {
    const { bot, delivered, layer } = makeHarness({ threads: [FIX_LOGIN], failDeliveries: 1 });
    return Effect.gen(function* () {
      const channel = yield* TelegramChannel.TelegramChannel;
      yield* channel.send({ threadId: FIX_LOGIN.id, text: "Ready" });
      const update = textUpdate({
        updateId: 7,
        messageId: 5,
        from: OWNER,
        text: "Continue",
        replyTo: 1000,
      });
      bot.queueUpdates([update]);
      bot.queueUpdates([update]);
      yield* channel.receive.pipe(Effect.flip);
      assert.equal(delivered.length, 0);
      yield* channel.receive;
      yield* channel.receive;
      assert.equal(delivered.length, 1);
      assert.deepEqual(
        bot.calls.filter((call) => call.method === "getUpdates").map((call) => call.body.offset),
        [undefined, undefined, 8],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps listening after a delivery fails, and delivers it on the next read", () =>
    Effect.gen(function* () {
      const failed = yield* Deferred.make<void>();
      const accepted = yield* Deferred.make<void>();
      const { bot, delivered, layer } = makeHarness({
        threads: [FIX_LOGIN],
        failDeliveries: 1,
        blockEmptyPolls: true,
        onDeliveryFailed: Deferred.succeed(failed, undefined),
        onDelivered: Deferred.succeed(accepted, undefined),
      });
      const answer = textUpdate({
        updateId: 1,
        messageId: 5,
        from: OWNER,
        text: "Ship it",
        replyTo: 1000,
      });
      yield* Effect.gen(function* () {
        const channel = yield* TelegramChannel.TelegramChannel;
        yield* channel.send({ threadId: FIX_LOGIN.id, text: "Build finished" });
        bot.queueUpdates([answer]);
        yield* channel.start();
        yield* Deferred.await(failed);
        assert.deepEqual(delivered, []);

        // Never acknowledged, so Telegram hands the same update out again once the wait is over.
        bot.queueUpdates([answer]);
        yield* TestClock.adjust("5 seconds");
        yield* Deferred.await(accepted);
        assert.equal(delivered.length, 1);
        assert.equal(delivered[0]?.threadId, FIX_LOGIN.id);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.effect("tells the owner when a thread refuses a message, and moves on to the next one", () => {
    const { bot, delivered, layer } = makeHarness({ threads: [FIX_LOGIN], rejectDeliveries: true });
    return Effect.gen(function* () {
      const channel = yield* TelegramChannel.TelegramChannel;
      yield* channel.send({ threadId: FIX_LOGIN.id, text: "Build finished" });
      bot.queueUpdates([
        textUpdate({ updateId: 1, messageId: 5, from: OWNER, text: "Ship it", replyTo: 1000 }),
        textUpdate({ updateId: 2, messageId: 6, from: OWNER, text: "/threads" }),
      ]);
      yield* channel.receive;
      yield* channel.receive;

      assert.deepEqual(delivered, []);
      const [, refusal, listed] = bot.sent();
      assert.include(String(refusal?.body.text), "could not take that message");
      // The refused message did not hold up the command sent after it.
      assert.include(String(listed?.body.text), "Fix login");
      const offsets = bot.calls
        .filter((call) => call.method === "getUpdates")
        .map((call) => call.body.offset);
      assert.deepEqual(offsets, [undefined, 3]);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "gives up on a message that keeps failing instead of holding up the rest forever",
    () => {
      const { bot, delivered, layer } = makeHarness({ threads: [FIX_LOGIN], failDeliveries: 99 });
      const answer = textUpdate({
        updateId: 1,
        messageId: 5,
        from: OWNER,
        text: "Ship it",
        replyTo: 1000,
      });
      return Effect.gen(function* () {
        const channel = yield* TelegramChannel.TelegramChannel;
        yield* channel.send({ threadId: FIX_LOGIN.id, text: "Build finished" });
        for (let attempt = 1; attempt < 5; attempt++) {
          bot.queueUpdates([answer]);
          yield* channel.receive.pipe(Effect.flip);
        }
        bot.queueUpdates([answer]);
        yield* channel.receive;
        yield* channel.receive;

        assert.deepEqual(delivered, []);
        assert.equal(bot.calls.findLast((call) => call.method === "getUpdates")?.body.offset, 2);
        // The owner is not left thinking the message went through.
        assert.include(String(bot.sent().at(-1)?.body.text), "could not be handled");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("does not redeliver a command after a lost Telegram confirmation", () => {
    const { bot, delivered, threads, layer } = makeHarness({ threads: [FIX_LOGIN] });
    return Effect.gen(function* () {
      const channel = yield* TelegramChannel.TelegramChannel;
      yield* channel.send({ threadId: FIX_LOGIN.id, text: "Ready" });
      const update = textUpdate({
        updateId: 7,
        messageId: 5,
        from: OWNER,
        text: "Continue",
        replyTo: 1000,
      });
      bot.queueUpdates([update]);
      bot.script("sendMessage", {
        status: 500,
        body: { ok: false, error_code: 500, description: "Temporary failure" },
      });
      yield* channel.receive.pipe(Effect.flip);
      assert.equal(delivered.length, 1);
      threads[0] = { ...threads[0]!, activeRunId: null };
      bot.queueUpdates([update]);
      yield* channel.receive;
      assert.equal(delivered.length, 1);
      assert.include(String(bot.sent().at(-1)?.body.text), "Already sent");
    }).pipe(Effect.provide(layer));
  });

  it.effect("delivers an owner's reply to the thread that sent the message", () => {
    const { bot, delivered, layer } = makeHarness({ threads: [FIX_LOGIN] });
    return Effect.gen(function* () {
      const channel = yield* TelegramChannel.TelegramChannel;
      const sent = yield* channel.send({ threadId: FIX_LOGIN.id, text: "Build finished" });
      assert.deepEqual(sent, {
        chatId: OWNER,
        chatName: "Olivia Owner",
        messageId: 1000,
        replyAvailable: true,
      });
      assert.deepEqual(bot.sent()[0]?.body, { chat_id: OWNER, text: "Build finished" });

      bot.queueUpdates([
        textUpdate({ updateId: 7, messageId: 5, from: OWNER, text: "Ship it", replyTo: 1000 }),
      ]);
      yield* channel.receive;

      assert.equal(delivered.length, 1);
      const delivery = delivered[0]!;
      assert.equal(delivery.threadId, FIX_LOGIN.id);
      assert.equal(delivery.projectId, PROJECT_ID);
      assert.match(delivery.text, /^Sent from Telegram\./);
      assert.isTrue(delivery.text.endsWith("\n\nShip it"));
      assert.equal(delivery.createdBy, "user");
      assert.equal(delivery.creationSource, "server");
      assert.equal(delivery.mode, "auto");
      // Derived from the bot, the chat, and the message, never from the token's secret half.
      assert.include(delivery.commandId, `123:${OWNER}:5`);
      assert.notInclude(delivery.commandId, "secret");

      const confirmation = bot.sent().at(-1)!;
      assert.equal(confirmation.method, "sendMessage");
      assert.deepEqual(confirmation.body, {
        chat_id: OWNER,
        text: "Sent to “Fix login”.",
        reply_parameters: { message_id: 5, allow_sending_without_reply: true },
      });

      // The confirmation can be answered too, and continues the same thread.
      bot.queueUpdates([
        textUpdate({
          updateId: 8,
          messageId: 6,
          from: OWNER,
          text: "And the tests",
          replyTo: confirmation.messageId!,
        }),
      ]);
      yield* channel.receive;
      assert.equal(delivered.length, 2);
      assert.equal(delivered[1]?.threadId, FIX_LOGIN.id);
    }).pipe(Effect.provide(layer));
  });

  it.effect("ignores an owner answering inside a group, and anybody else there", () => {
    const { bot, delivered, layer } = makeHarness({
      telegram: { chatIds: [OWNER, GROUP] },
      threads: [FIX_LOGIN],
    });
    return Effect.gen(function* () {
      const channel = yield* TelegramChannel.TelegramChannel;
      yield* channel.send({ threadId: FIX_LOGIN.id, text: "Build finished", chatId: GROUP });
      bot.queueUpdates([
        textUpdate({
          updateId: 1,
          messageId: 2,
          from: OWNER,
          chatId: GROUP,
          text: "Ship it",
          replyTo: 1000,
        }),
        textUpdate({
          updateId: 2,
          messageId: 3,
          from: STRANGER,
          chatId: GROUP,
          text: "Delete everything",
          replyTo: 1000,
        }),
      ]);
      yield* channel.receive;

      assert.deepEqual(delivered, []);
      assert.deepEqual(
        bot.sent().map((call) => call.method),
        ["sendMessage"],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("ignores a reply in a private chat from somebody who is not an owner", () => {
    const { bot, delivered, layer } = makeHarness({
      telegram: { ownerIds: [] },
      threads: [FIX_LOGIN],
    });
    return Effect.gen(function* () {
      const channel = yield* TelegramChannel.TelegramChannel;
      yield* channel.send({ threadId: FIX_LOGIN.id, text: "Build finished" });
      bot.queueUpdates([
        textUpdate({ updateId: 1, messageId: 2, from: OWNER, text: "Ship it", replyTo: 1000 }),
      ]);
      yield* channel.receive;

      assert.deepEqual(delivered, []);
      assert.equal(bot.sent().length, 1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps a redelivered message's ids stable and acknowledges what it read", () => {
    const { bot, delivered, layer } = makeHarness({ threads: [FIX_LOGIN] });
    return Effect.gen(function* () {
      const channel = yield* TelegramChannel.TelegramChannel;
      yield* channel.send({ threadId: FIX_LOGIN.id, text: "Build finished" });
      const reply = textUpdate({
        updateId: 7,
        messageId: 5,
        from: OWNER,
        text: "Ship it",
        replyTo: 1000,
      });
      bot.queueUpdates([reply]);
      bot.queueUpdates([reply]);
      bot.queueUpdates([
        textUpdate({ updateId: 8, messageId: 6, from: OWNER, text: "Ship it", replyTo: 1000 }),
      ]);
      yield* channel.receive;
      yield* channel.receive;
      yield* channel.receive;

      assert.equal(delivered.length, 2);
      assert.notEqual(delivered[1]?.commandId, delivered[0]?.commandId);
      assert.include(String(bot.sent()[2]?.body.text), "Already sent");
      const offsets = bot.calls
        .filter((call) => call.method === "getUpdates")
        .map((call) => call.body.offset);
      assert.deepEqual(offsets, [undefined, 8, 8]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("uploads a file from the thread's worktree as a document or a photo", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const worktree = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-telegram-" });
      yield* fileSystem.writeFileString(path.join(worktree, "report.pdf"), "%PDF-1.4 report");
      yield* fileSystem.writeFile(path.join(worktree, "chart.png"), new Uint8Array([137, 80, 78]));
      const worktreeThread = thread({
        id: "thread-report",
        title: "Report",
        worktreePath: worktree,
      });
      const { bot, layer } = makeHarness({ threads: [worktreeThread] });

      yield* Effect.gen(function* () {
        const channel = yield* TelegramChannel.TelegramChannel;
        yield* channel.send({
          threadId: worktreeThread.id,
          path: "report.pdf",
          text: "Weekly report",
        });
        yield* channel.send({ threadId: worktreeThread.id, path: "chart.png" });
        const missing = yield* channel
          .send({ threadId: worktreeThread.id, path: "missing.pdf", text: "Where" })
          .pipe(Effect.flip);

        const [document, photo] = bot.sent();
        assert.equal(document?.method, "sendDocument");
        assert.deepEqual(document?.body, { chat_id: String(OWNER), caption: "Weekly report" });
        assert.equal(document?.file?.name, "report.pdf");
        assert.equal(yield* Effect.promise(() => document!.file!.text()), "%PDF-1.4 report");
        assert.equal(photo?.method, "sendPhoto");
        assert.deepEqual(photo?.body, { chat_id: String(OWNER) });
        assert.equal(photo?.file?.name, "chart.png");

        assert.equal(missing.reason, "file-unreadable");
        assert.equal(bot.sent().length, 2);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps a thread without full access inside its workspace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-telegram-" });
      const worktree = path.join(home, "project");
      yield* fileSystem.makeDirectory(worktree);
      const secret = path.join(home, "id_rsa");
      yield* fileSystem.writeFileString(secret, "private key");
      yield* fileSystem.symlink(secret, path.join(worktree, "notes.txt"));
      const worktreeThread = thread({
        id: "thread-report",
        title: "Report",
        worktreePath: worktree,
      });
      const { bot, layer } = makeHarness({ threads: [worktreeThread] });

      yield* Effect.gen(function* () {
        const channel = yield* TelegramChannel.TelegramChannel;
        // An absolute path, a `..` and a symlink all point at the same file outside.
        for (const outside of [secret, "../id_rsa", "notes.txt"]) {
          const refused = yield* channel
            .send({ threadId: worktreeThread.id, path: outside })
            .pipe(Effect.flip);
          assert.equal(refused.reason, "file-outside-workspace");
        }
        assert.deepEqual(bot.sent(), []);

        // Its own files go out whichever way the path is written.
        yield* fileSystem.writeFileString(path.join(worktree, "report.txt"), "report");
        yield* channel.send({
          threadId: worktreeThread.id,
          path: path.join(worktree, "report.txt"),
        });
        assert.equal(bot.sent().at(-1)?.file?.name, "report.txt");

        // A thread with full access can already read any of them, so it may send them.
        for (const outside of [secret, "../id_rsa", "notes.txt"]) {
          yield* channel.send({ threadId: worktreeThread.id, path: outside, hostFiles: true });
        }
        assert.equal(bot.sent().length, 4);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each([
    {
      name: "no token",
      telegram: { botToken: "" },
      send: { text: "hi" },
      reason: "not-configured",
    },
    { name: "no chat", telegram: { chatIds: [] }, send: { text: "hi" }, reason: "not-configured" },
    {
      name: "a chat that is not in Settings",
      telegram: {},
      send: { text: "hi", chatId: 99 },
      reason: "chat-not-allowed",
    },
    { name: "nothing to send", telegram: {}, send: { text: "   " }, reason: "empty" },
  ] as const)("refuses $name without calling Telegram", ({ telegram, send, reason }) => {
    const { bot, layer } = makeHarness({ telegram, threads: [FIX_LOGIN] });
    return Effect.gen(function* () {
      const channel = yield* TelegramChannel.TelegramChannel;
      const error = yield* channel.send({ threadId: FIX_LOGIN.id, ...send }).pipe(Effect.flip);
      assert.equal(error.reason, reason);
      assert.deepEqual(bot.calls, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("lists open threads one message each, and a reply to one picks that thread", () => {
    const threads = [
      thread({ id: "thread-oldest", title: "Oldest", updatedAtMillis: 1_000 }),
      thread({ id: "thread-newest", title: "Newest", updatedAtMillis: 3_000 }),
      thread({ id: "thread-middle", title: "Middle", updatedAtMillis: 2_000 }),
      thread({ id: "thread-archived", title: "Archived", updatedAtMillis: 4_000, archived: true }),
      thread({ id: "thread-deleted", title: "Deleted", updatedAtMillis: 5_000, deleted: true }),
      thread({ id: "thread-subagent", title: "Subagent", updatedAtMillis: 6_000, subagent: true }),
    ];
    const { bot, delivered, layer } = makeHarness({ threads });
    return Effect.gen(function* () {
      const channel = yield* TelegramChannel.TelegramChannel;
      bot.queueUpdates([textUpdate({ updateId: 1, messageId: 2, from: OWNER, text: "/threads" })]);
      yield* channel.receive;

      const listed = bot.sent();
      // The most recent thread is sent last, so it sits nearest the keyboard.
      assert.deepEqual(
        listed.map((call) => String(call.body.text).split("\n")[0]),
        ["Oldest", "Middle", "Newest"],
      );
      const middle = listed[1]!;

      bot.queueUpdates([
        textUpdate({
          updateId: 2,
          messageId: 3,
          from: OWNER,
          text: "Carry on",
          replyTo: middle.messageId!,
        }),
      ]);
      yield* channel.receive;
      assert.equal(delivered.length, 1);
      assert.equal(delivered[0]?.threadId, ThreadId.make("thread-middle"));
    }).pipe(Effect.provide(layer));
  });

  it.effect("sends to the one group a name fits, and asks which when it fits several", () => {
    const { bot, layer } = makeHarness({
      telegram: { chatIds: [OWNER, GROUP, -1002, -1003] },
      threads: [FIX_LOGIN],
    });
    return Effect.gen(function* () {
      const channel = yield* TelegramChannel.TelegramChannel;

      const sent = yield* channel.send({
        threadId: FIX_LOGIN.id,
        text: "Report ready",
        chat: "leads",
      });
      assert.equal(sent.chatId, -1002);
      assert.equal(sent.chatName, "Team leads");
      // A group cannot answer, so the agent is told where an answer can come from.
      assert.isFalse(sent.replyAvailable);
      assert.equal(bot.sent().at(-1)?.body.chat_id, -1002);

      const several = yield* channel
        .send({ threadId: FIX_LOGIN.id, text: "Report ready", chat: "team" })
        .pipe(Effect.flip);
      assert.equal(several.reason, "chat-not-found");
      assert.include(several.message, "“Team” (-1001), “Team leads” (-1002)");

      // A lookup that merely failed must not make "team" look like it fits only one chat.
      bot.script("getChat", {
        status: 429,
        body: { ok: false, error_code: 429, description: "Too Many Requests" },
      });
      const unsure = yield* channel
        .send({ threadId: FIX_LOGIN.id, text: "Report ready", chat: "team" })
        .pipe(Effect.flip);
      assert.equal(unsure.reason, "rejected");

      // -1003 is a chat the bot was removed from: it has no name, and is not offered.
      const none = yield* channel
        .send({ threadId: FIX_LOGIN.id, text: "Report ready", chat: "sales" })
        .pipe(Effect.flip);
      assert.equal(none.reason, "chat-not-found");
      assert.include(none.message, "“Olivia Owner” (42), “Team” (-1001), “Team leads” (-1002)");
      assert.equal(bot.sent().filter((call) => call.method === "sendMessage").length, 1);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "says a group's id there when an owner adds the bot, and stays quiet for anybody else",
    () => {
      const { bot, delivered, layer } = makeHarness({});
      const added = (updateId: number, by: number) => ({
        update_id: updateId,
        my_chat_member: {
          chat: { id: GROUP, type: "supergroup", title: "Team" },
          from: { id: by, is_bot: false },
          old_chat_member: { status: "left" },
          new_chat_member: { status: "member" },
        },
      });
      return Effect.gen(function* () {
        const channel = yield* TelegramChannel.TelegramChannel;
        bot.queueUpdates([added(3, STRANGER), added(4, OWNER)]);
        yield* channel.receive;
        yield* channel.receive;

        assert.deepEqual(delivered, []);
        const introductions = bot.sent();
        assert.equal(introductions.length, 1);
        assert.equal(introductions[0]?.body.chat_id, GROUP);
        assert.include(String(introductions[0]?.body.text), String(GROUP));
        const offsets = bot.calls
          .filter((call) => call.method === "getUpdates")
          .map((call) => call.body.offset);
        assert.deepEqual(offsets, [undefined, 5]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("tells a stranger who sends /start the id to add in Settings", () => {
    const { bot, delivered, layer } = makeHarness({});
    return Effect.gen(function* () {
      const channel = yield* TelegramChannel.TelegramChannel;
      bot.queueUpdates([textUpdate({ updateId: 1, messageId: 9, from: STRANGER, text: "/start" })]);
      yield* channel.receive;

      assert.deepEqual(delivered, []);
      const [introduction] = bot.sent();
      assert.equal(introduction?.body.chat_id, STRANGER);
      assert.include(String(introduction?.body.text), String(STRANGER));
    }).pipe(Effect.provide(layer));
  });

  it.effect("tests the token by greeting every chat and naming the bot", () => {
    const { bot, layer } = makeHarness({ telegram: { chatIds: [OWNER, GROUP] } });
    return Effect.gen(function* () {
      const channel = yield* TelegramChannel.TelegramChannel;
      const result = yield* channel.sendTest();
      assert.deepEqual(result, {
        botUsername: "t3_test_bot",
        chats: [
          { chatId: OWNER, name: "Olivia Owner" },
          { chatId: GROUP, name: "Team" },
        ],
      });
      assert.deepEqual(
        bot.sent().map((call) => [call.method, call.body.chat_id]),
        [
          ["getMe", undefined],
          ["sendMessage", OWNER],
          ["sendMessage", GROUP],
        ],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("tries every chat in a test and says which one it could not reach", () => {
    const { bot, layer } = makeHarness({ telegram: { chatIds: [GROUP, OWNER] } });
    return Effect.gen(function* () {
      bot.script("sendMessage", {
        status: 403,
        body: { ok: false, error_code: 403, description: "Forbidden: bot was kicked" },
      });
      const channel = yield* TelegramChannel.TelegramChannel;
      const result = yield* channel.sendTest();
      assert.deepEqual(result.chats, [
        { chatId: GROUP, error: "Forbidden: bot was kicked" },
        { chatId: OWNER, name: "Olivia Owner" },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("passes on Telegram's reason when it refuses the token", () => {
    const { bot, layer } = makeHarness({});
    return Effect.gen(function* () {
      bot.script("getMe", {
        status: 401,
        body: { ok: false, error_code: 401, description: "Unauthorized" },
      });
      const channel = yield* TelegramChannel.TelegramChannel;
      const error = yield* channel.sendTest().pipe(Effect.flip);
      assert.equal(error.reason, "rejected");
      assert.include(error.message, "Unauthorized");
      assert.equal(bot.sent().length, 1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not let one unreadable update hold up the ones after it", () => {
    const { bot, delivered, layer } = makeHarness({ threads: [FIX_LOGIN] });
    return Effect.gen(function* () {
      const channel = yield* TelegramChannel.TelegramChannel;
      yield* channel.send({ threadId: FIX_LOGIN.id, text: "Build finished" });
      bot.queueUpdates([
        { update_id: 7, message: { message_id: "not a number", chat: null } },
        textUpdate({ updateId: 8, messageId: 5, from: OWNER, text: "Ship it", replyTo: 1000 }),
        { update_id: 9, message: { text: 42 } },
      ]);
      yield* channel.receive;
      yield* channel.receive;

      assert.equal(delivered.length, 1);
      assert.equal(delivered[0]?.threadId, FIX_LOGIN.id);
      // Unreadable updates are acknowledged too, or Telegram would send them again forever.
      const offsets = bot.calls
        .filter((call) => call.method === "getUpdates")
        .map((call) => call.body.offset);
      assert.deepEqual(offsets, [undefined, 10]);
    }).pipe(Effect.provide(layer));
  });
});
