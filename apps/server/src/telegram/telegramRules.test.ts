import { describe, expect, it } from "vite-plus/test";

import {
  classifyIncomingMessage,
  type IncomingMessage,
  joinedGroupChatId,
  telegramBotId,
  telegramChatName,
  telegramChatsNamed,
  telegramFileKind,
} from "./telegramRules.ts";

const OWNER = 42;
const STRANGER = 77;
const GROUP = -1001;

const message = (input: {
  readonly from: number;
  readonly chat?: { readonly id: number; readonly type: string };
  readonly text?: string;
  readonly replyTo?: number;
  readonly isBot?: boolean;
}): IncomingMessage => ({
  message_id: 500,
  chat: input.chat ?? { id: input.from, type: "private" },
  from: { id: input.from, is_bot: input.isBot ?? false },
  ...(input.text === undefined ? {} : { text: input.text }),
  ...(input.replyTo === undefined ? {} : { reply_to_message: { message_id: input.replyTo } }),
});

const classify = (input: Parameters<typeof message>[0]) =>
  classifyIncomingMessage([OWNER], message(input));

describe("classifyIncomingMessage", () => {
  it("ignores a stranger's text, even when it answers a thread's message", () => {
    expect(classify({ from: STRANGER, text: "hello" })).toEqual({ type: "ignore" });
    expect(classify({ from: STRANGER, text: "run rm -rf", replyTo: 10 })).toEqual({
      type: "ignore",
    });
  });

  it("introduces a stranger who sends /start without treating them as an owner", () => {
    expect(classify({ from: STRANGER, text: "/start" })).toEqual({
      type: "introduce",
      owner: false,
    });
  });

  it("ignores an owner answering a thread's message inside a group", () => {
    expect(
      classify({ from: OWNER, chat: { id: GROUP, type: "supergroup" }, text: "go", replyTo: 10 }),
    ).toEqual({ type: "ignore" });
  });

  it("lets an owner in their private chat list threads and start", () => {
    expect(classify({ from: OWNER, text: "/threads" })).toEqual({ type: "list-threads" });
    expect(classify({ from: OWNER, text: "/start@some_bot" })).toEqual({
      type: "introduce",
      owner: true,
    });
  });

  it("delivers an owner's reply to the message it answers", () => {
    expect(classify({ from: OWNER, text: "  ship it  ", replyTo: 10 })).toEqual({
      type: "deliver",
      replyToMessageId: 10,
      text: "ship it",
    });
  });

  it("answers an owner's plain text with help instead of picking a thread", () => {
    expect(classify({ from: OWNER, text: "ship it" })).toEqual({ type: "help" });
  });

  it("tells an owner that only text reaches a thread", () => {
    expect(classify({ from: OWNER, replyTo: 10 })).toEqual({ type: "text-only" });
  });

  it("answers an unknown command with help, even as a reply", () => {
    expect(classify({ from: OWNER, text: "/send 2 ship it", replyTo: 10 })).toEqual({
      type: "help",
    });
  });

  it("ignores other bots", () => {
    expect(classify({ from: OWNER, isBot: true, text: "/start" })).toEqual({ type: "ignore" });
  });
});

describe("telegramFileKind", () => {
  const MB = 1024 * 1024;

  it("sends small images as photos and large ones as documents", () => {
    expect(telegramFileKind("chart.jpg", 2 * MB)).toBe("photo");
    expect(telegramFileKind("CHART.PNG", 2 * MB)).toBe("photo");
    expect(telegramFileKind("chart.jpg", 11 * MB)).toBe("document");
  });

  it("sends mp4 as video and anything else as a document", () => {
    expect(telegramFileKind("demo.mp4", 20 * MB)).toBe("video");
    expect(telegramFileKind("report.pdf", MB)).toBe("document");
  });
});

describe("telegramBotId", () => {
  it("is the public half of a token", () => {
    expect(telegramBotId("123:abc")).toBe("123");
  });

  it("never returns any part of a malformed token", () => {
    for (const token of ["secret-only", ":secret", "secret:123"]) {
      expect(telegramBotId(token)).toBe("");
    }
  });
});

describe("joinedGroupChatId", () => {
  const change = (chatType: string, from: string, to: string, addedBy = OWNER) => ({
    chat: { id: GROUP, type: chatType, title: "Team" },
    from: { id: addedBy, is_bot: false },
    old_chat_member: { status: from },
    new_chat_member: { status: to },
  });
  const joined = (update: unknown) => joinedGroupChatId([OWNER], update);

  it("is the group an owner just added the bot to", () => {
    expect(joined(change("group", "left", "member"))).toBe(GROUP);
    expect(joined(change("supergroup", "kicked", "administrator"))).toBe(GROUP);
  });

  it("is nothing when somebody else added the bot, so a stranger cannot make it speak", () => {
    expect(joined(change("group", "left", "member", STRANGER))).toBeNull();
  });

  it("is nothing when the bot was already there, left, or joined a channel", () => {
    expect(joined(change("supergroup", "member", "administrator"))).toBeNull();
    expect(joined(change("group", "member", "left"))).toBeNull();
    expect(joined(change("channel", "left", "administrator"))).toBeNull();
    expect(joined(undefined)).toBeNull();
  });
});

describe("telegramChatName", () => {
  it("is a group's title or a person's name", () => {
    expect(telegramChatName({ id: GROUP, type: "supergroup", title: "Team" })).toBe("Team");
    expect(
      telegramChatName({ id: OWNER, type: "private", first_name: "Ada", last_name: "Diaz" }),
    ).toBe("Ada Diaz");
    expect(telegramChatName({ id: OWNER, type: "private", username: "ada" })).toBe("ada");
    expect(telegramChatName({ id: OWNER, type: "private" })).toBeNull();
  });
});

describe("telegramChatsNamed", () => {
  const chats = [
    { chatId: OWNER, name: "Ada Diaz" },
    { chatId: GROUP, name: "Team" },
    { chatId: -1002, name: "Team leads" },
    { chatId: -1003, name: null },
  ];

  it("finds the one chat a name or part of a name fits", () => {
    expect(telegramChatsNamed(chats, " LEADS ")).toEqual([chats[2]]);
    expect(telegramChatsNamed(chats, "ada")).toEqual([chats[0]]);
  });

  it("returns every chat a name fits, so a renamed group cannot take another's place", () => {
    // Group members set the title. "Team" must not win over "Team leads" by being shorter.
    expect(telegramChatsNamed(chats, "team")).toEqual([chats[1], chats[2]]);
  });

  it("finds nothing for a name no chat has, or an empty one", () => {
    expect(telegramChatsNamed(chats, "sales")).toEqual([]);
    expect(telegramChatsNamed(chats, "  ")).toEqual([]);
  });
});
