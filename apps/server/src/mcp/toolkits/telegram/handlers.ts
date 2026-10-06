import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as TelegramChannel from "../../../telegram/TelegramChannel.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller } from "../../threadAccess.ts";
import { TelegramToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(TelegramToolkit, {
  telegram_send: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { caller, limits } = yield* loadCaller();
      const telegram = yield* TelegramChannel.TelegramChannel;
      return yield* telegram
        .send({ ...input, threadId: caller?.id, hostFiles: limits.runtimeMode === "full-access" })
        .pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({
                // Only a send Telegram never answered is worth another try; what it refused,
                // and what the request itself got wrong, will fail the same way again.
                code:
                  error.reason === "unreachable" || error.reason === "context-unavailable"
                    ? "orchestration_error"
                    : "invalid_request",
                message: error.message,
              }),
          ),
        );
    }),
  ),
});
