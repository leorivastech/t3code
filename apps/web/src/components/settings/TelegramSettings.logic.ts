import type {
  ServerSettingsPatch,
  TelegramSendTestResult,
  TelegramSettings,
} from "@t3tools/contracts";

type TelegramPatch = NonNullable<ServerSettingsPatch["telegram"]>;

export type TelegramIdListParse =
  | { readonly ok: true; readonly ids: ReadonlyArray<number> }
  | { readonly ok: false; readonly error: string };

/**
 * Reads ids typed into one field, separated by commas or spaces. Chats may be
 * negative (groups and channels); people never are. Repeats are dropped and
 * the order is kept, because the first chat is the default.
 */
export function parseTelegramIdList(text: string, kind: "chat" | "person"): TelegramIdListParse {
  const ids: number[] = [];
  for (const entry of text.split(/[\s,]+/)) {
    if (entry === "") continue;
    const id = /^-?\d+$/.test(entry) ? Number(entry) : Number.NaN;
    if (!Number.isSafeInteger(id) || id === 0) {
      return { ok: false, error: `${entry} is not a Telegram id.` };
    }
    if (kind === "person" && id < 0) {
      return { ok: false, error: `${entry} is a group or channel. Only people can answer.` };
    }
    if (!ids.includes(id)) ids.push(id);
  }
  return { ok: true, ids };
}

export function formatTelegramIdList(ids: ReadonlyArray<number>): string {
  return ids.join(", ");
}

export interface TelegramDraft {
  /** A new token, or empty to keep the saved one. */
  readonly botToken: string;
  /** Typed chat ids, or null while the field still shows the saved list. */
  readonly chatIds: string | null;
  /** Typed owner ids, or null while the field still shows the saved list. */
  readonly ownerIds: string | null;
}

export interface TelegramDraftState {
  readonly chatIdsError: string | null;
  readonly ownerIdsError: string | null;
  /** Something differs from what the server has, valid or not. */
  readonly dirty: boolean;
  /** What Save sends, or null when there is nothing valid to save. */
  readonly patch: TelegramPatch | null;
}

function sameIds(left: ReadonlyArray<number>, right: ReadonlyArray<number>): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** Compares the form with the saved settings. The saved token is never shown, only replaced. */
export function resolveTelegramDraft(
  saved: TelegramSettings,
  draft: TelegramDraft,
): TelegramDraftState {
  const botToken = draft.botToken.trim();
  const chats = parseTelegramIdList(draft.chatIds ?? formatTelegramIdList(saved.chatIds), "chat");
  const owners = parseTelegramIdList(
    draft.ownerIds ?? formatTelegramIdList(saved.ownerIds),
    "person",
  );
  const chatsChanged = !chats.ok || !sameIds(chats.ids, saved.chatIds);
  const ownersChanged = !owners.ok || !sameIds(owners.ids, saved.ownerIds);
  const dirty = botToken !== "" || chatsChanged || ownersChanged;
  return {
    chatIdsError: chats.ok ? null : chats.error,
    ownerIdsError: owners.ok ? null : owners.error,
    dirty,
    patch:
      dirty && chats.ok && owners.ok
        ? {
            ...(botToken === "" ? {} : { botToken }),
            chatIds: [...chats.ids],
            ownerIds: [...owners.ids],
          }
        : null,
  };
}

export function telegramSettingsSaved(saved: TelegramSettings): boolean {
  return saved.botToken !== "" || saved.chatIds.length > 0 || saved.ownerIds.length > 0;
}

/** What a test found, said in one line. Any chat it missed makes it an error. */
export function telegramTestMessage(result: TelegramSendTestResult): {
  readonly tone: "info" | "error";
  readonly message: string;
} {
  const bot = `@${result.botUsername}`;
  if (result.chats.length === 0) {
    return {
      tone: "info",
      message: `${bot} is connected. Send /start to it in Telegram to get your chat id.`,
    };
  }
  const list = new Intl.ListFormat("en", { type: "conjunction" });
  // Names show which id is which chat, which matters once a group is in the list.
  const reached = result.chats
    .filter((chat) => chat.error === undefined)
    .map((chat) => chat.name ?? String(chat.chatId));
  const missed = result.chats.flatMap((chat) =>
    chat.error === undefined ? [] : [`${chat.chatId} (${chat.error})`],
  );
  const reachedLine = reached.length > 0 ? `${bot} reached ${list.format(reached)}.` : "";
  if (missed.length === 0) return { tone: "info", message: reachedLine };
  return {
    tone: "error",
    message: `${reachedLine} ${bot} could not reach ${list.format(missed)}.`.trim(),
  };
}
