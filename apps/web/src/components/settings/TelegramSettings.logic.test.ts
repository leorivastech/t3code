import type { TelegramSettings } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  parseTelegramIdList,
  resolveTelegramDraft,
  telegramSettingsSaved,
  telegramTestMessage,
} from "./TelegramSettings.logic";

const empty: TelegramSettings = { botToken: "", chatIds: [], ownerIds: [] };
const saved: TelegramSettings = {
  botToken: "<redacted>",
  chatIds: [111, -1002233],
  ownerIds: [111],
};
const untouched = { botToken: "", chatIds: null, ownerIds: null };

describe("parseTelegramIdList", () => {
  it("accepts ids separated by commas, spaces, or both, and keeps their order", () => {
    expect(parseTelegramIdList(" 42,-1001234\n7  , 9 ", "chat")).toEqual({
      ok: true,
      ids: [42, -1001234, 7, 9],
    });
    expect(parseTelegramIdList("  ", "chat")).toEqual({ ok: true, ids: [] });
  });

  it("drops repeats so the first chat stays the default", () => {
    expect(parseTelegramIdList("5, 3, 5", "chat")).toEqual({ ok: true, ids: [5, 3] });
  });

  it.each(["0", "-0", "1.5", "1e3", "abc", "+12", "12a", "99999999999999999999"])(
    "rejects %s",
    (entry) => {
      expect(parseTelegramIdList(`1, ${entry}`, "chat")).toEqual({
        ok: false,
        error: `${entry} is not a Telegram id.`,
      });
    },
  );

  it("rejects a group or channel where only people fit", () => {
    expect(parseTelegramIdList("-1001234", "chat").ok).toBe(true);
    expect(parseTelegramIdList("7, -1001234", "person")).toEqual({
      ok: false,
      error: "-1001234 is a group or channel. Only people can answer.",
    });
  });
});

describe("resolveTelegramDraft", () => {
  it("has nothing to save until something differs from the server", () => {
    expect(resolveTelegramDraft(saved, untouched)).toMatchObject({ dirty: false, patch: null });
    // Retyping the same ids with other separators is not a change.
    expect(
      resolveTelegramDraft(saved, { botToken: "  ", chatIds: "111 -1002233", ownerIds: "111," }),
    ).toMatchObject({ dirty: false, patch: null });
  });

  it("keeps the saved token unless a new one is typed", () => {
    expect(resolveTelegramDraft(saved, { ...untouched, chatIds: "-1002233, 111" }).patch).toEqual({
      chatIds: [-1002233, 111],
      ownerIds: [111],
    });
    expect(resolveTelegramDraft(empty, { ...untouched, botToken: " 123:abc " }).patch).toEqual({
      botToken: "123:abc",
      chatIds: [],
      ownerIds: [],
    });
  });

  it("blocks saving while a field is invalid and says which", () => {
    expect(
      resolveTelegramDraft(saved, { botToken: "123:abc", chatIds: "1.5", ownerIds: "-5" }),
    ).toEqual({
      chatIdsError: "1.5 is not a Telegram id.",
      ownerIdsError: "-5 is a group or channel. Only people can answer.",
      dirty: true,
      patch: null,
    });
  });

  it("saves cleared lists", () => {
    expect(resolveTelegramDraft(saved, { ...untouched, ownerIds: "" }).patch).toEqual({
      chatIds: [111, -1002233],
      ownerIds: [],
    });
  });
});

describe("telegramSettingsSaved", () => {
  it("is true while a token or any id is saved", () => {
    expect(telegramSettingsSaved(empty)).toBe(false);
    expect(telegramSettingsSaved({ ...empty, ownerIds: [1] })).toBe(true);
    expect(telegramSettingsSaved({ ...empty, botToken: "<redacted>" })).toBe(true);
  });
});

describe("telegramTestMessage", () => {
  it("names the chats the test reached, so a group's id can be told from a person's", () => {
    expect(
      telegramTestMessage({ botUsername: "t3_bot", chats: [{ chatId: 1, name: "Ada Diaz" }] }),
    ).toEqual({ tone: "info", message: "@t3_bot reached Ada Diaz." });
    expect(
      telegramTestMessage({
        botUsername: "t3_bot",
        chats: [{ chatId: 1, name: "Ada Diaz" }, { chatId: -2, name: "Team" }, { chatId: -3 }],
      }).message,
    ).toBe("@t3_bot reached Ada Diaz, Team, and -3.");
  });

  it("says which chat it could not reach, and why, next to the ones it did", () => {
    expect(
      telegramTestMessage({
        botUsername: "t3_bot",
        chats: [
          { chatId: 1, name: "Ada Diaz" },
          { chatId: -2, error: "Forbidden: bot was kicked" },
        ],
      }),
    ).toEqual({
      tone: "error",
      message: "@t3_bot reached Ada Diaz. @t3_bot could not reach -2 (Forbidden: bot was kicked).",
    });
  });

  it("points to /start when no chat is set up yet", () => {
    expect(telegramTestMessage({ botUsername: "t3_bot", chats: [] })).toEqual({
      tone: "info",
      message: "@t3_bot is connected. Send /start to it in Telegram to get your chat id.",
    });
  });
});
