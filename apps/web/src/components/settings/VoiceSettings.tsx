import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import {
  useClientSettings,
  useEnvironmentSettings,
  useUpdateClientSettings,
} from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { holdKeyLabel } from "../../voice/voiceOrders";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { Input } from "../ui/input";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";

/**
 * Spoken orders for the selected environment. The key belongs
 * to the representative environment; the key to hold belongs to this device.
 */
export function VoiceSettingsSection() {
  const { scope, environment, connectedEnvironments } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const aggregate = scope.environmentIds.length !== 1 && connectedEnvironments.length > 1;
  const { id, title } = searchableSetting("voice");

  return (
    <SettingsSection
      id={id}
      title={aggregate && environment ? `${title} · ${environment.label}` : title}
    >
      {environmentId === null ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          Connect an environment to set up voice.
        </p>
      ) : (
        <VoiceKeySettings
          // A draft belongs to one environment; switching must not carry it over.
          key={environmentId}
          environmentId={environmentId}
          environmentWide={scope.kind === "project" || scope.kind === "checkout"}
        />
      )}
      <HoldKeySetting />
    </SettingsSection>
  );
}

/**
 * The one key that both hears and understands. It is write-only: the server
 * keeps it in its secret store and reports only whether one is set.
 */
function VoiceKeySettings({
  environmentId,
  environmentWide,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentWide: boolean;
}) {
  const keySaved = useEnvironmentSettings(
    environmentId,
    (settings) => settings.voice.apiKey !== "",
  );
  const localWhisper = useEnvironmentSettings(
    environmentId,
    (settings) => settings.voice.localWhisper,
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save the voice key",
  });
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const fieldId = `voice-key-${environmentId}`;

  const save = async (apiKey: string) => {
    setSaving(true);
    try {
      const result = await updateSettings({
        environmentId,
        input: { patch: { voice: { apiKey } } },
      });
      if (result._tag === "Success") setDraft("");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsRow
      title="Spoken orders"
      description="Hold a key to speak. Thread navigation and scrolling happen after a short pause; other orders wait for release. Local Whisper keeps navigation recordings and text on this environment. Cloud mode uses Groq or OpenAI for transcription and other orders."
    >
      <form
        className="grid gap-3 pt-3 pb-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.trim() !== "" && !saving) void save(draft.trim());
        }}
      >
        <fieldset disabled={saving || environmentWide} className="contents">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor={`voice-local-${environmentId}`}>
              Local Whisper · threads and scrolling
            </Label>
            <Switch
              id={`voice-local-${environmentId}`}
              checked={localWhisper}
              onCheckedChange={(checked) => {
                void updateSettings({
                  environmentId,
                  input: { patch: { voice: { localWhisper: checked } } },
                });
              }}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={fieldId}>Groq or OpenAI key</Label>
            <Input
              id={fieldId}
              type="password"
              autoComplete="off"
              size="sm"
              placeholder={keySaved ? "Stored secret, enter a new value to replace" : "Not set"}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <p role="status" className="text-xs text-muted-foreground">
              {environmentWide
                ? "Environment-wide setting. Select an environment to change it."
                : localWhisper
                  ? "Local Whisper is selected. No API key is needed for threads and scrolling."
                  : keySaved
                    ? "Cloud voice is on."
                    : "Voice is off until a key is saved."}
            </p>
            <div className="flex shrink-0 gap-2">
              {keySaved ? (
                <Button size="xs" variant="outline" onClick={() => void save("")}>
                  Remove
                </Button>
              ) : null}
              <Button type="submit" size="xs" disabled={draft.trim() === ""}>
                Save
              </Button>
            </div>
          </div>
        </fieldset>
      </form>
    </SettingsRow>
  );
}

/** The next key pressed becomes the one to hold. Escape leaves it as it was. */
function HoldKeySetting() {
  const holdKey = useClientSettings((settings) => settings.voiceHoldKey);
  const updateClientSettings = useUpdateClientSettings();
  const [choosing, setChoosing] = useState(false);

  useEffect(() => {
    if (!choosing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.code !== "Escape" && event.code !== "") {
        void updateClientSettings({ voiceHoldKey: event.code });
      }
      setChoosing(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [choosing, updateClientSettings]);

  return (
    <SettingsRow
      title="Key to hold"
      description="Held while you speak, on this device. Pick one you do not type with; used in a shortcut with other keys, it still works as usual."
      control={
        <Button size="xs" variant="outline" onClick={() => setChoosing(true)}>
          {choosing ? "Press a key…" : holdKeyLabel(holdKey)}
        </Button>
      }
    />
  );
}
