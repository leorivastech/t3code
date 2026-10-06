import { OrchestratorMcpFailure, TelegramId, TelegramSendResult } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as TelegramChannel from "../../../telegram/TelegramChannel.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const TelegramSendTool = Tool.make("telegram_send", {
  description:
    "Send a message or a file to the user's Telegram chat, or to another chat or group listed in Settings. Use it when the user asks to be told or sent something on Telegram, and to answer a message that says it was sent from Telegram. Give text, path, or both. Text is shown as written, without Markdown, up to 4096 characters, or 1024 as the caption of a file. JPG, PNG, and WebP images and MP4 videos play in the chat; any other file, such as a PDF, arrives as a document. Files can be up to 50 MB. The user can answer the message in Telegram, and the answer arrives in this thread. A successful result means the message was sent: if replyAvailable is false, explain the warning but do not resend the file.",
  parameters: Schema.Struct({
    text: Schema.optional(Schema.String).annotate({
      description: "The message, or the caption when a file is sent.",
    }),
    path: Schema.optional(Schema.String).annotate({
      description:
        "A file to upload. A relative path is read from this thread's workspace; an absolute path is read in place.",
    }),
    chatId: Schema.optional(TelegramId).annotate({
      description:
        "Use the chatId supplied by an incoming Telegram message when answering it. Otherwise use a configured destination. When omitted, replies go to the latest Telegram sender in the active turn; other sends use the first configured chat.",
    }),
    chat: Schema.optional(Schema.String).annotate({
      description:
        "The name of a chat or group from Settings, when the user names one, such as the team group. Part of the name is enough when only one chat fits. Leave it out to answer a Telegram message or to use the default chat.",
    }),
  }),
  success: TelegramSendResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    TelegramChannel.TelegramChannel,
  ],
})
  .annotate(Tool.Title, "Send to Telegram")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

export const TelegramToolkit = Toolkit.make(TelegramSendTool);
