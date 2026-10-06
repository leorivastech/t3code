import type { EnvironmentId, ServerSettingsPatch } from "@t3tools/contracts";
import { ExternalLinkIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { formatEnvironmentQueryError } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button, InlineButton } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { TokenInput } from "./BitbucketCredentialsSettings";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  formatTelegramIdList,
  resolveTelegramDraft,
  telegramSettingsSaved,
  telegramTestMessage,
  type TelegramDraft,
} from "./TelegramSettings.logic";

const BOT_TUTORIAL_URL = "https://core.telegram.org/bots/tutorial#obtain-your-bot-token";
const UNTOUCHED: TelegramDraft = { botToken: "", chatIds: null, ownerIds: null };

/**
 * The Telegram channel of the selected environment. Like Source Control, it
 * edits the representative environment and names it when several are selected.
 */
export function TelegramSettingsSection() {
  const { scope, environment, connectedEnvironments } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const aggregate = scope.environmentIds.length !== 1 && connectedEnvironments.length > 1;
  const { id, title } = searchableSetting("telegram");

  return (
    <SettingsSection
      id={id}
      title={aggregate && environment ? `${title} · ${environment.label}` : title}
    >
      {environmentId === null ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          Connect an environment to set up Telegram.
        </p>
      ) : (
        <TelegramSettings
          // Drafts belong to one environment; switching must not carry them over.
          key={environmentId}
          environmentId={environmentId}
          environmentWide={scope.kind === "project" || scope.kind === "checkout"}
        />
      )}
    </SettingsSection>
  );
}

type Status = { readonly tone: "info" | "error"; readonly message: string };

function IdListField({
  id,
  label,
  hint,
  placeholder,
  value,
  error,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly placeholder: string;
  readonly value: string;
  readonly error: string | null;
  readonly onChange: (value: string) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        size="sm"
        font="mono"
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={value}
        aria-invalid={error !== null || undefined}
        aria-describedby={`${id}-hint`}
        onChange={(event) => onChange(event.target.value)}
      />
      <p
        id={`${id}-hint`}
        role={error ? "alert" : undefined}
        className={cn("text-xs", error ? "text-destructive" : "text-muted-foreground")}
      >
        {error ?? hint}
      </p>
    </div>
  );
}

/**
 * Bot token, chats agents may send to, and the people who may answer. The
 * token is write-only: the server keeps it in its secret store and reports
 * only whether one is set. A test goes to the saved settings, so it waits for
 * pending edits to be saved.
 */
function TelegramSettings({
  environmentId,
  environmentWide,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentWide: boolean;
}) {
  const saved = useEnvironmentSettings(environmentId, (settings) => settings.telegram);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save Telegram settings",
  });
  const testTelegram = useAtomCommand(serverEnvironment.testTelegram, { reportFailure: false });
  const [draft, setDraft] = useState(UNTOUCHED);
  const [pending, setPending] = useState<"save" | "test" | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const { chatIdsError, ownerIdsError, dirty, patch } = resolveTelegramDraft(saved, draft);
  const tokenSaved = saved.botToken !== "";
  const fieldId = (name: string) => `telegram-${name}-${environmentId}`;

  const edit = (next: Partial<TelegramDraft>) => {
    setDraft((current) => ({ ...current, ...next }));
    // A result describes the saved settings; an edit makes it stale.
    setStatus(null);
  };

  const save = async (telegram: NonNullable<ServerSettingsPatch["telegram"]>) => {
    setPending("save");
    setStatus(null);
    try {
      const result = await updateSettings({ environmentId, input: { patch: { telegram } } });
      if (result._tag === "Success") setDraft(UNTOUCHED);
      else setStatus({ tone: "error", message: "Could not save the Telegram settings." });
    } finally {
      setPending(null);
    }
  };

  const sendTest = async () => {
    setPending("test");
    setStatus(null);
    try {
      const result = await testTelegram({ environmentId, input: {} });
      setStatus(
        result._tag === "Success"
          ? telegramTestMessage(result.value)
          : { tone: "error", message: formatEnvironmentQueryError(result.cause) },
      );
    } finally {
      setPending(null);
    }
  };

  const footer: Status | null = environmentWide
    ? { tone: "info", message: "Environment-wide setting. Select an environment to change it." }
    : (status ?? (tokenSaved && dirty ? { tone: "info", message: "Save to send a test." } : null));

  return (
    <SettingsRow
      title="Bot"
      description={
        <>
          Agents can send you messages and files on Telegram, and you can answer by replying. Create
          a separate bot with @BotFather, paste its token and save first. Then send /start to that
          bot to get your id. Add your id to both fields below and save again.{" "}
          <InlineButton
            render={<a href={BOT_TUTORIAL_URL} target="_blank" rel="noreferrer noopener" />}
          >
            How to create a bot
            <ExternalLinkIcon aria-hidden className="size-3" />
          </InlineButton>
        </>
      }
    >
      <form
        className="grid gap-4 pt-3 pb-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (patch && pending === null) void save(patch);
        }}
      >
        {/* Locked while saving: a successful save clears the drafts, which would drop edits made mid-request. */}
        <fieldset disabled={pending === "save" || environmentWide} className="contents">
          <div className="grid gap-1.5">
            <Label htmlFor={fieldId("token")}>Bot token</Label>
            <TokenInput
              id={fieldId("token")}
              isSaved={tokenSaved}
              draft={draft.botToken}
              onDraftChange={(botToken) => edit({ botToken })}
            />
          </div>
          <IdListField
            id={fieldId("chats")}
            label="Chats"
            hint="Where agents can send. The first is the default for new sends; replies return to the sender. For a group, add the bot to it and it posts the group's id there."
            placeholder="Chat ids, separated by commas"
            value={draft.chatIds ?? formatTelegramIdList(saved.chatIds)}
            error={chatIdsError}
            onChange={(chatIds) => edit({ chatIds })}
          />
          <IdListField
            id={fieldId("owners")}
            label="Who can answer"
            hint="People who can answer agents, only from their private chat with the bot. Send /start to the bot to get your id. Leave empty to turn answering off."
            placeholder="User ids, separated by commas"
            value={draft.ownerIds ?? formatTelegramIdList(saved.ownerIds)}
            error={ownerIdsError}
            onChange={(ownerIds) => edit({ ownerIds })}
          />
          <div className="flex items-center justify-between gap-3">
            <p
              role="status"
              className={cn(
                "text-xs",
                footer?.tone === "error" ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {footer?.message}
            </p>
            <div className="flex shrink-0 gap-2">
              {telegramSettingsSaved(saved) ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={pending !== null}
                  onClick={() => void save({ botToken: "", chatIds: [], ownerIds: [] })}
                >
                  Remove
                </Button>
              ) : null}
              <Button
                size="xs"
                variant="outline"
                disabled={!tokenSaved || dirty || pending !== null}
                onClick={() => void sendTest()}
              >
                {pending === "test" ? "Sending…" : "Send test"}
              </Button>
              <Button type="submit" size="xs" disabled={patch === null || pending !== null}>
                Save
              </Button>
            </div>
          </div>
        </fieldset>
      </form>
    </SettingsRow>
  );
}
