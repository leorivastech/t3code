import type { ModCommand, ServerProviderSlashCommand } from "@t3tools/contracts";

/**
 * The mod command a message runs: its first word is `/name` of one, and the
 * rest are the command's arguments. Null for a message that goes to the provider.
 */
export function matchModCommand(
  text: string,
  commands: ReadonlyArray<ModCommand>,
): { readonly command: ModCommand; readonly args: string } | null {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (match === null) return null;
  const command = commands.find((entry) => entry.name === match[1]);
  return command === undefined ? null : { command, args: match[2] ?? "" };
}

/**
 * The slash menu's commands: the provider's and the mods'. A mod's command
 * stands in for a provider's of the same name, since it is the one that runs.
 */
export function withModSlashCommands(
  provided: ReadonlyArray<ServerProviderSlashCommand>,
  mods: ReadonlyArray<ModCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  if (mods.length === 0) return provided;
  const names = new Set(mods.map((command) => command.name));
  return [
    ...provided.filter((command) => !names.has(command.name)),
    ...mods.map((command) => ({
      name: command.name,
      description: command.description.trim() || `${command.plugin} mod`,
      ...(command.argumentHint?.trim() ? { input: { hint: command.argumentHint.trim() } } : {}),
    })),
  ];
}

/**
 * A composer draft after a mod's `$.prompt.fill`: the text replaces the draft,
 * ends it, or goes in at the cursor, which lands after it.
 */
export function fillModPrompt(
  draft: { readonly text: string; readonly cursor: number },
  fill: { readonly text: string; readonly mode: "replace" | "append" | "insert" },
): { readonly text: string; readonly cursor: number } {
  if (fill.mode === "replace") return { text: fill.text, cursor: fill.text.length };
  const at = fill.mode === "append" ? draft.text.length : draft.cursor;
  return {
    text: draft.text.slice(0, at) + fill.text + draft.text.slice(at),
    cursor: at + fill.text.length,
  };
}
