import * as Schema from "effect/Schema";

import type { TelegramChat, TelegramFileKind } from "./TelegramBotApi.ts";

/** Telegram's own limits for a bot. */
export const TELEGRAM_TEXT_MAX_CHARS = 4096;
export const TELEGRAM_CAPTION_MAX_CHARS = 1024;
export const TELEGRAM_FILE_MAX_BYTES = 50 * 1024 * 1024;
const TELEGRAM_PHOTO_MAX_BYTES = 10 * 1024 * 1024;

const IncomingMessage = Schema.Struct({
  message_id: Schema.Int,
  chat: Schema.Struct({ id: Schema.Int, type: Schema.String }),
  from: Schema.optional(Schema.Struct({ id: Schema.Int, is_bot: Schema.Boolean })),
  text: Schema.optional(Schema.String),
  reply_to_message: Schema.optional(Schema.Struct({ message_id: Schema.Int })),
});
export type IncomingMessage = typeof IncomingMessage.Type;

/** Reads the parts of a Telegram message the channel acts on. */
export const decodeIncomingMessage = Schema.decodeUnknownOption(IncomingMessage);

const MembershipChange = Schema.Struct({
  chat: Schema.Struct({ id: Schema.Int, type: Schema.String }),
  from: Schema.Struct({ id: Schema.Int }),
  old_chat_member: Schema.Struct({ status: Schema.String }),
  new_chat_member: Schema.Struct({ status: Schema.String }),
});

const decodeMembershipChange = Schema.decodeUnknownOption(MembershipChange);

const isMember = (status: string) => status === "member" || status === "administrator";

/**
 * The group an owner just added the bot to, read from a `my_chat_member` update. The bot says
 * the group's id there, which is the number Settings asks for. Anybody can add a bot to a
 * group, so only an owner's doing makes it speak; a channel is left alone, because a post
 * there reaches every subscriber.
 */
export function joinedGroupChatId(ownerIds: ReadonlyArray<number>, update: unknown): number | null {
  const change = decodeMembershipChange(update);
  if (change._tag === "None") return null;
  const { chat, from, old_chat_member, new_chat_member } = change.value;
  if (chat.type !== "group" && chat.type !== "supergroup") return null;
  if (!ownerIds.includes(from.id)) return null;
  return !isMember(old_chat_member.status) && isMember(new_chat_member.status) ? chat.id : null;
}

/** What to call a chat: a group's title, or a person's name. */
export function telegramChatName(chat: TelegramChat): string | null {
  const person = [chat.first_name, chat.last_name]
    .filter((part) => part !== undefined && part.trim().length > 0)
    .join(" ");
  const name = chat.title?.trim() || person.trim() || chat.username?.trim() || "";
  return name.length > 0 ? name : null;
}

/**
 * The configured chats a user could mean by a name, as in "send it to the team group". Group
 * titles are set by their members, so a name is only good when it fits one chat: the caller
 * sends to a single match and asks again for anything else.
 */
export function telegramChatsNamed<Chat extends { readonly name: string | null }>(
  chats: ReadonlyArray<Chat>,
  requested: string,
): ReadonlyArray<Chat> {
  const wanted = requested.trim().toLowerCase();
  if (wanted.length === 0) return [];
  return chats.filter((chat) => chat.name !== null && chat.name.toLowerCase().includes(wanted));
}

export type IncomingAction =
  /** Not for the channel: a bot, a stranger, or an owner writing outside their private chat. */
  | { readonly type: "ignore" }
  /** `/start` from anybody, answered with the id Settings asks for. */
  | { readonly type: "introduce"; readonly owner: boolean }
  | { readonly type: "list-threads" }
  | { readonly type: "help" }
  /** An owner sent something other than text, which a thread cannot receive yet. */
  | { readonly type: "text-only" }
  | { readonly type: "deliver"; readonly replyToMessageId: number; readonly text: string };

