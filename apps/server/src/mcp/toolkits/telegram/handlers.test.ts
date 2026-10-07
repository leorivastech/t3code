import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  TelegramSendError,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as TelegramChannel from "../../../telegram/TelegramChannel.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as TelegramHandlers from "./handlers.ts";
import { TelegramToolkit } from "./tools.ts";

const callerThreadId = ThreadId.make("telegram-caller");
const providerInstanceId = ProviderInstanceId.make("codex");

const callTelegramSend = (
  send: TelegramChannel.TelegramChannel["Service"]["send"],
  parameters: {
    readonly text?: string;
    readonly path?: string;
    readonly chatId?: number;
    readonly chat?: string;
  },
  runtimeMode: OrchestrationV2ThreadShell["runtimeMode"] = "full-access",
) => {
  const layerDependencies = Layer.mergeAll(
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment"),
      requestNamespace: "session",
      thread: { threadId: callerThreadId, providerSessionId: "session", providerInstanceId },
      client: undefined,
      issuedAt: 0,
      capabilities: new Set(["orchestration" as const]),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: () =>
        Effect.succeed({
          id: callerThreadId,
          providerInstanceId,
          runtimeMode,
          interactionMode: "default",
          activeRunId: "active-run",
          archivedAt: null,
          deletedAt: null,
        } as OrchestrationV2ThreadShell),
    }),
    Layer.mock(TelegramChannel.TelegramChannel)({ send }),
  );
  return TelegramToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(TelegramHandlers.layer).pipe(
        Layer.provide(layerDependencies),
      ),
    ),
    Effect.flatMap((toolkit) => toolkit.handle("telegram_send", parameters)),
    Stream.unwrap,
    Stream.runCollect,
    Effect.map((results) => results.at(-1)?.result),
    Effect.provide(layerDependencies),
  );
};

it.effect("sends on behalf of the calling thread, so the answer comes back to it", () =>
  Effect.gen(function* () {
    const requests: Array<TelegramChannel.TelegramSendInput> = [];
    const result = yield* callTelegramSend(
      (input) => {
        requests.push(input);
        return Effect.succeed({ chatId: 42, messageId: 7, replyAvailable: true });
      },
      { text: "Build finished", chatId: 42 },
    );
    expect(result).toEqual({ chatId: 42, messageId: 7, replyAvailable: true });
    // A full-access thread may send a file from outside its workspace.
    expect(requests).toEqual([
      { threadId: callerThreadId, text: "Build finished", chatId: 42, hostFiles: true },
    ]);
  }),
);

it.effect("does not let a thread without full access send files from outside its workspace", () =>
  Effect.gen(function* () {
    const requests: Array<TelegramChannel.TelegramSendInput> = [];
    yield* callTelegramSend(
      (input) => {
        requests.push(input);
        return Effect.succeed({ chatId: 42, messageId: 7, replyAvailable: true });
      },
      { path: "/etc/hosts" },
      "approval-required",
    );
    expect(requests).toEqual([{ threadId: callerThreadId, path: "/etc/hosts", hostFiles: false }]);
  }),
);

it.effect.each([
  { reason: "file-unreadable", code: "invalid_request" },
  { reason: "not-configured", code: "invalid_request" },
  { reason: "rejected", code: "invalid_request" },
  { reason: "unreachable", code: "orchestration_error" },
  { reason: "context-unavailable", code: "orchestration_error" },
  { reason: "reply-unavailable", code: "invalid_request" },
  { reason: "chat-not-found", code: "invalid_request" },
  { reason: "file-outside-workspace", code: "invalid_request" },
] as const)("tells the agent why a $reason send failed", ({ reason, code }) =>
  Effect.gen(function* () {
    const error = new TelegramSendError({ reason });
    const result = yield* callTelegramSend(() => Effect.fail(error), { text: "Build finished" });
    expect(result).toMatchObject({ _tag: "OrchestratorMcpFailure", code, message: error.message });
  }),
);