function commandName(text: string): string | null {
  // In a group Telegram appends the bot's name: `/start@my_bot`.
  const match = /^\/([a-z_]+)(?:@\w+)?(?:\s|$)/i.exec(text);
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * Decides what one incoming message means. Only an owner writing in their own private chat can
 * reach a thread: what they type becomes a user message for an agent that can run commands, so
 * a group, where anybody can answer, never counts, even when an owner is the one answering.
 */
export function classifyIncomingMessage(
  ownerIds: ReadonlyArray<number>,
  message: IncomingMessage,
): IncomingAction {
  const { chat, from } = message;
  if (from === undefined || from.is_bot) return { type: "ignore" };
  const text = message.text?.trim() ?? "";
  const command = commandName(text);
  const owner = chat.type === "private" && chat.id === from.id && ownerIds.includes(from.id);
  if (command === "start") return { type: "introduce", owner };
  if (!owner) return { type: "ignore" };
  if (command === "threads") return { type: "list-threads" };
  if (command !== null) return { type: "help" };
  if (text.length === 0) return { type: "text-only" };
  if (message.reply_to_message === undefined) return { type: "help" };
  return { type: "deliver", replyToMessageId: message.reply_to_message.message_id, text };
}

/** The Bot API upload a file goes through, chosen by what Telegram can show inline. */
export function telegramFileKind(fileName: string, sizeBytes: number): TelegramFileKind {
  const extension = fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase();
  if (["jpg", "jpeg", "png", "webp"].includes(extension)) {
    // A larger image is refused as a photo but accepted as a file.
    return sizeBytes <= TELEGRAM_PHOTO_MAX_BYTES ? "photo" : "document";
  }
  return extension === "mp4" ? "video" : "document";
}

const MIME_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  mp4: "video/mp4",
  pdf: "application/pdf",
};

export function telegramFileMimeType(fileName: string): string {
  const extension = fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase();
  return MIME_TYPES[extension] ?? "application/octet-stream";
}

/**
 * The bot a token belongs to. The id is the public half of the token, and is what keeps one
 * bot's message ids apart from another's after the token in Settings is replaced.
 */
export function telegramBotId(token: string): string {
  return /^(\d+):/.exec(token)?.[1] ?? "";
}

export const TELEGRAM_HELP =
  "Reply to a message from a thread to answer it. Send /threads to see the open threads and reply to the one you want.";

export const TELEGRAM_TEXT_ONLY = "Only text reaches a thread for now.";

/** What an agent reads above a message that came in from Telegram. */
export function telegramThreadMessage(text: string, chatId: number): string {
  return `Sent from Telegram. Answer with telegram_send using chatId ${chatId}.\n\n${text}`;
}

/** Read the server-assigned message id, never user-written text, to choose a reply destination. */
export function telegramReplyAddress(messageId: string): { botId: string; chatId: number } | null {
  const match = /^telegram-message:(\d+):(\d+):\d+$/.exec(messageId);
  if (match === null) return null;
  const chatId = Number(match[2]);
  return Number.isSafeInteger(chatId) && chatId > 0 ? { botId: match[1]!, chatId } : null;
}

/** A thread as the chat names it. */
export function telegramThreadTitle(title: string): string {
  return title.trim() || "Untitled thread";
}

export function telegramThreadLine(thread: {
  readonly title: string;
  readonly working: boolean;
}): string {
  return `${telegramThreadTitle(thread.title)}\n${thread.working ? "Working" : "Idle"} · reply here to message it`;
}

export function telegramIntroduction(input: {
  readonly chatId: number;
  readonly privateChat: boolean;
  readonly owner: boolean;
}): string {
  if (input.owner) return `T3 Code is connected to this chat. ${TELEGRAM_HELP}`;
  const subject = input.privateChat ? "Your Telegram id" : "This chat's id";
  return `${subject} is ${input.chatId}. Add it in T3 Code under Settings → Integrations → Telegram.`;
}
